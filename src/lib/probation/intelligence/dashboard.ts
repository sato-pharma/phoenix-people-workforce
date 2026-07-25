// Probation CEO exception dashboard rollup (Phase 8, P8-T01).
//
// PERFORMANCE: loads ALL active cases and their DV-days / feedback / assessments in a handful of
// BULK queries, then reuses the pure engines (scoring, progress, contradictions, classification)
// in memory per case — no per-case DB round-trips and no per-case report build. Read-only.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";

import { getProbationConfig } from "./config";
import { filterResolvedProbationCases } from "./cases";
import { computeProbationScore, type FeedbackScoreInput } from "./scoring";
import { detectContradictions } from "./contradictions";
import { computeDvProgress, currentProbationDay, milestoneStatuses, type DvDayLite } from "./report-metrics";
import { computeFeedbackSla } from "./feedback-sla";
import { classifyRisk, exceptionFlags, RISK_LABEL, type RiskLevel, type ExceptionFlags } from "./dashboard-classify";
import { buildMappedAgentKeySet, isCrmUnmapped } from "./dashboard-crm-mapping";
import { getMappedAgentHrIds } from "@/lib/crm/reads";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { probationDaysRemaining } from "@/lib/probation/date";
import { countUnresolvedProvisioningFailures } from "@/lib/probation/provisioning";
import type { ProbationEvaluatorRole, ProbationRecommendation } from "./types";

export type DashboardRow = {
  caseId: string;
  employeeHrId: string;
  employeeName: string | null;
  jobTitle: string | null;
  lineName: string | null;
  managerName: string | null;
  hireDate: string | null;
  currentDay: number | null;
  daysRemaining: number | null;
  dvRequired: number;
  dvFeedbackCompleted: number;
  feedbackPending: number;
  feedbackOverdue: number;
  hrStatus: "submitted" | "pending";
  sfeStatus: "submitted" | "pending";
  provisionalScore: number | null;
  finalScore: number | null;
  decisionReady: boolean;
  contradictionsCount: number;
  openActions: number;
  crmUnmapped: boolean;
  risk: RiskLevel;
  riskLabel: string;
  flags: ExceptionFlags;
  lastUpdate: string;
};

export type ProbationDashboard = {
  rows: DashboardRow[];
  summary: {
    total: number;
    onTrack: number;
    actionRequired: number;
    deadlineRisk: number;
    insufficientData: number;
    readyForDecision: number;
    overdueFeedback: number;
    contradictions: number;
    crmUnmapped: number;
    provisioningFailures: number;
  };
  generatedAt: string;
};

type CaseRow = {
  id: string; employee_hr_id: string; employee_name: string | null; job_title: string | null;
  line_name: string | null; manager_hr_id: string | null; hire_date: string | null;
  updated_at: string;
};
type DvRow = { case_id: string | null; evaluator_role: ProbationEvaluatorRole | null; dv_date: string; dv_status: string };
type FbRow = { case_id: string | null; dv_day_id: string; evaluator_role: ProbationEvaluatorRole | null; scores: Record<string, number> | null; recommendation: ProbationRecommendation | null };
type AssessRow = { case_id: string; kind: "sfe" | "hr"; score: number | null; status: string };

function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  return m;
}

export async function getProbationDashboard(nowIso: string = new Date().toISOString()): Promise<ProbationDashboard> {
  // Africa/Cairo calendar day, not a naive UTC slice of nowIso — Cairo is ahead of UTC, so a
  // UTC-slice can read "yesterday" for a few hours every night. currentDay (below, via
  // report-metrics' currentProbationDay) and daysRemaining (via probationDaysRemaining, which
  // independently resolves the same nowIso instant through the same Cairo primitive) must derive
  // from the same underlying instant so they can never visibly disagree near the boundary.
  const today = currentCairoDateOnlyIso(new Date(nowIso));
  const supabase = getSupabaseAdmin();
  const config = await getProbationConfig();

  const { data: caseData, error: cErr } = await supabase
    .from("probation_cases")
    .select("id, employee_hr_id, employee_name, job_title, line_name, manager_hr_id, hire_date, updated_at")
    .eq("status", "active");
  if (cErr) throw cErr;
  // Defense-in-depth (legacy-decision desync): a case can be stranded status='active' with the
  // employee already resolved via the LEGACY workflow (employee_probation passed/terminated OR a
  // terminal employment_status) if the outcome wasn't mirrored into probation_cases. Drop those in
  // memory so the dashboard never shows a permanently "active" phantom case. Fails OPEN — a lookup
  // error leaves the list exactly as loaded today.
  const cases = await filterResolvedProbationCases((caseData ?? []) as CaseRow[]);
  if (cases.length === 0) {
    return { rows: [], summary: { total: 0, onTrack: 0, actionRequired: 0, deadlineRisk: 0, insufficientData: 0, readyForDecision: 0, overdueFeedback: 0, contradictions: 0, crmUnmapped: 0, provisioningFailures: await countUnresolvedProvisioningFailures() }, generatedAt: nowIso };
  }
  const caseIds = cases.map((c) => c.id);

  // Bulk-load the children + manager names.
  const managerHrIds = Array.from(new Set(cases.map((c) => c.manager_hr_id).filter((x): x is string => Boolean(x))));
  const nameLookupHrIds = Array.from(new Set([...cases.map((c) => c.employee_hr_id), ...managerHrIds]));
  // Widen the CRM lookup with casing variants so a real casing difference between probation_cases and
  // ireports360_visits doesn't produce a false "unmapped" badge (canonical compare happens after).
  const caseHrIds = Array.from(
    new Set(
      cases.flatMap((c) => {
        const raw = c.employee_hr_id;
        const upper = canonicalHrIdForDisplay(raw);
        return [raw, raw.toUpperCase(), raw.toLowerCase(), upper].filter((x): x is string => Boolean(x));
      }),
    ),
  );
  const [dvRes, fbRes, asRes, mgrRes, daRes, mappedAgentHrIds] = await Promise.all([
    supabase.from("probation_dv_days").select("case_id, evaluator_role, dv_date, dv_status").in("case_id", caseIds),
    supabase.from("probation_feedback").select("case_id, dv_day_id, evaluator_role, scores, recommendation").in("case_id", caseIds),
    supabase.from("probation_assessments").select("case_id, kind, score, status").in("case_id", caseIds),
    nameLookupHrIds.length > 0
      ? supabase.from("employees").select("hr_id, full_name, nickname").in("hr_id", nameLookupHrIds)
      : Promise.resolve({ data: [] as Array<{ hr_id: string; full_name: string | null; nickname: string | null }> }),
    supabase.from("probation_development_actions").select("case_id, status").in("case_id", caseIds),
    // CRM identity-mapping check (E6): which probation reps actually appear as a CRM agent, via the
    // CRM single-door presence reader. No resigned-exclusion here on purpose — a present-but-excluded
    // agent is still "mapped", so they must not be mislabeled a CRM data gap.
    getMappedAgentHrIds(caseHrIds),
  ]);

  const dvByCase = groupBy((dvRes.data ?? []) as DvRow[], (r) => r.case_id);
  const fbByCase = groupBy((fbRes.data ?? []) as FbRow[], (r) => r.case_id);
  const asByCase = groupBy((asRes.data ?? []) as AssessRow[], (r) => r.case_id);
  const daByCase = groupBy((daRes.data ?? []) as Array<{ case_id: string | null; status: string }>, (r) => r.case_id);
  const mappedAgentKeys = buildMappedAgentKeySet(mappedAgentHrIds);
  const mgrName = new Map<string, string>();
  for (const m of ((mgrRes.data ?? []) as Array<{ hr_id: string; full_name: string | null; nickname: string | null }>)) {
    if (m.full_name) mgrName.set(m.hr_id.toLowerCase(), resolveEmployeeDisplayName(m.full_name, m.nickname));
  }

  const rows: DashboardRow[] = cases.map((c) => {
    const dvDays = dvByCase.get(c.id) ?? [];
    const feedbacks = fbByCase.get(c.id) ?? [];
    const assessments = asByCase.get(c.id) ?? [];
    const openActions = (daByCase.get(c.id) ?? []).filter((a) => a.status === "open").length;
    const crmUnmapped = isCrmUnmapped(c.employee_hr_id, mappedAgentKeys);

    const scoringFeedbacks: FeedbackScoreInput[] = feedbacks
      .filter((f): f is FbRow & { evaluator_role: ProbationEvaluatorRole } => f.evaluator_role != null)
      .map((f) => ({ dvDayId: f.dv_day_id, role: f.evaluator_role, scores: f.scores ?? {}, recommendation: f.recommendation }));

    const sfe = assessments.find((a) => a.kind === "sfe" && a.status === "submitted");
    const hr = assessments.find((a) => a.kind === "hr" && a.status === "submitted");
    const sfeScore = sfe?.score ?? null;
    const hrScore = hr?.score ?? null;

    const score = computeProbationScore({ feedbacks: scoringFeedbacks, sfeScore, hrScore }, config);
    const contradictions = detectContradictions(score, scoringFeedbacks);
    const progress = computeDvProgress(dvDays.map<DvDayLite>((d) => ({ evaluatorRole: d.evaluator_role, dvStatus: d.dv_status })), config);

    // Overdue feedback: validated DV-days without feedback whose SLA is overdue.
    const dvIdsWithFeedback = new Set(feedbacks.map((f) => f.dv_day_id));
    void dvIdsWithFeedback; // feedback is keyed by dv_day_id; open DV-days are those still 'validated'
    let feedbackOverdue = 0;
    for (const d of dvDays) {
      if (d.dv_status === "validated") {
        const sla = computeFeedbackSla(d.dv_date, nowIso, config.sla);
        if (sla.state === "overdue") feedbackOverdue += 1;
      }
    }

    const milestones = milestoneStatuses(c.hire_date, today);
    const mByDay = Object.fromEntries(milestones.map((m) => [m.day, m.reached]));
    const daysRemaining = probationDaysRemaining(c.hire_date, new Date(nowIso));
    const hasHighContradiction = contradictions.some((x) => x.severity === "high");

    const signals = {
      daysRemaining,
      dvRequired: progress.totalRequired,
      dvFeedbackCompleted: progress.totalFeedbackCompleted,
      feedbackOverdue,
      provisionalScore: score.provisionalScore,
      decisionReady: score.decisionReady,
      hasHighContradiction,
      hrSubmitted: hrScore != null,
      sfeSubmitted: sfeScore != null,
      day30: Boolean(mByDay[30]),
      day60: Boolean(mByDay[60]),
      day75: Boolean(mByDay[75]),
      contradictionsCount: contradictions.length,
    };
    const risk = classifyRisk(signals);
    const flags = exceptionFlags(signals);

    return {
      caseId: c.id,
      employeeHrId: c.employee_hr_id,
      employeeName: mgrName.get(c.employee_hr_id.toLowerCase()) ?? c.employee_name,
      jobTitle: c.job_title,
      lineName: c.line_name,
      managerName: c.manager_hr_id ? mgrName.get(c.manager_hr_id.toLowerCase()) ?? null : null,
      hireDate: c.hire_date,
      currentDay: currentProbationDay(c.hire_date, today),
      daysRemaining,
      dvRequired: progress.totalRequired,
      dvFeedbackCompleted: progress.totalFeedbackCompleted,
      feedbackPending: Math.max(0, progress.totalRequired - progress.totalFeedbackCompleted),
      feedbackOverdue,
      hrStatus: hrScore != null ? "submitted" : "pending",
      sfeStatus: sfeScore != null ? "submitted" : "pending",
      provisionalScore: score.provisionalScore,
      finalScore: score.finalScore,
      decisionReady: score.decisionReady,
      contradictionsCount: contradictions.length,
      openActions,
      crmUnmapped,
      risk,
      riskLabel: RISK_LABEL[risk],
      flags,
      lastUpdate: c.updated_at,
    };
  });

  // Exception-first ordering: red → amber → grey → green, then fewer days remaining first.
  const riskOrder: Record<RiskLevel, number> = { red: 0, amber: 1, grey: 2, green: 3 };
  rows.sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || (a.daysRemaining ?? 999) - (b.daysRemaining ?? 999));

  const summary = {
    total: rows.length,
    onTrack: rows.filter((r) => r.risk === "green").length,
    actionRequired: rows.filter((r) => r.risk === "amber").length,
    deadlineRisk: rows.filter((r) => r.risk === "red").length,
    insufficientData: rows.filter((r) => r.risk === "grey").length,
    readyForDecision: rows.filter((r) => r.decisionReady).length,
    overdueFeedback: rows.filter((r) => r.feedbackOverdue > 0).length,
    contradictions: rows.filter((r) => r.contradictionsCount > 0).length,
    crmUnmapped: rows.filter((r) => r.crmUnmapped).length,
    provisioningFailures: await countUnresolvedProvisioningFailures(),
  };

  return { rows, summary, generatedAt: nowIso };
}
