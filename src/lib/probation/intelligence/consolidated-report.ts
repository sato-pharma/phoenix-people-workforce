// Probation consolidated report (Phase 7). The single, always-live per-employee report — it is
// COMPUTED ON READ from the captured evidence (Phases 1-6), so it exists from day 1 and reflects
// every change immediately; there is no Day-75 batch generation. Read-only composition.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canSeeConfidentialNote } from "./assessments";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { getProbationSalesEvidence, type ProbationSalesEvidence } from "./sales-evidence";

import { getProbationConfig } from "./config";
import { getProbationCaseByEmployee, mapProbationCaseRow } from "./cases";
import { getCaseAssessments, getSfeEvidencePreview } from "./assessments";
import { listDevelopmentActionsByCase } from "./dev-actions";
import { getCaseScore } from "./scoring-service";
import { computeFeedbackSla, type FeedbackSlaState } from "./feedback-sla";
import { currentProbationDay, milestoneStatuses, computeDvProgress, type DvDayLite } from "./report-metrics";
import { probationDaysRemaining } from "@/lib/probation/date";
import type { ProbationCase, ProbationEvaluatorRole, ProbationRecommendation } from "./types";
import { isUuid } from "@/lib/http/uuid";

const STALE_SYNC_HOURS = 48;

type DvDayRow = {
  id: string; evaluator_hr_id: string | null; evaluator_role: ProbationEvaluatorRole | null;
  dv_date: string; ampm: string | null; area_name: string | null; visit_count: number;
  dv_status: string; validation_reason: string | null; synced_at: string | null;
};
type VisitRow = {
  dv_day_id: string; crm_visit_id: number | null; contact_name: string | null;
  comment: string | null; visit_type_description: string | null; ampm: string | null; visit_date: string | null;
};
type FeedbackRow = {
  id: string; dv_day_id: string; evaluator_role: ProbationEvaluatorRole | null;
  scores: Record<string, number> | null; strengths: string | null; development_areas: string | null;
  recommendation: ProbationRecommendation | null; status: string; current_version: number;
  submitted_by: string | null; submitted_at: string;
};

export type ConsolidatedReport = {
  case: ProbationCase & { currentProbationDay: number | null; daysRemaining: number | null };
  milestones: ReturnType<typeof milestoneStatuses>;
  dvProgress: ReturnType<typeof computeDvProgress>;
  dvDays: Array<{
    id: string; dvDate: string; evaluatorRole: ProbationEvaluatorRole | null; evaluatorHrId: string | null;
    evaluatorName: string | null;
    ampm: string | null; areaName: string | null; visitCount: number; dvStatus: string;
    validationReason: string | null;
    visits: Array<{ crmVisitId: number | null; contactName: string | null; comment: string | null; visitType: string | null; ampm: string | null }>;
    feedback: { id: string; score: number | null; recommendation: ProbationRecommendation | null; version: number; submittedAt: string } | null;
    sla: { state: FeedbackSlaState; hoursOverdue: number } | null;
  }>;
  assessments: Awaited<ReturnType<typeof getCaseAssessments>>;
  sfeEvidence: Awaited<ReturnType<typeof getSfeEvidencePreview>> | null;
  /** The territory's published sales against target over the probation months. Display only; no score reads it. */
  salesEvidence: ProbationSalesEvidence | null;
  score: Awaited<ReturnType<typeof getCaseScore>>["score"];
  contradictions: Awaited<ReturnType<typeof getCaseScore>>["contradictions"];
  provisionalReadiness: Awaited<ReturnType<typeof getCaseScore>>["provisionalReadiness"];
  slaBreaches: Array<{ dvDayId: string; dvDate: string; state: FeedbackSlaState; hoursOverdue: number }>;
  developmentActions: Array<Awaited<ReturnType<typeof listDevelopmentActionsByCase>>[number] & { ownerName: string | null }>;
  auditTimeline: Array<{ at: string; kind: string; detail: string; actor: string | null }>;
  dataFreshness: { lastCrmSyncAt: string | null; lastReportUpdateAt: string | null; generatedAt: string; stale: boolean };
  generatedAt: string;
};

function mean(scores: Record<string, number> | null): number | null {
  const v = Object.values(scores ?? {}).map(Number).filter(Number.isFinite);
  if (v.length === 0) return null;
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;
}

async function loadCaseById(caseId: string): Promise<ProbationCase | null> {
  // A malformed id is NOT FOUND, not a fault: this is a uuid column, and Postgres answers a
  // non-uuid with 22P02 from the WHERE clause instead of with no rows, which leaves as a 500.
  if (!isUuid(caseId)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("probation_cases")
    .select("*")
    .eq("id", caseId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapProbationCaseRow(data as Parameters<typeof mapProbationCaseRow>[0]) : null;
}

export async function buildConsolidatedReport(
  access: AccessContext,
  caseId: string,
  nowIso: string = new Date().toISOString(),
): Promise<ConsolidatedReport> {
  // Africa/Cairo calendar day (not a naive UTC slice of nowIso) — must stay derived from the
  // same instant as daysRemaining below so the two never visibly disagree near the nightly
  // Cairo/UTC boundary.
  const today = currentCairoDateOnlyIso(new Date(nowIso));
  const supabase = getSupabaseAdmin();
  const config = await getProbationConfig();

  const probationCase = await loadCaseById(caseId);
  if (!probationCase) throw new Error("Not found: probation case does not exist.");

  const [{ data: dvRows }, { data: fbRows }, assessments, score, sfeEvidence, developmentActions, salesEvidence] = await Promise.all([
    supabase.from("probation_dv_days")
      .select("id, evaluator_hr_id, evaluator_role, dv_date, ampm, area_name, visit_count, dv_status, validation_reason, synced_at")
      .eq("case_id", caseId).order("dv_date", { ascending: true }),
    supabase.from("probation_feedback")
      .select("id, dv_day_id, evaluator_role, scores, strengths, development_areas, recommendation, status, current_version, submitted_by, submitted_at")
      .eq("case_id", caseId),
    getCaseAssessments(access, caseId),
    getCaseScore(caseId, nowIso),
    getSfeEvidencePreview(caseId).catch(() => null),
    listDevelopmentActionsByCase(caseId).catch(() => []),
    (await canAccess(access, "sales", "read"))
      ? getProbationSalesEvidence({
          employeeHrId: probationCase.employeeHrId,
          endDate: probationCase.probationEndDate,
          startDate: probationCase.probationStartDate ?? probationCase.hireDate,
          todayIso: today,
          viewerRole: access.role,
        })
      : null,
  ]);

  const dvDays = (dvRows ?? []) as DvDayRow[];
  const feedbacks = (fbRows ?? []) as FeedbackRow[];
  const feedbackByDvDay = new Map(feedbacks.map((f) => [f.dv_day_id, f]));

  // Resolve display names for the case's own employee, evaluators, AND development-action owners
  // (show names, not HR codes).
  const nameHrIds = Array.from(new Set([
    probationCase.employeeHrId,
    ...dvDays.map((d) => d.evaluator_hr_id),
    ...developmentActions.map((a) => a.ownerHrId),
  ].filter((x): x is string => Boolean(x))));
  const evaluatorNameByHrId = new Map<string, string>();
  if (nameHrIds.length > 0) {
    const { data: emps } = await supabase.from("employees").select("hr_id, full_name, nickname").in("hr_id", nameHrIds);
    for (const e of (emps ?? []) as Array<{ hr_id: string; full_name: string | null; nickname: string | null }>) {
      if (e.full_name) evaluatorNameByHrId.set(e.hr_id.toLowerCase(), resolveEmployeeDisplayName(e.full_name, e.nickname));
    }
  }

  // Visit evidence for the DV-Days.
  const dvDayIds = dvDays.map((d) => d.id);
  let visitsByDay = new Map<string, VisitRow[]>();
  if (dvDayIds.length > 0) {
    const { data: vRows } = await supabase
      .from("probation_dv_visits")
      .select("dv_day_id, crm_visit_id, contact_name, comment, visit_type_description, ampm, visit_date")
      .in("dv_day_id", dvDayIds);
    visitsByDay = new Map();
    for (const v of (vRows ?? []) as VisitRow[]) {
      const arr = visitsByDay.get(v.dv_day_id) ?? [];
      arr.push(v);
      visitsByDay.set(v.dv_day_id, arr);
    }
  }

  const canSeeConfidential = canSeeConfidentialNote(access);
  const slaBreaches: ConsolidatedReport["slaBreaches"] = [];

  const dvDaysOut = dvDays.map((d) => {
    const fb = feedbackByDvDay.get(d.id) ?? null;
    // SLA applies only while a validated DV-Day has no feedback yet.
    let sla: { state: FeedbackSlaState; hoursOverdue: number } | null = null;
    if (d.dv_status === "validated" && !fb) {
      const s = computeFeedbackSla(d.dv_date, nowIso, config.sla, d.synced_at ?? null);
      sla = { state: s.state, hoursOverdue: s.hoursOverdue };
      if (s.state === "due" || s.state === "escalated" || s.state === "overdue") {
        slaBreaches.push({ dvDayId: d.id, dvDate: d.dv_date, state: s.state, hoursOverdue: s.hoursOverdue });
      }
    }
    return {
      id: d.id, dvDate: d.dv_date, evaluatorRole: d.evaluator_role, evaluatorHrId: d.evaluator_hr_id,
      evaluatorName: d.evaluator_hr_id ? evaluatorNameByHrId.get(d.evaluator_hr_id.toLowerCase()) ?? null : null,
      ampm: d.ampm, areaName: d.area_name, visitCount: d.visit_count, dvStatus: d.dv_status,
      validationReason: d.validation_reason,
      visits: (visitsByDay.get(d.id) ?? []).map((v) => ({
        crmVisitId: v.crm_visit_id, contactName: v.contact_name,
        // Comments can carry sensitive text; only reveal to HR/CEO.
        comment: canSeeConfidential ? v.comment : null,
        visitType: v.visit_type_description, ampm: v.ampm,
      })),
      feedback: fb ? { id: fb.id, score: mean(fb.scores), recommendation: fb.recommendation, version: fb.current_version, submittedAt: fb.submitted_at } : null,
      sla,
    };
  });

  const dvProgress = computeDvProgress(
    dvDays.map<DvDayLite>((d) => ({ evaluatorRole: d.evaluator_role, dvStatus: d.dv_status })),
    config,
  );

  // Event-sourced audit timeline (from the records themselves).
  const timeline: ConsolidatedReport["auditTimeline"] = [];
  timeline.push({ at: probationCase.createdAt, kind: "case_created", detail: `Probation case opened (${probationCase.source})`, actor: probationCase.createdBy });
  for (const d of dvDays) {
    if (d.synced_at) timeline.push({ at: d.synced_at, kind: "dv_captured", detail: `DV-Day ${d.dv_date} captured (${d.evaluator_role ?? "?"}, ${d.dv_status})`, actor: null });
  }
  for (const f of feedbacks) {
    timeline.push({ at: f.submitted_at, kind: "feedback", detail: `${f.evaluator_role?.toUpperCase() ?? "?"} feedback ${f.status} (v${f.current_version})`, actor: f.submitted_by });
  }
  if (probationCase.decisionAt) {
    timeline.push({ at: probationCase.decisionAt, kind: "decision", detail: `Decision: ${probationCase.decision}`, actor: probationCase.decisionBy });
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));

  const lastSync = probationCase.lastCrmSyncAt;
  const stale = lastSync ? (new Date(nowIso).getTime() - new Date(lastSync).getTime()) / 3_600_000 > STALE_SYNC_HOURS : true;

  return {
    case: {
      ...probationCase,
      employeeName: evaluatorNameByHrId.get(probationCase.employeeHrId.toLowerCase()) ?? probationCase.employeeName,
      currentProbationDay: currentProbationDay(probationCase.hireDate, today),
      daysRemaining: probationDaysRemaining(probationCase.hireDate, new Date(nowIso)),
    },
    milestones: milestoneStatuses(probationCase.hireDate, today),
    dvProgress,
    dvDays: dvDaysOut,
    assessments,
    sfeEvidence,
    salesEvidence,
    score: score.score,
    contradictions: score.contradictions,
    provisionalReadiness: score.provisionalReadiness,
    slaBreaches,
    developmentActions: developmentActions.map((a) => ({
      ...a,
      ownerName: a.ownerHrId ? evaluatorNameByHrId.get(a.ownerHrId.toLowerCase()) ?? null : null,
    })),
    auditTimeline: timeline,
    dataFreshness: {
      lastCrmSyncAt: lastSync,
      lastReportUpdateAt: probationCase.lastReportUpdateAt,
      generatedAt: nowIso,
      stale,
    },
    generatedAt: nowIso,
  };
}

/** Resolve a report by employee HR_ID (portal convenience). */
export async function buildConsolidatedReportByEmployee(
  access: AccessContext,
  employeeHrId: string,
  nowIso: string = new Date().toISOString(),
): Promise<ConsolidatedReport | null> {
  const probationCase = await getProbationCaseByEmployee(employeeHrId);
  if (!probationCase) return null;
  return buildConsolidatedReport(access, probationCase.id, nowIso);
}
