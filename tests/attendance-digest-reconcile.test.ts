import { strict as assert } from "node:assert";

import { reconcileDay, type ReconcileInput } from "../src/lib/attendance/digest-reconcile.ts";

function base(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    tier: "every_working_day",
    isWorkingDay: true,
    isHoliday: false,
    hasApprovedLeave: false,
    hasApprovedExcuse: false,
    planSaysOffice: null,
    hasPunch: true,
    ...overrides,
  };
}

export function runAttendanceDigestReconcileTests() {
  // --- Tier 1 (head office): judged every working day ---
  assert.equal(reconcileDay(base()).action, "judge", "a normal working day is judged");
  assert.equal(reconcileDay(base({ isWorkingDay: false })).action, "skip", "weekly off is skipped");
  assert.equal(reconcileDay(base({ isHoliday: true })).action, "skip", "holiday is skipped");
  assert.equal(reconcileDay(base({ hasApprovedLeave: true })).action, "skip", "approved leave is skipped");
  assert.equal(reconcileDay(base({ hasApprovedExcuse: true })).action, "skip", "approved excuse is skipped");
  // Tier 1 is judged even with no punch (becomes a missing-punch line downstream).
  assert.equal(reconcileDay(base({ hasPunch: false })).action, "judge", "head office no-punch working day is still judged");

  // Universal cancels win over the tier logic (precedence).
  assert.equal(
    reconcileDay(base({ isHoliday: true, isWorkingDay: true })).action,
    "skip",
    "holiday overrides a working day",
  );

  // --- Tier 2 (office-hybrid): judged only when plan=office AND a punch exists ---
  const t2 = (overrides: Partial<ReconcileInput>) => reconcileDay(base({ tier: "office_days_only", ...overrides }));

  assert.equal(t2({ planSaysOffice: true, hasPunch: true }).action, "judge", "office day with a punch is judged");

  const noShow = t2({ planSaysOffice: true, hasPunch: false });
  assert.equal(noShow.action, "flag");
  assert.equal(noShow.action === "flag" && noShow.flagType, "office_no_show", "office day, no punch → no-show flag");

  const anomaly = t2({ planSaysOffice: false, hasPunch: true });
  assert.equal(anomaly.action, "flag");
  assert.equal(anomaly.action === "flag" && anomaly.flagType, "field_punch_anomaly", "field day, a punch → anomaly flag");

  assert.equal(t2({ planSaysOffice: false, hasPunch: false }).action, "skip", "field day with no punch is a normal field day");
  assert.equal(t2({ planSaysOffice: null, hasPunch: true }).action, "skip", "no plan → not an office day, skipped");

  // Tier-2 mismatches are still cancelled by holidays/leave (no flag on a holiday).
  assert.equal(
    t2({ planSaysOffice: true, hasPunch: false, isHoliday: true }).action,
    "skip",
    "a holiday cancels even a tier-2 office no-show",
  );
  assert.equal(
    t2({ planSaysOffice: true, hasPunch: true, hasApprovedLeave: true }).action,
    "skip",
    "approved leave cancels even a tier-2 office+punch day",
  );
}
