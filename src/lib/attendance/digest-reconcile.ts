// Digest reconciliation gating — decides, for one employee-day, whether the
// flexible-hours engine should judge it at all, and how the two tiers differ.
//
// Owner-confirmed model (2026-07-03):
//   • A day is never judged when it is a weekly-off, an official (observed)
//     holiday, an approved full-day leave, or covered by an approved excuse.
//   • Tier 1 (head office, judgment_mode = every_working_day): judged on every
//     working day.
//   • Tier 2 (NSM/GPM/PM, judgment_mode = office_days_only): judged only when the
//     plan says office AND a punch exists. Any plan/punch mismatch is flagged to
//     the manager (cc HR + CEO), never auto-deducted:
//        plan office + no punch  → office no-show flag
//        plan field  + punch     → field-punch anomaly flag
//        plan field  + no punch  → normal field day, skip
//        no plan                 → not an office day, skip
//
// Owner-confirmed addendum (2026-07-21): the above only ever checked Phoenix's
// OWN vacation_requests/excuse_requests tables and (Tier-2 only) the weekly
// plan — it had no awareness of CRM (iReports360), so a day covered only by a
// CRM-recorded leave, or explained only by a real CRM field visit, was judged
// purely on device-punch timing with no way to know either was true. Both are
// now universal cancels, same standing as Phoenix leave/excuse and applying to
// BOTH tiers — a genuine field day proves itself the same way regardless of
// whether the employee's formal policy tier expects field work at all.
//
// This module is the pure gating matrix only. The actual deduction math is the
// separately-tested flexible-hours engine; the generator composes the two.

export type AttendanceJudgmentMode = "every_working_day" | "office_days_only";

export type ReconcileInput = {
  tier: AttendanceJudgmentMode;
  /** From the working-days classifier: is this an expected working day for the employee? */
  isWorkingDay: boolean;
  /** Observed (postponed-aware) official holiday. */
  isHoliday: boolean;
  /** An approved FULL-day leave covers the day. */
  hasApprovedLeave: boolean;
  /** An approved excuse/permission covers the day. */
  hasApprovedExcuse: boolean;
  /** Tier-2 only: plan says office (true) / field (false) / no plan (null). */
  planSaysOffice: boolean | null;
  /** Whether any punch was recorded that day. */
  hasPunch: boolean;
  /**
   * Company-wide fingerprint device/sync outage that day (zero punches
   * ingested for ANYONE, despite it being an expected working day) — see
   * getCompanyWideOutageDates in ingestion-health.ts. A missing punch caused
   * by the device being down is not the employee's fault and must never
   * become a missing-punch line or a false field-punch-anomaly flag.
   */
  deviceOutage: boolean;
  /**
   * A CRM-recorded leave day (iReports360 visit type -4 Annual Vacation — the
   * only genuine leave type; Health Day -15, Public Holiday -5 and Casual Leave
   * -6 are working time) covers this date, per getCrmLeaveDayMap — a leave the
   * employee may never have formally submitted through Phoenix's own
   * vacation_requests, but is real per the CRM record. Universal cancel,
   * same as hasApprovedLeave.
   */
  hasCrmLeave: boolean;
  /**
   * A real CRM field activity — a regular visit OR a CP-type entry
   * (Conference/Group Meeting/Campaign/Training/Meeting/Traveling) — was
   * logged this date, per getCrmActivityDayMaps's fieldVisitMap. Proof of
   * legitimate field/CRM-logged work explaining an office-punch absence.
   * Universal cancel, applies to both tiers.
   */
  hasCrmFieldVisit: boolean;
};

export type ReconcileDecision =
  // `reason` is null when it would only restate the outcome the day is already shown under (said once).
  | { action: "skip"; reason: string | null }
  | { action: "flag"; reason: string; flagType: "office_no_show" | "field_punch_anomaly" }
  | { action: "judge" };

/** The classification facts behind a "skip" decision — the same booleans ReconcileInput already
 * carries, minus the tier/plan fields that only decide whether to skip at all, not what the skip
 * MEANS. */
export type ReconcileSkipFacts = {
  isWeeklyOff: boolean;
  isHoliday: boolean;
  hasApprovedLeave: boolean;
  hasApprovedExcuse: boolean;
  hasCrmLeave: boolean;
  hasCrmFieldVisit: boolean;
  hasOutage: boolean;
};

export type ReconcileSkipOutcome =
  | "weekly_off"
  | "holiday"
  | "approved_leave"
  | "approved_excuse"
  | "crm_leave"
  | "crm_field_visit"
  | "device_outage"
  | "no_plan_field_day";

/**
 * What a "skip" decision means, in the same precedence reconcileDay itself applies. Isolated as
 * its own pure function so a caller never has to re-derive this from `decision.reason` (display
 * text, not a branching key) — the per-employee day report and the company activity report both
 * call this, so the two can never quietly disagree about what a given skip means.
 *
 * The final `no_plan_field_day` catch-all covers the two remaining office_days_only skip branches
 * (field-per-plan / no-plan-designated) — reconcileDay is the only caller that can actually reach
 * this function with none of the other facts true, since every other tier/universal-cancel skip
 * sets one of them.
 */
export function describeReconcileSkip(facts: ReconcileSkipFacts): ReconcileSkipOutcome {
  if (facts.isWeeklyOff) return "weekly_off";
  if (facts.isHoliday) return "holiday";
  if (facts.hasApprovedLeave) return "approved_leave";
  if (facts.hasApprovedExcuse) return "approved_excuse";
  if (facts.hasCrmLeave) return "crm_leave";
  if (facts.hasCrmFieldVisit) return "crm_field_visit";
  if (facts.hasOutage) return "device_outage";
  return "no_plan_field_day";
}

/** The facts that can cancel the MONEY on a judged day, as opposed to stopping it being judged. */
export type DeductionCancelFacts = {
  hasApprovedException: boolean;
  hasApprovedExcuse: boolean;
  hasApprovedLeave: boolean;
  /** Set when the approved leave covers only half the day — then it never cancels; see below. */
  halfDayVacationPart: "am_only" | "pm_only" | null;
  hasCrmLeave: boolean;
  hasCrmFieldVisit: boolean;
};

/**
 * Whether a judged day's DEDUCTION is cancelled outright.
 *
 * reconcileDay above decides whether a day is judged at all; this decides whether
 * the resulting charge survives. They must agree on what counts as cover, which is
 * why both live in this file — the fingerprint report kept its own inline version
 * that named only the exception and the excuse, and silently charged a full-day
 * approved leave, a CRM-recorded leave and a real CRM field visit even though this
 * module has always called all three universal cancels.
 *
 * A HALF-day approved vacation is deliberately NOT a cancel: the employee still
 * owes the other half, and the flexible-hours engine judges exactly that half
 * (requiredMinutesForHalfDayVacation + halfDayEffectiveStartMinutes). Owner
 * decision 2026-09-08, asked and answered: "judge the worked half".
 */
export function isAttendanceDeductionCancelled(facts: DeductionCancelFacts): boolean {
  if (facts.hasApprovedException || facts.hasApprovedExcuse) return true;
  if (facts.hasApprovedLeave && !facts.halfDayVacationPart) return true;
  return facts.hasCrmLeave || facts.hasCrmFieldVisit;
}

export function reconcileDay(input: ReconcileInput): ReconcileDecision {
  // Universal cancels — apply to both tiers, before any tier logic.
  if (!input.isWorkingDay) return { action: "skip", reason: null };
  if (input.isHoliday) return { action: "skip", reason: null };
  if (input.hasApprovedLeave) return { action: "skip", reason: null };
  if (input.hasApprovedExcuse) return { action: "skip", reason: null };
  if (input.hasCrmLeave) return { action: "skip", reason: null };
  if (input.hasCrmFieldVisit) return { action: "skip", reason: null };
  if (input.deviceOutage) return { action: "skip", reason: "Fingerprint device was not syncing this day — cannot judge attendance." };

  if (input.tier === "office_days_only") {
    if (input.planSaysOffice === true) {
      return input.hasPunch
        ? { action: "judge" }
        : { action: "flag", reason: "Planned office day with no punch.", flagType: "office_no_show" };
    }
    if (input.planSaysOffice === false) {
      return input.hasPunch
        ? { action: "flag", reason: "Field day in the plan but a punch was recorded.", flagType: "field_punch_anomaly" }
        : { action: "skip", reason: null };
    }
    return { action: "skip", reason: "No plan-designated office day." };
  }

  // Tier 1 — head office — judged on every working day (no-punch days become a
  // missing-punch line via the engine, routed to the A-13 → HR → COO chain).
  return { action: "judge" };
}
