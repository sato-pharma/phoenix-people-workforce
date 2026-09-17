import assert from "node:assert/strict";

import { addDays } from "../src/lib/payroll/copilot/cycle-window.ts";
import {
  currentReviewMonth,
  previousMonthKey,
  reviewWeekWindow,
  tileReviewMonth,
} from "../src/lib/attendance/digest-weeks.ts";
import {
  buildWeekDigests,
  durationTextToMinutes,
  isDigestibleRow,
  planWeekSync,
  priceOrNull,
} from "../src/lib/attendance/digest-generator.ts";
import type { FingerprintReportRow } from "../src/lib/attendance/fingerprint-report.ts";

/** A report row with only the fields the digest reads; the rest are irrelevant here. */
function row(overrides: Partial<FingerprintReportRow> & { employeeHrId: string; dateIso: string }): FingerprintReportRow {
  return {
    employeeHrId: overrides.employeeHrId,
    employeeName: overrides.employeeName ?? "Someone",
    dateIso: overrides.dateIso,
    deductionDays: overrides.deductionDays ?? "0",
    deductionValue: overrides.deductionValue ?? "0",
    status: overrides.status ?? "Late",
    lateMinutes: overrides.lateMinutes ?? "",
    earlyLeaveMinutes: overrides.earlyLeaveMinutes ?? "",
    timeLong: overrides.timeLong ?? "",
    recommendedAction: overrides.recommendedAction ?? "",
    approvedLeave: overrides.approvedLeave ?? "",
    approvedExcuse: overrides.approvedExcuse ?? "",
    crmActivity: overrides.crmActivity ?? "",
    weeklyPlan: overrides.weeklyPlan ?? "",
    actualFirstPunch: overrides.actualFirstPunch ?? "",
    actualLastPunch: overrides.actualLastPunch ?? "",
    hasException: overrides.hasException,
    sortKey: `${overrides.dateIso}\u0000${overrides.employeeHrId}`,
  } as unknown as FingerprintReportRow;
}

export function runAttendanceWeeklyDigestTests() {
  // --- The review month's weeks ---------------------------------------------------
  // Owner, 2026-09-17: "1–30 September. Keep payroll as it is. From October the weekly review's weeks
  // start on the 1st to match." Month-end payroll collects deductions by calendar month, so a review
  // month that ran 24th to 23rd put every month's last week into the next month's review.
  assert.deepEqual(
    tileReviewMonth("2026-09").map((week) => [week.index, week.startIso, week.endIso]),
    [
      [2, "2026-09-01", "2026-09-06"],
      [3, "2026-09-07", "2026-09-13"],
      [4, "2026-09-14", "2026-09-23"],
      [5, "2026-09-24", "2026-09-30"],
    ],
    "September 2026 is 1–30 September: week 3 keeps the dates its real digests were built with, and a fifth week closes the month",
  );
  assert.deepEqual(
    tileReviewMonth("2026-10").map((week) => [week.index, week.startIso, week.endIso]),
    [
      [1, "2026-10-01", "2026-10-07"],
      [2, "2026-10-08", "2026-10-14"],
      [3, "2026-10-15", "2026-10-21"],
      [4, "2026-10-22", "2026-10-31"],
    ],
    "from October a review month is the calendar month, starting on the 1st like payroll's",
  );
  assert.equal(tileReviewMonth("2027-02").at(-1)?.endIso, "2027-02-28", "the last week ends on the month's own last day");
  assert.equal(tileReviewMonth("2028-02").at(-1)?.endIso, "2028-02-29", "…in a leap year too");
  // Owner, 2026-09-17, after the live weeks shipped: "build starting from 1 august". August is an
  // ordinary calendar month — its fingerprint days were still Pending in month-end deductions.
  assert.deepEqual(
    tileReviewMonth("2026-08").map((week) => [week.index, week.startIso, week.endIso]),
    [
      [1, "2026-08-01", "2026-08-07"],
      [2, "2026-08-08", "2026-08-14"],
      [3, "2026-08-15", "2026-08-21"],
      [4, "2026-08-22", "2026-08-31"],
    ],
    "the review starts on 1 August 2026, in calendar weeks",
  );
  assert.deepEqual(tileReviewMonth("2026-07"), [], "nothing before August 2026 is reviewed");
  assert.equal(
    tileReviewMonth("2026-08").at(-1)!.endIso,
    addDays(tileReviewMonth("2026-09")[0]!.startIso, -1),
    "August's last week ends the day before September's first week starts — no day between them is lost",
  );
  for (const monthKey of ["2026-08", "2026-09", "2026-10", "2026-11", "2027-02", "2027-12"]) {
    const monthWeeks = tileReviewMonth(monthKey);
    const lastDay = new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)), 0)).getUTCDate();
    assert.equal(monthWeeks[0]!.startIso, `${monthKey}-01`, `${monthKey} starts on the 1st, the day payroll's month starts`);
    assert.equal(
      monthWeeks.at(-1)!.endIso,
      `${monthKey}-${String(lastDay).padStart(2, "0")}`,
      `${monthKey} ends on its last day, so no day falls into the next month's review`,
    );
    for (let index = 1; index < monthWeeks.length; index += 1) {
      assert.equal(
        monthWeeks[index]!.startIso,
        addDays(monthWeeks[index - 1]!.endIso, 1),
        `${monthKey} week ${monthWeeks[index]!.index} must start the day after the week before it ends — a gap silently drops a chargeable day`,
      );
      assert.equal(monthWeeks[index]!.index, monthWeeks[index - 1]!.index + 1, "weeks are numbered in order");
    }
  }

  // --- A week as it stands on a given day ------------------------------------------
  // Owner, 2026-09-17: "Show live, release any time". A week is listed from its first day and holds the
  // days up to YESTERDAY — today has not finished being worked and its punches have not arrived.
  const week4 = tileReviewMonth("2026-09").find((week) => week.index === 4)!;
  assert.equal(reviewWeekWindow("2026-09", week4, "2026-09-14"), null, "a week is not listed on its own first day: none of its days has finished");
  const firstDay = reviewWeekWindow("2026-09", week4, "2026-09-15");
  assert.equal(firstDay?.running, true);
  assert.equal(firstDay?.throughIso, "2026-09-14", "the day after it starts, the week holds its first day");
  const midWeek = reviewWeekWindow("2026-09", week4, "2026-09-17");
  assert.equal(midWeek?.running, true, "on 17 September week 4 is still running — it used to be invisible until the 24th");
  assert.equal(midWeek?.throughIso, "2026-09-16", "…and it holds the days up to yesterday, never today");
  assert.equal(midWeek?.monthKey, "2026-09");
  const ownLastDay = reviewWeekWindow("2026-09", week4, "2026-09-23");
  assert.equal(ownLastDay?.running, true, "a week is still running on its own last day");
  assert.equal(ownLastDay?.throughIso, "2026-09-22");
  const dayAfter = reviewWeekWindow("2026-09", week4, "2026-09-24");
  assert.equal(dayAfter?.running, false, "the day after it ends, the week is complete");
  assert.equal(dayAfter?.throughIso, "2026-09-23");
  assert.equal(reviewWeekWindow("2026-09", week4, "2026-10-20")?.throughIso, "2026-09-23", "a finished week never reaches past its own end");

  assert.equal(currentReviewMonth("2026-09-17"), "2026-09");
  assert.equal(
    currentReviewMonth("2026-10-01"),
    "2026-09",
    "on 1 October the last full day is 30 September, so September is still the month under review",
  );
  assert.equal(currentReviewMonth("2026-10-02"), "2026-10");
  assert.equal(currentReviewMonth("2027-01-01"), "2026-12", "the year rolls back with the month");

  // The per-surface gate assertions moved to attendance-digest-rules.test.ts with the
  // 2026-09-15 release flow, which replaced the 2026-09-08 lockdown they used to pin.

  // --- Which months the bridge has to ask for --------------------------------
  // A settlement is written the week the employee answers; the candidate it belongs to
  // is not created until that month has CLOSED. So the answers waiting to be applied
  // always span two months, and the January boundary is where a naive `month - 1`
  // produces "2026-00" — a month that matches nothing, silently, on the one day of the
  // year nobody is watching for it.
  assert.equal(previousMonthKey("2026-09"), "2026-08", "an ordinary month steps back one");
  assert.equal(previousMonthKey("2026-01"), "2025-12", "January steps back to December of the PREVIOUS year");
  assert.equal(previousMonthKey("2026-10"), "2026-09", "the two-digit boundary keeps its padding");
  assert.equal(previousMonthKey("2026-11"), "2026-10", "no off-by-one across the 10/11 boundary");
  assert.throws(() => previousMonthKey("2026-13"), /out of range/, "an impossible month is refused, not wrapped");
  assert.throws(() => previousMonthKey("2026-00"), /out of range/, "the bad value this function exists to prevent is itself refused");
  assert.throws(() => previousMonthKey("202609"), /YYYY-MM/, "a malformed key is refused rather than parsed loosely");

  // --- Duration parsing ------------------------------------------------------
  assert.equal(durationTextToMinutes("06:03"), 363, "hh:mm parses to minutes");
  assert.equal(durationTextToMinutes(""), 0, "a blank duration is zero, not NaN");
  assert.equal(durationTextToMinutes("garbage"), 0, "an unparseable duration is zero, not NaN");

  // --- Which rows become lines ----------------------------------------------
  assert.equal(
    isDigestibleRow(row({ employeeHrId: "A-1", dateIso: "2026-09-01", deductionDays: "0" })),
    false,
    "a day the report cancelled arrives as 0 days and must never become a digest line — that is how the 2026-09-08 cancel fix reaches this module without a second copy of the rule",
  );
  assert.equal(
    isDigestibleRow(row({ employeeHrId: "A-1", dateIso: "2026-09-01", deductionDays: "0.5", hasException: true })),
    false,
    "an approved exception is never chargeable",
  );
  assert.equal(
    isDigestibleRow(row({ employeeHrId: "A-1", dateIso: "2026-09-01", deductionDays: "0.5" })),
    true,
    "a genuinely chargeable day becomes a line",
  );
  assert.equal(
    isDigestibleRow(
      row({ employeeHrId: "A-1", dateIso: "2026-09-01", deductionDays: "0.5", deductionValue: "Base salary missing" }),
    ),
    true,
    "no salary on file does NOT make the day free — it is still chargeable, and pricing it at zero silently is the defect people-with-no-salary-figure warns about",
  );

  // --- Unpriced is not free ---------------------------------------------------
  // Caught in the 2026-09-08 dry run: B-185 would have been shown "2 days, 0.00 EGP"
  // for two days that then become real month-end candidates. The earlier test above
  // only pinned that such a day still COUNTS; it never checked what number gets SHOWN.
  assert.equal(priceOrNull("177.42"), 177.42, "a real price parses");
  assert.equal(priceOrNull("0"), 0, "a genuine zero stays zero — not every falsy price is unknown");
  assert.equal(
    priceOrNull("Base salary missing"),
    null,
    "the report's own words for 'no salary on file' become null, never 0",
  );
  assert.equal(priceOrNull(""), null, "a blank price is unknown, not free");

  const unpriced = buildWeekDigests([
    row({ employeeHrId: "B-185", dateIso: "2026-09-01", deductionDays: "0.5", deductionValue: "Base salary missing" }),
    row({ employeeHrId: "B-185", dateIso: "2026-09-02", deductionDays: "0.5", deductionValue: "177.42" }),
  ])[0]!;
  assert.equal(unpriced.lines[0]!.deductionValue, null, "the unpriced day carries null, not 0.00");
  assert.equal(unpriced.lines[1]!.deductionValue, 177.42, "the priced day beside it is unaffected");
  assert.equal(unpriced.hasUnpricedDay, true, "the digest records that it contains an unpriced day");
  assert.equal(
    unpriced.totalDeductionValue,
    null,
    "one unpriced day makes the WEEK total unknown — a partial sum would look complete, which is the same lie in a quieter voice",
  );
  assert.equal(unpriced.totalDeductionDays, 1, "the DAYS still add up: what is unknown is the price, not the charge");

  const allPriced = buildWeekDigests([
    row({ employeeHrId: "A-1", dateIso: "2026-09-01", deductionDays: "0.5", deductionValue: "100" }),
    row({ employeeHrId: "A-1", dateIso: "2026-09-02", deductionDays: "0.5", deductionValue: "50" }),
  ])[0]!;
  assert.equal(allPriced.hasUnpricedDay, false, "a fully priced week says so");
  assert.equal(allPriced.totalDeductionValue, 150, "and totals normally");

  // --- Grouping --------------------------------------------------------------
  const digests = buildWeekDigests([
    row({ employeeHrId: "A-1", dateIso: "2026-09-03", deductionDays: "0.5", deductionValue: "177.42", status: "Short day" }),
    row({ employeeHrId: "A-1", dateIso: "2026-09-01", deductionDays: "0.25", deductionValue: "88.71", status: "Late" }),
    row({ employeeHrId: "A-2", dateIso: "2026-09-02", deductionDays: "0.5", deductionValue: "483.87" }),
    row({ employeeHrId: "A-3", dateIso: "2026-09-02", deductionDays: "0" }),
  ]);

  assert.equal(digests.length, 2, "only employees with at least one chargeable day get a digest");
  assert.ok(
    !digests.some((digest) => digest.employeeHrId === "A-3"),
    "a clean week produces NO digest — the 2026-07 module sent 'nothing to report' notices and they were the first thing switched off",
  );

  const first = digests[0]!;
  assert.equal(first.employeeHrId, "A-1");
  assert.equal(first.lines.length, 2);
  assert.equal(first.lines[0]!.workDate, "2026-09-01", "lines are ordered by date, not by the order the report returned them");
  assert.equal(first.totalDeductionDays, 0.75, "day totals add up across the week");
  assert.equal(first.totalDeductionValue, 266.13, "value totals add up across the week");
  assert.equal(first.lines[0]!.status, "late", "a Late row maps to the late line status");
  assert.equal(first.lines[1]!.status, "short_hours", "a Short day row maps to short_hours");

  // --- Bringing a week up to date ---------------------------------------------------
  // Owner, 2026-09-17: "Show live, release any time". The daily job and Refresh ask the database to add
  // new flagged days, refresh the ones still waiting, and take off a waiting day the report now clears.
  {
    const plan = planWeekSync(
      [
        row({ employeeHrId: "T-901", dateIso: "2026-09-13", deductionDays: "0.5", deductionValue: "533.33" }),
        row({ employeeHrId: "T-901", dateIso: "2026-09-15", deductionDays: "0.5", deductionValue: "533.33" }),
        row({ employeeHrId: "T-901", dateIso: "2026-09-14", deductionDays: "0.5", deductionValue: "533.33" }),
        row({ employeeHrId: "t-901", dateIso: "2026-09-16", deductionDays: "0.25", deductionValue: "266.67" }),
        row({ employeeHrId: "T-901", dateIso: "2026-09-17", deductionDays: "0.5", deductionValue: "533.33" }),
        row({ employeeHrId: "T-902", dateIso: "2026-09-14", deductionDays: "0" }),
        row({ employeeHrId: "T-902", dateIso: "2026-09-15", deductionDays: "0.5", deductionValue: "150", hasException: true }),
        row({ employeeHrId: "T-903", dateIso: "2026-09-15", deductionDays: "0.25", deductionValue: "100" }),
        row({ employeeHrId: "T-903", dateIso: "2026-09-15", deductionDays: "0.5", deductionValue: "200" }),
        row({ employeeHrId: "T-903", dateIso: "2026-09-16", deductionDays: "0" }),
        row({ employeeHrId: "T-904", dateIso: "2026-09-15", deductionDays: "0" }),
        row({ employeeHrId: "T-904", dateIso: "2026-09-15", deductionDays: "0.5", deductionValue: "150" }),
        row({ employeeHrId: "T-905", dateIso: "2026-09-17", deductionDays: "0.5", deductionValue: "150" }),
      ],
      { startIso: "2026-09-14", throughIso: "2026-09-16" },
    );

    const flagged = plan.get("t-901");
    assert.deepEqual(
      flagged?.lines.map((line) => line.workDate),
      ["2026-09-14", "2026-09-15", "2026-09-16"],
      "only the week's days up to yesterday, in date order — and two spellings of one HR id are one employee",
    );
    assert.deepEqual(flagged?.clearedDates, []);

    const excused = plan.get("t-902");
    assert.deepEqual(excused?.lines, [], "an employee whose days the report now clears has nothing to add");
    assert.deepEqual(
      excused?.clearedDates,
      ["2026-09-14", "2026-09-15"],
      "…but the cleared days are named, so a day still waiting for release is taken off: an excuse or leave approved after the day was flagged",
    );

    const twice = plan.get("t-903");
    assert.equal(twice?.lines.length, 1, "one employee-day is one day, even when the report returns it twice");
    assert.equal(twice?.lines[0]!.deductionDays, 0.5, "…and the larger charge is kept");
    assert.deepEqual(twice?.clearedDates, ["2026-09-16"]);

    const both = plan.get("t-904");
    assert.equal(both?.lines.length, 1);
    assert.deepEqual(
      both?.clearedDates,
      [],
      "a day flagged once is never also named cleared — the database refuses a week that names a day both ways, which would fail the whole employee",
    );

    assert.equal(plan.has("t-905"), false, "a flagged day after yesterday is not in the week yet");
  }

  // --- Evidence travels with the line ---------------------------------------
  const withEvidence = buildWeekDigests([
    row({
      employeeHrId: "B-155",
      dateIso: "2026-09-04",
      deductionDays: "0.5",
      deductionValue: "419.35",
      crmActivity: "Traveling: back from Minya",
      weeklyPlan: "Office",
      actualFirstPunch: "12:57 PM",
    }),
  ])[0]!;
  assert.equal(
    withEvidence.lines[0]!.evidence.crmActivity,
    "Traveling: back from Minya",
    "the contradicting evidence travels onto the line, so a dispute can be judged without re-running the report — its absence is why four wrong deductions were approved on 2026-08-05",
  );
  assert.equal(withEvidence.lines[0]!.evidence.firstPunch, "12:57 PM", "the punch times travel too");
}
