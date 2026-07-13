// Probation feedback workflow (Phase 4: P4-T01/T02 tasks, T04 submit, T05 auth, T08 versioning,
// T09 dedup, T10 SLA/status surfacing).
//
// A "feedback task" is a validated DV-Day that has no feedback yet. It is OWNED by the DV-Day's
// evaluator (the person who actually did the double visit, resolved from CRM). Authorization is
// therefore ROW-LEVEL — you may submit/edit feedback for a DV-Day iff you are its evaluator, or
// you are a probation administrator acting via an audited override. This resolves the audit's
// permission contradiction (managers could see the form but a Super-Admin-only probation:update
// blocked them): the route uses the low bar probation:read, and this row-level check is the real
// boundary.

import { writeAuditLog } from "@/lib/admin/audit";
import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isProbationAdministrator } from "@/lib/probation/service";

import { assertCaseAcceptsSubmissions } from "./cases";
import { createDevelopmentActions, type DevelopmentActionInput } from "./dev-actions";
import { getProbationConfig } from "./config";
import { computeFeedbackSla, type FeedbackSlaStatus } from "./feedback-sla";
import { validateScorecard, type ScorecardInput } from "./scorecard";
import type {
  ProbationEvaluatorRole,
  ProbationFeedback,
  ProbationRecommendation,
  ProbationScorecard,
} from "./types";

function norm(value: string | null | undefined): string {
  return normalizeHrId(value) ?? String(value ?? "").trim().toLowerCase();
}

// ── Authorization (P4-T05) ──────────────────────────────────────────────────

export type FeedbackAuth = { canAct: boolean; isOwner: boolean; isOverride: boolean };

/** Row-level authorization: caller is the DV-Day's evaluator, or an audited admin override. */
export function resolveFeedbackAuth(
  access: Pick<AccessContext, "role" | "scope" | "hrId">,
  evaluatorHrId: string | null,
): FeedbackAuth {
  const isOwner = Boolean(access.hrId && evaluatorHrId && norm(access.hrId) === norm(evaluatorHrId));
  const isAdmin = isProbationAdministrator(access);
  return { canAct: isOwner || isAdmin, isOwner, isOverride: isAdmin && !isOwner };
}

// ── Types ───────────────────────────────────────────────────────────────────

type DvDayRow = {
  id: string;
  case_id: string | null;
  employee_hr_id: string;
  evaluator_hr_id: string | null;
  evaluator_role: ProbationEvaluatorRole | null;
  dv_date: string;
  dv_status: string;
  visit_count: number;
  created_at?: string | null;
};

export type FeedbackTask = {
  dvDayId: string;
  caseId: string | null;
  employeeHrId: string;
  evaluatorHrId: string | null;
  evaluatorRole: ProbationEvaluatorRole | null;
  dvDate: string;
  visitCount: number;
  /** When the DV-Day row was created (SLA anchor floor — the task becomes actionable at capture time). */
  createdAt: string | null;
  sla: FeedbackSlaStatus;
};

export type SubmitFeedbackInput = ScorecardInput & {
  /** Optional structured development actions to open from this feedback (E1). */
  developmentActions?: DevelopmentActionInput[];
};

// ── Row mapping ───────────────────────────────────────────────────────────────

type FeedbackRow = {
  id: string; dv_day_id: string; case_id: string | null; employee_hr_id: string;
  evaluator_hr_id: string; evaluator_role: ProbationEvaluatorRole | null;
  scores: ProbationScorecard; strengths: string | null; development_areas: string | null;
  objective_observations: string | null; recommendation: ProbationRecommendation | null;
  confidential_note: string | null; status: "submitted" | "edited"; current_version: number;
  submitted_by: string | null; submitted_at: string; created_at: string; updated_at: string;
};

function mapFeedback(row: FeedbackRow): ProbationFeedback {
  return {
    id: row.id, dvDayId: row.dv_day_id, caseId: row.case_id, employeeHrId: row.employee_hr_id,
    evaluatorHrId: row.evaluator_hr_id, evaluatorRole: row.evaluator_role, scores: row.scores ?? {},
    strengths: row.strengths, developmentAreas: row.development_areas,
    objectiveObservations: row.objective_observations, recommendation: row.recommendation,
    confidentialNote: row.confidential_note, status: row.status, currentVersion: row.current_version,
    submittedBy: row.submitted_by, submittedAt: row.submitted_at, createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const FEEDBACK_COLUMNS =
  "id, dv_day_id, case_id, employee_hr_id, evaluator_hr_id, evaluator_role, scores, strengths, " +
  "development_areas, objective_observations, recommendation, confidential_note, status, " +
  "current_version, submitted_by, submitted_at, created_at, updated_at";

// ── Feedback tasks (P4-T01/T02/T10) ──────────────────────────────────────────

/**
 * Open feedback tasks: validated DV-Days without feedback yet. An evaluator sees only their own;
 * a probation administrator sees all. Each task carries its SLA status.
 */
export async function listFeedbackTasks(
  access: AccessContext,
  nowIso: string = new Date().toISOString(),
): Promise<FeedbackTask[]> {
  const supabase = getSupabaseAdmin();
  const config = await getProbationConfig();

  let query = supabase
    .from("probation_dv_days")
    .select("id, case_id, employee_hr_id, evaluator_hr_id, evaluator_role, dv_date, dv_status, visit_count, created_at")
    .eq("dv_status", "validated");
  if (!isProbationAdministrator(access)) {
    query = query.ilike("evaluator_hr_id", norm(access.hrId));
  }
  const { data, error } = await query.order("dv_date", { ascending: true });
  if (error) throw error;

  const rows = (data ?? []) as DvDayRow[];
  if (rows.length === 0) return [];

  // Exclude DV-Days that already have feedback (defense-in-depth; validated status should imply none).
  const dvDayIds = rows.map((r) => r.id);
  const { data: fb } = await supabase
    .from("probation_feedback")
    .select("dv_day_id")
    .in("dv_day_id", dvDayIds);
  const withFeedback = new Set(((fb ?? []) as Array<{ dv_day_id: string }>).map((r) => r.dv_day_id));

  return rows
    .filter((r) => !withFeedback.has(r.id))
    .map((r) => ({
      dvDayId: r.id,
      caseId: r.case_id,
      employeeHrId: r.employee_hr_id,
      evaluatorHrId: r.evaluator_hr_id,
      evaluatorRole: r.evaluator_role,
      dvDate: r.dv_date,
      visitCount: r.visit_count,
      createdAt: r.created_at ?? null,
      sla: computeFeedbackSla(r.dv_date, nowIso, config.sla, r.created_at ?? null),
    }));
}

async function loadDvDay(dvDayId: string): Promise<DvDayRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("probation_dv_days")
    .select("id, case_id, employee_hr_id, evaluator_hr_id, evaluator_role, dv_date, dv_status, visit_count")
    .eq("id", dvDayId)
    .maybeSingle();
  if (error) throw error;
  return (data as DvDayRow | null) ?? null;
}

// ── Submit feedback (P4-T04/T09) ─────────────────────────────────────────────

export async function submitDvFeedback(
  access: AccessContext,
  dvDayId: string,
  input: SubmitFeedbackInput,
): Promise<ProbationFeedback> {
  const dvDay = await loadDvDay(dvDayId);
  if (!dvDay) throw new Error("Not found: DV-Day does not exist.");

  const auth = resolveFeedbackAuth(access, dvDay.evaluator_hr_id);
  if (!auth.canAct) {
    throw new Error("Forbidden: only the DV-Day evaluator (or a probation administrator) may submit this feedback.");
  }
  if (dvDay.dv_status !== "validated" && dvDay.dv_status !== "feedback_pending") {
    throw new Error(`Invalid state: feedback can only be submitted for a validated DV-Day (current: ${dvDay.dv_status}).`);
  }
  await assertCaseAcceptsSubmissions(dvDay.case_id);

  const config = await getProbationConfig();
  const check = validateScorecard(input, config);
  if (!check.ok) throw new Error(`Validation failed: ${check.errors.join(" ")}`);

  const supabase = getSupabaseAdmin();

  // P4-T09 dedup: exactly one active feedback per DV-Day (unique dv_day_id also enforces this).
  const { data: existing } = await supabase
    .from("probation_feedback")
    .select("id")
    .eq("dv_day_id", dvDayId)
    .maybeSingle();
  if (existing) {
    throw new Error("Conflict: feedback already exists for this DV-Day. Edit the existing feedback instead.");
  }

  const now = new Date().toISOString();
  const actorHrId = norm(access.hrId) || access.loginId || access.role;

  const { data: inserted, error: insErr } = await supabase
    .from("probation_feedback")
    .insert({
      dv_day_id: dvDayId,
      case_id: dvDay.case_id,
      employee_hr_id: dvDay.employee_hr_id,
      evaluator_hr_id: dvDay.evaluator_hr_id,
      evaluator_role: dvDay.evaluator_role,
      scores: check.scores,
      strengths: input.strengths ?? null,
      development_areas: input.developmentAreas ?? null,
      objective_observations: input.objectiveObservations ?? null,
      recommendation: check.recommendation,
      confidential_note: input.confidentialNote ?? null,
      status: "submitted",
      current_version: 1,
      submitted_by: actorHrId,
      submitted_at: now,
      updated_at: now,
    })
    .select(FEEDBACK_COLUMNS)
    .single();
  if (insErr) throw insErr;
  const feedback = mapFeedback(inserted as unknown as FeedbackRow);

  // Immutable version 1 (P4-T08).
  await supabase.from("probation_feedback_versions").insert({
    feedback_id: feedback.id,
    version_number: 1,
    action: "submit",
    edited_by: actorHrId,
    edit_reason: null,
    snapshot: snapshotOf(feedback),
    scores: check.scores,
    recommendation: check.recommendation,
  });

  // DV-Day advances to feedback_completed.
  await supabase.from("probation_dv_days").update({ dv_status: "feedback_completed", updated_at: now }).eq("id", dvDayId);

  // Optional development actions opened from this feedback (E1). Best-effort; never fails the submit.
  if (input.developmentActions && input.developmentActions.length > 0) {
    await createDevelopmentActions({
      caseId: dvDay.case_id,
      dvDayId,
      employeeHrId: dvDay.employee_hr_id,
      actions: input.developmentActions,
      createdBy: actorHrId,
    }).catch(() => undefined);
  }

  await writeAuditLog({
    actorLoginId: access.loginId ?? actorHrId,
    entityType: "probation_feedback",
    entityId: feedback.id,
    newValues: { dvDayId, recommendation: check.recommendation, override: auth.isOverride },
    summary: `Probation DV feedback submitted for ${dvDay.employee_hr_id}${auth.isOverride ? " (admin override)" : ""}`,
  });

  return feedback;
}

// ── Edit feedback with versioning (P4-T08) ───────────────────────────────────

export async function editDvFeedback(
  access: AccessContext,
  feedbackId: string,
  input: SubmitFeedbackInput,
  editReason: string,
): Promise<ProbationFeedback> {
  if (!editReason || !editReason.trim()) {
    throw new Error("Validation failed: an edit reason is required.");
  }

  const supabase = getSupabaseAdmin();
  const { data: currentRow, error: loadErr } = await supabase
    .from("probation_feedback")
    .select(FEEDBACK_COLUMNS)
    .eq("id", feedbackId)
    .maybeSingle();
  if (loadErr) throw loadErr;
  if (!currentRow) throw new Error("Not found: feedback does not exist.");
  const current = mapFeedback(currentRow as unknown as FeedbackRow);

  const auth = resolveFeedbackAuth(access, current.evaluatorHrId);
  if (!auth.canAct) {
    throw new Error("Forbidden: only the original evaluator (or a probation administrator) may edit this feedback.");
  }

  const config = await getProbationConfig();
  const check = validateScorecard(input, config);
  if (!check.ok) throw new Error(`Validation failed: ${check.errors.join(" ")}`);

  const now = new Date().toISOString();
  const actorHrId = norm(access.hrId) || access.loginId || access.role;
  const nextVersion = current.currentVersion + 1;

  // Snapshot the PRIOR version before overwriting (preserve original + all edits).
  await supabase.from("probation_feedback_versions").insert({
    feedback_id: feedbackId,
    version_number: nextVersion,
    action: "edit",
    edited_by: actorHrId,
    edit_reason: editReason.trim(),
    snapshot: { previous: snapshotOf(current), next: { scores: check.scores, recommendation: check.recommendation } },
    scores: check.scores,
    recommendation: check.recommendation,
  });

  const { data: updated, error: updErr } = await supabase
    .from("probation_feedback")
    .update({
      scores: check.scores,
      strengths: input.strengths ?? null,
      development_areas: input.developmentAreas ?? null,
      objective_observations: input.objectiveObservations ?? null,
      recommendation: check.recommendation,
      confidential_note: input.confidentialNote ?? null,
      status: "edited",
      current_version: nextVersion,
      updated_at: now,
    })
    .eq("id", feedbackId)
    .select(FEEDBACK_COLUMNS)
    .single();
  if (updErr) throw updErr;

  await writeAuditLog({
    actorLoginId: access.loginId ?? actorHrId,
    entityType: "probation_feedback",
    entityId: feedbackId,
    oldValues: { version: current.currentVersion, scores: current.scores, recommendation: current.recommendation },
    newValues: { version: nextVersion, scores: check.scores, recommendation: check.recommendation, editReason: editReason.trim(), override: auth.isOverride },
    summary: `Probation DV feedback edited (v${nextVersion}) for ${current.employeeHrId}`,
  });

  return mapFeedback(updated as unknown as FeedbackRow);
}

function snapshotOf(fb: ProbationFeedback): Record<string, unknown> {
  return {
    scores: fb.scores,
    strengths: fb.strengths,
    developmentAreas: fb.developmentAreas,
    objectiveObservations: fb.objectiveObservations,
    recommendation: fb.recommendation,
    confidentialNote: fb.confidentialNote,
    version: fb.currentVersion,
  };
}
