// Probation HR evidence aggregation (Phase 5, P5-T03).
//
// This module covers the FIELD FORCE (Medical Reps + District Managers). Fingerprint attendance
// is a head-office concept and does NOT apply here — a field rep's presence is their CRM field
// activity (see the SFE evidence). So the HR assessment is NOT attendance-driven: it surfaces the
// auto signals relevant to field roles (leave requests, deduction decisions) and leaves conduct /
// documentation / disciplinary warnings to HR JUDGMENT (entered manually via the assessment score
// + comments), since there is no structured store for those. Attendance-style metrics are marked
// not-applicable for field roles. Best-effort: a missing/renamed source degrades gracefully.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key";

export type HrMetric = {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  available: boolean;
  note?: string;
};

export type HrEvidence = {
  window: { from: string | null; to: string };
  metrics: HrMetric[];
  generatedAt: string;
};

async function safeCount(
  build: () => PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number | null> {
  try {
    const { count, error } = await build();
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

/** Aggregate the few HR signals that have real data; mark the rest unavailable. */
export async function buildHrEvidence(
  employeeHrId: string,
  window: { from: string | null; to: string },
  generatedAt: string = new Date().toISOString(),
): Promise<HrEvidence> {
  const supabase = getSupabaseAdmin();
  const hrId = employeeHrId.trim();

  const leaveCount = await safeCount(() =>
    supabase
      .from("v2_vacation_requests")
      .select("id", { count: "exact", head: true })
      .ilike("employee_hr_id", hrId),
  );

  // Deduction decisions come from the UNIFIED Deductions module. The legacy governance tables
  // (deduction_candidates/deduction_decisions) stopped receiving new rows once the Track C cutover
  // (mossy-ocean) moved the last live writer onto deductions_candidates/deductions_decisions, so a
  // count off the legacy table silently freezes at the pre-cutover total and undercounts forever.
  //
  // deductions_decisions keys by candidate_id, not the employee — the employee lives on the
  // candidate's employee_hr_id_compact. compactDeductionsHrId lower-cases and strips the HR id the
  // same way that column is derived, so the compact-to-compact match is alias-aware (a plain
  // .eq/.ilike on the mixed-case raw HR id under-returns). We count this employee's LIVE
  // (non-superseded) candidates whose paired decision is an ACTUAL decision: every candidate gets a
  // "Pending" decision row at collection time ("detected", not "decided"), so Pending is excluded.
  const deductionCompact = compactDeductionsHrId(hrId);
  const deductionCount = deductionCompact
    ? await safeCount(() =>
        supabase
          .from("deductions_decisions")
          .select("id, deductions_candidates!inner(employee_hr_id_compact, superseded_at)", {
            count: "exact",
            head: true,
          })
          .eq("deductions_candidates.employee_hr_id_compact", deductionCompact)
          .is("deductions_candidates.superseded_at", null)
          .neq("decision_status", "Pending"),
      )
    : null;

  const metrics: HrMetric[] = [
    // Auto signals relevant to field roles.
    { key: "leave_requests", label: "Leave requests", value: leaveCount, unit: "requests", available: leaveCount != null },
    { key: "deduction_decisions", label: "Deduction decisions", value: deductionCount, unit: "decisions", available: deductionCount != null },
    // Fingerprint attendance is head-office only — not applicable to field reps (presence = CRM activity).
    { key: "attendance", label: "Fingerprint attendance", value: null, unit: "days", available: false, note: "not applicable to field roles (presence tracked via CRM field activity)" },
    // HR judgment, entered manually with the assessment (no structured auto source).
    { key: "conduct", label: "Professional conduct", value: null, unit: "", available: false, note: "HR judgment (manual entry)" },
    { key: "documentation", label: "Documentation completeness", value: null, unit: "%", available: false, note: "HR judgment (manual entry)" },
    { key: "warnings", label: "Disciplinary warnings", value: null, unit: "warnings", available: false, note: "HR judgment (manual entry)" },
  ];

  return { window, metrics, generatedAt };
}
