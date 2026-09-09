import assert from "node:assert/strict";

import {
  isAttendanceDeductionCancelled,
  type DeductionCancelFacts,
} from "../src/lib/attendance/digest-reconcile.ts";
import {
  evaluateFlexibleHoursDay,
  halfDayEffectiveStartMinutes,
  requiredMinutesForHalfDayVacation,
} from "../src/lib/attendance/flexible-hours.ts";

const NO_COVER: DeductionCancelFacts = {
  halfDayVacationPart: null,
  hasApprovedException: false,
  hasApprovedExcuse: false,
  hasApprovedLeave: false,
  hasCrmFieldVisit: false,
  hasCrmLeave: false,
};

export function runAttendanceDeductionCancelRuleTests() {
  // ---------------------------------------------------------------------------
  // The cancel rule. Every case below is a real August 2026 production day the
  // fingerprint connector turned into a live deduction candidate before this
  // fix — 5 of them, 2,709.57 EGP, all still Pending only because a deductions
  // month is never auto-published.
  // ---------------------------------------------------------------------------
  assert.equal(
    isAttendanceDeductionCancelled({ ...NO_COVER, hasApprovedLeave: true }),
    true,
    "a FULL-day approved leave cancels the charge — A-1 on 2026-08-04 and A-2 on 2026-08-11 were each charged 0.5 day while on approved leave",
  );
  assert.equal(
    isAttendanceDeductionCancelled({ ...NO_COVER, hasCrmLeave: true }),
    true,
    "a CRM-recorded leave cancels the charge — A-1 on 2026-08-26 was charged 0.5 day against a CRM Annual Vacation",
  );
  assert.equal(
    isAttendanceDeductionCancelled({ ...NO_COVER, hasCrmFieldVisit: true }),
    true,
    "a real CRM field visit cancels the charge — B-155 on 2026-08-11 was charged 419.35 EGP on a day he logged CRM Traveling back from Minya, and A-12 on 2026-08-24 was charged 1,451.61 EGP on a logged Campaign meeting",
  );

  // The two cancels that already worked — pinned so the rewrite cannot lose them.
  assert.equal(
    isAttendanceDeductionCancelled({ ...NO_COVER, hasApprovedException: true }),
    true,
    "an approved exception still cancels — this was the original behaviour and must survive",
  );
  assert.equal(
    isAttendanceDeductionCancelled({ ...NO_COVER, hasApprovedExcuse: true }),
    true,
    "an approved excuse still cancels — restored once already after it charged 1,666.66 EGP in July 2026",
  );

  // The owner's ruling: a half-day is judged, never cancelled.
  assert.equal(
    isAttendanceDeductionCancelled({ ...NO_COVER, hasApprovedLeave: true, halfDayVacationPart: "am_only" }),
    false,
    "an AM-only vacation does NOT cancel — the employee still owes the afternoon (owner 2026-09-08: judge the worked half)",
  );
  assert.equal(
    isAttendanceDeductionCancelled({ ...NO_COVER, hasApprovedLeave: true, halfDayVacationPart: "pm_only" }),
    false,
    "a PM-only vacation does NOT cancel — the employee still owes the morning",
  );
  assert.equal(
    isAttendanceDeductionCancelled(NO_COVER),
    false,
    "with nothing covering the day the charge stands — the rule must not fail open into cancelling everything",
  );

  // ---------------------------------------------------------------------------
  // Judging the worked half. An AM-only vacation moves the obligation to the
  // afternoon, so lateness is measured from where that half begins.
  // ---------------------------------------------------------------------------
  const SCHEDULED_START = 9 * 60; // 09:00
  const FLEX = 30;
  const REQUIRED_FULL = 480;
  const REQUIRED_HALF = requiredMinutesForHalfDayVacation(REQUIRED_FULL, "am_only");
  assert.equal(REQUIRED_HALF, 240, "half of an 8-hour requirement is 4 hours");

  assert.equal(
    halfDayEffectiveStartMinutes(SCHEDULED_START, REQUIRED_HALF, "am_only"),
    13 * 60,
    "the worked half of a 09:00 shift with an AM-only vacation opens at 13:00, not 09:00",
  );
  assert.equal(
    halfDayEffectiveStartMinutes(SCHEDULED_START, REQUIRED_HALF, "pm_only"),
    SCHEDULED_START,
    "a PM-only vacation keeps the normal start — the morning is still owed",
  );
  assert.equal(
    halfDayEffectiveStartMinutes(SCHEDULED_START, REQUIRED_FULL, null),
    SCHEDULED_START,
    "an ordinary day is untouched",
  );

  const lateBrackets = [{ fromMinutes: 1, toMinutes: null, deductionDays: 0.5 }];
  const shortBrackets = [{ fromMinutes: 1, toMinutes: null, deductionDays: 0.5 }];

  // A-7, 2026-08-02: approved AM-only vacation, punched 10:56 -> 17:00.
  // Judged against the 09:00 start he was excused from, this produced exactly the
  // 86 late minutes and 0.25-day charge (177.42 EGP) that reached production.
  const beforeFix = evaluateFlexibleHoursDay({
    config: {
      scheduledStartMinutes: SCHEDULED_START,
      flexCeilingMinutes: SCHEDULED_START + FLEX,
      requiredMinutes: REQUIRED_HALF,
    },
    firstPunchMinutes: 10 * 60 + 56,
    lastPunchMinutes: 17 * 60,
    lateBrackets,
    shortBrackets,
    visiblePunchCount: 2,
  });
  assert.equal(beforeFix.lateMinutes, 86, "reproduces the production defect: 86 minutes late against a morning he had off");
  assert.equal(beforeFix.deductionDays, 0.25, "reproduces the production charge of 0.25 day (177.42 EGP)");

  const afterFix = evaluateFlexibleHoursDay({
    config: {
      scheduledStartMinutes: halfDayEffectiveStartMinutes(SCHEDULED_START, REQUIRED_HALF, "am_only"),
      flexCeilingMinutes: halfDayEffectiveStartMinutes(SCHEDULED_START, REQUIRED_HALF, "am_only") + FLEX,
      requiredMinutes: REQUIRED_HALF,
    },
    firstPunchMinutes: 10 * 60 + 56,
    lastPunchMinutes: 17 * 60,
    lateBrackets,
    shortBrackets,
    visiblePunchCount: 2,
  });
  assert.equal(afterFix.lateMinutes, 0, "arriving 10:56 for a half that opens at 13:00 is not late at all");
  assert.equal(afterFix.deductionDays, 0, "A-7's 0.25-day charge on 2026-08-02 disappears once the worked half is what is judged");
  assert.equal(afterFix.hoursCompleted, true, "he worked 6h04 against a 4h requirement — the hours were always complete");

  // A-9, 2026-08-02: same approved AM-only vacation, punched 12:54 -> 17:12,
  // charged 204 minutes late and 0.25 day (387.10 EGP).
  const colleagueAfterFix = evaluateFlexibleHoursDay({
    config: {
      scheduledStartMinutes: halfDayEffectiveStartMinutes(SCHEDULED_START, REQUIRED_HALF, "am_only"),
      flexCeilingMinutes: halfDayEffectiveStartMinutes(SCHEDULED_START, REQUIRED_HALF, "am_only") + FLEX,
      requiredMinutes: REQUIRED_HALF,
    },
    firstPunchMinutes: 12 * 60 + 54,
    lastPunchMinutes: 17 * 60 + 12,
    lateBrackets,
    shortBrackets,
    visiblePunchCount: 2,
  });
  assert.equal(colleagueAfterFix.deductionDays, 0, "A-9's 0.25-day charge on 2026-08-02 disappears the same way");

  // The half still has to be worked — the ruling is "judge it", not "waive it".
  const shirkedHalf = evaluateFlexibleHoursDay({
    config: {
      scheduledStartMinutes: halfDayEffectiveStartMinutes(SCHEDULED_START, REQUIRED_HALF, "am_only"),
      flexCeilingMinutes: halfDayEffectiveStartMinutes(SCHEDULED_START, REQUIRED_HALF, "am_only") + FLEX,
      requiredMinutes: REQUIRED_HALF,
    },
    firstPunchMinutes: 15 * 60,
    lastPunchMinutes: 16 * 60,
    lateBrackets,
    shortBrackets,
    visiblePunchCount: 2,
  });
  assert.ok(
    shirkedHalf.deductionDays > 0,
    "someone who takes the morning off and then works only one hour of the afternoon is still charged — judging the worked half is not waiving it",
  );
}
