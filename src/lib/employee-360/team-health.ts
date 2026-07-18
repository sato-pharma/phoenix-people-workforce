// Employee 360 — manager "Team Health" analytics.
//
// For a field LEADER (District / Regional / National Sales Manager) this answers
// the question their own field presence can't: how well is their TEAM being
// developed? It reuses the coaching module's coached-vs-neglected builder
// (buildTrainingManagerCoachingComparison), scoped to the manager's own reps, so
// a DM sees exactly which of their reps have been coached and which are neglected.
// Training Managers get their own, richer analysis (tm-analytics) — not this.

import { buildTrainingManagerCoachingComparison } from "@/lib/coaching/analytics";
import type { CoachingReportSummaryRow } from "@/lib/coaching/types";
import { resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TeamHealthRep = {
  hrId: string;
  name: string;
  coached: boolean;
  coachingCount: number;
  averageScore: number | null;
  latestCoachingDate: string | null;
  latestCoachName: string | null;
};

export type TeamHealthSummary = {
  hasData: boolean;
  repCount: number;
  coachedCount: number;
  neverCoachedCount: number;
  coverageRate: number; // 0..1 — share of the manager's reps coached in the window
  avgScore: number | null; // average coaching score among coached reps
  neglected: TeamHealthRep[]; // never-coached reps
  coached: TeamHealthRep[]; // coached reps, most recent first
};

const EMPTY: TeamHealthSummary = {
  hasData: false,
  repCount: 0,
  coachedCount: 0,
  neverCoachedCount: 0,
  coverageRate: 0,
  avgScore: null,
  neglected: [],
  coached: [],
};

/**
 * Coaching coverage of a manager's own reps within the window. `teamHrIds` is the
 * manager's org-tree descendants (already computed by the detail page); we keep
 * only the active Medical Reps in it as the coachable denominator.
 */
export async function getEmployee360TeamHealth(input: {
  teamHrIds: string[];
  employees: EmployeeDirectoryRow[];
  window: { from: string; to: string };
}): Promise<TeamHealthSummary> {
  const teamKeys = new Set(
    input.teamHrIds.map((h) => canonicalHrIdKey(h)).filter((k): k is string => Boolean(k)),
  );
  const teamReps = input.employees.filter((e) => {
    const key = canonicalHrIdKey(e.hrId);
    return (
      key != null &&
      teamKeys.has(key) &&
      resolveEmployee360RoleCategory(e.jobTitle ?? e.positionTitle) === "medical-rep"
    );
  });
  if (teamReps.length === 0) return EMPTY;

  const repHrIds = teamReps.map((e) => e.hrId.toUpperCase());
  let reports: CoachingReportSummaryRow[] = [];
  try {
    const { data } = await getSupabaseAdmin()
      .from("coaching_reports_summary")
      .select("medical_rep_hr_id, coaching_date, final_score_percent, coach_name, coach_hr_id, status")
      .in("medical_rep_hr_id", repHrIds)
      .gte("coaching_date", input.window.from)
      .lte("coaching_date", input.window.to);
    // buildTrainingManagerCoachingComparison only reads these six fields.
    reports = (data ?? []).map(
      (r) =>
        ({
          medicalRepHrId: String((r as Record<string, unknown>).medical_rep_hr_id ?? ""),
          coachingDate: String((r as Record<string, unknown>).coaching_date ?? ""),
          finalScorePercent: Number((r as Record<string, unknown>).final_score_percent ?? 0),
          coachName: String((r as Record<string, unknown>).coach_name ?? ""),
          coachHrId: String((r as Record<string, unknown>).coach_hr_id ?? ""),
          status: String((r as Record<string, unknown>).status ?? ""),
        }) as unknown as CoachingReportSummaryRow,
    );
  } catch {
    reports = [];
  }

  const comparison = buildTrainingManagerCoachingComparison({ employees: teamReps, reports });
  const mapped: TeamHealthRep[] = comparison.rows.map((row) => ({
    hrId: row.hrId,
    name: row.medicalRepName,
    coached: row.status === "coached",
    coachingCount: row.coachingCount,
    averageScore: row.averageScore,
    latestCoachingDate: row.latestCoachingDate,
    latestCoachName: row.latestCoachName,
  }));
  const coached = mapped
    .filter((r) => r.coached)
    .sort((a, b) => String(b.latestCoachingDate ?? "").localeCompare(String(a.latestCoachingDate ?? "")));
  const neglected = mapped.filter((r) => !r.coached);
  const scores = coached.map((r) => r.averageScore).filter((s): s is number => s != null);

  return {
    hasData: true,
    repCount: comparison.totalMedicalReps,
    coachedCount: comparison.coachedCount,
    neverCoachedCount: comparison.uncoachedCount,
    coverageRate: comparison.totalMedicalReps > 0 ? comparison.coachedCount / comparison.totalMedicalReps : 0,
    avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    neglected,
    coached,
  };
}
