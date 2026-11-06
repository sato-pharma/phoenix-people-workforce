import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  OFFICE_CYCLE_FIRST_MONTH_KEY,
  allowedDraftDateWindow,
  calendarMonthsInWindow,
  clipDraftToCycleWindow,
  cycleCoversEmployee,
  cycleWindow,
  dayChargeTarget,
  isCycleWindowCollectable,
  isDeductionCycle,
  isSplitCycleMonth,
  ledgerClaimMonthKeys,
  mergeCycleDrafts,
  shiftMonth,
} from "../src/lib/deductions/cycle.ts";
import { anchorDate } from "../src/lib/deductions/leave-balance.ts";
import { holdCrossCycleClaimedDrafts } from "../src/lib/deductions/collect.ts";
import { candidateInsideDateWindow, validateCandidateDraft } from "../src/lib/deductions/service.ts";
import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";

/**
 * The two deduction cycles (owner, 2026-10-26).
 *
 *   "I can't calculate the deductions of the part one salary because the deduction module itself
 *    only doesn't run if the month didn't finish… make anyone part one to be from 22 to 20."
 *
 * Part 1 of the salary is paid before the month ends, so every employee paid in ONE part is judged
 * over the Head Office cycle — the 22nd of the previous month → the 21st — and everyone paid in two
 * parts stays on the calendar month. The office cycle starts with the October 2026 payroll month,
 * whose window opens on 1 October because September was collected on the calendar month for
 * everyone. These pins hold the windows, the population split, the clip and merge arithmetic, the
 * validation door a cycle row passes through, and every "is this day already charged?" read that
 * must now look one month further.
 */
export async function runDeductionsCycleTests(): Promise<void> {
  // ── The windows ───────────────────────────────────────────────────────────
  {
    assert.equal(OFFICE_CYCLE_FIRST_MONTH_KEY, "2026-10");
    const october = cycleWindow("office", { year: 2026, month: 10 });
    assert.deepEqual(
      [october.monthKey, october.start, october.end],
      ["2026-10", "2026-10-01", "2026-10-21"],
      "October 2026 is the cutover: 1 → 21 October, never from 22 September (September was collected on the calendar month)",
    );
    const november = cycleWindow("office", { year: 2026, month: 11 });
    assert.deepEqual(
      [november.monthKey, november.start, november.end],
      ["2026-11", "2026-10-22", "2026-11-21"],
      "from November the window is the plain 22nd of the previous month → the 21st",
    );
    const january = cycleWindow("office", { year: 2027, month: 1 });
    assert.deepEqual(
      [january.start, january.end],
      ["2026-12-22", "2027-01-21"],
      "January's window opens in December of the previous year",
    );
    assert.throws(
      () => cycleWindow("office", { year: 2026, month: 9 }),
      /starts with the October 2026 payroll month/,
      "there is no office window before the cutover — inventing one would charge September twice",
    );
    const february = cycleWindow("calendar", { year: 2028, month: 2 });
    assert.deepEqual([february.start, february.end], ["2028-02-01", "2028-02-29"], "the calendar window is the whole month, leap day included");

    // Consecutive office windows tile the calendar with no gap and no overlap: the day after one
    // window's end is the next window's start.
    for (let period = { year: 2026, month: 10 }, index = 0; index < 18; index += 1, period = shiftMonth(period, 1)) {
      const current = cycleWindow("office", period);
      const next = cycleWindow("office", shiftMonth(period, 1));
      const dayAfter = new Date(`${current.end}T00:00:00Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      assert.equal(next.start, dayAfter.toISOString().slice(0, 10), `office windows must tile: ${current.monthKey} → ${next.monthKey}`);
    }
  }

  // ── Collectable only after the window's LAST day has ended (Cairo) ────────
  {
    const october = cycleWindow("office", { year: 2026, month: 10 });
    assert.equal(isCycleWindowCollectable(october, "2026-10-21"), false, "the 21st itself is still running");
    assert.equal(isCycleWindowCollectable(october, "2026-10-22"), true, "collectable from the 22nd");
    const calendar = cycleWindow("calendar", { year: 2026, month: 10 });
    assert.equal(isCycleWindowCollectable(calendar, "2026-10-31"), false);
    assert.equal(isCycleWindowCollectable(calendar, "2026-11-01"), true);
  }

  // ── The calendar months a window spans ────────────────────────────────────
  {
    const keys = (window: ReturnType<typeof cycleWindow>) =>
      calendarMonthsInWindow(window).map((period) => `${period.year}-${String(period.month).padStart(2, "0")}`);
    assert.deepEqual(keys(cycleWindow("office", { year: 2026, month: 10 })), ["2026-10"]);
    assert.deepEqual(keys(cycleWindow("office", { year: 2026, month: 11 })), ["2026-10", "2026-11"]);
    assert.deepEqual(keys(cycleWindow("office", { year: 2027, month: 1 })), ["2026-12", "2027-01"]);
    assert.deepEqual(keys(cycleWindow("calendar", { year: 2026, month: 11 })), ["2026-11"]);
  }

  // ── Every employee on exactly one cycle ───────────────────────────────────
  {
    const september = { year: 2026, month: 9 };
    const october = { year: 2026, month: 10 };
    assert.equal(isSplitCycleMonth(september), false);
    assert.equal(isSplitCycleMonth(october), true);
    for (const isOnePart of [true, false]) {
      assert.equal(cycleCoversEmployee("calendar", september, isOnePart), true, "before the cutover the calendar run covers everyone");
      assert.equal(cycleCoversEmployee("office", september, isOnePart), false, "before the cutover the office run covers no one");
      const covering = (["office", "calendar"] as const).filter((cycle) => cycleCoversEmployee(cycle, october, isOnePart));
      assert.equal(covering.length, 1, "from the cutover every employee is on exactly ONE cycle — never both, never neither");
    }
    assert.equal(cycleCoversEmployee("office", october, true), true, "one-part pay → the Head Office cycle");
    assert.equal(cycleCoversEmployee("calendar", october, false), true, "two-part pay → the calendar month");
    assert.equal(isDeductionCycle("office"), true);
    assert.equal(isDeductionCycle("calendar"), true);
    assert.equal(isDeductionCycle("weekly"), false);
    assert.equal(isDeductionCycle(undefined), false);
  }

  // ── Clip: passthrough when wholly inside, scaled when cut ─────────────────
  const november = cycleWindow("office", { year: 2026, month: 11 });
  const draft = (overrides: Partial<DeductionsCandidateDraft>): DeductionsCandidateDraft => ({
    category: "crm",
    sourceSystem: "crm",
    sourceRecordId: "rec-1",
    employeeHrId: "S-101",
    employeeName: "Test Rep",
    monthKey: "2026-10",
    month: 10,
    year: 2026,
    unit: "days",
    rawValue: 4,
    estimatedAmount: 400.01,
    calculationStatus: "calculated",
    dates: ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"],
    evidence: { origin: "test" },
    ...overrides,
  });
  {
    const half = clipDraftToCycleWindow(draft({}), november, "2026-10");
    assert.ok(half);
    assert.deepEqual(half.dates, ["2026-10-22", "2026-10-23"], "only the window's days are kept");
    assert.equal(half.monthKey, "2026-11", "re-keyed to the PAYROLL month it is paid in");
    assert.equal(half.month, 11);
    assert.equal(half.year, 2026);
    assert.equal(half.rawValue, 2, "the day count scales by the kept fraction");
    // A CRM row is priced on what its days WEIGH: Tue 20, Wed 21, Thu 22 (half), Fri 23 is 3.5 days,
    // and the kept Thu 22 + Fri 23 are 1.5 of them — 400.01 × 1.5 / 3.5, never half the money.
    assert.equal(
      half.estimatedAmount,
      171.43,
      "REGRESSION: a CRM row cut at the cycle boundary is priced on the kept days' weight (Thursday is half), not their count",
    );
    const countBased = clipDraftToCycleWindow(draft({ category: "fingerprint", sourceSystem: "fingerprint" }), november, "2026-10");
    assert.equal(countBased?.estimatedAmount, 200.01, "every other category still scales by the kept fraction");
    assert.deepEqual(
      (half.evidence as Record<string, unknown>).deductionCycle,
      { cycle: "office", windowStart: "2026-10-22", windowEnd: "2026-11-21", calendarMonths: ["2026-10"] },
      "the clipped row carries the marker the validator reads",
    );
    assert.equal((half.evidence as Record<string, unknown>).origin, "test", "the connector's own evidence survives");

    const whole = clipDraftToCycleWindow(
      draft({ dates: ["2026-10-22", "2026-10-25", "2026-10-26"], rawValue: 3, estimatedAmount: 333.33 }),
      november,
      "2026-10",
    );
    assert.ok(whole);
    assert.equal(whole.rawValue, 3);
    assert.equal(whole.estimatedAmount, 333.33, "a draft wholly inside the window passes through to the piaster");

    assert.equal(
      clipDraftToCycleWindow(draft({ dates: ["2026-10-20", "2026-10-21"] }), november, "2026-10"),
      null,
      "a draft with no day inside the window is dropped — those days belong to October's window",
    );
    const unknown = clipDraftToCycleWindow(draft({ estimatedAmount: null }), november, "2026-10");
    assert.equal(unknown?.estimatedAmount, null, "an unknown amount stays unknown");
  }

  // ── Merge: one record split across two calendar months becomes one row ───
  {
    const octoberPart = clipDraftToCycleWindow(
      draft({ dates: ["2026-10-29", "2026-10-30"], rawValue: 2, estimatedAmount: 200 }),
      november,
      "2026-10",
    )!;
    const novemberPart = clipDraftToCycleWindow(
      draft({ monthKey: "2026-11", month: 11, dates: ["2026-11-02"], rawValue: 1, estimatedAmount: 100 }),
      november,
      "2026-11",
    )!;
    const merged = mergeCycleDrafts([octoberPart, novemberPart]);
    assert.equal(merged.drafts.length, 1, "one identity, one row — two would collide on the ledger's unique key");
    const [row] = merged.drafts;
    assert.deepEqual(row.dates, ["2026-10-29", "2026-10-30", "2026-11-02"]);
    assert.equal(row.rawValue, 3);
    assert.equal(row.estimatedAmount, 300);
    assert.equal(row.calculationStatus, "calculated");
    assert.deepEqual(
      ((row.evidence as Record<string, unknown>).deductionCycle as { calendarMonths: string[] }).calendarMonths,
      ["2026-10", "2026-11"],
    );
    assert.equal(merged.notes.length, 0);

    const withUnknown = mergeCycleDrafts([octoberPart, { ...novemberPart, estimatedAmount: null }]);
    assert.equal(withUnknown.drafts[0].estimatedAmount, null, "any unknown part makes the whole amount unknown");
    assert.equal(withUnknown.drafts[0].calculationStatus, "requires_review");

    const overlapping = mergeCycleDrafts([octoberPart, { ...novemberPart, dates: ["2026-10-30", "2026-11-02"] }]);
    assert.equal(overlapping.drafts[0].estimatedAmount, null, "a day reported twice is never summed blind");
    assert.equal(overlapping.drafts[0].calculationStatus, "requires_review");
    assert.equal(overlapping.drafts[0].rawValue, 3, "the union of days, not the sum of counts");
    assert.equal(overlapping.notes.length, 1, "and the run says so");

    const otherPerson = mergeCycleDrafts([octoberPart, { ...novemberPart, employeeHrId: "S-202" }]);
    assert.equal(otherPerson.drafts.length, 2, "different people are never merged");
  }

  // ── The validation door: a cycle row may leave its month only inside its exact window ─
  {
    const cycleRow = clipDraftToCycleWindow(draft({}), november, "2026-10")!;
    assert.deepEqual(allowedDraftDateWindow(cycleRow), { start: "2026-10-22", end: "2026-11-21" });
    assert.equal(validateCandidateDraft(cycleRow).valid, true, "an office row carrying 22–23 October on November's payroll is valid");

    const unmarked = { ...cycleRow, evidence: { origin: "test" } };
    assert.equal(validateCandidateDraft(unmarked).valid, false, "without the marker a row is held to its own calendar month, as before");

    const widened = {
      ...cycleRow,
      dates: ["2026-10-01", "2026-10-22"],
      evidence: {
        deductionCycle: { cycle: "office", windowStart: "2026-10-01", windowEnd: "2026-11-21", calendarMonths: ["2026-10"] },
      },
    };
    assert.deepEqual(
      allowedDraftDateWindow(widened),
      { start: "2026-11-01", end: "2026-11-30" },
      "a marker naming any window but the one this module computes cannot widen anything",
    );
    assert.equal(validateCandidateDraft(widened).valid, false, "a spoofed marker cannot carry 1 October onto November's payroll");

    const beyond = { ...cycleRow, dates: ["2026-11-22"] };
    assert.equal(validateCandidateDraft(beyond).valid, false, "the 22nd belongs to the NEXT window and is refused");

    const preCutover = {
      ...draft({ monthKey: "2026-09", month: 9, dates: ["2026-08-25"] }),
      evidence: {
        deductionCycle: { cycle: "office", windowStart: "2026-08-22", windowEnd: "2026-09-21", calendarMonths: ["2026-08"] },
      },
    };
    assert.equal(validateCandidateDraft(preCutover).valid, false, "no month before October 2026 has an office window to let a date through");

    const plain = draft({ monthKey: "2026-11", month: 11, dates: ["2026-11-03"] });
    assert.equal(validateCandidateDraft(plain).valid, true, "an ordinary calendar row is unchanged");
  }

  // ── The leave balance is charged at a date INSIDE the row's own month ──────
  {
    assert.equal(
      anchorDate({ monthKey: "2027-01", dates: ["2026-12-28", "2027-01-05"] }),
      "2027-01-05",
      "January's office row starts in December — anchoring there would charge last year's balance",
    );
    assert.equal(anchorDate({ monthKey: "2027-01", dates: ["2026-12-28"] }), "2027-01-01", "no in-month day → the 1st of the payroll month");
    assert.equal(anchorDate({ monthKey: "2026-11", dates: ["2026-11-09"] }), "2026-11-09");
  }

  // ── Every "is this day already charged?" read looks one month further ─────
  {
    assert.deepEqual(ledgerClaimMonthKeys("2026-10"), ["2026-10", "2026-11"]);
    assert.deepEqual(ledgerClaimMonthKeys("2026-12"), ["2026-12", "2027-01"]);

    // An office row for November carries 22–31 October. A connector judging October, or a reader
    // asking about an October day, must see it — or the day is charged a second time on the calendar
    // side, or shown as uncharged.
    const readers: Array<[string, RegExp]> = [
      ["src/lib/deductions/connectors/crm.ts", /\.in\("month_key", ledgerClaimMonthKeys\(monthKey\)\)/],
      ["src/lib/deductions/connectors/dsm-no-record.ts", /\.in\("month_key", ledgerClaimMonthKeys\(monthKey\)\)/],
      ["src/lib/deductions/connectors/half-day.ts", /\.in\("month_key", ledgerClaimMonthKeys\(monthKey\)\)/],
      ["src/lib/deductions/connectors/holiday-bridge.ts", /\.in\("month_key", ledgerClaimMonthKeys\(monthKey\)\)/],
      ["src/lib/deductions/connectors/vacation.ts", /\.in\("month_key", ledgerClaimMonthKeys\(input\.monthKey\)\)/],
      ["src/lib/hr-ops-reports/bridge.ts", /\.in\("month_key", ledgerClaimMonthKeys\(monthKey\)\)/],
      ["src/lib/deductions/settlement.ts", /ledgerClaimMonthKeys\(draft\.monthKey\)\.map/],
    ];
    for (const [file, pattern] of readers) {
      assert.match(readFileSync(file, "utf8"), pattern, `${file} must read the claim ledger across the month AND the next one`);
    }
    const dayReport = readFileSync("src/lib/attendance/employee-day-report.ts", "utf8");
    assert.equal(
      (dayReport.match(/for \(const monthKey of ledgerClaimMonthKeys\(dateIso\.slice\(0, 7\)\)\) monthKeys\.add\(monthKey\);/g) ?? []).length,
      2,
      "the employee day report must read both month keys for its decisions AND its summary",
    );
  }

  // ── The two runs never retire each other's rows ───────────────────────────
  {
    const service = readFileSync("src/lib/deductions/service.ts", "utf8");
    assert.match(
      service,
      /\.filter\(\(candidate\) => !employeeFilter \|\| employeeFilter\(candidate\.employeeHrIdCompact \?\? ""\)\)/,
      "reconcile must supersede only the rows of the population this run covers",
    );
    const collect = readFileSync("src/lib/deductions/collect.ts", "utf8");
    assert.match(collect, /const employeeFilter = await calendarEmployeeFilter\(\{ month, year \}\);/, "the calendar run reads its population BEFORE the connector");
    assert.match(
      collect,
      /const unheld = employeeFilter\s*\?\s*exemptionFree\.filter\(\(draft\) => employeeFilter\(compactDeductionsHrId\(draft\.employeeHrId\) \?\? ""\)\)\s*:\s*exemptionFree;/,
      "from the cutover the calendar run must drop the one-part employees' drafts, or they are charged on both cycles",
    );
    assert.match(
      collect,
      /category: collector\.reconcilesWholeCategory,\s*monthKey: window\.monthKey,\s*employeeFilter,\s*dateWindow: \{ start: window\.start, end: window\.end \},/,
      "the office run reconciles only its own population, and only the rows wholly inside its window",
    );
    assert.match(
      collect,
      /sourceSystems: collector\.reconcilesSourceScope\.sourceSystems,\s*employeeFilter,\s*dateWindow: \{ start: window\.start, end: window\.end \},/,
      "the office run's source-scoped reconcile is held to its window too",
    );
    assert.match(
      collect,
      /if \(\(input\.cycle \?\? "calendar"\) === "office"\)/,
      "the office cycle goes through its own door with its own end-of-window guard",
    );
    assert.match(
      collect,
      /if \(!isCycleWindowCollectable\(window, today\)\)/,
      "the office door refuses a window that has not ended in Cairo",
    );

    const route = readFileSync("app/api/admin/deductions/collect/route.ts", "utf8");
    assert.match(route, /if \(!isDeductionCycle\(cycle\)\) \{\s*throw new Error\('Validation: cycle must be "office" or "calendar"\.'\);/, "an unknown cycle is refused, never run as the calendar month");
    assert.match(route, /body\.cycle === undefined \|\| body\.cycle === null \? "calendar" : body\.cycle/, "an absent cycle keeps the calendar meaning every older caller relies on");
  }

  // ── A row outside the office window is not the office run's to retire ─────
  // A row keyed to October with a day past the 21st was written before the cycle existed (the
  // Employee Day Report keyed by calendar month). The October office scan never emits it, and that
  // absence is not a retraction: retiring it drops its decision with nothing to carry it to.
  {
    const window = { start: "2026-10-01", end: "2026-10-21" };
    assert.equal(candidateInsideDateWindow(["2026-10-05", "2026-10-21"], window), true);
    assert.equal(candidateInsideDateWindow(["2026-10-21", "2026-10-22"], window), false, "a single day past the window takes the row out of scope");
    assert.equal(candidateInsideDateWindow(["2026-10-25"], undefined), true, "no window keeps every row in scope, as before");
    assert.match(
      readFileSync("src/lib/deductions/service.ts", "utf8"),
      /\.filter\(\(candidate\) => candidateInsideDateWindow\(candidate\.dates, input\.scope\.dateWindow\)\);/,
      "reconcile must apply the window to the rows it may retire",
    );
  }

  // ── One day written outside a run lands on the SAME month the run keys it to ─
  {
    const twoPart = dayChargeTarget("2026-10-25", false);
    assert.equal(twoPart.monthKey, "2026-10");
    assert.equal(twoPart.cycleEvidence, null, "a two-part employee's day stays on its calendar month");

    assert.equal(dayChargeTarget("2026-09-25", true).monthKey, "2026-09", "September was collected on the calendar month for everyone");
    assert.equal(dayChargeTarget("2026-09-25", true).cycleEvidence, null);

    const early = dayChargeTarget("2026-10-15", true);
    assert.equal(early.monthKey, "2026-10");
    assert.deepEqual([early.cycleEvidence?.windowStart, early.cycleEvidence?.windowEnd], ["2026-10-01", "2026-10-21"]);

    const late = dayChargeTarget("2026-10-25", true);
    assert.deepEqual([late.monthKey, late.month, late.year], ["2026-11", 11, 2026], "a one-part day past the 21st belongs to the NEXT payroll month");
    assert.deepEqual([late.cycleEvidence?.windowStart, late.cycleEvidence?.windowEnd], ["2026-10-22", "2026-11-21"]);
    assert.equal(dayChargeTarget("2026-10-21", true).monthKey, "2026-10", "the 21st closes its own month");
    assert.equal(dayChargeTarget("2026-12-28", true).monthKey, "2027-01", "December's tail rolls into January");

    // And the validation door lets it through: its marker names exactly November's window.
    const dayDraft = draft({
      category: "fingerprint",
      sourceSystem: "fingerprint_report",
      sourceRecordId: "S-101:2026-10-25",
      monthKey: late.monthKey,
      month: late.month,
      year: late.year,
      rawValue: 1,
      estimatedAmount: 100,
      dates: ["2026-10-25"],
      evidence: { deductionCycle: late.cycleEvidence },
    });
    assert.deepEqual(validateCandidateDraft(dayDraft).errors, [], "the re-keyed day must pass the validator");

    const dayReport = readFileSync("src/lib/attendance/employee-day-report.ts", "utf8");
    assert.match(dayReport, /const target = dayChargeTarget\(input\.dateIso, isOnePart\);/, "the day report must key the day through the cycle rule");
    assert.match(
      dayReport,
      /for \(const claimMonthKey of ledgerClaimMonthKeys\(calendarMonthKey\)\) \{/,
      "the day report must find the row that already holds the day in BOTH month keys before adding one",
    );
    assert.match(dayReport, /deductionCycle: target\.cycleEvidence/, "the re-keyed day must carry the office marker");
  }

  // ── A day already on the OTHER cycle's row is never added again ───────────
  // The population is read when a run starts: paid in two parts for October (calendar, 1–31 Oct),
  // one part for November (office, 22 Oct → 21 Nov) would charge 22–31 October twice.
  {
    const novemberDraft = draft({
      category: "crm",
      sourceSystem: "crm_visits_mirror",
      sourceRecordId: "live_2026-11_S-101",
      monthKey: "2026-11",
      month: 11,
      year: 2026,
      rawValue: 2,
      estimatedAmount: 200,
      dates: ["2026-10-22", "2026-10-23"],
      evidence: { deductionCycle: november },
    });
    const liveRow = (overrides: Partial<{ monthKey: string; sourceSystem: string; dates: string[]; candidateKey: string }>) => ({
      monthKey: "2026-10",
      employeeHrIdCompact: "s101",
      category: "crm" as const,
      sourceSystem: "crm_visits_mirror",
      dates: ["2026-10-22"],
      candidateKey: "crm:crm_visits_mirror:other:s101:2026-10:abc",
      ...overrides,
    });

    const held = holdCrossCycleClaimedDrafts({ drafts: [novemberDraft], live: [liveRow({})], identityOf: () => "x" });
    assert.equal(held.keep.length, 0, "a day the October calendar row already claims must hold the November office draft");
    assert.equal(held.notes.length, 1);
    assert.match(held.notes[0], /^Test Rep: 2026-10-22 already sit on a deduction of another payroll month/, "the note names the person and the claimed day");
    assert.match(held.notes[0], /not charged yet: 2026-10-23/, "the note names the open day so it can be added by hand");

    const sameMonth = holdCrossCycleClaimedDrafts({
      drafts: [novemberDraft],
      live: [liveRow({ monthKey: "2026-11" })],
      identityOf: () => "x",
    });
    assert.equal(sameMonth.keep.length, 1, "a row of the draft's OWN month is the reconcile's business, not a cross-cycle claim");

    const alreadyLive = holdCrossCycleClaimedDrafts({
      drafts: [novemberDraft],
      live: [liveRow({}), liveRow({ monthKey: "2026-11", candidateKey: "id-1:2026-10-22|2026-10-23", dates: ["2026-11-02"] })],
      identityOf: () => "id-1",
    });
    assert.equal(alreadyLive.keep.length, 1, "a draft already live under its own month is kept, or the reconcile would retire that row");

    const manual = holdCrossCycleClaimedDrafts({
      drafts: [novemberDraft],
      live: [liveRow({ sourceSystem: "manual_hr" })],
      identityOf: () => "x",
    });
    assert.equal(manual.keep.length, 1, "a manual HR row's date is a placeholder, never a claim");

    const collect = readFileSync("src/lib/deductions/collect.ts", "utf8");
    assert.match(
      collect,
      /const crossCycle = employeeFilter \? await applyCrossCycleHold\(unheld, \{ month, year \}\) : \{ drafts: unheld, notes: \[\] \};/,
      "the calendar run must hold a day the office row already carries (from the cutover)",
    );
    assert.match(collect, /const crossCycle = await applyCrossCycleHold\(unheld, period\);/, "the office run must hold a day the calendar row already carries");
  }

  // ── A run re-reads the page ───────────────────────────────────────────────
  // The October Head Office run wrote 28 deductions and the screen kept reading 0 until a manual
  // reload: every panel fetched on mount only. The run bumps a version that re-keys them.
  {
    const workspace = readFileSync("src/components/admin/deductions-workspace.tsx", "utf8");
    assert.match(
      workspace,
      /finally \{\s*setCollecting\(false\);\s*setDataVersion\(\(version\) => version \+ 1\);/,
      "a collection run must bump the data version when it ends, or the panels keep the pre-run numbers",
    );
    assert.ok(workspace.includes("const panelKey = `${monthKey}:${dataVersion}`;"), "the panel key must carry the data version");
    // Every panel carries the version AND its own name: they are siblings, and siblings sharing one key
    // leave a stale copy behind on each re-read (November 2026: the leaver banner showed two and three times).
    const keys: string[] = [];
    for (const panel of ["MasterExportBar", "OverviewTab", "ByEmployeeTab", "CategoryTab", "LeaverSettlementPanel"]) {
      const match = workspace.match(new RegExp("<" + panel + " key=\\{`([a-z-]+):\\$\\{panelKey\\}`\\}"));
      assert.ok(match, `${panel} must be keyed on its own name plus panelKey, or it never remounts after a collection run`);
      keys.push(match[1]);
    }
    assert.equal(new Set(keys).size, keys.length, `two sibling panels share a key prefix (${keys.join(", ")}) — React leaves duplicates behind`);
  }
}
