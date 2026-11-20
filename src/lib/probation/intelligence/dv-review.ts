// Probation DV review queue (Phase 3, P3-T08).
//
// Two sources feed the admin review queue, so nothing is silently dropped:
//   1. probation_dv_days rows with a problem dv_status (rejected | invalid | duplicate |
//      manually_reviewed) — these resolved to an employee+evaluator but failed validation.
//   2. probation_dv_ingest_issues — raw CRM rows that couldn't even form a DV-Day (no employee,
//      no evaluator, or no crm_visit_id).

import type { DvDetectionResult } from "./dv-detection";

export type DvIngestIssueRow = {
  crm_visit_id: number | null;
  employee_hr_id: string | null;
  evaluator_hr_id: string | null;
  dv_date: string | null;
  reason: string;
  raw: Record<string, unknown>;
};

/** Shape detection's unresolved rows (no employee/evaluator/crm id) into ingest-issue rows. */
export function toIngestIssueRows(unresolved: DvDetectionResult["unresolved"]): DvIngestIssueRow[] {
  return unresolved.map((u) => ({
    crm_visit_id: u.crmVisitId,
    employee_hr_id: u.visit.employeeHrId,
    evaluator_hr_id: u.visit.evaluatorHrId,
    dv_date: u.visit.dvDate || null,
    reason: u.reason,
    raw: {
      employeeName: u.visit.employeeName,
      evaluatorName: u.visit.evaluatorName,
      contactName: u.visit.contactName,
      visitType: u.visit.visitType,
      ampm: u.visit.ampm,
    },
  }));
}

export type DvReviewItem = {
  source: "dv_day" | "ingest_issue";
  crmVisitIds: number[];
  employeeHrId: string | null;
  evaluatorHrId: string | null;
  dvDate: string | null;
  status: string;
  reason: string | null;
};

