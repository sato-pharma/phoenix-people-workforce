import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveCycleWindow } from "../src/lib/payroll/copilot/cycle-window.ts";
import {
  completedSettlementWeek,
  previousMonthKey,
  settlementWeekForDate,
  tileSettlementWeeks,
} from "../src/lib/attendance/digest-weeks.ts";
import {
  buildWeekDigests,
  durationTextToMinutes,
  isDigestibleRow,
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
  // --- Week tiling -----------------------------------------------------------
  // The cycle window itself is cycle-window.ts's job; this module only cuts it up.
  const cycle = resolveCycleWindow("2026-09-08", 24);
  const weeks = tileSettlementWeeks(cycle);

  assert.equal(weeks.length, 4, "a cycle is always tiled into exactly four settlement weeks");
  assert.equal(weeks[0]!.startIso, cycle.startIso, "week 1 opens on the cycle's own start, not on a Monday");
  assert.equal(weeks[3]!.endIso, cycle.endIso, "week 4 closes on the cycle end so nothing falls past the cut-off");
  for (let index = 0; index < 3; index += 1) {
    assert.equal(weeks[index]!.index, index + 1, "weeks are numbered 1..4 in order");
  }

  // No gaps and no overlaps — every day of the cycle belongs to exactly one week.
  for (let index = 1; index < weeks.length; index += 1) {
    const previousEnd = new Date(`${weeks[index - 1]!.endIso}T00:00:00Z`).getTime();
    const thisStart = new Date(`${weeks[index]!.startIso}T00:00:00Z`).getTime();
    assert.equal(
      thisStart - previousEnd,
      86_400_000,
      `week ${index + 1} must start the day after week ${index} ends — a gap silently drops a chargeable day`,
    );
  }

  assert.equal(settlementWeekForDate(cycle.startIso, cycle), 1, "the first day of the cycle is in week 1");
  assert.equal(settlementWeekForDate(cycle.endIso, cycle), 4, "the last day of the cycle is in week 4");
  assert.equal(
    settlementWeekForDate("1999-01-01", cycle),
    null,
    "a date outside the cycle belongs to no week, rather than defaulting to one",
  );

  // --- Which week is due -----------------------------------------------------
  assert.equal(
    completedSettlementWeek(cycle.startIso, cycle),
    null,
    "on the first day of a cycle no week has closed, so no digest is due — the same reason the deductions collector refuses an in-progress month",
  );
  const afterWeekOne = new Date(new Date(`${weeks[0]!.endIso}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  assert.equal(
    completedSettlementWeek(afterWeekOne, cycle)?.index,
    1,
    "the day after week 1 ends, week 1 is the one to send",
  );
  assert.equal(
    completedSettlementWeek(weeks[0]!.endIso, cycle),
    null,
    "a week is not due on its own last day — that day has not finished being worked",
  );

  // --- The lockdown reaches every employee-facing surface ---------------------
  // Owner 2026-09-08: the page is closed pending his rules on how employees are told
  // it exists. Removing the nav row was UX ONLY, so the gate has to be asked by the
  // page AND all three APIs — a gate with three doors around it is not a gate.
  //
  // Asserted on the sources because none of these can be invoked without a Supabase
  // client, and the defect being guarded against is precisely a surface that never
  // calls the gate at all.
  for (const surface of [
    "app/employee-portals/attendance/digests/page.tsx",
    "app/api/attendance/digests/route.ts",
    "app/api/attendance/digests/[id]/confirm/route.ts",
    "app/api/attendance/digests/[id]/dispute/route.ts",
  ]) {
    const source = readFileSync(surface, "utf8");
    assert.match(
      source,
      /canOpenDigestPortal\(access\)/,
      `${surface} must ask canOpenDigestPortal — an ungated surface reopens the page the nav row was removed to hide`,
    );
    assert.match(
      source,
      /canOpenDigestPortal\(access\)\.catch\(\(\) => false\)/,
      `${surface} must fail CLOSED: a lookup that throws means "not verifiably allowed", never "let them in", on a surface showing somebody their own pay`,
    );
  }

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
