import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

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
    deviceOutage: false,
    hasCrmLeave: false,
    hasCrmFieldVisit: false,
    ...overrides,
  };
}

export function runAttendanceReconcileDayTests() {
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

  // --- Device-outage fail-safe: applies to BOTH tiers, before any tier logic ---
  assert.equal(
    reconcileDay(base({ deviceOutage: true, hasPunch: false })).action,
    "skip",
    "tier-1 no-punch day is skipped, not judged, when the device was down",
  );
  assert.equal(
    t2({ planSaysOffice: true, hasPunch: false, deviceOutage: true }).action,
    "skip",
    "an outage cancels a tier-2 office no-show flag — the missing punch isn't the employee's fault",
  );
  assert.equal(
    t2({ planSaysOffice: false, hasPunch: true, deviceOutage: true }).action,
    "skip",
    "an outage cancels a tier-2 field-punch anomaly flag too (the punch signal itself is untrustworthy that day)",
  );
  assert.equal(
    reconcileDay(base({ deviceOutage: true, hasPunch: true })).action,
    "skip",
    "an outage day is skipped even if this employee happens to have a punch (company-wide signal wins)",
  );

  // --- CRM awareness (2026-07-21): universal cancels, both tiers ---
  assert.equal(
    reconcileDay(base({ hasCrmLeave: true })).action,
    "skip",
    "a CRM-recorded leave day is skipped even with no matching Phoenix vacation_requests row",
  );
  assert.equal(
    reconcileDay(base({ hasCrmFieldVisit: true, hasPunch: false })).action,
    "skip",
    "tier-1, no office punch, but a real CRM field visit that day — skipped, not a missing-punch line",
  );
  assert.equal(
    t2({ planSaysOffice: true, hasPunch: false, hasCrmFieldVisit: true }).action,
    "skip",
    "a real CRM field visit cancels even a tier-2 office no-show flag",
  );
  assert.equal(
    t2({ planSaysOffice: null, hasCrmLeave: true }).action,
    "skip",
    "CRM leave cancels a tier-2 day regardless of plan/no-plan",
  );
  // Precedence: CRM signals are universal cancels, so they still win even when
  // a punch also exists that day (e.g. a half-day office stop before a field visit).
  assert.equal(
    reconcileDay(base({ hasCrmFieldVisit: true, hasPunch: true })).action,
    "skip",
    "a real CRM field visit cancels judgment even if a punch also exists that day",
  );

  // --- The SAME rule, in the code that actually deducts (2026-08-01) ---
  //
  // Everything above tests reconcileDay() in digest-reconcile.ts — the engine of
  // the attendance-digest feature, which was DROPPED (migration
  // 20260722124339_drop_attendance_digest_feature). So the correct cascade was
  // tested in code that no longer runs, while fingerprint-report.ts — the live
  // path that produces the money — fetched the approved-excuse map, rendered it
  // into a label, and charged the deduction anyway.
  //
  // Cost, measured on July 2026 production data: 1,666.66 EGP over three days
  // that were each fully covered by an approved excuse — A-9 on 07-07 (800.00),
  // B-155 on 07-09 and 07-14 (433.33 each).
  //
  // A behaviour test cannot reach getFingerprintAttendanceReport (it builds a
  // Supabase client), so this is a wiring assertion on the live file.
  {
    const report = readFileSync("src/lib/attendance/fingerprint-report.ts", "utf8");
    assert.match(
      report,
      /const deductionCancelled = hasApprovedException \|\| hasApprovedExcuse/,
      "an approved excuse must cancel the attendance deduction, not merely be displayed",
    );
    assert.match(
      report,
      /deductionValue: deductionCancelled \?/,
      "the money field must be gated on deductionCancelled, not on hasApprovedException alone",
    );
    assert.doesNotMatch(
      report,
      /deductionDays: hasApprovedException \?/,
      "deductionDays gated on hasApprovedException alone is the fail-open that charged excused days",
    );
  }
}
