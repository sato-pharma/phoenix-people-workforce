import { strict as assert } from "node:assert";

import {
  bracketDeductionDays,
  evaluateFlexibleHoursDay,
  requiredMinutesForHalfDayVacation,
  type DeductionBracket,
  type FlexibleHoursConfig,
} from "../src/lib/attendance/flexible-hours.ts";

// Standard config from the confirmed spec: 09:00 start, 09:30 flex ceiling, 7h50m required.
const CONFIG: FlexibleHoursConfig = {
  scheduledStartMinutes: 9 * 60, // 540
  flexCeilingMinutes: 9 * 60 + 30, // 570
  requiredMinutes: 7 * 60 + 50, // 470
};

// Brackets chosen to reproduce the owner's worked examples exactly.
const LATE_BRACKETS: DeductionBracket[] = [
  { fromMinutes: 1, toMinutes: 15, deductionDays: 0.25 },
  { fromMinutes: 16, toMinutes: 30, deductionDays: 0.5 },
  { fromMinutes: 31, toMinutes: 45, deductionDays: 0.75 },
  { fromMinutes: 46, toMinutes: null, deductionDays: 1 },
];
const SHORT_BRACKETS: DeductionBracket[] = [
  { fromMinutes: 1, toMinutes: 15, deductionDays: 0.25 },
  { fromMinutes: 16, toMinutes: 30, deductionDays: 0.25 },
  { fromMinutes: 31, toMinutes: 45, deductionDays: 0.5 },
  { fromMinutes: 46, toMinutes: null, deductionDays: 1 },
];

function evaluate(firstPunchMinutes: number | null, lastPunchMinutes: number | null, visiblePunchCount = 2) {
  return evaluateFlexibleHoursDay({
    firstPunchMinutes,
    lastPunchMinutes,
    visiblePunchCount,
    config: CONFIG,
    lateBrackets: LATE_BRACKETS,
    shortBrackets: SHORT_BRACKETS,
  });
}

const at = (h: number, m: number) => h * 60 + m;

export function runAttendanceFlexibleHoursTests() {
  // --- bracketDeductionDays ---
  assert.equal(bracketDeductionDays(LATE_BRACKETS, 0), 0, "zero minutes → no deduction");
  assert.equal(bracketDeductionDays(LATE_BRACKETS, -5), 0, "negative minutes → no deduction");
  assert.equal(bracketDeductionDays(LATE_BRACKETS, 15), 0.25, "inclusive upper bound of a bracket");
  assert.equal(bracketDeductionDays(LATE_BRACKETS, 16), 0.5, "inclusive lower bound of next bracket");
  assert.equal(bracketDeductionDays(LATE_BRACKETS, 999), 1, "open-ended top bracket");
  // Dead-zone: brackets that only start at 16 leave 1–15 uncovered → 0.
  const gapBrackets: DeductionBracket[] = [{ fromMinutes: 16, toMinutes: null, deductionDays: 1 }];
  assert.equal(bracketDeductionDays(gapBrackets, 10), 0, "minutes below the first bracket are a dead zone → 0");

  // --- The five confirmed worked examples ---
  // 1. 9:15 → 17:05 : 7h50m, on time, full hours → None.
  const r1 = evaluate(at(9, 15), at(17, 5));
  assert.equal(r1.status, "Complete");
  assert.equal(r1.deductionDays, 0);

  // 2. 9:30 → 17:20 : exactly at the flex ceiling, exactly 7h50m → None.
  const r2 = evaluate(at(9, 30), at(17, 20));
  assert.equal(r2.status, "Complete");
  assert.equal(r2.lateMinutes, 0, "arrival exactly at 9:30 is not late");
  assert.equal(r2.deductionDays, 0);

  // 3. 10:00 → 17:50 : 30 min late BUT completed the hours → half-day halved to quarter-day.
  const r3 = evaluate(at(10, 0), at(17, 50));
  assert.equal(r3.status, "Late");
  assert.equal(r3.lateMinutes, 30);
  assert.equal(r3.hoursCompleted, true);
  assert.equal(r3.halved, true);
  assert.equal(r3.deductionDays, 0.25, "half-day (0.5) halved because hours completed → 0.25");

  // 4. 10:00 → 17:00 : 30 min late AND ~50 min short → worse of the two = full day.
  const r4 = evaluate(at(10, 0), at(17, 0));
  assert.equal(r4.status, "Short hours");
  assert.equal(r4.lateMinutes, 30);
  assert.equal(r4.shortMinutes, 50);
  assert.equal(r4.halved, false, "no halving when hours were not completed");
  assert.equal(r4.deductionDays, 1, "short-hours penalty (1.0) is worse than late (0.5) → 1.0");

  // 5. 9:20 → 16:50 : within flex, but 20 min short → quarter-day.
  const r5 = evaluate(at(9, 20), at(16, 50));
  assert.equal(r5.status, "Short hours");
  assert.equal(r5.lateMinutes, 0);
  assert.equal(r5.shortMinutes, 20);
  assert.equal(r5.deductionDays, 0.25);

  // --- Missing punch: never auto-deducted, routed to verification ---
  const miss = evaluate(at(10, 0), null, 1);
  assert.equal(miss.status, "Missing punch");
  assert.equal(miss.deductionDays, 0, "a missing punch is never auto-deducted");

  // --- Halving is exact ÷2 across brackets ---
  const lateFull = evaluate(at(10, 20), at(18, 10)); // 50 min late, 470 worked → full-day halved
  assert.equal(lateFull.status, "Late");
  assert.equal(lateFull.hoursCompleted, true);
  assert.equal(lateFull.deductionDays, 0.5, "full-day (1.0) halved because hours completed → 0.5");

  // --- One minute past the flex ceiling is late ---
  const oneMinLate = evaluate(at(9, 31), at(17, 21));
  assert.equal(oneMinLate.lateMinutes, 1);
  assert.equal(oneMinLate.status, "Late");
  assert.equal(oneMinLate.deductionDays, 0.125, "1 min late (0.25) halved because hours completed → 0.125");

  // --- Worse-of-two ties resolve to short-hours ---
  const tieShort: DeductionBracket[] = [{ fromMinutes: 1, toMinutes: null, deductionDays: 0.5 }];
  const tie = evaluateFlexibleHoursDay({
    firstPunchMinutes: at(10, 0), // 30 late → late bracket 0.5
    lastPunchMinutes: at(17, 30), // worked 450 → 20 short → short bracket 0.5
    visiblePunchCount: 2,
    config: CONFIG,
    lateBrackets: LATE_BRACKETS,
    shortBrackets: tieShort,
  });
  assert.equal(tie.deductionDays, 0.5);
  assert.equal(tie.status, "Short hours", "on a tie, the short-hours classification wins");

  // --- requiredMinutesForHalfDayVacation: an approved half-day vacation halves
  // the required presence instead of judging against the full scheduled day ---
  assert.equal(requiredMinutesForHalfDayVacation(470, null), 470, "no half-day vacation leaves the full requirement untouched");
  assert.equal(requiredMinutesForHalfDayVacation(470, "pm_only"), 235, "a Pm-Only vacation halves the required presence (470 -> 235)");
  assert.equal(requiredMinutesForHalfDayVacation(470, "am_only"), 235, "an Am-Only vacation halves the required presence the same way");
  assert.equal(requiredMinutesForHalfDayVacation(471, "pm_only"), 236, "an odd requirement rounds rather than silently truncating");

  // --- Reproduces the reported July 2026 false positive: a Pm-Only vacation with
  // a complete AM punch must read Complete, not "Short day" against the full day ---
  const halfDayConfig: FlexibleHoursConfig = {
    ...CONFIG,
    requiredMinutes: requiredMinutesForHalfDayVacation(CONFIG.requiredMinutes, "pm_only"),
  };
  const pmVacationMorningPunch = evaluateFlexibleHoursDay({
    firstPunchMinutes: at(8, 50),
    lastPunchMinutes: at(13, 0),
    visiblePunchCount: 2,
    config: halfDayConfig,
    lateBrackets: LATE_BRACKETS,
    shortBrackets: SHORT_BRACKETS,
  });
  assert.equal(pmVacationMorningPunch.status, "Complete", "a Pm-Only vacation plus a full morning punch must not be judged short against the full day");
  assert.equal(pmVacationMorningPunch.deductionDays, 0, "no deduction once the required window accounts for the approved half-day vacation");

  // Without the half-day adjustment, the SAME punch reproduces the original bug —
  // confirms the fix is actually load-bearing, not a no-op.
  const withoutAdjustment = evaluate(at(8, 50), at(13, 0));
  assert.equal(withoutAdjustment.status, "Short hours", "sanity check: judging the same punch against the full day is exactly the false positive being fixed");
}
