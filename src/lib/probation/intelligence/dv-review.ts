// Probation DV review queue (Phase 3, P3-T08).
//
// Two sources feed the admin review queue, so nothing is silently dropped:
//   1. probation_dv_days rows with a problem dv_status (rejected | invalid | duplicate |
//      manually_reviewed) — these resolved to an employee+evaluator but failed validation.
//   2. probation_dv_ingest_issues — raw CRM rows that couldn't even form a DV-Day (no employee,
//      no evaluator, or no crm_visit_id).

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DvDetectionResult } from "./dv-detection";

export type DvIngestIssueRow = {
  crm_visit_id: number | null;
  employee_hr_id: string | null;
  evaluator_hr_id: string | null;
  dv_date: string | null;
  reason: string;
  raw: Record<string, unknown>;
};

const REVIEW_DV_STATUSES = ["rejected", "invalid", "duplicate", "manually_reviewed"] as const;

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

/**
 * Read the current review queue: problem-status DV-Days + unresolved ingest issues.
 * Read-only; ordered newest DV date first.
 */
export async function getDvReviewQueue(supabase: SupabaseClient): Promise<DvReviewItem[]> {
  const items: DvReviewItem[] = [];

  const { data: dvDays, error: dvErr } = await supabase
    .from("probation_dv_days")
    .select("employee_hr_id, evaluator_hr_id, dv_date, dv_status, validation_reason, crm_source_ids")
    .in("dv_status", [...REVIEW_DV_STATUSES])
    .order("dv_date", { ascending: false });
  if (dvErr) throw new Error(dvErr.message);
  for (const r of (dvDays ?? []) as Array<{
    employee_hr_id: string; evaluator_hr_id: string | null; dv_date: string;
    dv_status: string; validation_reason: string | null; crm_source_ids: number[] | null;
  }>) {
    items.push({
      source: "dv_day",
      crmVisitIds: r.crm_source_ids ?? [],
      employeeHrId: r.employee_hr_id,
      evaluatorHrId: r.evaluator_hr_id,
      dvDate: r.dv_date,
      status: r.dv_status,
      reason: r.validation_reason,
    });
  }

  const { data: issues, error: issErr } = await supabase
    .from("probation_dv_ingest_issues")
    .select("crm_visit_id, employee_hr_id, evaluator_hr_id, dv_date, reason")
    .is("resolved_at", null)
    .order("created_at", { ascending: false });
  if (issErr) throw new Error(issErr.message);
  for (const r of (issues ?? []) as Array<{
    crm_visit_id: number | null; employee_hr_id: string | null;
    evaluator_hr_id: string | null; dv_date: string | null; reason: string;
  }>) {
    items.push({
      source: "ingest_issue",
      crmVisitIds: r.crm_visit_id == null ? [] : [r.crm_visit_id],
      employeeHrId: r.employee_hr_id,
      evaluatorHrId: r.evaluator_hr_id,
      dvDate: r.dv_date,
      status: "ingest_issue",
      reason: r.reason,
    });
  }

  return items;
}
