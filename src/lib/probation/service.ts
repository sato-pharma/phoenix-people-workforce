import {
  getEmployeeDirectory,
  getEmployeeDirectoryRows,
  isActiveLifecycleStatus,
} from "@/lib/employees/employee-directory";
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
import { createSystemNotification } from "@/lib/notifications/system";
import {
  probationDaysRemaining,
  probationEndDate as canonicalProbationEndDate,
} from "@/lib/probation/date";
import { isProbationFieldRoleTitle } from "@/lib/probation/intelligence/cases";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { sameWorkforceLine } from "@/lib/workforce/hierarchy-resolver";

import type {
  ProbationRow,
  ProbationWorkflowAction,
  ProbationWorkflowRecord,
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

type ProbationReminderEventDbRow = {
  employee_hr_id: string | null;
  id: string;
  metadata: Record<string, unknown> | null;
  recipients?: string[] | null;
  scheduled_for: string | null;
  status: string | null;
  subject: string | null;
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

function managerOf(employee: EmployeeScopeRow, directory: EmployeeScopeRow[]) {
  const managerHrId = normalizeHrId(employee.managerHrId);
  return managerHrId ? directory.find((row) => normalizeHrId(row.hrId) === managerHrId) ?? null : null;
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

function normalizeDate(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  return raw ? raw.slice(0, 10) : null;
}

function addDays(value: string | null | undefined, days: number) {
  return addDaysToDateOnly(normalizeDate(value), days);
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

// ONE PROBATION MODEL (audit item REC-010, 14 Nov 2026). A probationer's review state - the
// `workflow` on every tracker row, its decision, and whether a decision is still outstanding - is read
// from their PROBATION CASE (`probation_cases`), the record the case page decides on
// (src/lib/probation/intelligence/decision.ts). The second model this replaced, `probation_evaluations`,
// had its own Pass / Terminate door and a best-effort mirror into the case; when the mirror missed, the
// tracker and the case disagreed about where a person stood. That door, the mirror and the sweep that
// opened an empty evaluation for every probationer are gone, and nothing writes `probation_evaluations`
// any more (its rows are left in place: 61 on 14 Nov 2026, every one still "evaluation requested").
// The record is shaped as the old one so the tracker, the portal, the exports, the command centres and
// the Needs You row keep reading `row.workflow` unchanged; the fields only the old model held stay null.
type ProbationCaseWorkflowDbRow = {
  id: string;
  employee_hr_id: string;
  employee_name: string | null;
  job_title: string | null;
  line_name: string | null;
  area_name: string | null;
  probation_end_date: string | null;
  decision: string | null;
  decision_reason: string | null;
  decision_by: string | null;
  decision_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const PROBATION_CASE_WORKFLOW_COLUMNS =
  "id, employee_hr_id, employee_name, job_title, line_name, area_name, probation_end_date, decision, decision_reason, decision_by, decision_at, created_by, created_at, updated_at";

export function mapProbationCaseToWorkflow(row: ProbationCaseWorkflowDbRow): ProbationWorkflowRecord {
  const decision: ProbationWorkflowRecord["decision"] =
    row.decision === "pass" || row.decision === "terminate" ? row.decision : null;
  const decidedAt = decision ? asIso(row.decision_at) : null;
  const decidedBy = decision ? row.decision_by : null;
  return {
    allowedActions: [],
    approvedAt: decidedAt,
    approvedBy: decidedBy,
    areaName: row.area_name,
    completedAt: decidedAt,
    completedBy: decidedBy,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by,
    decision,
    decisionReason: decision ? row.decision_reason : null,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name ?? row.employee_hr_id,
    evaluationScores: {},
    hrRecommendation: null,
    hrReviewedAt: null,
    hrReviewedBy: null,
    id: row.id,
    jobTitle: row.job_title,
    lineName: row.line_name,
    managerFeedback: null,
    managerReviewedAt: null,
    managerReviewedBy: null,
    probationEndDate: row.probation_end_date ?? "",
    probationId: null,
    probationLetterName: null,
    probationLetterUrl: null,
    status: decision === "pass" ? "passed" : decision === "terminate" ? "terminated" : "active",
    updatedAt: new Date(row.updated_at).toISOString(),
    workflowNotes: null,
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

/** Each probationer's case, keyed by the canonical HR id, shaped as the tracker's workflow record. */
async function loadCaseWorkflowsByHrId() {
  const { data, error } = await getSupabaseAdmin()
    .from("probation_cases")
    .select(PROBATION_CASE_WORKFLOW_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) throw error;
  const byHrId = new Map<string, ProbationWorkflowRecord>();
  for (const row of (data ?? []) as ProbationCaseWorkflowDbRow[]) {
    const key = normalizeHrId(row.employee_hr_id);
    if (key && !byHrId.has(key)) byHrId.set(key, mapProbationCaseToWorkflow(row));
  }
  return byHrId;
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
  let caseWorkflowsByHrId = new Map<string, ProbationWorkflowRecord>();

  try {
    [probationByHrId, caseWorkflowsByHrId] = await Promise.all([
      loadProbationByHrId(),
      loadCaseWorkflowsByHrId(),
    ]);
  } catch (error) {
    if (!isProbationSchemaMissing(error)) throw error;
  }

  return employees
    // FIELD ROLES ONLY (owner, 13-14 Nov 2026, replacing the 2026-07-17 Medical-Reps-only rule): a Medical
    // Representative or a District / Regional / National Sales Manager. Office and head-office roles
    // inside their own hire+90 window must never surface in the tracker/dashboard/exports/portal — this
    // list is built from the employee directory window, not probation_cases, so it needs its own guard,
    // the same one the case provisioning uses. See isProbationFieldRoleTitle.
    .filter((employee) => isProbationFieldRoleTitle(employee.positionTitle ?? employee.jobTitle))
    .filter((employee) => canReadProbationEmployee(access, employee, viewer, employees, viewerAllowedLines))
    .map((employee) => {
      const probation = probationByHrId.get(employee.hrId);
      // The person's probation case is their review state (REC-010): one record, the one the case page decides on.
      const workflow = caseWorkflowsByHrId.get(normalizeHrId(employee.hrId) ?? "") ?? null;
      const manager = managerOf(employee, employees);
      const managerManager = manager ? managerOf(manager, employees) : null;
      const probationEndDate = canonicalProbationEndDate(employee.hireDate) ?? "";
      // No action is taken on the tracker row any more: a decision is made on the case page and feedback
      // through the double-visit feedback tasks (REC-010).
      const allowedActions: ProbationWorkflowAction[] = [];
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
