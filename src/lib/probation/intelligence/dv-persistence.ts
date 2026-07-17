// Probation DV-Day persistence shaping (Phase 3, P3-T07 visit details).
//
// Pure mappers from a validated DV-Day to the row payloads for probation_dv_days and its child
// probation_dv_visits. No DB access here — the idempotent writer (P3-T09) composes these. Keeping
// the shaping pure makes the "one DV-Day → many visit rows" mapping unit-testable.

import type { ValidatedDvDay } from "./dv-validation";

export type DvDayRowPayload = {
  case_id: string | null;
  employee_hr_id: string;
  evaluator_hr_id: string;
  evaluator_role: string | null;
  dv_date: string;
  ampm: "AM" | "PM" | null;
  visit_count: number;
  dv_status: string;
  validation_reason: string | null;
  crm_source_ids: number[];
  synced_at: string;
};

export type DvVisitRowPayload = {
  crm_visit_id: number;
  contact_name: string | null;
  customer_name: string | null;
  comment: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  ampm: "AM" | "PM" | null;
  visit_date: string;
};

/**
 * A DV-Day's ampm is a single marker only when the whole day sat in one half; a day spanning both
 * AM and PM visits is a full field day and stores null (the per-visit ampm keeps the detail).
 */
function dayAmpm(periods: Array<"AM" | "PM">): "AM" | "PM" | null {
  return periods.length === 1 ? periods[0] : null;
}

/** Shape the parent probation_dv_days row (excludes DB-generated id/timestamps). */
export function toDvDayRow(day: ValidatedDvDay, syncedAt: string): DvDayRowPayload {
  return {
    case_id: day.caseId,
    employee_hr_id: day.employeeHrId,
    evaluator_hr_id: day.evaluatorHrId,
    evaluator_role: day.evaluatorRole,
    dv_date: day.dvDate,
    ampm: dayAmpm(day.periods),
    visit_count: day.visitCount,
    dv_status: day.dvStatus,
    validation_reason: day.validationReason,
    // Sorted for deterministic payloads (stable across re-syncs).
    crm_source_ids: [...day.crmVisitIds].sort((a, b) => a - b),
    synced_at: syncedAt,
  };
}

/** Shape the child probation_dv_visits rows carrying every underlying customer visit (P3-T07). */
export function toDvVisitRows(day: ValidatedDvDay): DvVisitRowPayload[] {
  return day.visits.map((v) => ({
    crm_visit_id: v.crmVisitId,
    contact_name: v.contactName,
    customer_name: v.customerName,
    comment: v.comment,
    visit_type: v.visitType,
    visit_type_description: v.visitTypeDescription,
    ampm: v.ampm,
    visit_date: v.dvDate,
  }));
}
