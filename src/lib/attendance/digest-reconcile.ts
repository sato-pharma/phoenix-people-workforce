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
};

export type ReconcileDecision =
  | { action: "skip"; reason: string }
  | { action: "flag"; reason: string; flagType: "office_no_show" | "field_punch_anomaly" }
  | { action: "judge" };

export function reconcileDay(input: ReconcileInput): ReconcileDecision {
  // Universal cancels — apply to both tiers, before any tier logic.
  if (!input.isWorkingDay) return { action: "skip", reason: "Weekly off — not a working day." };
  if (input.isHoliday) return { action: "skip", reason: "Official holiday." };
  if (input.hasApprovedLeave) return { action: "skip", reason: "Approved leave." };
  if (input.hasApprovedExcuse) return { action: "skip", reason: "Approved excuse." };

  if (input.tier === "office_days_only") {
    if (input.planSaysOffice === true) {
      return input.hasPunch
        ? { action: "judge" }
        : { action: "flag", reason: "Planned office day with no punch.", flagType: "office_no_show" };
    }
    if (input.planSaysOffice === false) {
      return input.hasPunch
        ? { action: "flag", reason: "Field day in the plan but a punch was recorded.", flagType: "field_punch_anomaly" }
        : { action: "skip", reason: "Field day per plan." };
    }
    return { action: "skip", reason: "No plan-designated office day." };
  }

  // Tier 1 — head office — judged on every working day (no-punch days become a
  // missing-punch line via the engine, routed to the A-13 → HR → COO chain).
  return { action: "judge" };
}
