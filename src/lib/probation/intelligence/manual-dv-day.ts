// Manual probation scorecards — open a DV-Day the CRM never produced.
//
// WHY THIS EXISTS (owner request 2026-08-20). The whole probation score flow is anchored on a
// DV-Day: `probation_feedback` has a NOT NULL, UNIQUE `dv_day_id`, and both the feedback inbox
// (listFeedbackTasks) and the submit gate (resolveFeedbackAuth) key off the DV-Day's
// `evaluator_hr_id`. DV-Days are only ever born from CRM double-visit activity (dv-sync.ts), so an
// evaluator can score a probationer ONLY where iReports happened to record the two of them on the
// same customer visits. Live example that surfaced this: the CNS National Sales Manager owned
// exactly 2 DV-Days — both for the same rep — so he could score that one person and nobody else,
// while `config.requirements.nsm = 1` demands an NSM component on EVERY case in his line. That
// component was unfillable, permanently blocking decision-readiness.
//
// The fix keeps the DV-Day as the single anchor and simply lets an evaluator OPEN one by hand for a
// probationer in their probation SCORING scope (filterProbationScorableHrIds — the tracker's own
// per-row rule, except that a National Sales Manager is national and may score any probationer, per
// the owner's 2026-08-20 instruction that this must not stop at his own line). Downstream is
// untouched on purpose: the row is
// an ordinary `validated` DV-Day, so it appears in the existing inbox, uses the existing structured
// scorecard form, versions and audits identically, and counts toward the same role requirement.
// A manual day is distinguishable forever by `visit_count = 0`, `crm_source_ids = []` and
// `validation_reason = MANUAL_DV_VALIDATION_REASON` — it never claims field visits that did not
// happen.
//
// Safe against the CRM sync: syncProbationDvDays inserts ON CONFLICT DO NOTHING and skips any
// (evaluator, employee, date) key already present, so a manual day is never clobbered or duplicated
// by a later sync of the same day.

import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { filterProbationScorableHrIds, isProbationSchemaMissing } from "@/lib/probation/service";
import { loadReferenceLines } from "@/lib/reference/reference-lists";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { assertCaseAcceptsSubmissions } from "./cases";
import { getProbationConfig } from "./config";
import { clampToWindow, resolveEvaluatorRole, type DvValidationContext } from "./dv-validation";
import type { ProbationEvaluatorRole } from "./types";

/** Stamped on every hand-opened DV-Day so a manual score is never mistaken for a captured field day. */
export const MANUAL_DV_VALIDATION_REASON = "manual_scorecard";

/** DV-Day statuses that still owe feedback — a caller holding one of these does not need a new day. */
const OPEN_DV_STATUSES = ["validated", "feedback_pending"] as const;

function norm(value: string | null | undefined): string {
  return normalizeHrId(value) ?? String(value ?? "").trim().toLowerCase();
}

type ActiveCaseRow = {
  id: string;
  employee_hr_id: string;
  employee_name: string | null;
  line_name: string | null;
  probation_start_date: string | null;
  probation_end_date: string | null;
};

export type ScorableProbationer = {
  caseId: string;
  employeeHrId: string;
  employeeName: string;
  /** The role THIS caller would score as, for THIS probationer (dm is a relationship, not a title). */
  evaluatorRole: ProbationEvaluatorRole;
  probationEndDate: string | null;
  /** Product line, so a cross-line list says which team each probationer belongs to. */
  lineName: string | null;
  /** An already-open DV-Day of the caller's for this rep — reuse it instead of opening another. */
  openDvDayId: string | null;
  /** Scorecards this caller has already submitted for this rep. */
  submittedCount: number;
  /** DV-Day feedbacks this role owes per case (config.requirements). 0 means optional (TM). */
  requiredCount: number;
};

/**
 * Resolve the caller's probation evaluator role for one employee, using the SAME rule the CRM
 * validation layer applies (resolveEvaluatorRole): District Manager is a relationship (the caller
 * IS this rep's manager), NSM / TM / PM|GPM come from the caller's app_auth_users role, and PM/GPM
 * is not applicable on the CNS line. Sharing that function is deliberate — a second copy here would
 * be free to drift from what the sync writes onto real DV-Days.
 */
function evaluatorRoleFor(
  callerHrId: string,
  employeeHrId: string,
  callerAppRole: string,
  managerHrId: string | null,
  lineName: string | null,
): ProbationEvaluatorRole | null {
  const ctx: DvValidationContext = {
    caseByEmployee: new Map(),
    evaluatorAppRoleByHrId: new Map([[norm(callerHrId), callerAppRole]]),
    managerHrIdByEmployee: new Map([[norm(employeeHrId), managerHrId ? norm(managerHrId) : null]]),
    existingDvDayKeys: new Set(),
  };
  return resolveEvaluatorRole(callerHrId, employeeHrId, ctx, lineName).role;
}

async function loadCallerAppRole(callerHrId: string): Promise<string> {
  const { data } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("role")
    .ilike("hr_id", callerHrId)
    .eq("is_active", true)
    .maybeSingle();
  return String((data as { role?: string } | null)?.role ?? "");
}

type EmployeeFact = {
  managerHrId: string | null;
  displayName: string | null;
  /** Lifecycle status — someone who has left is not scored, however open their case still is. */
  employmentStatus: string | null;
  lineId: number | null;
};

/** manager_hr_id, display name, lifecycle status and line for probationers, keyed by normalized HR_ID. */
async function loadEmployeeFacts(hrIds: string[]): Promise<Map<string, EmployeeFact>> {
  const facts = new Map<string, EmployeeFact>();
  if (hrIds.length === 0) return facts;
  // PostgREST folds .in() values into the URL; batch so a large cohort cannot overflow the header.
  const variants = Array.from(new Set(hrIds.flatMap((hrId) => [hrId, hrId.toUpperCase(), hrId.toLowerCase()])));
  for (let i = 0; i < variants.length; i += 100) {
    const { data } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id, manager_hr_id, full_name, nickname, employment_status, line_id")
      .in("hr_id", variants.slice(i, i + 100));
    for (const row of (data ?? []) as Array<{
      hr_id: string; manager_hr_id: string | null; full_name: string | null; nickname: string | null;
      employment_status: string | null; line_id: number | null;
    }>) {
      facts.set(norm(row.hr_id), {
        managerHrId: row.manager_hr_id,
        displayName: row.full_name ? resolveEmployeeDisplayName(row.full_name, row.nickname) : null,
        employmentStatus: row.employment_status,
        lineId: row.line_id,
      });
    }
  }
  return facts;
}

/**
 * line_id to line name. `employees.line_name` is NULL for every row in production (the text column
 * was never backfilled) and `probation_cases.line_name` is NULL on the newer cases, so the id is the
 * only reliable source. Needed because the list now spans lines: a name alone does not tell a
 * national manager which team he is scoring for.
 */
async function loadLineNames(): Promise<Map<number, string>> {
  // From the shared one-minute copy (src/lib/reference/reference-lists.ts). A failed read left the
  // map empty before — the scorecard then showed the probationer without a line — and still does.
  const rows = await loadReferenceLines().catch(() => []);
  const byId = new Map<number, string>();
  for (const row of rows) {
    if (row.id != null && row.name) byId.set(row.id, row.name);
  }
  return byId;
}

/**
 * Every probationer this caller may open a scorecard for: an active, undecided probation case,
 * inside the caller's probation read scope, for which the caller holds an eligible evaluator role.
 *
 * Returns [] (never throws) when the intelligence schema is absent, so the portal page keeps
 * rendering its tracker in an environment where the probation domain has not been migrated.
 */
export async function listScorableProbationers(access: AccessContext): Promise<ScorableProbationer[]> {
  const callerHrId = norm(access.hrId);
  if (!callerHrId) return [];

  const supabase = getSupabaseAdmin();

  let cases: ActiveCaseRow[] = [];
  try {
    const { data, error } = await supabase
      .from("probation_cases")
      .select("id, employee_hr_id, employee_name, line_name, probation_start_date, probation_end_date")
      .eq("status", "active")
      .is("decision", null)
      .order("probation_end_date", { ascending: true });
    if (error) throw error;
    cases = (data ?? []) as ActiveCaseRow[];
  } catch (error) {
    if (isProbationSchemaMissing(error)) return [];
    throw error;
  }
  if (cases.length === 0) return [];

  const caseHrIds = Array.from(new Set(cases.map((row) => norm(row.employee_hr_id)).filter(Boolean)));

  const [scorable, callerAppRole, employeeFacts, lineNames, config] = await Promise.all([
    filterProbationScorableHrIds(access, caseHrIds),
    loadCallerAppRole(callerHrId),
    loadEmployeeFacts(caseHrIds),
    loadLineNames(),
    getProbationConfig(),
  ]);

  // The caller's own DV-Days for this cohort: which are still open, and which already carry a score.
  const { data: dvRows } = await supabase
    .from("probation_dv_days")
    .select("id, employee_hr_id, dv_status")
    .ilike("evaluator_hr_id", callerHrId);
  const openDvDayByEmployee = new Map<string, string>();
  const dvDayIds: string[] = [];
  for (const row of (dvRows ?? []) as Array<{ id: string; employee_hr_id: string; dv_status: string }>) {
    dvDayIds.push(row.id);
    if ((OPEN_DV_STATUSES as readonly string[]).includes(row.dv_status)) {
      const key = norm(row.employee_hr_id);
      if (!openDvDayByEmployee.has(key)) openDvDayByEmployee.set(key, row.id);
    }
  }

  const submittedByEmployee = new Map<string, number>();
  if (dvDayIds.length > 0) {
    const { data: feedbackRows } = await supabase
      .from("probation_feedback")
      .select("employee_hr_id, dv_day_id")
      .in("dv_day_id", dvDayIds);
    for (const row of (feedbackRows ?? []) as Array<{ employee_hr_id: string }>) {
      const key = norm(row.employee_hr_id);
      submittedByEmployee.set(key, (submittedByEmployee.get(key) ?? 0) + 1);
    }
  }
  // A DV-Day the caller holds but whose feedback is still pending is not "submitted" — the map above
  // counts only real probation_feedback rows, so a still-open day never inflates the count.

  const rows: ScorableProbationer[] = [];
  for (const row of cases) {
    const employeeHrId = norm(row.employee_hr_id);
    if (!employeeHrId || !scorable.has(employeeHrId)) continue;
    if (employeeHrId === callerHrId) continue; // nobody scores themselves

    const facts = employeeFacts.get(employeeHrId);
    // A case stays open after the person leaves — only a decision closes it. Scoring a leaver is
    // meaningless, so they are withheld from the launcher (three such cases are open in production
    // today). The tracker still shows them; only the invitation to score is withheld.
    if (!isActiveLifecycleStatus(facts?.employmentStatus)) continue;

    const evaluatorRole = evaluatorRoleFor(
      callerHrId,
      employeeHrId,
      callerAppRole,
      facts?.managerHrId ?? null,
      row.line_name,
    );
    if (!evaluatorRole) continue;

    rows.push({
      caseId: row.id,
      employeeHrId: row.employee_hr_id,
      // Human-readable name always — never a bare HR code (owner rule).
      employeeName: facts?.displayName ?? row.employee_name ?? row.employee_hr_id,
      evaluatorRole,
      probationEndDate: row.probation_end_date,
      lineName: row.line_name ?? (facts?.lineId != null ? lineNames.get(facts.lineId) ?? null : null),
      openDvDayId: openDvDayByEmployee.get(employeeHrId) ?? null,
      submittedCount: submittedByEmployee.get(employeeHrId) ?? 0,
      requiredCount: config.requirements[evaluatorRole] ?? 0,
    });
  }

  return rows;
}

export type OpenScorecardResult = {
  dvDayId: string;
  employeeHrId: string;
  evaluatorRole: ProbationEvaluatorRole;
  /** False when an already-open DV-Day of the caller's was reused instead of a new one opened. */
  created: boolean;
};

/**
 * Open (or reuse) a DV-Day so this caller can score this probationer, then hand back the id the
 * structured feedback form is keyed on.
 *
 * Authorization is re-derived here from the caller's own AccessContext — never from the request
 * body — so this route is exactly as safe as the tracker it mirrors:
 *   1. the case must exist, be active, and be undecided (assertCaseAcceptsSubmissions);
 *   2. the probationer must be inside the caller's probation SCORING scope;
 *   3. the probationer must still be employed;
 *   4. the caller must hold an eligible evaluator role FOR THIS REP.
 *
 * Idempotent twice over: an already-open DV-Day of the caller's is reused rather than duplicated,
 * and the (evaluator, employee, dv_date) unique key makes a double-submit on the same day resolve
 * to the same row instead of a second one.
 */
export async function openManualScorecard(
  access: AccessContext,
  employeeHrId: string,
): Promise<OpenScorecardResult> {
  const callerHrId = norm(access.hrId);
  if (!callerHrId) {
    throw new Error("Forbidden: your account is not linked to an employee record, so a score cannot be attributed.");
  }
  const employee = norm(employeeHrId);
  if (!employee) throw new Error("Validation failed: employeeHrId is required.");
  if (employee === callerHrId) throw new Error("Forbidden: you cannot score yourself.");

  const supabase = getSupabaseAdmin();

  const { data: caseData, error: caseError } = await supabase
    .from("probation_cases")
    .select("id, employee_hr_id, line_name, status, decision, probation_start_date, probation_end_date")
    .ilike("employee_hr_id", employee)
    .maybeSingle();
  if (caseError && !isProbationSchemaMissing(caseError)) throw caseError;
  const probationCase = caseData as (ActiveCaseRow & { status: string; decision: string | null }) | null;
  if (!probationCase) throw new Error("Not found: this employee has no probation case.");
  if (probationCase.status !== "active") {
    throw new Error("Conflict: this probation case is no longer active.");
  }
  await assertCaseAcceptsSubmissions(probationCase.id);

  const scorable = await filterProbationScorableHrIds(access, [employee]);
  if (!scorable.has(employee)) {
    throw new Error("Forbidden: this probationer is outside your scope.");
  }

  const [callerAppRole, facts] = await Promise.all([
    loadCallerAppRole(callerHrId),
    loadEmployeeFacts([employee]),
  ]);
  if (!isActiveLifecycleStatus(facts.get(employee)?.employmentStatus)) {
    throw new Error("Conflict: this employee has left the company, so a probation score cannot be recorded.");
  }
  const evaluatorRole = evaluatorRoleFor(
    callerHrId,
    employee,
    callerAppRole,
    facts.get(employee)?.managerHrId ?? null,
    probationCase.line_name,
  );
  if (!evaluatorRole) {
    throw new Error("Forbidden: your role does not evaluate this probationer.");
  }

  // Reuse an already-open DV-Day rather than stacking another one on the same rep.
  const { data: openRows } = await supabase
    .from("probation_dv_days")
    .select("id, dv_date")
    .ilike("evaluator_hr_id", callerHrId)
    .ilike("employee_hr_id", employee)
    .in("dv_status", [...OPEN_DV_STATUSES])
    .order("dv_date", { ascending: true })
    .limit(1);
  const reusable = (openRows ?? [])[0] as { id: string } | undefined;
  if (reusable) {
    return { dvDayId: reusable.id, employeeHrId: probationCase.employee_hr_id, evaluatorRole, created: false };
  }

  // Date the manual day today (Cairo), clamped into the probation window so it never lands outside
  // the period every window-scoped reader filters on. Clamping can collide with a real CRM day on
  // that exact date — the unique-key re-read below resolves that to the existing row.
  const dvDate = clampToWindow(
    currentCairoDateOnlyIso(),
    probationCase.probation_start_date,
    probationCase.probation_end_date,
  );
  const now = new Date().toISOString();

  const { data: inserted, error: insertError } = await supabase
    .from("probation_dv_days")
    .insert({
      case_id: probationCase.id,
      employee_hr_id: probationCase.employee_hr_id,
      evaluator_hr_id: callerHrId,
      evaluator_role: evaluatorRole,
      dv_date: dvDate,
      ampm: null,
      visit_count: 0,
      dv_status: "validated",
      validation_reason: MANUAL_DV_VALIDATION_REASON,
      crm_source_ids: [],
      synced_at: null,
      updated_at: now,
    })
    .select("id")
    .maybeSingle();

  if (insertError && !isUniqueViolation(insertError)) throw insertError;

  const dvDayId = insertError ? null : (inserted as { id?: string } | null)?.id ?? null;
  if (dvDayId) {
    return { dvDayId, employeeHrId: probationCase.employee_hr_id, evaluatorRole, created: true };
  }

  // Lost the unique key to a day that already exists for this (evaluator, rep, date). The reuse
  // lookup above already ruled out an OPEN one, so this row is a closed day — almost always one the
  // caller scored earlier today. Say that plainly instead of routing them to a form that will just
  // report the task as unavailable.
  const existing = await findDvDay(callerHrId, employee, dvDate);
  if (!existing) throw new Error("The scorecard could not be opened. Try again.");
  const { data: existingFeedback } = await supabase
    .from("probation_feedback")
    .select("id")
    .eq("dv_day_id", existing)
    .maybeSingle();
  if (existingFeedback) {
    throw new Error("Conflict: you have already submitted a score for this probationer today.");
  }
  return { dvDayId: existing, employeeHrId: probationCase.employee_hr_id, evaluatorRole, created: false };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return code === "23505" || message.includes("duplicate key") || message.includes("already exists");
}

async function findDvDay(evaluatorHrId: string, employeeHrId: string, dvDate: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from("probation_dv_days")
    .select("id")
    .ilike("evaluator_hr_id", evaluatorHrId)
    .ilike("employee_hr_id", employeeHrId)
    .eq("dv_date", dvDate)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}
