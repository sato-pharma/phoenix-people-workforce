import assert from "node:assert/strict";

import { reconcileDay, type ReconcileInput } from "../src/lib/attendance/digest-reconcile.ts";
import { evaluateFlexibleHoursDay, type FlexibleHoursConfig } from "../src/lib/attendance/flexible-hours.ts";

// The day-by-day report prints an outcome ("Approved leave", "Holiday", "Complete") and, beside it, a
// reason. A reason that only restates the outcome is the same fact twice, so it is null and the screen
// draws nothing. A reason that ADDS something (why a day could not be judged, which penalty applied) stays,
// and never repeats the minutes the Late and Short cells already show.

const baseInput: ReconcileInput = {
  deviceOutage: false,
  hasApprovedExcuse: false,
  hasApprovedLeave: false,
  hasCrmFieldVisit: false,
  hasCrmLeave: false,
  hasPunch: true,
  isHoliday: false,
  isWorkingDay: true,
  planSaysOffice: null,
  tier: "head_office",
} as unknown as ReconcileInput;

const config: FlexibleHoursConfig = { flexCeilingMinutes: 9 * 60 + 30, requiredMinutes: 8 * 60, scheduledStartMinutes: 9 * 60 };
const noBrackets: never[] = [];
const bracketed = [{ fromMinutes: 1, toMinutes: null, deductionDays: 0.5 }] as unknown as Parameters<typeof evaluateFlexibleHoursDay>[0]["lateBrackets"];

function skipReason(overrides: Partial<ReconcileInput>) {
  const decision = reconcileDay({ ...baseInput, ...overrides });
  assert.equal(decision.action, "skip");
  return decision.action === "skip" ? decision.reason : "unreachable";
}

export function runAttendanceDayReasonSaidOnceTests() {
  // Skips whose reason would only restate the outcome label are null.
  assert.equal(skipReason({ isWorkingDay: false }), null, "'Weekly off' needs no second 'not a working day'");
  assert.equal(skipReason({ isHoliday: true }), null, "'Holiday' needs no second 'Official holiday.'");
  assert.equal(skipReason({ hasApprovedLeave: true }), null, "'Approved leave' needs no second 'Approved leave.'");
  assert.equal(skipReason({ hasApprovedExcuse: true }), null, "'Approved excuse' needs no second 'Approved excuse.'");
  assert.equal(skipReason({ hasCrmLeave: true }), null);
  assert.equal(skipReason({ hasCrmFieldVisit: true }), null);

  // A skip that explains something the outcome does not keeps its words.
  assert.match(skipReason({ deviceOutage: true }) ?? "", /not syncing/, "why the day could not be judged is not in the outcome label");
  const flagged = reconcileDay({ ...baseInput, tier: "office_days_only", planSaysOffice: true, hasPunch: false } as ReconcileInput);
  assert.equal(flagged.action, "flag");
  if (flagged.action === "flag") assert.match(flagged.reason, /Planned office day/, "'planned' is not in 'Office no-show (flagged)'");

  // Flexible hours: a complete day says nothing beyond its status.
  const day = (first: number, last: number) =>
    evaluateFlexibleHoursDay({ config, firstPunchMinutes: first, lastPunchMinutes: last, lateBrackets: bracketed, shortBrackets: bracketed, visiblePunchCount: 2 });
  const complete = day(9 * 60, 17 * 60);
  assert.equal(complete.status, "Complete");
  assert.equal(complete.reason, null, "'On time and full hours.' under 'Complete' is the same fact twice");

  // The minutes are the Late and Short cells' to say, never the reason's.
  const late = day(10 * 60, 18 * 60 + 30);
  const shortOnly = day(9 * 60, 15 * 60);
  const both = day(10 * 60, 16 * 60);
  for (const [label, result] of [["late", late], ["short", shortOnly], ["both", both]] as const) {
    assert.ok(result.reason, `${label}: a penalised day keeps a reason, because it is stored on the deduction line`);
    assert.ok(!/\d/.test(result.reason ?? ""), `${label}: the reason "${result.reason}" repeats minutes the Late and Short cells show`);
  }
  assert.equal(late.lateMinutes > 0 && late.shortMinutes === 0, true, "fixture: the late day completed its hours");
  assert.match(late.reason ?? "", /halved/);
  assert.match(both.reason ?? "", /penalty applies/);

  // A lone punch keeps its words: 'Missing punch' does not say it needs verifying.
  const lone = evaluateFlexibleHoursDay({ config, firstPunchMinutes: 9 * 60, lastPunchMinutes: null, lateBrackets: noBrackets, shortBrackets: noBrackets, visiblePunchCount: 1 });
  assert.match(lone.reason ?? "", /needs verification/);
}
