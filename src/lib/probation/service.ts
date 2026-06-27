import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { assertProbationWorkflowTransition } from "@/lib/employee-lifecycle/workflow";
import {
  canSeeEmployee,
  normalizeHrId,
  systemAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import { addDaysToDateOnly, parseDateOnly } from "@/lib/date-only";
import { lifecycleRiskWindows } from "@/lib/lifecycle-risk/metrics";
import { createSystemNotification } from "@/lib/notifications/system";
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
  extension_end_date: string | null;
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
  extensionEndDate?: string | null;
  evaluationScores?: Record<string, number | string | null>;
  hrRecommendation?: string | null;
  managerFeedback?: string | null;
  note?: string | null;
};

const probationDays = 90;
// Governance: probation pass/terminate/evaluation authority is reserved for Super Admin
// (Admin-HR) and the HR Manager B-10 (Omar Anwar Gawish), who holds the Super Admin role.
// The retired broad HR access role and Talent Acquisition must NOT administer or approve probation.
const hrProbationRoles = new Set(["Super Admin"]);
async function resolveActiveHrApproverHrIds(): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", ["HR Manager", "Super Admin"])
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
// administration; Talent Acquisition stays scoped to recruitment workflows. Training Manager and
// Marketing Manager additionally have company-wide probation VIEW/EXPORT as part of their org-wide
// oversight — but deliberately NOT administrator powers (manager_feedback/pass/terminate stay
// gated by isProbationAdministrator), so their oversight is strictly read-only.
export function canViewAllProbation(access: Pick<AccessContext, "role" | "scope">) {
  return (
    isProbationAdministrator(access) ||
    access.role === "Training Manager" ||
    access.role === "Marketing Manager"
  );
}

export function canReadAllProbation(access: Pick<AccessContext, "role" | "scope">) {
  return canViewAllProbation(access) || access.role === "CEO";
}

export function assertCanExportProbation(access: AccessContext) {
  if (!canViewAllProbation(access)) {
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
  if (decision === "extend") return "extended";
  if (decision === "terminate") return "terminated";
  if (evaluationStatus === "completed") return "passed";
  return "active";
}

function isFinalWorkflow(row: ProbationWorkflowRecord | null | undefined) {
  return Boolean(row?.decision === "pass" || row?.decision === "terminate");
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

function daysRemaining(value: string | null | undefined) {
  const endDate = parseDateOnly(normalizeDate(value));
  if (!endDate) return 0;
  const end = endDate.getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((end - today.getTime()) / 86400000);
}

function baseProbationEndDate(employee: Pick<EmployeeScopeRow, "hireDate">) {
  return addDays(employee.hireDate, probationDays) ?? "";
}

function currentProbationEndDate(employee: EmployeeScopeRow) {
  return baseProbationEndDate(employee);
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
    extensionEndDate: row.extension_end_date,
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

export async function getProbationRows(access: AccessContext): Promise<ProbationRow[]> {
  const employees = await getEmployeeDirectoryRows();
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
    .filter((employee) => canReadProbationEmployee(access, employee, viewer, employees))
    .map((employee) => {
      const probation = probationByHrId.get(employee.hrId);
      const workflow = evaluationsByHrId.get(employee.hrId) ?? null;
      const manager = managerOf(employee, employees);
      const managerManager = manager ? managerOf(manager, employees) : null;
      const probationEndDate = currentProbationEndDate(employee);
      const allowedActions = allowedWorkflowActions(access, workflow, employee, viewer, employees);
      if (workflow) workflow.allowedActions = allowedActions;
      return {
        allowedActions,
        area_name: employee.areaName ?? "Unassigned",
        crm_id: employee.crmId ?? "",
        days_remaining: daysRemaining(probationEndDate),
        employment_status: employee.employmentStatus ?? "",
        full_name: employee.fullName,
        hire_date: employee.hireDate ?? "",
        hr_id: employee.hrId,
        job_title: employee.positionTitle ?? employee.jobTitle ?? "Unassigned",
        line_name: employee.lineName ?? "Unassigned",
        manager_hr_id: employee.managerHrId,
        manager_manager_hr_id: managerManager?.hrId ?? null,
        manager_manager_name: managerManager?.fullName ?? null,
        manager_name: employee.managerName ?? manager?.fullName ?? null,
        has_durable_probation_record: Boolean(probation),
        probation_end_date: probationEndDate,
        probation_id: probation?.id === undefined ? null : String(probation.id),
        team_name: employee.teamName,
        workflow,
      };
    })
    .filter((row) => row.days_remaining > 0 || row.workflow);
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

async function notifyProbationWorkflow(record: ProbationWorkflowRecord, title: string, tone: "success" | "warning" | "danger") {
  await createSystemNotification({
    actionUrl: "/api/probation/redirect",
    actorId: "system",
    email: {
      ctaHref: "/api/probation/redirect",
      ctaLabel: "Open probation tracker",
      employeeHrId: record.employeeHrId,
      metrics: [
        { label: "Employee", value: `${record.employeeName} (${record.employeeHrId})` },
        { label: "Status", value: record.status },
        { label: "Decision", value: record.decision ?? "Pending" },
      ],
      notificationType: "probation",
      subject: `Phoenix ${title} - ${record.employeeName}`,
      summary: `Probation review for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
      // The admin-editable probation_workflow template renders an employee detail table
      // ({{line}}/{{jobTitle}}/{{endDate}}); the generic metric→context mapping leaves
      // those tokens empty. Fill them from the workflow record so the email is not blank.
      templateContext: {
        area: record.areaName ?? "—",
        employeeHrId: record.employeeHrId,
        employeeName: record.employeeName,
        endDate: record.probationEndDate ?? "—",
        jobTitle: record.jobTitle ?? "—",
        line: record.lineName ?? "—",
      },
      title,
      tone,
    },
    eventType: "workflow_updated",
    message: `Probation review for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
    metadata: {
      decision: record.decision ?? null,
      employeeHrId: record.employeeHrId,
      idempotencyKey: `probation:${record.employeeHrId}:${record.status}`,
      status: record.status,
    },
    module: "probation",
    priority: tone === "danger" ? "critical" : "high",
    subjectHrId: record.employeeHrId,
    title,
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

function resolveProbationReminderRecipientHrIds(employee: EmployeeScopeRow, directory: EmployeeScopeRow[], hrApproverHrIds: string[]) {
  const manager = managerOf(employee, directory);
  return Array.from(new Set([
    normalizeHrId(manager?.hrId),
    ...probationWorkflowApproverHrIds(employee, directory, hrApproverHrIds),
  ].filter(Boolean)));
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

async function ensureProbationReminderEvents(employee: EmployeeScopeRow, directory: EmployeeScopeRow[]) {
  const schedule = getProbationReminderSchedule(employee.hireDate);
  if (schedule.length === 0) return;

  const now = new Date().toISOString();
  const hrApproverHrIds = await resolveActiveHrApproverHrIds();
  const recipientHrIds = resolveProbationReminderRecipientHrIds(employee, directory, hrApproverHrIds);
  const workflowApproverHrIds = probationWorkflowApproverHrIds(employee, directory, hrApproverHrIds);
  const recipientRoles = probationRecipientRoles(employee, directory, hrApproverHrIds);
  const rows = schedule.map((reminder) => ({
    category: "probation",
    employee_hr_id: employee.hrId,
    event_key: `${employee.hrId}:probation:${reminder.reminderType}:${reminder.scheduledFor}`,
    metadata: {
      href: "/probation",
      message: `${employee.fullName} has ${reminder.daysRemaining} days remaining in the 90-day probation period. Submit manager probation feedback.`,
      title: `${employee.fullName}'s probation feedback is due`,
      days_after_hire: reminder.daysAfterHire,
      days_remaining: reminder.daysRemaining,
      hire_date: employee.hireDate,
      recipient_roles: recipientRoles,
      reminder_type: reminder.reminderType,
      workflowApproverHrIds,
      details: [
        { label: "Employee", value: `${employee.fullName} (${employee.hrId})` },
        { label: "Days remaining", value: `${reminder.daysRemaining}` },
        { label: "Status", value: "Feedback required" },
        { label: "Action", value: "Submit feedback" },
      ],
    },
    recipients: recipientHrIds,
    scheduled_for: reminder.scheduledFor,
    status: "pending",
    subject: `${employee.fullName}'s probation feedback is due`,
    updated_at: now,
  }));

  const { error } = await getSupabaseAdmin()
    .from("notification_events")
    .upsert(rows, { onConflict: "event_key", ignoreDuplicates: true });
  if (error && !isProbationSchemaMissing(error)) throw error;
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
  return new Date().toISOString().slice(0, 10);
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

  await Promise.all(
    rows
      .map((row) => employeesByHrId.get(normalizeHrId(row.hr_id)))
      .filter((employee): employee is EmployeeScopeRow => Boolean(employee))
      .map((employee) => ensureProbationReminderEvents(employee, employees)),
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

  for (const event of events) {
    attempted += 1;
    const metadata = reminderMetadata(event);
    const employeeHrId = normalizeHrId(event.employee_hr_id);
    const employee = employeeHrId ? employeesByHrId.get(employeeHrId) : null;
    const row = employeeHrId ? activeRows.get(employeeHrId) : null;

    if (!employee || !row || row.workflow?.decision === "pass" || row.workflow?.decision === "terminate") {
      await markProbationReminderEvent(event.id, "failed", {
        ...metadata,
        skipped_reason: "Probation reminder skipped because the employee is no longer in an active probation review window.",
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
    const reminderManagerName = employee.managerName ?? managerOf(employee, employees)?.fullName ?? "Team";
    const actionUrl = `/api/probation/redirect?employeeHrId=${encodeURIComponent(employee.hrId)}`;
    const notificationResult = await createSystemNotification({
      actionUrl,
      actorId: "system",
      email: {
        ctaHref: actionUrl,
        ctaLabel: "Open Probation Review",
        employeeHrId: employee.hrId,
        metrics: [
          { label: "Employee", value: `${employee.fullName} (${employee.hrId})` },
          { label: "Hire date", value: employee.hireDate ?? "-" },
          { label: "Days remaining", value: String(daysRemainingValue) },
        ],
        notificationType: "probation",
        subject: event.subject ?? `Probation reminder: ${employee.fullName}`,
        summary: `${employee.fullName} is at day ${Number.isFinite(daysAfterHire) ? daysAfterHire : "-"} of the fixed 90-day probation period.`,
        // The admin-editable probation_reminder template renders a detail table whose
        // cells use {{line}}/{{jobTitle}}/{{area}}/{{hireDate}}/{{endDate}}/{{duration}}
        // plus a "Dear {{managerName}}" greeting. The generic metric→context mapping in
        // notifications/email.ts does not populate those tokens, so without this explicit
        // templateContext the email goes out with all of those rows blank. templateContext
        // is merged last into the render context, so it authoritatively fills them.
        templateContext: {
          area: employee.areaName ?? "—",
          duration: `${daysRemainingValue} day${daysRemainingValue === 1 ? "" : "s"} remaining`,
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
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
      message: `${employee.fullName} is at day ${Number.isFinite(daysAfterHire) ? daysAfterHire : "-"} of the fixed 90-day probation period.`,
      metadata: {
        ...metadata,
        actionUrl,
        area: employee.areaName ?? null,
        department: employee.departmentName ?? null,
        employeeHrId: employee.hrId,
        employeeName: employee.fullName,
        eventDate: todayDateOnly(),
        hiringDate: employee.hireDate ?? null,
        idempotencyKey: `probation-reminder:${event.id}:policy`,
        line: employee.lineName ?? null,
        managerName: employee.managerName ?? managerOf(employee, employees)?.fullName ?? null,
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

  const employeeHrId = cleanText(input.employeeHrId)?.toUpperCase();
  if (!employeeHrId) throw new Error("Employee HR ID is required.");

  const employees = await getEmployeeDirectoryRows();
  const viewer = employees.find((row) => normalizeHrId(row.hrId) === normalizeHrId(access.hrId)) ?? null;
  const employee = employees.find((row) => row.hrId.toUpperCase() === employeeHrId);
  if (!employee) throw new Error("Employee was not found in the directory.");
  if (!canReadProbationEmployee(access, employee, viewer, employees)) {
    throw new Error("Forbidden: employee is outside your probation scope.");
  }

  const probationByHrId = await loadProbationByHrId().catch((error) => {
    if (isProbationSchemaMissing(error)) return new Map<string, ProbationDbRow>();
    throw error;
  });
  const probation = probationByHrId.get(employee.hrId);
  const probationEndDate = currentProbationEndDate(employee);
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
  await notifyProbationWorkflow(record, "Probation Evaluation Created", "warning");
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
  const updates: Record<string, unknown> = {
    updated_at: now,
    workflow_notes: appendWorkflowNote(row.workflow_notes, actor, action, note),
  };

  if (input.evaluationScores) updates.evaluation_scores = input.evaluationScores;

  switch (action) {
    case "manager_feedback":
      updates.status = "manager_feedback";
      updates.manager_feedback = cleanText(input.managerFeedback) ?? row.manager_feedback;
      updates.manager_reviewed_at = now;
      updates.manager_reviewed_by = actor;
      break;
    case "pass":
    case "terminate":
      updates.status = "completed";
      updates.decision = action;
      updates.decision_reason = cleanText(input.decisionReason);
      updates.extension_end_date = null;
      updates.approved_at = now;
      updates.approved_by = actor;
      updates.completed_at = now;
      updates.completed_by = actor;
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
  await notifyProbationWorkflow(
    updated,
    action === "pass" || action === "terminate" ? "Probation Decision Recorded" : "Probation Review Updated",
    updated.decision === "terminate" ? "danger" : action === "pass" ? "success" : "warning",
  );
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
}
