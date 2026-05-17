import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import {
  canSeeEmployee,
  normalizeHrId,
  normalizeLineName,
  systemAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import { addDaysToDateOnly, parseDateOnly } from "@/lib/date-only";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
  probationLetterName?: string | null;
  probationLetterUrl?: string | null;
};

const probationDays = 90;
const hrProbationRoles = new Set(["Super Admin", "HR Specialist"]);
const extensionProbationStatus = "extended";

export function isProbationAdministrator(access: Pick<AccessContext, "role" | "scope">) {
  return access.scope === "system" || hrProbationRoles.has(access.role);
}

export function assertCanExportProbation(access: AccessContext) {
  if (!isProbationAdministrator(access)) {
    throw new Error(`Forbidden: ${access.role} cannot export probation.`);
  }
}

function isSameLine(employee: EmployeeScopeRow, viewer: EmployeeScopeRow | null) {
  if (!viewer) return false;
  const employeeLine = normalizeLineName(employee.lineName);
  const viewerLine = normalizeLineName(viewer.lineName);
  return Boolean(employeeLine && viewerLine && employeeLine === viewerLine);
}

function canReadProbationEmployee(
  access: AccessContext,
  employee: EmployeeScopeRow,
  viewer: EmployeeScopeRow | null,
  directory: EmployeeScopeRow[] = [],
) {
  if (isProbationAdministrator(access)) return true;
  if (access.role === "National Sales Manager") return isSameLine(employee, viewer);
  if (access.role === "Regional Manager") return isInManagerHierarchy(directory, viewer, employee);
  if (access.role === "Training Manager") return false;
  return canSeeEmployee(access, employee);
}

function canSubmitManagerFeedback(
  access: AccessContext,
  employee: EmployeeScopeRow,
  viewer: EmployeeScopeRow | null,
  directory: EmployeeScopeRow[] = [],
) {
  if (isProbationAdministrator(access)) return true;
  if (access.role === "National Sales Manager") return isSameLine(employee, viewer);
  if (access.role === "Regional Manager") return isInManagerHierarchy(directory, viewer, employee);
  if (access.role === "District Manager" || access.role === "Manager") return canSeeEmployee(access, employee);
  return false;
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

function currentProbationEndDate(employee: EmployeeScopeRow, probation: ProbationDbRow | undefined) {
  const baseEndDate = baseProbationEndDate(employee);
  if (probation?.status === extensionProbationStatus && probation.probation_end_date) {
    return probation.probation_end_date;
  }
  return baseEndDate;
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
  allowed.add("extend");
  allowed.add("terminate");
  allowed.add("upload_letter");

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
      const probationEndDate = workflow?.decision === "extend" && workflow.extensionEndDate
        ? workflow.extensionEndDate
        : currentProbationEndDate(employee, probation);
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
        has_durable_probation_record: Boolean(probation),
        probation_end_date: probationEndDate,
        probation_id: probation?.id === undefined ? null : String(probation.id),
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
  await safeSendNotificationEmail({
    ctaHref: "/probation",
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
    title,
    tone,
  });
}

export function getProbationReminderSchedule(hireDate: string | null | undefined) {
  const reminders = [
    { daysAfterHire: 30, daysRemaining: 60, reminderType: "probation_day_30_check" },
    { daysAfterHire: 60, daysRemaining: 30, reminderType: "probation_30_days_remaining" },
    { daysAfterHire: 75, daysRemaining: 15, reminderType: "probation_15_days_remaining" },
  ] as const;

  return reminders
    .map((reminder) => ({
      ...reminder,
      scheduledFor: addDays(hireDate, reminder.daysAfterHire),
    }))
    .filter((reminder) => Boolean(reminder.scheduledFor));
}

async function ensureProbationReminderEvents(employee: EmployeeScopeRow) {
  const schedule = getProbationReminderSchedule(employee.hireDate);
  if (schedule.length === 0) return;

  const now = new Date().toISOString();
  const rows = schedule.map((reminder) => ({
    category: "probation",
    employee_hr_id: employee.hrId,
    event_key: `${employee.hrId}:probation:${reminder.reminderType}:${reminder.scheduledFor}`,
    metadata: {
      href: "/probation",
      message: `${employee.fullName} has ${reminder.daysRemaining} days remaining in the fixed 90-day probation period.`,
      title: `Probation reminder: ${employee.fullName}`,
      days_after_hire: reminder.daysAfterHire,
      days_remaining: reminder.daysRemaining,
      hire_date: employee.hireDate,
      reminder_type: reminder.reminderType,
    },
    recipients: [employee.managerHrId].filter(Boolean),
    scheduled_for: reminder.scheduledFor,
    status: "pending",
    subject: `Probation reminder: ${employee.fullName}`,
    updated_at: now,
  }));

  const { error } = await getSupabaseAdmin()
    .from("notification_events")
    .upsert(rows, { onConflict: "event_key" });
  if (error && !isProbationSchemaMissing(error)) throw error;
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
  const { data, error } = await supabase
    .from("notification_events")
    .select("id,employee_hr_id,metadata,scheduled_for,status,subject")
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
  const employees = await getEmployeeDirectoryRows();
  const rows = await getProbationRows(systemAccessContext);
  const activeRows = new Map(rows.map((row) => [normalizeHrId(row.hr_id), row]));
  const employeesByHrId = new Map(employees.map((employee) => [normalizeHrId(employee.hrId), employee]));
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

    const daysRemaining = Number(metadata.days_remaining ?? row.days_remaining);
    const daysAfterHire = Number(metadata.days_after_hire ?? 90 - daysRemaining);
    const result = await safeSendNotificationEmail({
      ctaHref: "/probation",
      ctaLabel: "Open probation tracker",
      employeeHrId: employee.hrId,
      metrics: [
        { label: "Employee", value: `${employee.fullName} (${employee.hrId})` },
        { label: "Hire date", value: employee.hireDate ?? "-" },
        { label: "Days remaining", value: Number.isFinite(daysRemaining) ? String(daysRemaining) : String(row.days_remaining) },
      ],
      notificationType: "probation",
      subject: event.subject ?? `Probation reminder: ${employee.fullName}`,
      summary: `${employee.fullName} is at day ${Number.isFinite(daysAfterHire) ? daysAfterHire : "-"} of the fixed 90-day probation period.`,
      title: event.subject ?? "Probation reminder",
      tone: row.days_remaining <= 15 ? "danger" : "warning",
    });

    await markProbationReminderEvent(event.id, result.skipped ? "failed" : "sent", {
      ...metadata,
      email_result: result.skipped ? result.reason : result.id,
      processed_at: new Date().toISOString(),
    });
    if (result.skipped) {
      failed += 1;
    } else {
      sent += 1;
    }
    processedIds.push(event.id);
  }

  return { attempted, failed, processedIds, sent };
}

function assertText(value: string | null | undefined, message: string) {
  if (!cleanText(value)) throw new Error(message);
}

function assertDateAfter(value: string | null | undefined, current: string | null | undefined, message: string) {
  const next = parseDateOnly(normalizeDate(value));
  const previous = parseDateOnly(normalizeDate(current));
  if (!next || !previous || next.getTime() <= previous.getTime()) {
    throw new Error(message);
  }
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
  if (isFinalWorkflow(row) && action !== "upload_letter") {
    throw new Error(`Invalid probation transition: ${actionLabel(action)} is not allowed after final decision.`);
  }

  switch (action) {
    case "manager_feedback":
      assertText(input.managerFeedback ?? row.managerFeedback, "Manager feedback is required before this transition.");
      return;
    case "pass":
      return;
    case "extend":
      assertDateAfter(input.extensionEndDate, row.probationEndDate, "Extension end date must be later than the current probation end date.");
      return;
    case "terminate":
      assertText(input.decisionReason, "Termination decision reason is required.");
      return;
    case "upload_letter":
      assertText(input.probationLetterUrl, "Probation letter URL is required.");
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
  const probationEndDate = currentProbationEndDate(employee, probation);
  if (!probationEndDate) throw new Error("Probation end date is required.");

  const existingEvaluations = await loadEvaluationsByHrId().catch((error) => {
    if (isProbationSchemaMissing(error)) return new Map<string, ProbationWorkflowRecord>();
    throw error;
  });
  const existing = existingEvaluations.get(employee.hrId);
  if (existing && !isFinalWorkflow(existing)) {
    throw new Error("An open probation evaluation already exists for this employee.");
  }

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
  await ensureProbationReminderEvents(employee);
  await insertHistory(record, "created", actor, null, { managerFeedback: cleanText(input.managerFeedback) });
  await notifyProbationWorkflow(record, "Probation Evaluation Created", "warning");
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
    case "extend":
    case "terminate":
      updates.status = "completed";
      updates.decision = action;
      updates.decision_reason = cleanText(input.decisionReason);
      updates.extension_end_date = action === "extend" ? normalizeDate(input.extensionEndDate) : null;
      updates.approved_at = now;
      updates.approved_by = actor;
      updates.completed_at = now;
      updates.completed_by = actor;
      break;
    case "upload_letter":
      if (!cleanText(input.probationLetterUrl)) throw new Error("Probation letter URL is required.");
      updates.probation_letter_url = cleanText(input.probationLetterUrl);
      updates.probation_letter_name = cleanText(input.probationLetterName) ?? "Probation letter";
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
  if (action === "pass" || action === "extend" || action === "terminate") {
    await applyDecisionSideEffects(updated);
  }
  await insertHistory(updated, action, actor, row.status, { decisionReason: cleanText(input.decisionReason), note });
  await notifyProbationWorkflow(
    updated,
    action === "pass" || action === "extend" || action === "terminate" ? "Probation Decision Recorded" : "Probation Review Updated",
    updated.decision === "terminate" ? "danger" : action === "pass" || action === "extend" ? "success" : "warning",
  );
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
  } else if (record.decision === "extend") {
    if (!record.extensionEndDate) throw new Error("Extension end date is required before completion.");
    employeeUpdates.probation_end_date = record.extensionEndDate;
    employeeUpdates.employment_status = "active";
    employeeUpdates.organogram_visible = true;
    employeeUpdates.payroll_eligible = true;
    probationUpdates.probation_end_date = record.extensionEndDate;
    probationUpdates.status = "extended";
  } else if (record.decision === "terminate") {
    employeeUpdates.employment_status = "terminated";
    employeeUpdates.organogram_visible = false;
    employeeUpdates.payroll_eligible = false;
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
    const { error } = await supabase
      .from("app_auth_users")
      .update({ is_active: false, updated_at: now })
      .eq("hr_id", record.employeeHrId);
    if (error && !isProbationSchemaMissing(error)) throw error;
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
