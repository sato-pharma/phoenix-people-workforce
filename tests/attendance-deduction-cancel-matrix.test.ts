import assert from "node:assert/strict";

import {
  isAttendanceDeductionCancelled,
  type DeductionCancelFacts,
} from "../src/lib/attendance/digest-reconcile.ts";
import {
  evaluateFlexibleHoursDay,
  halfDayEffectiveStartMinutes,
  halfDayEffectiveWindowMinutes,
  requiredMinutesForHalfDayVacation,
} from "../src/lib/attendance/flexible-hours.ts";
import { resolvePolicyAttendanceStatus } from "../src/lib/attendance/metrics.ts";

type HalfDay = "am_only" | "pm_only" | null;

/**
 * The cancel policy written as an ordered precedence chain, in the words the two
 * source documents use, rather than as the implementation's boolean expression.
 *
 *   digest-reconcile.ts — an approved exception, an approved excuse, an approved
 *     full-day leave, a CRM-recorded leave and a real CRM field visit are all
 *     universal cancels.
 *   Owner decision 2026-09-08 — a HALF-day vacation is judged on the worked half,
 *     so it is not a cancel; the other half is still owed.
 *
 * Deliberately shaped differently from the code under test: if a refactor ever
 * reorders or inverts a branch, the exhaustive sweep below catches it rather than
 * both sides drifting together.
 */
function policyReference(facts: DeductionCancelFacts): boolean {
  if (facts.hasApprovedException) return true;
  if (facts.hasApprovedExcuse) return true;
  if (facts.hasCrmLeave) return true;
  if (facts.hasCrmFieldVisit) return true;
  if (facts.hasApprovedLeave) return facts.halfDayVacationPart === null;
  return false;
}

/** One day of real production evidence, taken from the database, not from a display label. */
type Fixture = {
  key: string;
  halfDay: HalfDay;
  leave: boolean;
  excuse: boolean;
  crmLeave: boolean;
  crmField: boolean;
  cancelled: boolean;
};

/**
 * Every day the 2026-09-08 fix changed (22), plus an evenly spread control sample
 * of days it deliberately left charged (24), across April–August 2026.
 *
 * The five flags come from v2_vacation_requests, v2_excuse_requests and
 * ireports360_visits directly — NOT from the report's own label columns, which
 * collapse an approved vacation and a CRM leave into one string and would have
 * encoded B-185's 09 July as uncovered when the database says otherwise.
 */
const PRODUCTION_DAYS: Fixture[] = [
  { key: "A-8:2026-05-17", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: true, cancelled: true },
  { key: "A-7:2026-06-17", halfDay: null, leave: true, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "A-9:2026-06-03", halfDay: null, leave: true, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "A-9:2026-06-09", halfDay: null, leave: true, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "A-9:2026-06-21", halfDay: null, leave: true, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "B-122:2026-06-28", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: true, cancelled: true },
  { key: "B-155:2026-06-16", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: true, cancelled: true },
  { key: "B-155:2026-06-23", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: true, cancelled: true },
  { key: "A-1:2026-07-12", halfDay: null, leave: true, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "A-2:2026-07-12", halfDay: null, leave: true, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "B-155:2026-07-13", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: true, cancelled: true },
  { key: "B-155:2026-07-19", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: true, cancelled: true },
  { key: "B-155:2026-07-27", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: true, cancelled: true },
  { key: "B-185:2026-07-09", halfDay: "pm_only", leave: true, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "B-185:2026-07-14", halfDay: null, leave: true, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "A-1:2026-08-04", halfDay: null, leave: true, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "A-1:2026-08-26", halfDay: null, leave: false, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "A-12:2026-08-24", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: true, cancelled: true },
  { key: "A-2:2026-08-11", halfDay: null, leave: true, excuse: false, crmLeave: true, crmField: false, cancelled: true },
  { key: "A-7:2026-08-02", halfDay: "am_only", leave: true, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-9:2026-08-02", halfDay: "am_only", leave: true, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "B-155:2026-08-11", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: true, cancelled: true },
  { key: "A-3:2026-05-18", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-10:2026-06-25", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-3:2026-06-29", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-9:2026-06-22", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "B-10:2026-06-23", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "B-157:2026-06-25", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "B-185:2026-06-23", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "OF-0001:2026-06-21", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-10:2026-07-01", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-10:2026-07-22", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-16:2026-07-16", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-9:2026-07-13", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "B-122:2026-07-05", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "B-122:2026-07-29", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "B-185:2026-07-08", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "OF-0001:2026-07-30", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-1:2026-08-12", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-10:2026-08-09", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-12:2026-08-03", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-8:2026-08-02", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "A-9:2026-08-20", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "B-10:2026-08-17", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "B-185:2026-08-12", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
  { key: "B-185:2026-08-31", halfDay: null, leave: false, excuse: false, crmLeave: false, crmField: false, cancelled: false },
];

const factsFor = (f: Fixture): DeductionCancelFacts => ({
  halfDayVacationPart: f.halfDay,
  hasApprovedException: false,
  hasApprovedExcuse: f.excuse,
  hasApprovedLeave: f.leave,
  hasCrmFieldVisit: f.crmField,
  hasCrmLeave: f.crmLeave,
});

export function runAttendanceDeductionCancelMatrixTests() {
  let cases = 0;

  // --- GROUP A: exhaustive truth table, 16 flag combinations x 3 half-day states ---
  const bools = [false, true];
  const halves: HalfDay[] = [null, "am_only", "pm_only"];
  for (const hasApprovedException of bools) {
    for (const hasApprovedExcuse of bools) {
      for (const hasApprovedLeave of bools) {
        for (const hasCrmLeave of bools) {
          for (const hasCrmFieldVisit of bools) {
            for (const halfDayVacationPart of halves) {
              const facts: DeductionCancelFacts = {
                halfDayVacationPart,
                hasApprovedException,
                hasApprovedExcuse,
                hasApprovedLeave,
                hasCrmFieldVisit,
                hasCrmLeave,
              };
              cases++;
              assert.equal(
                isAttendanceDeductionCancelled(facts),
                policyReference(facts),
                `cancel rule disagrees with the written policy for ${JSON.stringify(facts)}`,
              );
            }
          }
        }
      }
    }
  }
  assert.equal(cases, 96, "the sweep must cover all 96 combinations — a smaller number means a loop stopped early");

  // The single most costly combination, called out by name so a failure reads plainly.
  cases++;
  assert.equal(
    isAttendanceDeductionCancelled({
      halfDayVacationPart: null,
      hasApprovedException: false,
      hasApprovedExcuse: false,
      hasApprovedLeave: true,
      hasCrmFieldVisit: false,
      hasCrmLeave: false,
    }),
    true,
    "a full-day approved leave and nothing else must cancel — this alone was 9 of the 22 wrong days",
  );

  // --- GROUP B: where the worked half begins ---
  const b: Array<[number, number, HalfDay, number, string]> = [
    [540, 240, "am_only", 780, "09:00 shift, 4h half -> the afternoon opens at 13:00"],
    [540, 240, "pm_only", 540, "PM-only keeps the 09:00 start: the morning is still owed"],
    [540, 480, null, 540, "an ordinary day is never shifted"],
    [540, 0, "am_only", 540, "a zero-minute half cannot move the start"],
    [0, 240, "am_only", 240, "a midnight-start shift still adds the half"],
    [480, 235, "am_only", 715, "an odd requirement (470 -> 235) shifts by the rounded half, not a truncated one"],
    [540, 1, "am_only", 541, "a one-minute half shifts by exactly one minute"],
    [600, 210, "am_only", 810, "10:00 shift with a 3.5h half opens at 13:30"],
    [540, 720, "am_only", 1260, "a long half can push the window late in the day without wrapping"],
    [540, 240, null, 540, "null half-day with a halved requirement still does not shift"],
  ];
  for (const [start, half, part, expected, why] of b) {
    cases++;
    assert.equal(halfDayEffectiveStartMinutes(start, half, part), expected, why);
  }

  // The two helpers must compose the way statusFromFlexibleHours composes them.
  for (const [full, part, expectedHalf] of [
    [480, "am_only", 240],
    [470, "am_only", 235],
    [471, "pm_only", 236],
    [480, null, 480],
  ] as Array<[number, HalfDay, number]>) {
    cases++;
    assert.equal(
      requiredMinutesForHalfDayVacation(full, part),
      expectedHalf,
      `the halved requirement for ${full} min / ${part} must round, never truncate`,
    );
  }

  // --- GROUP C: every production day the fix touched, plus controls ---
  assert.equal(PRODUCTION_DAYS.length, 46, "the production corpus must stay at 46 days — 22 changed, 24 controls");
  for (const day of PRODUCTION_DAYS) {
    cases++;
    assert.equal(
      isAttendanceDeductionCancelled(factsFor(day)),
      day.cancelled,
      `${day.key}: the rule must reach the same verdict production reached after the fix`,
    );
    cases++;
    assert.equal(
      policyReference(factsFor(day)),
      day.cancelled,
      `${day.key}: the written policy must reach that verdict too, independently of the implementation`,
    );
  }
  assert.equal(
    PRODUCTION_DAYS.filter((d) => d.cancelled).length,
    20,
    "20 of the 46 are cancelled by the rule; the other 2 changed days went to zero through the worked-half judgment, not a cancel",
  );

  // --- GROUP D: the engine, judging the worked half ---
  const START = 540;
  const FLEX = 30;
  const HALF = 240;
  const SHIFTED = halfDayEffectiveStartMinutes(START, HALF, "am_only");
  const brackets = [{ fromMinutes: 1, toMinutes: null, deductionDays: 0.5 }];
  const judge = (first: number, last: number, startMinutes: number, punches = 2) =>
    evaluateFlexibleHoursDay({
      config: { scheduledStartMinutes: startMinutes, flexCeilingMinutes: startMinutes + FLEX, requiredMinutes: HALF },
      firstPunchMinutes: first,
      lastPunchMinutes: last,
      lateBrackets: brackets,
      shortBrackets: brackets,
      visiblePunchCount: punches,
    });

  const d: Array<[string, () => void]> = [
    ["arriving exactly at the shifted ceiling is not late", () => {
      assert.equal(judge(SHIFTED + FLEX, SHIFTED + FLEX + HALF, SHIFTED).lateMinutes, 0);
    }],
    ["one minute past the shifted ceiling is one minute late", () => {
      assert.equal(judge(SHIFTED + FLEX + 1, SHIFTED + FLEX + 1 + HALF, SHIFTED).lateMinutes, 1);
    }],
    ["A-7's real 10:56 arrival is not late once the window shifts", () => {
      assert.equal(judge(656, 1020, SHIFTED).deductionDays, 0);
    }],
    ["A-7's real day WAS charged 0.25 against the unshifted window", () => {
      assert.equal(judge(656, 1020, START).deductionDays, 0.25);
    }],
    ["A-9's real 12:54 arrival is not late once the window shifts", () => {
      assert.equal(judge(774, 1032, SHIFTED).deductionDays, 0);
    }],
    ["A-9's real day WAS charged 0.25 against the unshifted window", () => {
      assert.equal(judge(774, 1032, START).deductionDays, 0.25);
    }],
    ["working the full half exactly meets the requirement", () => {
      assert.equal(judge(SHIFTED, SHIFTED + HALF, SHIFTED).hoursCompleted, true);
    }],
    ["one minute short of the half is short, not complete", () => {
      assert.equal(judge(SHIFTED, SHIFTED + HALF - 1, SHIFTED).shortMinutes, 1);
    }],
    ["taking the morning off and working one hour is still charged", () => {
      assert.ok(judge(900, 960, SHIFTED).deductionDays > 0);
    }],
    ["a single punch on a half day is a missing punch, never a deduction", () => {
      assert.equal(judge(SHIFTED, SHIFTED, SHIFTED, 1).deductionDays, 0);
    }],
    ["late AND short on the half takes the worse of the two, unhalved", () => {
      const r = judge(SHIFTED + 120, SHIFTED + 120 + 60, SHIFTED);
      assert.equal(r.halved, false);
      assert.ok(r.deductionDays > 0);
    }],
    ["late but hours completed on the half is halved", () => {
      const r = judge(SHIFTED + 120, SHIFTED + 120 + HALF, SHIFTED);
      assert.equal(r.halved, true);
      assert.equal(r.deductionDays, 0.25);
    }],
  ];
  for (const [why, run] of d) {
    cases++;
    try {
      run();
    } catch (error) {
      throw new Error(`${why}: ${(error as Error).message}`);
    }
  }

  // --- GROUP E: the LEGACY grace-period engine, judging the worked half ---
  //
  // The two policy groups with no `required_minutes` route through
  // resolvePolicyAttendanceStatus rather than the flexible-hours engine, and it was
  // never told about half-day vacations at all. It also measures EARLY LEAVE against
  // scheduled_end, which the flexible engine has no concept of — so Pm-Only broke
  // here in the mirror image of Am-Only: work the morning, leave at the agreed
  // midpoint, and be charged for the afternoon you had approved off.
  const legacyPolicy = {
    effective_from: "2026-01-01",
    effective_to: null,
    grace_minutes: 10,
    is_active: true,
    scheduled_end: "17:00",
    scheduled_start: "09:00",
    target_type: "default",
    target_value: null,
  };
  const legacy = (first: number, last: number, duration: number, part: HalfDay) =>
    resolvePolicyAttendanceStatus({
      baseSalary: 15000,
      durationMinutes: duration,
      firstPunchMinutes: first,
      halfDayVacationPart: part,
      lastPunchMinutes: last,
      policy: legacyPolicy,
      reportDate: "2026-08-10",
      rules: [],
      visiblePunchCount: 2,
    });

  const e: Array<[string, () => void]> = [
    ["AM-only: arriving 13:00 and working the afternoon is Complete, not Late", () => {
      assert.equal(legacy(780, 1020, 240, "am_only").status, "Complete");
    }],
    ["AM-only: that same day WAS charged when judged against the full schedule", () => {
      assert.notEqual(legacy(780, 1020, 240, null).status, "Complete");
    }],
    ["PM-only: working 09:00-13:00 and leaving is Complete, not Early leave", () => {
      assert.equal(legacy(540, 780, 240, "pm_only").status, "Complete");
    }],
    ["PM-only: that same day WAS charged for early leave against the full schedule", () => {
      assert.equal(legacy(540, 780, 240, null).status, "Early leave");
    }],
    ["AM-only: arriving 13:05 is inside the 10-minute grace", () => {
      assert.equal(legacy(785, 1020, 235, "am_only").status, "Complete");
    }],
    ["AM-only: arriving 14:00 is still charged", () => {
      assert.notEqual(legacy(840, 1020, 180, "am_only").status, "Complete");
    }],
    ["PM-only: leaving at 11:00 skips half the owed morning and is still charged", () => {
      assert.notEqual(legacy(540, 660, 120, "pm_only").status, "Complete");
    }],
    ["a whole ordinary day is judged exactly as before", () => {
      assert.equal(legacy(540, 1020, 480, null).status, "Complete");
    }],
    ["omitting the field entirely still judges a whole day", () => {
      const result = resolvePolicyAttendanceStatus({
        baseSalary: 15000,
        durationMinutes: 240,
        firstPunchMinutes: 540,
        lastPunchMinutes: 780,
        policy: legacyPolicy,
        reportDate: "2026-08-10",
        rules: [],
        visiblePunchCount: 2,
      });
      assert.equal(
        result.status,
        "Early leave",
        "the explainer and policy-preview callers pass no half-day and must be unaffected",
      );
    }],
  ];
  for (const [why, run] of e) {
    cases++;
    try {
      run();
    } catch (error) {
      throw new Error(`${why}: ${(error as Error).message}`);
    }
  }

  // The window helper itself, both ends.
  const w: Array<[HalfDay, number, number, string]> = [
    ["am_only", 780, 1020, "AM-only opens the window at the midpoint and keeps the scheduled end"],
    ["pm_only", 540, 780, "PM-only keeps the scheduled start and closes the window at the midpoint"],
    [null, 540, 1020, "an ordinary day keeps both ends"],
  ];
  for (const [part, expectedStart, expectedEnd, why] of w) {
    cases++;
    assert.deepEqual(
      halfDayEffectiveWindowMinutes({
        halfDayVacationPart: part,
        halfRequiredMinutes: 240,
        scheduledEndMinutes: 1020,
        scheduledStartMinutes: 540,
      }),
      { startMinutes: expectedStart, endMinutes: expectedEnd },
      why,
    );
  }

  assert.ok(cases >= 150, `expected at least 150 cases, ran ${cases}`);
}
