import {
  getEmployeeDirectory,
  getEmployeeDirectoryRows,
  invalidateEmployeeDirectoryCache,
  isActiveLifecycleStatus,
} from "@/lib/employees/employee-directory";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { assertProbationWorkflowTransition } from "@/lib/employee-lifecycle/workflow";
import {
  canSeeEmployee,
  normalizeHrId,
  systemAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import { cache } from "react";
import { resolveViewerAllowedLines } from "@/lib/auth/scope-visibility";
import { addDaysToDateOnly } from "@/lib/date-only";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { lifecycleRiskWindows } from "@/lib/lifecycle-risk/metrics";
import { afterResponse } from "@/lib/http/after-response";
import { createSystemNotification } from "@/lib/notifications/system";
import {
  probationDaysRemaining,
  probationEndDate as canonicalProbationEndDate,
} from "@/lib/probation/date";
import {
  getProbationCaseByEmployee,
  isMedicalRepresentativeTitle,
} from "@/lib/probation/intelligence/cases";
import { resignEmployeeAndOpenVacancy } from "@/lib/resignations/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { sameWorkforceLine } from "@/lib/workforce/hierarchy-resolver";

import type {
  CreateProbationEvaluationInput,
  ProbationDecision,
  ProbationRow,
  ProbationWorkflowAction,
  ProbationWorkflowRecord,
  ProbationWorkflowStatus,
} from "./types";

type EmployeeScopeRow = Awaited<ReturnType<typeof getEmployeeDirectoryRows>>[number];

type ProbationDbRow = {
  id: string | number;
  employee_hr_id: string | null;
  probation_start_date: string | null;
  probation_end_date: string | null;
  status: string;
  // The twelve DV checkbox columns (migration 20260629140000) were declared here until 2026-09-01.
  // The SELECT is `*`, so they still arrive from the database — they are simply no longer typed or
  // read, because nothing has written them since the Case model took over provisioning. Probation
  // DV state is read from `probation_dv_days` via intelligence/dv-progress-lookup.ts.
};

type ProbationEvaluationDbRow = {
  id: string;
  employee_hr_id: string;
  probation_id: string | null;
  employee_name: string;
  job_title: string | null;
  line_name: string | null;
  area_name: string | null;
  probation_end_date: string;
  evaluation_scores: Record<string, number | string | null>;
  manager_feedback: string | null;
  hr_recommendation: string | null;
  decision: ProbationDecision | null;
  decision_reason: string | null;
  probation_letter_url: string | null;
  probation_letter_name: string | null;
  workflow_notes: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  manager_reviewed_at: string | null;
  manager_reviewed_by: string | null;
  hr_reviewed_at: string | null;
  hr_reviewed_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  completed_at: string | null;
  completed_by: string | null;
};

type ProbationReminderEventDbRow = {
  employee_hr_id: string | null;
  id: string;
  metadata: Record<string, unknown> | null;
  recipients?: string[] | null;
  scheduled_for: string | null;
  status: string | null;
  subject: string | null;
};

type ProbationWorkflowInput = {
  decisionReason?: string | null;
  expectedUpdatedAt?: string | null;
  evaluationScores?: Record<string, number | string | null>;
  hrRecommendation?: string | null;
  managerFeedback?: string | null;
  note?: string | null;
};

// Governance: probation pass/terminate/evaluation authority is reserved for Super Admin
// (Admin-HR) and the HR Manager B-10 (Omar Anwar Gawish), who holds the Super Admin role.
// The retired broad HR access role and Talent Acquisition must NOT administer or approve probation.
const hrProbationRoles = new Set(["Super Admin"]);
async function resolveActiveHrApproverHrIds(): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", ["Super Admin"])
    .eq("is_active", true);
  if (error) return [];
  return ((data ?? []) as Array<{ hr_id?: string | null }>)
    .map((row) => normalizeHrId(row.hr_id))
    .filter(Boolean) as string[];
}

type FeedbackAuthUser = { hr_id?: string | null; role?: string | null };

/** The role list the probation reminders address. Null when the read failed (callers treat that as "nobody"). */
async function loadFeedbackAuthUsers(): Promise<FeedbackAuthUser[] | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id, role")
    .in("role", ["National Sales Manager", "Training Manager", "Product Manager", "Group Product Manager"])
    .eq("is_active", true);
  if (error) return null;
  return (data ?? []) as FeedbackAuthUser[];
}

/**
 * The two role reads every probation reminder needs, shared across ONE processing run. Reading them per
 * employee made the cron's step an N+1 (Sentry PHOENIX-WORKFORCE-4: 30 identical `app_auth_users`
 * selects in one request — the page shows them as "GET [Filtered]" because Sentry hides any URL naming
 * "auth"). The copy lives only inside the run that created it. A failed read is never kept, so one
 * blip costs the employees it hit and not every employee left in the run: an empty approver list falls
 * back to a fresh read, and a failed role read is asked again by the next employee.
 */
type ProbationRecipientLookups = {
  feedbackAuthUsers: () => Promise<FeedbackAuthUser[] | null>;
  hrApproverHrIds: () => Promise<string[]>;
};

export function createProbationRecipientLookups(hrApproverHrIds: string[]): ProbationRecipientLookups {
  let held: Promise<FeedbackAuthUser[] | null> | null = null;
  return {
    feedbackAuthUsers: () => {
      if (held) return held;
      const read = loadFeedbackAuthUsers();
      held = read;
      read.then(
        (rows) => {
          if (rows === null && held === read) held = null;
        },
        () => {
          if (held === read) held = null;
        },
      );
      return read;
    },
    // A Super Admin always exists, so an empty list means the read failed — ask again rather than share it.
    hrApproverHrIds: async () => (hrApproverHrIds.length > 0 ? hrApproverHrIds : resolveActiveHrApproverHrIds()),
  };
}

async function activeHrIdsByRole(roles: string[]): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", roles)
    .eq("is_active", true);
  if (error) return [];
  return ((data ?? []) as Array<{ hr_id?: string | null }>)
    .map((row) => normalizeHrId(row.hr_id))
    .filter(Boolean) as string[];
}

export function isProbationAdministrator(access: Pick<AccessContext, "role" | "scope">) {
  return access.scope === "system" || hrProbationRoles.has(access.role);
}

// View/export probation access follows the same Super Admin governance boundary as
// administration. Training Manager, Marketing Manager, and (owner-requested 2026-07-24)
// Talent Acquisition additionally have company-wide probation VIEW/EXPORT as part of their
// org-wide oversight — but deliberately NOT administrator powers (manager_feedback/pass/
// terminate stay gated by isProbationAdministrator), so their oversight is strictly read-only.
export function canViewAllProbation(access: Pick<AccessContext, "role" | "scope">) {
  return (
    isProbationAdministrator(access) ||
    access.role === "Training Manager" ||
    access.role === "Marketing Manager" ||
    access.role === "HR Operations"
  );
}

// The Talent Acquisition seat (HR Resourcing) reads beside the CEO, not beside the administrators:
// the owner ticked the Decision Dashboard and Probation Analytics for her on 2026-10-08, both of
// which open on this function, and every route behind it is a GET. canViewAllProbation is NOT
// widened — it is also the company-wide EXPORT gate (canExportProbation), which he did not give her.
// The Probation Tracker shares this gate and is closed to her by page instead
// (src/lib/auth/seat-page-fences.ts).
export function canReadAllProbation(access: Pick<AccessContext, "role" | "scope">) {
  return canViewAllProbation(access) || access.role === "CEO" || access.role === "HR Resourcing";
}

/**
 * Field-ladder roles whose probation READ is subtree/line-scoped rather than company-wide.
 *
 * They may export, but only ever the rows getProbationRows already returns for them — that reader
 * filters every employee through canReadProbationEmployee, so the workbook/PDF can never contain a
 * person the exporter cannot already see on screen. This is the ONLY thing separating a scoped
 * exporter from canViewAllProbation, which stays company-wide.
 *
 * Before this existed, District Manager and National Sales Manager carried `probation: ["export"]`
 * in defaultPermissionMatrix but assertCanExportProbation keyed off canViewAllProbation, which
 * excludes them — so the grant was inert and the matrix overstated their access.
 */
const scopedProbationExportRoles: ReadonlySet<AccessContext["role"]> = new Set([
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
]);

export function canExportProbation(access: Pick<AccessContext, "role" | "scope">) {
  return canViewAllProbation(access) || scopedProbationExportRoles.has(access.role);
}

// Probation Analytics (historical outcomes) audience — owner rule 2026-07-17. The feedback-submitting
// manager tiers (National Sales Manager, Product / Group Product Manager) plus SFE, admin, and the CEO
// get the read-only outcomes dashboard. This is deliberately WIDER than canReadAllProbation (which
// gates the operational tracker/exports) so evaluators can see aggregate pass/terminate trends without
// gaining the operational or administrative surfaces.
const probationAnalyticsRoles: ReadonlySet<AccessContext["role"]> = new Set([
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "CEO",
  "Super Admin",
]);
export function canViewProbationAnalytics(access: Pick<AccessContext, "role" | "scope">) {
  return access.scope === "system" || canReadAllProbation(access) || probationAnalyticsRoles.has(access.role);
}

export function assertCanExportProbation(access: AccessContext) {
  // canExportProbation, not canViewAllProbation: the scoped field-ladder roles export only the rows
  // getProbationRows hands them, which is already narrowed by canReadProbationEmployee.
  if (!canExportProbation(access)) {
    throw new Error(`Forbidden: ${access.role} cannot export probation.`);
  }
}

function isSameLine(employee: EmployeeScopeRow, viewer: EmployeeScopeRow | null) {
  if (!viewer) return false;
  // Prefer numeric line_id (canonical sameWorkforceLine), falling back to normalized
  // lineName text only when an id is missing — mirrors Coaching / Double-Visit-Analytics.
  // The old text-only comparison missed peers whose lineName text was stale.
  return sameWorkforceLine(employee, viewer);
}

function canReadProbationEmployee(
  access: AccessContext,
  employee: EmployeeScopeRow,
  viewer: EmployeeScopeRow | null,
  directory: EmployeeScopeRow[] = [],
  viewerAllowedLines: string[] | null = null,
) {
  if (canReadAllProbation(access)) return true;
  // Marketing Manager is intentionally NOT in this line-scoped branch: it is already
  // granted company-wide read/export via canViewAllProbation (head-of-department oversight),
  // so this branch was unreachable dead code for it.
  if (
    access.role === "National Sales Manager" ||
    access.role === "Product Manager" ||
    access.role === "Group Product Manager"
  ) {
    // When a per-user line override is set (e.g. Ahmed Sharaf spanning two lines),
    // check against the override list instead of the viewer's own single line.
    if (viewerAllowedLines && viewerAllowedLines.length > 0) {
      const employeeLine = (employee.lineName ?? "").trim().toLowerCase();
      return viewerAllowedLines.some((l) => l.trim().toLowerCase() === employeeLine);
    }
    return isSameLine(employee, viewer);
  }
  if (access.role === "Regional Manager") return isInManagerHierarchy(directory, viewer, employee);
  // Training Manager is handled above by canViewAllProbation (org-wide read/export oversight).
  return canSeeEmployee(access, employee);
}

function canSubmitManagerFeedback(
  access: AccessContext,
  employee: EmployeeScopeRow,
  viewer: EmployeeScopeRow | null,
  directory: EmployeeScopeRow[] = [],
) {
  if (isProbationAdministrator(access)) return true;
  return isDirectManagerOrManagerOfManager(directory, viewer, employee);
}

/**
 * Probation SCORING scope for a set of employees, by HR_ID — who this caller may open a probation
 * scorecard for, for surfaces that work from `probation_cases` rather than from the
 * employee-directory window.
 *
 * Built on the tracker's own per-row rule (canReadProbationEmployee) with two deliberate
 * differences, each of which exists because scoring is not reading:
 *
 * 1. NO date or job-title window. getProbationRows additionally hides anyone past day 90 or not
 *    titled "medical rep" — right for the tracker, wrong here: a case still open past its end date
 *    is still the caller's to score, and its evaluators still owe it feedback.
 * 2. National Sales Manager is national. The title is held once per product line today (three
 *    live holders), so the read rule's "same line as the viewer" default silently confined each
 *    NSM to their own line's probationers — while `config.requirements.nsm = 1` demands an NSM
 *    component on EVERY case. Owner instruction 2026-08-20: an NSM may score anyone in probation,
 *    not only their own line.
 *
 *    A per-user `line_scope_override` still wins. That column is how the owner deliberately pins
 *    a manager to named lines (Ahmed Sharaf spans Pedia + Anti Infective), so an NSM who has one
 *    keeps exactly the lines it lists — setting an override is how to narrow an NSM back down,
 *    with no code change.
 *
 * This widens WHO MAY BE SCORED and nothing else: the tracker, the exports and every other
 * probation read still go through canReadProbationEmployee unchanged.
 *
 * Returns the normalized (lowercased) HR_IDs the caller may score.
 */
export async function filterProbationScorableHrIds(
  access: AccessContext,
  employeeHrIds: readonly string[],
): Promise<Set<string>> {
  return filterProbationHrIds(access, employeeHrIds, canScoreProbationEmployee);
}

function canScoreProbationEmployee(
  access: AccessContext,
  employee: EmployeeScopeRow,
  viewer: EmployeeScopeRow | null,
  directory: EmployeeScopeRow[] = [],
  viewerAllowedLines: string[] | null = null,
) {
  if (access.role === "National Sales Manager" && !(viewerAllowedLines && viewerAllowedLines.length > 0)) {
    return true;
  }
  return canReadProbationEmployee(access, employee, viewer, directory, viewerAllowedLines);
}

async function filterProbationHrIds(
  access: AccessContext,
  employeeHrIds: readonly string[],
  isAllowed: (
    access: AccessContext,
    employee: EmployeeScopeRow,
    viewer: EmployeeScopeRow | null,
    directory: EmployeeScopeRow[],
    viewerAllowedLines: string[] | null,
  ) => boolean,
): Promise<Set<string>> {
  const wanted = new Set(
    employeeHrIds.map((hrId) => normalizeHrId(hrId)).filter((hrId): hrId is string => Boolean(hrId)),
  );
  if (wanted.size === 0) return new Set();

  const [{ employees }, viewerAllowedLines] = await Promise.all([
    getEmployeeDirectory(),
    resolveViewerAllowedLines(access),
  ]);
  const viewerHrId = normalizeHrId(access.hrId);
  const viewer = employees.find((employee) => normalizeHrId(employee.hrId) === viewerHrId) ?? null;

  const allowed = new Set<string>();
  for (const employee of employees) {
    const hrId = normalizeHrId(employee.hrId);
    if (!hrId || !wanted.has(hrId)) continue;
    if (isAllowed(access, employee, viewer, employees, viewerAllowedLines)) {
      allowed.add(hrId);
    }
  }
  return allowed;
}

function isInManagerHierarchy(directory: EmployeeScopeRow[], manager: EmployeeScopeRow | null, employee: EmployeeScopeRow) {
  if (!manager) return false;
  const managerHrId = normalizeHrId(manager.hrId);
  if (managerHrId && managerHrId === normalizeHrId(employee.hrId)) return true;
  const employeeByHrId = new Map(directory.map((row) => [normalizeHrId(row.hrId), row]));
  let currentManagerHrId = normalizeHrId(employee.managerHrId);
  const visited = new Set<string>();

  while (currentManagerHrId && !visited.has(currentManagerHrId)) {
    if (currentManagerHrId === managerHrId) return true;
    visited.add(currentManagerHrId);
    currentManagerHrId = normalizeHrId(employeeByHrId.get(currentManagerHrId)?.managerHrId);
  }

  return false;
}

function isDirectManagerOrManagerOfManager(directory: EmployeeScopeRow[], viewer: EmployeeScopeRow | null, employee: EmployeeScopeRow) {
  if (!viewer) return false;
  const viewerHrId = normalizeHrId(viewer.hrId);
  const directManagerHrId = normalizeHrId(employee.managerHrId);
  if (!viewerHrId || !directManagerHrId) return false;
  if (viewerHrId === directManagerHrId) return true;
  const manager = directory.find((row) => normalizeHrId(row.hrId) === directManagerHrId) ?? null;
  return Boolean(manager && viewerHrId === normalizeHrId(manager.managerHrId));
}

function managerOf(employee: EmployeeScopeRow, directory: EmployeeScopeRow[]) {
  const managerHrId = normalizeHrId(employee.managerHrId);
  return managerHrId ? directory.find((row) => normalizeHrId(row.hrId) === managerHrId) ?? null : null;
}

function actionLabel(action: ProbationWorkflowAction) {
  return action.replace(/_/g, " ");
}

function normalizeProbationStatus(
  evaluationStatus: string | null | undefined,
  decision: ProbationDecision | null | undefined,
): ProbationWorkflowStatus {
  if (decision === "pass") return "passed";
  if (decision === "terminate") return "terminated";
  if (evaluationStatus === "completed") return "passed";
  return "active";
}

function isFinalWorkflow(row: ProbationWorkflowRecord | null | undefined) {
  return Boolean(row?.decision === "pass" || row?.decision === "terminate");
}

/**
 * True while a probation review still needs a human decision — including a row
 * that has no evaluation record yet, because nobody has decided that one either.
 *
 * Exported so the executive tiles that link to this module count the rows this
 * module returns. A second, local copy of "pass or terminate means done" is what
 * let the CEO's probation count drift into describing people the tracker page
 * cannot display.
 */
export function isProbationDecisionOutstanding(row: Pick<ProbationRow, "workflow">) {
  return !isFinalWorkflow(row.workflow);
}

function cleanText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizeDate(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  return raw ? raw.slice(0, 10) : null;
}

function addDays(value: string | null | undefined, days: number) {
  return addDaysToDateOnly(normalizeDate(value), days);
}

function appendWorkflowNote(existing: string | null | undefined, actor: string, action: string, note?: string | null) {
  const entry = `[${new Date().toISOString()}] ${actor}: ${action}${note ? ` - ${note}` : ""}`;
  return existing ? `${existing}\n${entry}` : entry;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

export function probationErrorMessage(error: unknown) {
  return errorMessage(error);
}

export function isProbationSchemaMissing(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("employee_probation") ||
    message.includes("probation_evaluations") ||
    message.includes("probation_history") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

/**
 * Is the shared notification outbox genuinely ABSENT — as opposed to one of its COLUMNS being gone?
 *
 * 🔴 THE REMINDER WRITES MUST NOT USE `isProbationSchemaMissing`. That predicate was written for
 * probation's OWN tables during the window before their migration landed, and one of the things it
 * matches is the bare phrase `schema cache` — which is exactly how PostgREST words a missing COLUMN:
 * "Could not find the 'x' column of 'notification_events' in the schema cache" (PGRST204). So a
 * dropped or renamed column on the outbox made every "probation feedback is due" and "decision
 * overdue" row silently fail to be created: no manager told, no row to find, and nothing red
 * anywhere. Found by the org select-audit, 2026-09-30.
 *
 * This tolerates only the one case the original was reaching for — the TABLE not being there — and
 * says so positively rather than by exclusion, so a new PostgREST wording cannot quietly widen it.
 * A missing column now throws, which is what the caller wants: a notification nobody receives is
 * worse than a visible failure.
 */
export function isNotificationOutboxMissing(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  const code = String(
    (typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : "") ?? "",
  ).toUpperCase();

  // A COLUMN is never the table. Both spellings, before anything else can match them.
  if (code === "PGRST204" || code === "42703") return false;
  if (/could not find the '[^']*' column/.test(message)) return false;
  if (message.includes("column") && message.includes("does not exist")) return false;

  return (
    code === "PGRST205" ||
    code === "42P01" ||
    (message.includes("could not find the table") && message.includes("notification_events")) ||
    (message.includes("relation") && message.includes("notification_events") && message.includes("does not exist"))
  );
}

function asIso(value: string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function mapEvaluation(row: ProbationEvaluationDbRow): ProbationWorkflowRecord {
  return {
    areaName: row.area_name,
    approvedAt: asIso(row.approved_at),
    approvedBy: row.approved_by,
    completedAt: asIso(row.completed_at),
    completedBy: row.completed_by,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by,
    decision: row.decision,
    decisionReason: row.decision_reason,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    evaluationScores: row.evaluation_scores ?? {},
    hrRecommendation: row.hr_recommendation,
    hrReviewedAt: asIso(row.hr_reviewed_at),
    hrReviewedBy: row.hr_reviewed_by,
    id: row.id,
    jobTitle: row.job_title,
    lineName: row.line_name,
    managerFeedback: row.manager_feedback,
    managerReviewedAt: asIso(row.manager_reviewed_at),
    managerReviewedBy: row.manager_reviewed_by,
    probationEndDate: row.probation_end_date,
    probationId: row.probation_id,
    probationLetterName: row.probation_letter_name,
    probationLetterUrl: row.probation_letter_url,
    status: normalizeProbationStatus(row.status, row.decision),
    updatedAt: new Date(row.updated_at).toISOString(),
    workflowNotes: row.workflow_notes,
  };
}

async function loadProbationByHrId() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_probation")
    .select("*")
    .order("probation_end_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) throw error;
  const byHrId = new Map<string, ProbationDbRow>();
  for (const row of (data ?? []) as ProbationDbRow[]) {
    if (row.employee_hr_id && !byHrId.has(row.employee_hr_id)) {
      byHrId.set(row.employee_hr_id, row);
    }
  }
  return byHrId;
}

async function loadEvaluationsByHrId() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("probation_evaluations")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;
  const byHrId = new Map<string, ProbationWorkflowRecord>();
  for (const row of (data ?? []) as ProbationEvaluationDbRow[]) {
    if (!byHrId.has(row.employee_hr_id)) {
      byHrId.set(row.employee_hr_id, mapEvaluation(row));
    }
  }
  return byHrId;
}

function allowedWorkflowActions(
  access: AccessContext,
  row: ProbationWorkflowRecord | null | undefined,
  employee: EmployeeScopeRow,
  viewer: EmployeeScopeRow | null,
  directory: EmployeeScopeRow[] = [],
): ProbationWorkflowAction[] {
  const allowed = new Set<ProbationWorkflowAction>();
  const isHr = isProbationAdministrator(access);
  const canManagerAct = canSubmitManagerFeedback(access, employee, viewer, directory);
  if (!row) return Array.from(allowed);
  if (isFinalWorkflow(row)) return [];

  if (canManagerAct) {
    allowed.add("manager_feedback");
  }

  if (!isHr) return Array.from(allowed);

  allowed.add("pass");
  allowed.add("terminate");

  return Array.from(allowed);
}

function assertWorkflowActionAllowed(
  access: AccessContext,
  row: ProbationWorkflowRecord,
  action: ProbationWorkflowAction,
  employee: EmployeeScopeRow,
  viewer: EmployeeScopeRow | null,
  directory: EmployeeScopeRow[] = [],
) {
  if (!allowedWorkflowActions(access, row, employee, viewer, directory).includes(action)) {
    throw new Error(`Forbidden: ${access.role} cannot ${actionLabel(action)} for this probation record.`);
  }
}

// 🔴 ONE READ PER REQUEST. The admin home asks for this list twice in the same instant: the
// lifecycle-risk tiles (`getPlatformMetrics` → `getLifecycleRiskMetrics`) and the Needs You
// probation row (`probation-decisions` in `src/lib/needs-you/sources.ts`), both under one
// `getCeoCommandCenterData`. Two copies of the directory join and both probation reads, started
// together on a loaded minute, queued past the board's eight-second budget and the row went amber
// (26 Oct 2026, 00:32 Cairo: two timeouts 34 ms apart while every query stayed under 132 ms in
// pg_stat_statements). `cache()` makes the second caller wait on the first's promise. It is keyed
// on the `access` object, so a different viewer never shares a list, and it is a no-op outside a
// React request — the write routes read once, after their write, and the reminder sweep runs bare.
// No caller may sort or edit these rows in place: they are shared.
export const getProbationRows = cache(loadProbationRows);

// The tracker's own list: everyone in `getProbationRows` PLUS the probations that ended with no
// decision. A lapsed probation with an open case is the one a manager still owes an answer on, and
// it used to vanish from the tracker the day it ended (while "Score a probationer" still listed it).
// Only the tracker surfaces read this — the reminder sweep, the CEO and HR tiles, the Needs You
// count and the Double-Visit analytics keep `getProbationRows` and its "still inside 90 days" rule,
// so no count or email outside the tracker moves. Same per-request cache, same no-edit-in-place rule.
export const getProbationTrackerRows = cache(loadProbationTrackerRows);

// One directory join and both probation reads, shared by the two lists above in a request.
const loadAllProbationRows = cache(buildProbationRows);

async function loadProbationRows(access: AccessContext): Promise<ProbationRow[]> {
  return (await loadAllProbationRows(access)).filter((row) => row.days_remaining > 0);
}

async function loadOpenProbationCaseHrIds(): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin()
    .from("probation_cases")
    .select("employee_hr_id")
    .eq("status", "active")
    .is("decision", null);
  if (error) {
    // A domain that is not migrated has no cases, so nothing is overdue. Anything else is a real
    // failure and must reach the page, never read as "no overdue decisions".
    if (isProbationSchemaMissing(error)) return new Set();
    throw error;
  }
  return new Set(
    ((data ?? []) as Array<{ employee_hr_id: string | null }>)
      .map((row) => normalizeHrId(row.employee_hr_id))
      .filter((hrId): hrId is string => Boolean(hrId)),
  );
}

async function loadProbationTrackerRows(access: AccessContext): Promise<ProbationRow[]> {
  const rows = await loadAllProbationRows(access);
  const isLapsedAndUndecided = (row: ProbationRow) =>
    row.days_remaining <= 0 &&
    Boolean(row.probation_end_date) &&
    isProbationDecisionOutstanding(row) &&
    isActiveLifecycleStatus(row.employment_status);
  if (!rows.some(isLapsedAndUndecided)) return rows.filter((row) => row.days_remaining > 0);

  const openCaseHrIds = await loadOpenProbationCaseHrIds();
  return rows.flatMap((row): ProbationRow[] => {
    if (row.days_remaining > 0) return [row];
    if (!isLapsedAndUndecided(row)) return [];
    const hrId = normalizeHrId(row.hr_id);
    return hrId && openCaseHrIds.has(hrId) ? [{ ...row, overdue_decision: true }] : [];
  });
}

async function buildProbationRows(access: AccessContext): Promise<ProbationRow[]> {
  const [{ employees }, viewerAllowedLines] = await Promise.all([
    getEmployeeDirectory(),
    resolveViewerAllowedLines(access),
  ]);
  const viewerHrId = normalizeHrId(access.hrId);
  const viewer = employees.find((employee) => normalizeHrId(employee.hrId) === viewerHrId) ?? null;
  let probationByHrId = new Map<string, ProbationDbRow>();
  let evaluationsByHrId = new Map<string, ProbationWorkflowRecord>();

  try {
    [probationByHrId, evaluationsByHrId] = await Promise.all([
      loadProbationByHrId(),
      loadEvaluationsByHrId(),
    ]);
  } catch (error) {
    if (!isProbationSchemaMissing(error)) throw error;
  }

  return employees
    // MEDICAL-REPRESENTATIVE-ONLY (owner rule 2026-07-17): probation is a med-rep workflow. Managers
    // (DSM/RSM/NSM) and head-office roles inside their own hire+90 window must never surface in the
    // tracker/dashboard/exports/portal — deleting their probation_cases was not enough because this
    // list is built from the employee directory window, not probation_cases. See isMedicalRepresentativeTitle.
    .filter((employee) => isMedicalRepresentativeTitle(employee.positionTitle ?? employee.jobTitle))
    .filter((employee) => canReadProbationEmployee(access, employee, viewer, employees, viewerAllowedLines))
    .map((employee) => {
      const probation = probationByHrId.get(employee.hrId);
      const workflow = evaluationsByHrId.get(employee.hrId) ?? null;
      const manager = managerOf(employee, employees);
      const managerManager = manager ? managerOf(manager, employees) : null;
      const probationEndDate = canonicalProbationEndDate(employee.hireDate) ?? "";
      const allowedActions = allowedWorkflowActions(access, workflow, employee, viewer, employees);
      if (workflow) workflow.allowedActions = allowedActions;
      return {
        allowedActions,
        area_name: employee.areaName ?? "Unassigned",
        crm_id: employee.crmId ?? "",
        days_remaining: probationDaysRemaining(employee.hireDate) ?? 0,
        employment_status: employee.employmentStatus ?? "",
        last_working_date: employee.lastWorkingDate ?? null,
        // A `dv_state` projection of employee_probation's DV checkboxes stood here until
        // 2026-09-01. It answered null for every row this function ever returned, because the
        // table it read has been empty since the Case model took over provisioning. Anything
        // needing probation DV state reads probation_dv_days through
        // intelligence/dv-progress-lookup.ts, which is where the visits actually land.
        full_name: employee.displayName,
        hire_date: employee.hireDate ?? "",
        hr_id: employee.hrId,
        job_title: employee.positionTitle ?? employee.jobTitle ?? "Unassigned",
        line_name: employee.lineName ?? "Unassigned",
        manager_hr_id: employee.managerHrId,
        manager_manager_hr_id: managerManager?.hrId ?? null,
        manager_manager_name: managerManager?.displayName ?? null,
        manager_name: employee.managerName ?? manager?.displayName ?? null,
        has_durable_probation_record: Boolean(probation),
        probation_end_date: probationEndDate,
        probation_id: probation?.id === undefined ? null : String(probation.id),
        team_name: employee.teamName,
        workflow,
      };
    });
}

async function insertHistory(
  evaluation: ProbationWorkflowRecord,
  action: string,
  actor: string,
  oldStatus?: string | null,
  details: Record<string, unknown> = {},
) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("probation_history").insert({
    action,
    actor,
    details,
    employee_hr_id: evaluation.employeeHrId,
    evaluation_id: evaluation.id,
    new_status: evaluation.status,
    old_status: oldStatus ?? null,
  });
  if (error && !isProbationSchemaMissing(error)) throw error;
}

// SCOPE LEAK FIX (owner report 2026-07-19): this used to call createSystemNotification with no
// explicit recipient, which fell through to the generic cross-module governance resolver. Its
// "probation.*" policy uses a "permission_based" strategy that treats matching department_id as
// sufficient organizational scope — but in this org department_id groups the ENTIRE field-sales org
// (124 employees, every product line) under one id, not per line. Net effect: up to 98 active users
// company-wide (any role holding probation:read, which is nearly every role) received another line's
// probationer's case-status notification — e.g. an Anti Infective probationer's update reaching the
// Pedia and CNS National Sales Managers, District Managers, and Medical Reps.
//
// Fixed by resolving an EXPLICIT, line-scoped recipient list ourselves — reusing
// resolveFeedbackExtraRecipients's NSM management-chain walk (already correct, used by the SLA
// reminder path below) instead of the generic governance's broad department match — and sending one
// createSystemNotification per recipient. An explicit recipientHrId never invokes
// resolveNotificationRecipientsWithGovernance (see system.ts), so this bypasses the leaky path
// entirely for this call site without touching the shared governance code other modules rely on.
async function notifyProbationWorkflow(
  record: ProbationWorkflowRecord,
  employee: EmployeeScopeRow,
  directory: EmployeeScopeRow[],
  employeeDisplayName: string,
  title: string,
  tone: "success" | "warning" | "danger",
) {
  const manager = managerOf(employee, directory);
  const dmHrId = normalizeHrId(manager?.hrId);
  const [{ nsmHrIds }, hrApproverHrIds, ceoHrIds] = await Promise.all([
    resolveFeedbackExtraRecipients(employee, directory),
    resolveActiveHrApproverHrIds(),
    activeHrIdsByRole(["CEO"]),
  ]);
  const recipientHrIds = Array.from(
    new Set([dmHrId, ...nsmHrIds, ...hrApproverHrIds, ...ceoHrIds].filter((hrId): hrId is string => Boolean(hrId))),
  );
  if (recipientHrIds.length === 0) return;

  await Promise.all(
    recipientHrIds.map((recipientHrId) =>
      createSystemNotification({
        actionUrl: "/api/probation/redirect",
        actorId: "system",
        email: {
          ctaHref: "/api/probation/redirect",
          ctaLabel: "Open probation tracker",
          employeeHrId: record.employeeHrId,
          metrics: [
            { label: "Employee", value: `${employeeDisplayName} (${record.employeeHrId})` },
            { label: "Job Title", value: record.jobTitle ?? "—" },
            { label: "Line", value: record.lineName ?? "—" },
            { label: "Area", value: record.areaName ?? "—" },
            { label: "Probation end date", value: record.probationEndDate ?? "—" },
            { label: "Status", value: record.status },
            { label: "Decision", value: record.decision ?? "Pending" },
          ],
          notificationType: "probation",
          subject: `Phoenix ${title} - ${employeeDisplayName}`,
          summary: `Probation review for ${employeeDisplayName} is now ${record.status.replace(/_/g, " ")}.`,
          // The admin-editable probation_workflow template renders an employee detail table
          // ({{line}}/{{jobTitle}}/{{endDate}}); the generic metric→context mapping leaves
          // those tokens empty. Fill them from the workflow record so the email is not blank.
          templateContext: {
            area: record.areaName ?? "—",
            employeeHrId: record.employeeHrId,
            employeeName: employeeDisplayName,
            endDate: record.probationEndDate ?? "—",
            jobTitle: record.jobTitle ?? "—",
            line: record.lineName ?? "—",
          },
          title,
          tone,
        },
        eventType: "workflow_updated",
        message: `Probation review for ${employeeDisplayName} is now ${record.status.replace(/_/g, " ")}.`,
        metadata: {
          decision: record.decision ?? null,
          employeeHrId: record.employeeHrId,
          idempotencyKey: `probation:${record.employeeHrId}:${record.status}:${recipientHrId}`,
          status: record.status,
        },
        module: "probation",
        priority: tone === "danger" ? "critical" : "high",
        recipientHrId,
        subjectHrId: record.employeeHrId,
        title,
      }).catch(() => undefined),
    ),
  );
}

export function getProbationReminderSchedule(hireDate: string | null | undefined) {
  const reminders = [
    {
      daysAfterHire: lifecycleRiskWindows.probationDays - lifecycleRiskWindows.probationWarningDays,
      daysRemaining: lifecycleRiskWindows.probationWarningDays,
      reminderType: "probation_day_30_check",
    },
    {
      daysAfterHire: lifecycleRiskWindows.probationDays - lifecycleRiskWindows.probationCriticalDays,
      daysRemaining: lifecycleRiskWindows.probationCriticalDays,
      reminderType: "probation_30_days_remaining",
    },
    {
      daysAfterHire: lifecycleRiskWindows.probationDays - lifecycleRiskWindows.probationRiskDays,
      daysRemaining: lifecycleRiskWindows.probationRiskDays,
      reminderType: "probation_15_days_remaining",
    },
  ] as const;

  return reminders
    .map((reminder) => ({
      ...reminder,
      scheduledFor: addDays(hireDate, reminder.daysAfterHire),
    }))
    .filter((reminder) => Boolean(reminder.scheduledFor));
}

function probationWorkflowApproverHrIds(employee: EmployeeScopeRow, directory: EmployeeScopeRow[], hrApproverHrIds: string[]) {
  const manager = managerOf(employee, directory);
  const managerManager = manager ? managerOf(manager, directory) : null;
  return Array.from(new Set([
    normalizeHrId(managerManager?.hrId),
    ...hrApproverHrIds,
  ].filter(Boolean)));
}

export async function resolveFeedbackExtraRecipients(
  employee: EmployeeScopeRow,
  directory: EmployeeScopeRow[],
  lookups?: ProbationRecipientLookups,
): Promise<{ nsmHrIds: string[]; tmHrIds: string[]; pmGpmHrIds: string[] }> {
  const isCns = (employee.lineName ?? "").toLowerCase() === "cns";

  const authUsers = (lookups ? await lookups.feedbackAuthUsers() : await loadFeedbackAuthUsers()) ?? [];

  const nsmAuthHrIds = new Set(
    authUsers
      .filter((u) => u.role === "National Sales Manager")
      .map((u) => normalizeHrId(u.hr_id))
      .filter(Boolean),
  );
  const tmHrIds = authUsers
    .filter((u) => u.role === "Training Manager")
    .map((u) => normalizeHrId(u.hr_id))
    .filter(Boolean) as string[];
  const pmGpmCandidateHrIds = authUsers
    .filter((u) => u.role === "Product Manager" || u.role === "Group Product Manager")
    .map((u) => normalizeHrId(u.hr_id))
    .filter(Boolean) as string[];

  // Walk the management chain upward to find the NSM for this employee
  const nsmHrIds: string[] = [];
  let current: EmployeeScopeRow | null | undefined = managerOf(employee, directory);
  while (current) {
    const normalized = normalizeHrId(current.hrId);
    if (normalized && nsmAuthHrIds.has(normalized)) {
      nsmHrIds.push(normalized);
      break;
    }
    current = managerOf(current, directory);
  }

  // PM/GPM: filter by matching lineId; skip entirely for CNS
  const pmGpmHrIds: string[] = [];
  if (!isCns && employee.lineId !== null) {
    const directoryMap = new Map(directory.map((e) => [normalizeHrId(e.hrId), e]));
    for (const hrId of pmGpmCandidateHrIds) {
      const emp = directoryMap.get(hrId);
      if (emp?.lineId === employee.lineId) {
        pmGpmHrIds.push(hrId);
      }
    }
  }

  return { nsmHrIds, tmHrIds, pmGpmHrIds };
}

function probationRecipientRoles(employee: EmployeeScopeRow, directory: EmployeeScopeRow[], hrApproverHrIds: string[]) {
  const manager = managerOf(employee, directory);
  const managerManager = manager ? managerOf(manager, directory) : null;
  return [
    manager ? { hr_id: normalizeHrId(manager.hrId), role: "Direct Manager" } : null,
    managerManager ? { hr_id: normalizeHrId(managerManager.hrId), role: "Manager of Manager" } : null,
    ...hrApproverHrIds.map((hrId) => ({ hr_id: hrId, role: "HR Pilot Approver" })),
  ].filter((recipient): recipient is { hr_id: string; role: string } => Boolean(recipient?.hr_id));
}

async function ensureProbationReminderEvents(
  employee: EmployeeScopeRow,
  directory: EmployeeScopeRow[],
  lookups?: ProbationRecipientLookups,
  storedKeys?: ReadonlySet<string>,
) {
  const schedule = getProbationReminderSchedule(employee.hireDate);
  if (schedule.length === 0) return;

  const now = new Date().toISOString();
  const hrApproverHrIds = await (lookups ? lookups.hrApproverHrIds() : resolveActiveHrApproverHrIds());
  const { nsmHrIds, tmHrIds, pmGpmHrIds } = await resolveFeedbackExtraRecipients(employee, directory, lookups);
  const workflowApproverHrIds = probationWorkflowApproverHrIds(employee, directory, hrApproverHrIds);
  const recipientRoles = probationRecipientRoles(employee, directory, hrApproverHrIds);

  const dmNormalized = normalizeHrId(managerOf(employee, directory)?.hrId);

  // Base recipients for all cycles: DM + NSM + HR
  const baseRecipientHrIds = Array.from(
    new Set([...(dmNormalized ? [dmNormalized] : []), ...nsmHrIds, ...hrApproverHrIds].filter(Boolean)),
  );
  // Cycle 1 additionally notifies TM + PM/GPM (once-only roles)
  const cycle1RecipientHrIds = Array.from(
    new Set([...baseRecipientHrIds, ...tmHrIds, ...pmGpmHrIds]),
  );

  const reminderToCycle: Record<string, number> = {
    probation_day_30_check: 1,
    probation_30_days_remaining: 2,
    probation_15_days_remaining: 3,
  };

  const rows = schedule.map((reminder) => {
    const cycleNumber = reminderToCycle[reminder.reminderType] ?? 1;
    const recipients = cycleNumber === 1 ? cycle1RecipientHrIds : baseRecipientHrIds;
    return {
      category: "probation",
      employee_hr_id: employee.hrId,
      event_key: `${employee.hrId}:probation:${reminder.reminderType}:${reminder.scheduledFor}`,
      metadata: {
        // `&action=feedback&cycle=N` was dropped 2026-09-01 with the legacy feedback panel: the
        // params opened a per-cycle form backed by employee_probation, a table that has held zero
        // rows since the Case model took over provisioning. The redirect now lands the recipient on
        // their probation view, where their open DV feedback tasks are listed and submittable.
        href: `/api/probation/redirect?employeeHrId=${employee.hrId}`,
        message: `${employee.displayName} has ${reminder.daysRemaining} days remaining in the 90-day probation period. Submit manager probation feedback.`,
        title: `${employee.displayName}'s probation feedback is due`,
        days_after_hire: reminder.daysAfterHire,
        days_remaining: reminder.daysRemaining,
        hire_date: employee.hireDate,
        recipient_roles: recipientRoles,
        reminder_type: reminder.reminderType,
        cycle_number: cycleNumber,
        workflowApproverHrIds,
        details: [
          { label: "Employee", value: `${employee.displayName} (${employee.hrId})` },
          { label: "Days remaining", value: `${reminder.daysRemaining}` },
          { label: "Status", value: "Feedback required" },
          { label: "Action", value: "Submit feedback" },
        ],
      },
      recipients,
      scheduled_for: reminder.scheduledFor,
      status: "pending",
      subject: `${employee.displayName}'s probation feedback is due`,
      updated_at: now,
    };
  });

  // ignoreDuplicates never touches a stored row, so leaving out the keys already stored writes exactly
  // what the upsert would have written — without a round trip per employee on every run.
  const missingRows = storedKeys ? rows.filter((row) => !storedKeys.has(row.event_key)) : rows;
  if (missingRows.length === 0) return;

  const { error } = await getSupabaseAdmin()
    .from("notification_events")
    .upsert(missingRows, { onConflict: "event_key", ignoreDuplicates: true });
  // The OUTBOX, not a probation table: a missing COLUMN here must never be swallowed, or every
  // "feedback is due" reminder stops being created with nothing red. See isNotificationOutboxMissing.
  if (error && !isNotificationOutboxMissing(error)) throw error;
}

/**
 * How often a stalled, past-deadline probation is re-chased. Seven days: the pre-deadline schedule
 * (getProbationReminderSchedule) already fires three times in the run-up, so a weekly nudge after
 * the deadline is escalation without becoming noise.
 */
export const OVERDUE_PROBATION_REMINDER_CADENCE_DAYS = 7;

/** Whole days between two YYYY-MM-DD strings (to − from). Both are date-only, so UTC-anchored is exact. */
function dateOnlyDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * The PURE decision behind the overdue escalation: given a case's outstanding-ness, its probation
 * end date and today, decide whether a weekly overdue reminder is due and which 7-day bucket it
 * belongs to. Kept pure (no clock, no database) so tests can drive every calendar edge — the same
 * split as selectUnpublishedClosings. `ensureOverdueProbationReminderEvents` is the I/O shell.
 *
 * 🔴 THE GAP THIS CLOSES. The three scheduled reminders all land BEFORE the deadline (the last at
 * hire + 75, i.e. 15 days remaining). Once the 90 days lapse with the evaluation still open, nothing
 * chased the manager and the case sat at `evaluation_requested` silently — six reached 46–60 days
 * overdue on production before anyone noticed (2026-09-29). This fires weekly to DM + NSM + HR until
 * a final decision is recorded; the send loop's own `isProbationDecisionOutstanding` gate means a
 * case decided between weeks stops chasing on its own.
 */
export function planOverdueProbationReminder(input: {
  outstanding: boolean;
  probationEndDate: string | null | undefined;
  today: string;
  cadenceDays?: number;
}): { create: boolean; daysOverdue: number; weekBucket: number } {
  const none = { create: false, daysOverdue: 0, weekBucket: 0 };
  if (!input.outstanding) return none; // already decided — nothing to chase
  if (!input.probationEndDate) return none;
  const daysOverdue = dateOnlyDaysBetween(input.probationEndDate, input.today);
  if (daysOverdue < 1) return none; // not yet past the deadline — the pre-deadline schedule owns this
  const cadence = input.cadenceDays ?? OVERDUE_PROBATION_REMINDER_CADENCE_DAYS;
  return { create: true, daysOverdue, weekBucket: Math.floor(daysOverdue / cadence) };
}

/** Stable, collision-free key: one event per (employee, end date, 7-day bucket). */
export function overdueProbationReminderEventKey(hrId: string, probationEndDate: string, weekBucket: number): string {
  return `${hrId}:probation:probation_overdue:${probationEndDate}:w${weekBucket}`;
}

/**
 * The I/O shell around planOverdueProbationReminder: writes one weekly `probation_overdue` event
 * into notification_events for a past-deadline, still-open case. `ignoreDuplicates` on the bucketed
 * event_key keeps a same-week re-run to one event, and a fresh bucket next week creates the next
 * nudge. Recipients are DM + NSM + HR — the base cycle from ensureProbationReminderEvents.
 */
async function ensureOverdueProbationReminderEvents(
  employee: EmployeeScopeRow,
  row: Pick<ProbationRow, "workflow" | "probation_end_date">,
  directory: EmployeeScopeRow[],
  lookups?: ProbationRecipientLookups,
  storedKeys?: ReadonlySet<string>,
) {
  const probationEndDate = row.probation_end_date ?? canonicalProbationEndDate(employee.hireDate);
  const plan = planOverdueProbationReminder({
    outstanding: isProbationDecisionOutstanding(row),
    probationEndDate,
    today: todayDateOnly(),
  });
  if (!plan.create || !probationEndDate) return;
  // This week's nudge is already stored: the ignoreDuplicates upsert below would write nothing.
  if (storedKeys?.has(overdueProbationReminderEventKey(employee.hrId, probationEndDate, plan.weekBucket))) return;

  const hrApproverHrIds = await (lookups ? lookups.hrApproverHrIds() : resolveActiveHrApproverHrIds());
  const { nsmHrIds } = await resolveFeedbackExtraRecipients(employee, directory, lookups);
  const workflowApproverHrIds = probationWorkflowApproverHrIds(employee, directory, hrApproverHrIds);
  const recipientRoles = probationRecipientRoles(employee, directory, hrApproverHrIds);
  const dmNormalized = normalizeHrId(managerOf(employee, directory)?.hrId);
  const recipients = Array.from(
    new Set([...(dmNormalized ? [dmNormalized] : []), ...nsmHrIds, ...hrApproverHrIds].filter(Boolean)),
  );
  if (recipients.length === 0) return; // no one to chase — an empty recipients array would send nowhere

  const now = new Date().toISOString();
  const overdueLabel = `${plan.daysOverdue} day${plan.daysOverdue === 1 ? "" : "s"}`;
  const subject = `${employee.displayName}'s probation decision is overdue`;
  const rows = [
    {
      category: "probation",
      employee_hr_id: employee.hrId,
      event_key: overdueProbationReminderEventKey(employee.hrId, probationEndDate, plan.weekBucket),
      metadata: {
        href: `/api/probation/redirect?employeeHrId=${employee.hrId}`,
        message: `${employee.displayName}'s 90-day probation ended ${overdueLabel} ago and no decision has been recorded. Submit the manager evaluation and record the probation decision.`,
        title: subject,
        // Past the 90-day window, so it renders as day 90+overdue rather than a negative day count.
        days_after_hire: lifecycleRiskWindows.probationDays + plan.daysOverdue,
        days_remaining: -plan.daysOverdue,
        days_overdue: plan.daysOverdue,
        hire_date: employee.hireDate,
        recipient_roles: recipientRoles,
        reminder_type: "probation_overdue",
        // Cycle 4 — after the three scheduled cycles (day-30 check, 30-remaining, 15-remaining).
        cycle_number: 4,
        workflowApproverHrIds,
        details: [
          { label: "Employee", value: `${employee.displayName} (${employee.hrId})` },
          { label: "Probation ended", value: probationEndDate },
          { label: "Overdue by", value: overdueLabel },
          { label: "Status", value: "Decision overdue" },
          { label: "Action", value: "Submit evaluation & decide" },
        ],
      },
      recipients,
      scheduled_for: todayDateOnly(),
      status: "pending",
      subject,
      updated_at: now,
    },
  ];

  const { error } = await getSupabaseAdmin()
    .from("notification_events")
    .upsert(rows, { onConflict: "event_key", ignoreDuplicates: true });
  // The OUTBOX, not a probation table: a missing COLUMN here must never be swallowed, or every
  // "decision overdue" reminder stops being created with nothing red. See isNotificationOutboxMissing.
  if (error && !isNotificationOutboxMissing(error)) throw error;
}

/** Rows per page of the stored-key read — PostgREST's own ceiling, so a short page means the end. */
const STORED_PROBATION_KEY_PAGE = 1000;

/**
 * The probation outbox keys already stored for these employees, read once per reminder run. Every
 * ensure call writes with ignoreDuplicates, so a stored key is a guaranteed no-op write; knowing them
 * up front lets the run skip those writes (about 370 an hour on production, 23 Oct 2026, all no-ops).
 * A failed read returns null and the run writes every row exactly as before — it fails toward the old
 * behaviour, never toward a missed reminder.
 */
async function loadStoredProbationEventKeys(employeeHrIds: string[]): Promise<Set<string> | null> {
  const hrIds = Array.from(new Set(employeeHrIds.filter(Boolean)));
  const keys = new Set<string>();
  if (hrIds.length === 0) return keys;
  for (let from = 0; ; from += STORED_PROBATION_KEY_PAGE) {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_events")
      .select("event_key")
      .eq("category", "probation")
      .in("employee_hr_id", hrIds)
      .order("event_key", { ascending: true })
      .range(from, from + STORED_PROBATION_KEY_PAGE - 1);
    if (error) return null;
    const page = (data ?? []) as Array<{ event_key: string | null }>;
    for (const entry of page) if (entry.event_key) keys.add(entry.event_key);
    if (page.length < STORED_PROBATION_KEY_PAGE) return keys;
  }
}

async function ensureSystemProbationReview(employee: EmployeeScopeRow, probationEndDate: string) {
  const existingEvaluations = await loadEvaluationsByHrId().catch((error) => {
    if (isProbationSchemaMissing(error)) return new Map<string, ProbationWorkflowRecord>();
    throw error;
  });
  const existing = existingEvaluations.get(employee.hrId);
  if (existing && !isFinalWorkflow(existing)) return existing;

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("probation_evaluations")
    .insert({
      area_name: employee.areaName,
      created_by: "system",
      employee_hr_id: employee.hrId,
      employee_name: employee.fullName,
      evaluation_scores: {},
      job_title: employee.positionTitle ?? employee.jobTitle,
      line_name: employee.lineName,
      manager_feedback: null,
      probation_end_date: probationEndDate,
      probation_id: null,
      status: "evaluation_requested",
      updated_at: now,
      workflow_notes: appendWorkflowNote(null, "system", "opened probation review from scheduled reminder", null),
    })
    .select("*")
    .single();

  if (error) throw error;
  const record = mapEvaluation(data as ProbationEvaluationDbRow);
  await insertHistory(record, "created", "system", null, { source: "probation_reminder" });
  return record;
}

function todayDateOnly() {
  return currentCairoDateOnlyIso();
}

function reminderMetadata(row: ProbationReminderEventDbRow) {
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
}

async function markProbationReminderEvent(id: string, status: "sent" | "failed", details: Record<string, unknown>) {
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("notification_events")
    .update({
      metadata: details,
      sent_at: status === "sent" ? now : null,
      status,
      updated_at: now,
    })
    .eq("id", id);
  if (error && !isProbationSchemaMissing(error)) throw error;
}

export async function processDueProbationReminderEvents(limit = 25) {
  const supabase = getSupabaseAdmin();
  const [employees, hrApproverHrIds] = await Promise.all([
    getEmployeeDirectoryRows(),
    resolveActiveHrApproverHrIds(),
  ]);
  const rows = await getProbationRows(systemAccessContext);
  const activeRows = new Map(rows.map((row) => [normalizeHrId(row.hr_id), row]));
  const employeesByHrId = new Map(employees.map((employee) => [normalizeHrId(employee.hrId), employee]));
  // One read of the role lists for the whole run, not two to four per employee on probation.
  const lookups = createProbationRecipientLookups(hrApproverHrIds);
  const probationEmployees = rows.flatMap((row) => {
    const employee = employeesByHrId.get(normalizeHrId(row.hr_id));
    return employee ? [{ employee, row }] : [];
  });
  // One read of the keys already queued, instead of one no-op write per employee on every run.
  const storedKeys = (await loadStoredProbationEventKeys(probationEmployees.map(({ employee }) => employee.hrId))) ?? undefined;

  await Promise.all(
    probationEmployees.map(async ({ employee, row }) => {
      // The three scheduled reminders (pre-deadline) …
      await ensureProbationReminderEvents(employee, employees, lookups, storedKeys);
      // … plus the weekly overdue escalation once the 90 days lapse with no decision recorded.
      await ensureOverdueProbationReminderEvents(employee, row, employees, lookups, storedKeys);
    }),
  );

  const { data, error } = await supabase
    .from("notification_events")
    .select("id,employee_hr_id,metadata,recipients,scheduled_for,status,subject")
    .eq("category", "probation")
    .in("status", ["pending", "scheduled"])
    .lte("scheduled_for", todayDateOnly())
    .order("scheduled_for", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 50)));

  if (error) {
    if (isProbationSchemaMissing(error)) return { attempted: 0, failed: 0, processedIds: [], sent: 0 };
    throw error;
  }

  const events = (data ?? []) as ProbationReminderEventDbRow[];
  const processedIds: string[] = [];
  let attempted = 0;
  let failed = 0;
  let sent = 0;

  // Coexistence guard: an employee already decided in the NEW probation-intelligence module must not
  // keep receiving LEGACY probation reminders. A new-module pass/terminate never writes back to the
  // legacy row, so without this the same person gets duplicate/contradictory reminders until the
  // 90-day window expires. Best-effort — the new tables may not exist pre-migration.
  const decidedByNewModule = new Set<string>();
  try {
    const { data: decided } = await supabase
      .from("probation_cases")
      .select("employee_hr_id")
      .not("decision", "is", null);
    for (const r of (decided ?? []) as Array<{ employee_hr_id: string }>) {
      const key = normalizeHrId(r.employee_hr_id);
      if (key) decidedByNewModule.add(key);
    }
  } catch {
    // new-module schema absent (pre-migration) — legacy behavior unchanged
  }

  for (const event of events) {
    attempted += 1;
    const metadata = reminderMetadata(event);
    const employeeHrId = normalizeHrId(event.employee_hr_id);
    const employee = employeeHrId ? employeesByHrId.get(employeeHrId) : null;
    const row = employeeHrId ? activeRows.get(employeeHrId) : null;

    if (
      !employee || !row ||
      !isProbationDecisionOutstanding(row) ||
      (employeeHrId && decidedByNewModule.has(employeeHrId))
    ) {
      await markProbationReminderEvent(event.id, "failed", {
        ...metadata,
        skipped_reason: "Probation reminder skipped because the employee is no longer in an active probation review window (or was decided in the new probation module).",
      });
      failed += 1;
      processedIds.push(event.id);
      continue;
    }

    if (!row.workflow) {
      await ensureSystemProbationReview(employee, row.probation_end_date);
    }

    const daysRemaining = Number(metadata.days_remaining ?? row.days_remaining);
    const daysAfterHire = Number(metadata.days_after_hire ?? 90 - daysRemaining);
    const daysRemainingValue = Number.isFinite(daysRemaining) ? daysRemaining : row.days_remaining;
    // The overdue escalation reuses this send path; its copy must not read as "day 136 of a 90-day
    // probation" or "−46 days remaining". Branch the human-facing strings on the reminder type.
    const isOverdue = String(metadata.reminder_type ?? "") === "probation_overdue";
    const daysOverdueValue = Number(metadata.days_overdue ?? (Number.isFinite(daysRemainingValue) ? -daysRemainingValue : 0));
    const overdueLabel = `${daysOverdueValue} day${daysOverdueValue === 1 ? "" : "s"}`;
    const reminderSummary = isOverdue
      ? `${employee.displayName}'s 90-day probation ended ${overdueLabel} ago and no decision has been recorded.`
      : `${employee.displayName} is at day ${Number.isFinite(daysAfterHire) ? daysAfterHire : "-"} of the fixed 90-day probation period.`;
    const reminderManagerName = employee.managerName ?? managerOf(employee, employees)?.displayName ?? "Team";
    const actionUrl = `/api/probation/redirect?employeeHrId=${encodeURIComponent(employee.hrId)}`;
    const notificationResult = await createSystemNotification({
      actionUrl,
      actorId: "system",
      email: {
        ctaHref: actionUrl,
        ctaLabel: "Open Probation Review",
        employeeHrId: employee.hrId,
        metrics: [
          { label: "Employee", value: `${employee.displayName} (${employee.hrId})` },
          { label: "Job Title", value: employee.jobTitle ?? "-" },
          { label: "Line", value: employee.lineName ?? "-" },
          { label: "Area", value: employee.areaName ?? "-" },
          { label: "Hire date", value: employee.hireDate ?? "-" },
          { label: "Probation end date", value: row.probation_end_date ?? "-" },
          { label: "Days remaining", value: String(daysRemainingValue) },
        ],
        notificationType: "probation",
        subject: event.subject ?? `Probation reminder: ${employee.displayName}`,
        summary: reminderSummary,
        // The admin-editable probation_reminder template renders a detail table whose
        // cells use {{line}}/{{jobTitle}}/{{area}}/{{hireDate}}/{{endDate}}/{{duration}}
        // plus a "Dear {{managerName}}" greeting. The generic metric→context mapping in
        // notifications/email.ts does not populate those tokens, so without this explicit
        // templateContext the email goes out with all of those rows blank. templateContext
        // is merged last into the render context, so it authoritatively fills them.
        templateContext: {
          area: employee.areaName ?? "—",
          duration: isOverdue
            ? `${overdueLabel} overdue`
            : `${daysRemainingValue} day${daysRemainingValue === 1 ? "" : "s"} remaining`,
          employeeHrId: employee.hrId,
          employeeName: employee.displayName,
          endDate: row.probation_end_date ?? "—",
          hireDate: employee.hireDate ?? "—",
          jobTitle: employee.jobTitle ?? "—",
          line: employee.lineName ?? "—",
          managerName: reminderManagerName,
        },
        title: event.subject ?? "Probation reminder",
        tone: row.days_remaining <= 15 ? "danger" : "warning",
      },
      eventType: "reminder_due",
      message: reminderSummary,
      metadata: {
        ...metadata,
        actionUrl,
        area: employee.areaName ?? null,
        department: employee.departmentName ?? null,
        employeeHrId: employee.hrId,
        employeeName: employee.displayName,
        eventDate: todayDateOnly(),
        hiringDate: employee.hireDate ?? null,
        idempotencyKey: `probation-reminder:${event.id}:policy`,
        line: employee.lineName ?? null,
        managerName: employee.managerName ?? managerOf(employee, employees)?.displayName ?? null,
        requestUrl: actionUrl,
        status: "Feedback required",
        team: employee.teamName ?? null,
        workflowApproverHrIds: probationWorkflowApproverHrIds(employee, employees, hrApproverHrIds),
      },
      module: "probation",
      priority: row.days_remaining <= 15 ? "critical" : "high",
      recordId: event.id,
      subjectHrId: employee.hrId,
      title: event.subject ?? "Probation reminder",
    });
    const notificationResults = [notificationResult];
    const deliverySent = notificationResults.some((result) => result.deliveries.some((delivery) => delivery.status === "sent"));

    await markProbationReminderEvent(event.id, deliverySent ? "sent" : "failed", {
      ...metadata,
      delivery_results: notificationResults.map((result) => result.deliveries),
      processed_at: new Date().toISOString(),
    });
    if (deliverySent) {
      sent += 1;
    } else {
      failed += 1;
    }
    processedIds.push(event.id);
  }

  return { attempted, failed, processedIds, sent };
}

function assertText(value: string | null | undefined, message: string) {
  if (!cleanText(value)) throw new Error(message);
}

function assertExpectedVersion(row: ProbationWorkflowRecord, expectedUpdatedAt: string | null | undefined) {
  if (!expectedUpdatedAt) return;
  const current = new Date(row.updatedAt);
  const expected = new Date(expectedUpdatedAt);
  if (Number.isNaN(current.getTime()) || Number.isNaN(expected.getTime()) || current.toISOString() !== expected.toISOString()) {
    throw new Error("Probation workflow was updated by another user. Refresh and try again.");
  }
}

function validateWorkflowTransition(row: ProbationWorkflowRecord, action: ProbationWorkflowAction, input: ProbationWorkflowInput) {
  assertExpectedVersion(row, input.expectedUpdatedAt);
  if (isFinalWorkflow(row)) {
    throw new Error(`Invalid probation transition: ${actionLabel(action)} is not allowed after final decision.`);
  }

  switch (action) {
    case "manager_feedback":
      assertText(input.managerFeedback ?? row.managerFeedback, "Manager feedback is required before this transition.");
      return;
    case "pass":
      return;
    case "terminate":
      assertText(input.decisionReason, "Termination decision reason is required.");
      return;
    default:
      throw new Error("Unsupported probation workflow action.");
  }
}

export async function createProbationEvaluation(input: CreateProbationEvaluationInput, actor: string, access: AccessContext) {
  if (!isProbationAdministrator(access)) {
    throw new Error(`Forbidden: ${access.role} cannot create probation evaluations.`);
  }

  const employeeHrId = normalizeHrId(input.employeeHrId);
  if (!employeeHrId) throw new Error("Employee HR ID is required.");

  const employees = await getEmployeeDirectoryRows();
  const viewer = employees.find((row) => normalizeHrId(row.hrId) === normalizeHrId(access.hrId)) ?? null;
  const employee = employees.find((row) => normalizeHrId(row.hrId) === employeeHrId);
  if (!employee) throw new Error("Employee was not found in the directory.");
  if (!canReadProbationEmployee(access, employee, viewer, employees)) {
    throw new Error("Forbidden: employee is outside your probation scope.");
  }

  const probationByHrId = await loadProbationByHrId().catch((error) => {
    if (isProbationSchemaMissing(error)) return new Map<string, ProbationDbRow>();
    throw error;
  });
  const probation = probationByHrId.get(employee.hrId);
  const probationEndDate = canonicalProbationEndDate(employee.hireDate) ?? "";
  if (!probationEndDate) throw new Error("Probation end date is required.");

  const existingEvaluations = await loadEvaluationsByHrId().catch((error) => {
    if (isProbationSchemaMissing(error)) return new Map<string, ProbationWorkflowRecord>();
    throw error;
  });
  const existing = existingEvaluations.get(employee.hrId);
  if (existing && !isFinalWorkflow(existing)) {
    throw new Error("An open probation evaluation already exists for this employee.");
  }

  await assertProbationWorkflowTransition({
    access,
    action: "create",
    status: "new",
  });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("probation_evaluations")
    .insert({
      area_name: employee.areaName,
      created_by: actor,
      employee_hr_id: employee.hrId,
      employee_name: employee.fullName,
      evaluation_scores: input.evaluationScores ?? {},
      job_title: employee.positionTitle ?? employee.jobTitle,
      line_name: employee.lineName,
      manager_feedback: cleanText(input.managerFeedback),
      probation_end_date: probationEndDate,
      probation_id: probation?.id === undefined ? null : String(probation.id),
      status: input.managerFeedback ? "manager_feedback" : "evaluation_requested",
      updated_at: new Date().toISOString(),
      workflow_notes: appendWorkflowNote(null, actor, "created probation evaluation", cleanText(input.workflowNotes)),
    })
    .select("*")
    .single();

  if (error) throw error;
  const record = mapEvaluation(data as ProbationEvaluationDbRow);
  await ensureProbationReminderEvents(employee, employees);
  await insertHistory(record, "created", actor, null, { managerFeedback: cleanText(input.managerFeedback) });
  // After the reply (afterResponse): the evaluation is saved, and the notice used to be awaited before the
  // answer left — recipient lookups and a send per recipient. A failed notice is logged, never thrown.
  await afterResponse("probation_notice:created", async () => {
    await notifyProbationWorkflow(record, employee, employees, employee.displayName, "Probation Evaluation Created", "warning");
  });
  invalidateExecutiveDashboardCache("probation evaluation created", ["probation"]);
  return record;
}

export async function runProbationWorkflow(
  id: string,
  action: ProbationWorkflowAction,
  actor: string,
  access: AccessContext,
  input: ProbationWorkflowInput = {},
) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("probation_evaluations").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as ProbationEvaluationDbRow;
  const current = mapEvaluation(row);
  const employees = await getEmployeeDirectoryRows();
  const viewer = employees.find((employee) => normalizeHrId(employee.hrId) === normalizeHrId(access.hrId)) ?? null;
  const employee = employees.find((employee) => normalizeHrId(employee.hrId) === normalizeHrId(row.employee_hr_id));
  if (!employee || !canReadProbationEmployee(access, employee, viewer, employees)) {
    throw new Error("Forbidden: probation workflow is outside your scope.");
  }
  assertWorkflowActionAllowed(access, current, action, employee, viewer, employees);
  validateWorkflowTransition(current, action, input);
  const expectedNextStatusByAction: Record<ProbationWorkflowAction, string> = {
    manager_feedback: "probation_manager_feedback",
    pass: "probation_passed",
    terminate: "probation_terminated",
  };
  await assertProbationWorkflowTransition({
    access,
    action,
    decision: row.decision,
    expectedNextStatus: expectedNextStatusByAction[action],
    status: row.status,
  });

  const now = new Date().toISOString();
  const note = cleanText(input.note);
  // Persist the canonical HR_ID (never a login token) for decision attribution.
  const actorHrId = viewer?.hrId ?? normalizeHrId(access.hrId) ?? actor;
  const updates: Record<string, unknown> = {
    updated_at: now,
    workflow_notes: appendWorkflowNote(row.workflow_notes, actorHrId, action, note),
  };

  if (input.evaluationScores) updates.evaluation_scores = input.evaluationScores;

  switch (action) {
    case "manager_feedback":
      updates.status = "manager_feedback";
      updates.manager_feedback = cleanText(input.managerFeedback) ?? row.manager_feedback;
      updates.manager_reviewed_at = now;
      updates.manager_reviewed_by = actorHrId;
      break;
    case "pass":
    case "terminate":
      updates.status = "completed";
      updates.decision = action;
      updates.decision_reason = cleanText(input.decisionReason);
      updates.approved_at = now;
      updates.approved_by = actorHrId;
      updates.completed_at = now;
      updates.completed_by = actorHrId;
      break;
    default:
      throw new Error("Unsupported probation workflow action.");
  }

  let updateQuery = supabase
    .from("probation_evaluations")
    .update(updates)
    .eq("id", id);
  if (input.expectedUpdatedAt) {
    updateQuery = updateQuery.eq("updated_at", row.updated_at);
  }
  const { data: updatedData, error: updateError } = await updateQuery
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updatedData) throw new Error("Probation workflow was updated by another user. Refresh and try again.");

  const updated = mapEvaluation(updatedData as ProbationEvaluationDbRow);
  if (action === "pass" || action === "terminate") {
    await applyDecisionSideEffects(updated);
  }
  await insertHistory(updated, action, actor, row.status, { decisionReason: cleanText(input.decisionReason), note });
  // After the reply (afterResponse): the decision is saved and its side effects applied, and the notice
  // used to be awaited before the answer left — recipient lookups and a send per recipient. A failed
  // notice is logged, never thrown (it used to turn a saved decision into a false 500).
  await afterResponse("probation_notice:workflow", async () => {
    await notifyProbationWorkflow(
      updated,
      employee,
      employees,
      employee.displayName,
      action === "pass" || action === "terminate" ? "Probation Decision Recorded" : "Probation Review Updated",
      updated.decision === "terminate" ? "danger" : action === "pass" ? "success" : "warning",
    );
  });
  invalidateEmployeeDirectoryCache();
  invalidateExecutiveDashboardCache("probation workflow updated", ["probation", "employees", "vacancies", "payroll"]);
  return updated;
}

async function applyDecisionSideEffects(record: ProbationWorkflowRecord) {
  if (!record.decision) return;

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const employeeUpdates: Record<string, unknown> = { updated_at: now };
  const probationUpdates: Record<string, unknown> = { updated_at: now };

  if (record.decision === "pass") {
    employeeUpdates.employment_status = "active";
    employeeUpdates.organogram_visible = true;
    employeeUpdates.payroll_eligible = true;
    probationUpdates.status = "passed";
  } else if (record.decision === "terminate") {
    probationUpdates.status = "terminated";
  }

  if (Object.keys(employeeUpdates).length > 1) {
    const { error } = await supabase.from("employees").update(employeeUpdates).eq("hr_id", record.employeeHrId);
    if (error) throw error;
  }
  if (record.probationId && Object.keys(probationUpdates).length > 1) {
    const { error } = await supabase.from("employee_probation").update(probationUpdates).eq("id", record.probationId);
    if (error) throw error;
  }
  if (record.decision === "terminate") {
    await resignEmployeeAndOpenVacancy(
      record.employeeHrId,
      {
        effectiveDate: todayDateOnly(),
        employeeHrId: record.employeeHrId,
        employeeStatus: "terminated",
        reason: record.decisionReason ?? "Probation termination.",
        submittedDate: todayDateOnly(),
        workflowNotes: `Probation termination from probation review ${record.id}.`,
      },
      record.completedBy ?? record.approvedBy ?? "probation",
      undefined,
      // A probation termination is a COMPANY decision, not a resignation. Without this the
      // resignation recipient list also receives a "Resignation Submitted" notice framed as
      // voluntary, alongside the real probation-decision notice — wrong framing, wrong audience,
      // duplicated for one event. intelligence/decision.ts:223 already does this on the newer
      // path, and resignations/service.ts:1247-1250 documents that probation-sourced
      // terminations must suppress it.
      { suppressWorkflowNotification: true },
    );
  }

  if (record.decision === "pass" || record.decision === "terminate") {
    const { error } = await supabase
      .from("notification_events")
      .update({
        status: "cancelled",
        updated_at: now,
      })
      .eq("employee_hr_id", record.employeeHrId)
      .eq("category", "probation")
      .in("status", ["scheduled", "pending"]);
    if (error && !isProbationSchemaMissing(error)) throw error;
  }

  // Write-through to the NEW probation_cases model. The legacy workflow above resolves the employee
  // (employee_probation + employees), but the CEO Probation Decision Dashboard and the milestone-email
  // sweep read `probation_cases`. Without this a legacy-decided rep stays a permanently "active" case:
  // it keeps getting milestone emails and keeps accepting feedback. Best-effort — never let a mirror
  // failure break the legacy decision that already succeeded.
  await mirrorLegacyDecisionToProbationCase(record);
}

/**
 * Mirror a completed LEGACY probation decision into the new `probation_cases` model so the two
 * systems stay in sync. Idempotent and non-overwriting: only the FIRST writer (decision still null,
 * status still active) records the outcome. `side_effects_applied_at` is set so the new module's
 * `decideProbation` will NOT re-drive side effects (resignation/employee update already happened via
 * the legacy path). Best-effort: any failure is recorded to the provisioning-failure monitoring sink
 * and swallowed, never propagated into the legacy decision flow.
 */
async function mirrorLegacyDecisionToProbationCase(record: ProbationWorkflowRecord) {
  if (!record.decision) return;
  try {
    const probationCase = await getProbationCaseByEmployee(record.employeeHrId);
    if (!probationCase) return; // non-med-rep / pre-module employee — nothing to mirror
    if (probationCase.decision || probationCase.status !== "active") return; // already decided elsewhere — never overwrite
    const now = new Date().toISOString();
    const { error } = await getSupabaseAdmin()
      .from("probation_cases")
      .update({
        decision: record.decision, // "pass" | "terminate" — same vocabulary, no translation
        decision_reason: record.decisionReason ?? null,
        decision_by: record.completedBy ?? record.approvedBy ?? "legacy_probation",
        decision_at: now,
        status: "decided",
        // Load-bearing: tells the NEW module its side effects were already applied via the legacy
        // path, so decideProbation won't re-drive them (double resignation / employee update).
        side_effects_applied_at: now,
        updated_at: now,
      })
      .eq("id", probationCase.id)
      .is("decision", null); // idempotency: only the first writer sets the decision
    if (error) throw error;
  } catch (error) {
    // Best-effort monitoring only — never let mirroring failure break the legacy decision.
    try {
      await getSupabaseAdmin().from("probation_provisioning_failures").insert({
        employee_hr_id: record.employeeHrId,
        source: "legacy_decision_writethrough",
        error_message: String((error as { message?: unknown })?.message ?? error),
      });
    } catch {
      /* best-effort */
    }
  }
}
