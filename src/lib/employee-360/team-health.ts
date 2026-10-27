// Employee 360 — manager "Team Health" analytics.
//
// For a field LEADER (District / Regional / National Sales Manager) this answers
// the question their own field presence can't: how well is their TEAM being
// developed? Two lenses over the SAME rep roster (their org-tree Medical Reps):
//   1. Coaching coverage — reuses the coaching module's coached-vs-neglected
//      builder (buildTrainingManagerCoachingComparison), scoped to their reps.
//   2. Double-visit coverage — which reps this manager joined in the field, from
//      the leadership activity already computed for the profile (leadership.byRep),
//      so no extra heavy CRM scan.
// The headline is the COMBINED gap: reps who got NEITHER coaching NOR a double-visit
// this period — genuinely neglected. Training Managers get their own richer analysis
// (tm-analytics), not this.

import { buildTrainingManagerCoachingComparison } from "@/lib/coaching/analytics";
import type { CoachingReportSummaryRow } from "@/lib/coaching/types";
import { resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { todayInCairo } from "@/lib/date-only";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TeamHealthRep = {
  hrId: string;
  name: string;
  coached: boolean;
  coachingCount: number;
  averageScore: number | null;
  latestCoachingDate: string | null;
  latestCoachName: string | null;
  doubleVisited: boolean;
};

export type TeamHealthSummary = {
  hasData: boolean;
  /** The coaching read failed: the section says so, never "every rep never coached" (2026-10-27). */
  unavailable?: boolean;
  repCount: number;
  // Coaching
  coachedCount: number;
  neverCoachedCount: number;
  coverageRate: number; // 0..1 — share of the manager's reps coached in the window
  avgScore: number | null; // average coaching score among coached reps
  neglected: TeamHealthRep[]; // never-coached reps
  coached: TeamHealthRep[]; // coached reps, most recent first
  // Double-visits (this manager, from leadership.byRep)
  dvCoveredCount: number;
  dvCoverageRate: number; // 0..1 — share of reps this manager double-visited
  // Combined gap: neither coached nor double-visited this period.
  fullyNeglectedCount: number;
  fullyNeglected: TeamHealthRep[];
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
  dvCoveredCount: 0,
  dvCoverageRate: 0,
  fullyNeglectedCount: 0,
  fullyNeglected: [],
};

/**
 * Coaching + double-visit coverage of a manager's own reps within the window.
 * `teamHrIds` is the manager's org-tree descendants (from the detail page); we keep
 * only the active Medical Reps as the denominator. `dvRepHrIds` are the reps this
 * manager double-visited this period (leadership.byRep with doubleVisits > 0).
 */
export async function getEmployee360TeamHealth(input: {
  teamHrIds: string[];
  employees: EmployeeDirectoryRow[];
  window: { from: string; to: string };
  dvRepHrIds?: string[];
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

  // Every stored spelling of each id: production keeps hr_id mixed-case, and an upper-cased filter matched nobody.
  const repHrIds = Array.from(new Set(teamReps.flatMap((e) => hrIdLookupKeys(e.hrId))));
  // Today in Cairo: a report dated ahead is not coaching delivered yet, as on the rep's own section.
  const today = todayInCairo();
  const lastDay = input.window.to < today ? input.window.to : today;
  let reports: CoachingReportSummaryRow[] = [];
  try {
    // PostgREST folds every .in() value into the request URL; an unbatched array of a few
    // hundred ids can push the URL past undici's ~16KB header limit and throw
    // "TypeError: fetch failed" / HeadersOverflowError — teamHrIds can be a manager's whole
    // org subtree (e.g. an NSM's line), so batch it.
    const rawReports: unknown[] = [];
    for (let i = 0; i < repHrIds.length; i += 100) {
      const batch = repHrIds.slice(i, i + 100);
      const { data, error } = await getSupabaseAdmin()
        .from("coaching_reports_summary")
        .select("medical_rep_hr_id, coaching_date, final_score_percent, coach_name, coach_hr_id, status")
        .in("medical_rep_hr_id", batch)
        .gte("coaching_date", input.window.from)
        .lte("coaching_date", lastDay);
      if (error) throw new Error(error.message);
      rawReports.push(...(data ?? []));
    }
    // buildTrainingManagerCoachingComparison only reads these six fields.
    reports = rawReports.map(
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
  } catch (error) {
    // A failed read is never "every rep never coached".
    logError("Employee 360 team health coaching read failed", {
      error,
      labels: { event: "employee_360_team_health_failed" },
    });
    return { ...EMPTY, unavailable: true, repCount: teamReps.length };
  }

  const dvKeys = new Set(
    (input.dvRepHrIds ?? []).map((h) => canonicalHrIdKey(h)).filter((k): k is string => Boolean(k)),
  );

  const comparison = buildTrainingManagerCoachingComparison({ employees: teamReps, reports });
  const mapped: TeamHealthRep[] = comparison.rows.map((row) => {
    const key = canonicalHrIdKey(row.hrId);
    return {
      hrId: row.hrId,
      name: row.medicalRepName,
      coached: row.status === "coached",
      coachingCount: row.coachingCount,
      averageScore: row.averageScore,
      latestCoachingDate: row.latestCoachingDate,
      latestCoachName: row.latestCoachName,
      doubleVisited: key != null && dvKeys.has(key),
    };
  });

  const coached = mapped
    .filter((r) => r.coached)
    .sort((a, b) => String(b.latestCoachingDate ?? "").localeCompare(String(a.latestCoachingDate ?? "")));
  const neglected = mapped.filter((r) => !r.coached);
  const dvCoveredCount = mapped.filter((r) => r.doubleVisited).length;
  const fullyNeglected = mapped.filter((r) => !r.coached && !r.doubleVisited);
  const scores = coached.map((r) => r.averageScore).filter((s): s is number => s != null);
  const total = comparison.totalMedicalReps;

  return {
    hasData: true,
    repCount: total,
    coachedCount: comparison.coachedCount,
    neverCoachedCount: comparison.uncoachedCount,
    coverageRate: total > 0 ? comparison.coachedCount / total : 0,
    avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    neglected,
    coached,
    dvCoveredCount,
    dvCoverageRate: total > 0 ? dvCoveredCount / total : 0,
    fullyNeglectedCount: fullyNeglected.length,
    fullyNeglected,
  };
}
