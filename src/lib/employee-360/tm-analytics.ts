// Employee 360 — Training Manager god-mode analytics.
//
// A Training Manager's job is to develop the WHOLE field force through coaching
// and double-visits. Their own field-visit counts say nothing about that. This
// builder measures the thing that matters: across every active Medical Rep (the
// TM's coachable pool), who did this TM actually coach, who is neglected, is the
// effort spread or concentrated on a handful, and — netting it out — is this TM
// EFFICIENT. It reuses the coaching module's coached-vs-neglected builder, keyed
// to reports THIS TM authored (coach_hr_id), so "coached" means "coached by them".

import { buildTrainingManagerCoachingComparison, completedReportStatuses } from "@/lib/coaching/analytics";
import type { CoachingReportSummaryRow } from "@/lib/coaching/types";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TmRepRef = { hrId: string; name: string; line: string | null; count: number };
export type TmMonthPoint = { month: string; sessions: number; reps: number };
export type TmVerdict = "efficient" | "adequate" | "needs_improvement";

export type TrainingManagerAnalytics = {
  hasData: boolean;
  /** The coaching reports could not be read — the screen says so, never a row of zeros. */
  unavailable?: boolean;
  poolSize: number; // all active Medical Reps
  coachedByTm: number; // reps this TM coached in the window
  neglectedByTm: number; // reps this TM never coached
  coverageRate: number; // coachedByTm / poolSize (0..1)
  sessionsDelivered: number; // completed coaching reports authored by this TM — every rep, a leaver included
  avgScoreGiven: number | null; // avg coaching score across their coached reps
  topFocusShare: number | null; // share of sessions spent on the top-5 reps (concentration)
  overFocusedCount: number; // reps coached 3+ times
  concentratedReps: TmRepRef[]; // most-coached reps (their focus)
  neglectedReps: TmRepRef[]; // active reps this TM never coached (sample)
  monthly: TmMonthPoint[]; // sessions + distinct reps per month
  efficiencyScore: number; // 0..100 composite
  verdict: TmVerdict;
  rationale: string;
};

function mapReport(r: Record<string, unknown>): CoachingReportSummaryRow {
  return {
    medicalRepHrId: String(r.medical_rep_hr_id ?? ""),
    coachingDate: String(r.coaching_date ?? ""),
    finalScorePercent: Number(r.final_score_percent ?? 0),
    coachName: String(r.coach_name ?? ""),
    coachHrId: String(r.coach_hr_id ?? ""),
    status: String(r.status ?? ""),
  } as unknown as CoachingReportSummaryRow;
}

/** Full effectiveness analysis for one Training Manager over the window. */
export async function getTrainingManagerAnalytics(input: {
  tmHrId: string;
  employees: EmployeeDirectoryRow[];
  window: { from: string; to: string };
}): Promise<TrainingManagerAnalytics> {
  let reports: CoachingReportSummaryRow[] = [];
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("coaching_reports_summary")
      .select("medical_rep_hr_id, coaching_date, final_score_percent, coach_name, coach_hr_id, status")
      .eq("coach_hr_id", input.tmHrId.toUpperCase())
      .gte("coaching_date", input.window.from)
      .lte("coaching_date", input.window.to);
    if (error) throw error;
    reports = (data ?? []).map((r) => mapReport(r as Record<string, unknown>));
  } catch (error) {
    logError("Employee 360 Training Manager coaching read failed", {
      error,
      labels: { event: "employee_360_tm_analytics_failed" },
    });
    return unavailableTrainingManagerAnalytics();
  }
  return summarizeTrainingManagerAnalytics(input.employees, reports);
}

/** What the section shows when the coaching reports could not be read: no figure, and the reason. */
function unavailableTrainingManagerAnalytics(): TrainingManagerAnalytics {
  return {
    hasData: false,
    unavailable: true,
    poolSize: 0,
    coachedByTm: 0,
    neglectedByTm: 0,
    coverageRate: 0,
    sessionsDelivered: 0,
    avgScoreGiven: null,
    topFocusShare: null,
    overFocusedCount: 0,
    concentratedReps: [],
    neglectedReps: [],
    monthly: [],
    efficiencyScore: 0,
    verdict: "needs_improvement",
    rationale: "The coaching reports could not be read just now, so no figure is shown.",
  };
}

/**
 * The analysis, from the reports this Training Manager authored in the window. PURE.
 *
 * Coverage is measured against today's active Medical Reps; the sessions are EVERY completed report
 * he wrote (2026-10-27: a rep who has since resigned was still coached — the section printed 25 of
 * the 51 sessions the "Coaching delivered" tile and the monthly chart beside it both count).
 */
export function summarizeTrainingManagerAnalytics(
  employees: EmployeeDirectoryRow[],
  reports: CoachingReportSummaryRow[],
): TrainingManagerAnalytics {

  // Pool = all active Medical Reps (the builder filters to them internally).
  const comparison = buildTrainingManagerCoachingComparison({ employees, reports });
  const poolSize = comparison.totalMedicalReps;
  const coachedByTm = comparison.coachedCount;
  const neglectedByTm = comparison.uncoachedCount;
  const coverageRate = poolSize > 0 ? coachedByTm / poolSize : 0;

  const coachedRows = comparison.rows
    .filter((r) => r.coachingCount > 0)
    .sort((a, b) => b.coachingCount - a.coachingCount);
  // Sessions per rep over every completed report, so the total, the concentration and the over-focus
  // are worked out on the same sessions the monthly chart counts.
  const sessionsByRep = new Map<string, number>();
  for (const report of reports) {
    if (!completedReportStatuses.has(report.status)) continue;
    const rep = canonicalHrIdKey(report.medicalRepHrId);
    if (!rep) continue;
    sessionsByRep.set(rep, (sessionsByRep.get(rep) ?? 0) + 1);
  }
  const perRep = [...sessionsByRep.values()].sort((a, b) => b - a);
  const sessionsDelivered = perRep.reduce((s, n) => s + n, 0);
  const top5 = perRep.slice(0, 5).reduce((s, n) => s + n, 0);
  const topFocusShare = sessionsDelivered > 0 ? top5 / sessionsDelivered : null;
  const overFocusedCount = perRep.filter((n) => n >= 3).length;
  const scores = coachedRows.map((r) => r.averageScore).filter((s): s is number => s != null);
  const avgScoreGiven = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  const concentratedReps: TmRepRef[] = coachedRows
    .slice(0, 6)
    .map((r) => ({ hrId: r.hrId, name: r.medicalRepName, line: r.lineName, count: r.coachingCount }));
  const neglectedReps: TmRepRef[] = comparison.rows
    .filter((r) => r.coachingCount === 0)
    .slice(0, 12)
    .map((r) => ({ hrId: r.hrId, name: r.medicalRepName, line: r.lineName, count: 0 }));

  // Monthly cadence from the TM's completed authored reports.
  const monthMap = new Map<string, { sessions: number; reps: Set<string> }>();
  for (const report of reports) {
    if (!completedReportStatuses.has(report.status)) continue;
    const month = String(report.coachingDate).slice(0, 7);
    if (!month) continue;
    const entry = monthMap.get(month) ?? { sessions: 0, reps: new Set<string>() };
    entry.sessions += 1;
    entry.reps.add(String(report.medicalRepHrId).toLowerCase());
    monthMap.set(month, entry);
  }
  const monthly: TmMonthPoint[] = Array.from(monthMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, sessions: v.sessions, reps: v.reps.size }));

  // Efficiency = breadth (coverage) + effort (sessions per rep) + balance (not
  // hoarded on a few reps). Each component is 0..1; weighted to 100.
  const volumeRatio = poolSize > 0 ? Math.min(1, sessionsDelivered / poolSize) : 0;
  const balance = topFocusShare == null ? 1 : Math.max(0, 1 - topFocusShare);
  const efficiencyScore = Math.round(45 * coverageRate + 30 * volumeRatio + 25 * balance);
  const verdict: TmVerdict =
    efficiencyScore >= 65 ? "efficient" : efficiencyScore >= 40 ? "adequate" : "needs_improvement";

  const rationale =
    poolSize === 0
      ? "No active Medical Reps found to assess coverage against."
      : `Coached ${coachedByTm} of ${poolSize} field reps (${Math.round(coverageRate * 100)}% coverage) across ` +
        `${sessionsDelivered} sessions; ${neglectedByTm} reps never coached this period` +
        (topFocusShare != null ? `; top-5 reps took ${Math.round(topFocusShare * 100)}% of the coaching.` : ".");

  return {
    hasData: poolSize > 0,
    poolSize,
    coachedByTm,
    neglectedByTm,
    coverageRate,
    sessionsDelivered,
    avgScoreGiven,
    topFocusShare,
    overFocusedCount,
    concentratedReps,
    neglectedReps,
    monthly,
    efficiencyScore,
    verdict,
    rationale,
  };
}
