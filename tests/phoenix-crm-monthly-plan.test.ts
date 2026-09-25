import assert from "node:assert/strict";

import { AM_CALL_RATE_TARGET, CALL_RATE_WEEKDAYS, PM_CALL_RATE_TARGET } from "../src/lib/crm/call-rate.ts";
import { addDaysIso } from "../src/lib/crm/dates.ts";
import { fieldWeeksOfMonth, monthEndOf, monthStartOf, plannableMonths, weekdayOfIsoDay } from "../src/lib/phoenix-crm/calendar.ts";
import {
  callRateWorkingDaysOfMonth,
  isMonthlyPlanEditable,
  monthlyCallRate,
  monthlyPlanStatusLabel,
  summarizeMonthlyList,
  tallyDoctorMonth,
  type DoctorMonthInput,
} from "../src/lib/phoenix-crm/monthly-plan-rules.ts";
import { PHOENIX_CRM_DEFAULT_SETTINGS, type PhoenixCrmGrade, type PhoenixCrmListType } from "../src/lib/phoenix-crm/types.ts";

/**
 * Phoenix CRM — the monthly plan (owner, 2026-09-25).
 *
 *   - A field-week belongs to the month its Saturday (week_start) falls in — one month per week, so a
 *     week straddling a month edge sits wholly in the month its Saturday is in.
 *   - A doctor's month total against his grade norm: over is a deviation, shown and ALLOWED, never
 *     blocked; a grade with no number has no norm.
 *   - The meters read the PLAN (the dated placements), AM and PM apart and NEVER averaged.
 *   - The call rate divides by the Saturday-to-Wednesday working days of the month, AM against 2 and
 *     PM against 10, and its weekday set is the company standard (src/lib/crm/call-rate.ts) — copied
 *     into the phone module, kept equal here.
 */

const SETTINGS = PHOENIX_CRM_DEFAULT_SETTINGS;

function tally(customerId: string, listType: PhoenixCrmListType, grade: PhoenixCrmGrade | null, placed: number) {
  const input: DoctorMonthInput = { customerId, listType, grade, placed };
  return tallyDoctorMonth(input, SETTINGS);
}

export function runPhoenixCrmMonthlyPlanTests() {
  // ── A field-week belongs to the month of its Saturday — one month per week ──────────────────────
  assert.deepEqual(
    fieldWeeksOfMonth("2026-10-01"),
    ["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31"],
    "October's weeks are its five Saturdays — the last (Oct 31) belongs to October though it runs into November",
  );
  assert.deepEqual(
    fieldWeeksOfMonth("2026-09-01"),
    ["2026-09-05", "2026-09-12", "2026-09-19", "2026-09-26"],
    "September's last week (Sat Sep 26, running into Oct 1) stays in September; Oct 3's week is October's, not counted twice",
  );
  assert.ok(!fieldWeeksOfMonth("2026-09-01").includes("2026-10-03"), "a Saturday in October is never a September week");
  assert.equal(monthStartOf("2026-10-31"), "2026-10-01");
  assert.deepEqual(plannableMonths("2026-10-30").length >= 1, true, "the current month is always plannable");

  // ── Deviation vs the grade norm: over is allowed and shown, never blocked ───────────────────────
  {
    const over = tally("pm-b-over", "PM", "B", 3);
    assert.equal(over.required, 2, "PM grade B needs 2 a month");
    assert.equal(over.deviation, 1, "placed 3 is +1 over the norm — a deviation");
    assert.equal(over.done, true, "over the norm still counts as done");

    const behind = tally("pm-c-behind", "PM", "C", 0);
    assert.equal(behind.required, 1);
    assert.equal(behind.deviation, -1, "behind is a negative deviation");
    assert.equal(behind.done, false);

    const exact = tally("am-a-exact", "AM", "A", 1);
    assert.deepEqual([exact.required, exact.deviation, exact.done], [1, 0, true], "AM grade A needs 1; placed 1 is exactly done");

    const noNorm = tally("am-b-nonorm", "AM", "B", 2);
    assert.deepEqual([noNorm.required, noNorm.deviation], [null, null], "AM grades B and C have no norm, so no deviation");
    assert.equal(noNorm.done, true, "a customer with no norm is done once placed at least once");
    assert.equal(tally("am-b-empty", "AM", "B", 0).done, false, "and not done while never placed");
  }

  // ── The meters keep AM and PM apart, and never add them together ────────────────────────────────
  {
    const tallies = [
      tally("pm-1", "PM", "A", 4), // norm 3 → over
      tally("pm-2", "PM", "B", 1), // norm 2 → behind
      tally("pm-3", "PM", "C", 0), // norm 1 → behind, uncovered
      tally("am-1", "AM", "A", 2), // norm 1 → over
      tally("am-2", "AM", "B", 0), // no norm, uncovered
    ];
    const pm = summarizeMonthlyList(tallies, "PM");
    assert.equal(pm.panel, 3, "three PM on the panel");
    assert.equal(pm.placements, 5, "4 + 1 + 0 dated placements");
    assert.equal(pm.covered, 2, "two PM placed at least once");
    assert.equal(pm.withNorm, 3, "all three PM carry a grade norm");
    assert.equal(pm.metNorm, 1, "only pm-1 is at or over its norm");
    assert.equal(pm.overNorm, 1, "pm-1 is over — a deviation, shown");
    assert.equal(pm.underNorm, 2);

    const am = summarizeMonthlyList(tallies, "AM");
    assert.equal(am.panel, 2, "AM is counted on its own, never folded into PM");
    assert.equal(am.placements, 2);
    assert.equal(am.withNorm, 1, "only AM grade A has a norm");
    assert.equal(am.overNorm, 1, "am-1 placed 2 against a norm of 1");
    assert.equal(am.covered, 1);
  }

  // ── The call rate: the month's Saturday-to-Wednesday working days, AM vs 2 and PM vs 10 ─────────
  {
    // Re-derive the working-day count from the COMPANY weekday set, which proves the phone module's
    // copied set (monthly-plan-rules CALL_RATE_WEEKDAYS) equals src/lib/crm/call-rate.ts's.
    const month = "2026-10-01";
    let expected = 0;
    for (let day = monthStartOf(month); day <= monthEndOf(month); day = addDaysIso(day, 1)) {
      if (CALL_RATE_WEEKDAYS.has(weekdayOfIsoDay(day))) expected += 1;
    }
    const workingDays = callRateWorkingDaysOfMonth(month);
    assert.equal(workingDays, expected, "the monthly plan's working-day set is the company call-rate set — kept equal, not imported");
    assert.equal(workingDays, 21, "October 2026 has 21 Saturday-to-Wednesday days");

    const rate = monthlyCallRate({ monthStart: month, amPlacements: 42, pmPlacements: 210 }, SETTINGS);
    assert.equal(rate.amPerDay, 2, "42 AM over 21 days is 2.0 a day");
    assert.equal(rate.pmPerDay, 10, "210 PM over 21 days is 10.0 a day");
    assert.deepEqual([rate.amTarget, rate.pmTarget], [2, 10], "the targets come from settings, AM and PM apart");
    assert.deepEqual([rate.amExpected, rate.pmExpected], [42, 210], "expected placements are target × working days");
    // There is no combined 'per day' anywhere — the two are only ever reported apart.
    assert.equal(Object.keys(rate).some((key) => /combined|average|avg|total/i.test(key)), false, "no averaged or combined call-rate field exists");

    const rounded = monthlyCallRate({ monthStart: month, amPlacements: 31, pmPlacements: 0 }, SETTINGS);
    assert.equal(rounded.amPerDay, 1.5, "31 over 21 is 1.476, rounded to one decimal");
    assert.equal(rounded.pmPerDay, 0);
  }

  // ── Status labels and editability ───────────────────────────────────────────────────────────────
  assert.equal(monthlyPlanStatusLabel(null), "Not started");
  assert.equal(monthlyPlanStatusLabel("submitted"), "Waiting for review");
  assert.equal(monthlyPlanStatusLabel("approved"), "Approved");
  assert.equal(monthlyPlanStatusLabel("returned"), "Returned for changes");
  assert.equal(isMonthlyPlanEditable(null), true, "a month not started yet is editable");
  assert.equal(isMonthlyPlanEditable("draft"), true);
  assert.equal(isMonthlyPlanEditable("returned"), true, "a returned month is edited, then sent again");
  assert.equal(isMonthlyPlanEditable("submitted"), false, "a submitted or approved month is reopened first");
  assert.equal(isMonthlyPlanEditable("approved"), false);

  // ── The copied call-rate targets equal the company standard ─────────────────────────────────────
  assert.equal(SETTINGS.callRateAmTarget, AM_CALL_RATE_TARGET, "the phone's AM call-rate target is the company's 2, copied not imported");
  assert.equal(SETTINGS.callRatePmTarget, PM_CALL_RATE_TARGET, "the phone's PM call-rate target is the company's 10");
}
