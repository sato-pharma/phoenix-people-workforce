import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
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
  status: ProbationWorkflowStatus;
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

const probationDays = 90;

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
    status: row.status,
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

export async function getProbationRows(): Promise<ProbationRow[]> {
  const employees = await getEmployeeDirectoryRows();
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
    .map((employee) => {
      const probation = probationByHrId.get(employee.hrId);
      const probationEndDate = probation?.probation_end_date ?? addDays(employee.hireDate, probationDays) ?? "";
      return {
        area_name: employee.areaName ?? "Unassigned",
        crm_id: employee.crmId ?? "",
        days_remaining: daysRemaining(probationEndDate),
        employment_status: employee.employmentStatus ?? "",
        full_name: employee.fullName,
        hire_date: employee.hireDate ?? "",
        hr_id: employee.hrId,
        job_title: employee.positionTitle ?? employee.jobTitle ?? "Unassigned",
        line_name: employee.lineName ?? "Unassigned",
        probation_end_date: probationEndDate,
        probation_id: probation?.id === undefined ? null : String(probation.id),
        workflow: evaluationsByHrId.get(employee.hrId) ?? null,
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
    summary: `Probation workflow for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
    title,
    tone,
  });
}

export async function createProbationEvaluation(input: CreateProbationEvaluationInput, actor: string) {
  const employeeHrId = cleanText(input.employeeHrId)?.toUpperCase();
  if (!employeeHrId) throw new Error("Employee HR ID is required.");

  const employees = await getEmployeeDirectoryRows();
  const employee = employees.find((row) => row.hrId.toUpperCase() === employeeHrId);
  if (!employee) throw new Error("Employee was not found in the directory.");

  const probationByHrId = await loadProbationByHrId().catch((error) => {
    if (isProbationSchemaMissing(error)) return new Map<string, ProbationDbRow>();
    throw error;
  });
  const probation = probationByHrId.get(employee.hrId);
  const probationEndDate = normalizeDate(input.probationEndDate) ?? probation?.probation_end_date ?? addDays(employee.hireDate, probationDays);
  if (!probationEndDate) throw new Error("Probation end date is required.");

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
  await insertHistory(record, "created", actor, null, { managerFeedback: cleanText(input.managerFeedback) });
  await notifyProbationWorkflow(record, "Probation Evaluation Created", "warning");
  return record;
}

export async function runProbationWorkflow(
  id: string,
  action: ProbationWorkflowAction,
  actor: string,
  input: {
    decisionReason?: string | null;
    extensionEndDate?: string | null;
    evaluationScores?: Record<string, number | string | null>;
    hrRecommendation?: string | null;
    managerFeedback?: string | null;
    note?: string | null;
    probationLetterName?: string | null;
    probationLetterUrl?: string | null;
  } = {},
) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("probation_evaluations").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as ProbationEvaluationDbRow;
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
    case "hr_recommendation":
      updates.status = "hr_recommendation";
      updates.hr_recommendation = cleanText(input.hrRecommendation) ?? row.hr_recommendation;
      updates.hr_reviewed_at = now;
      updates.hr_reviewed_by = actor;
      break;
    case "approve_pass":
    case "approve_extend":
    case "approve_terminate":
      updates.status = "approved";
      updates.decision = action === "approve_pass" ? "pass" : action === "approve_extend" ? "extend" : "terminate";
      updates.decision_reason = cleanText(input.decisionReason);
      updates.extension_end_date = action === "approve_extend" ? normalizeDate(input.extensionEndDate) : null;
      updates.approved_at = now;
      updates.approved_by = actor;
      break;
    case "upload_letter":
      if (!cleanText(input.probationLetterUrl)) throw new Error("Probation letter URL is required.");
      updates.probation_letter_url = cleanText(input.probationLetterUrl);
      updates.probation_letter_name = cleanText(input.probationLetterName) ?? "Probation letter";
      break;
    case "complete":
      if (row.status !== "approved") throw new Error("Only approved probation workflows can be completed.");
      updates.status = "completed";
      updates.completed_at = now;
      updates.completed_by = actor;
      break;
    case "cancel":
      updates.status = "cancelled";
      updates.decision_reason = cleanText(input.decisionReason) ?? "Cancelled.";
      break;
    case "reopen":
      if (!["cancelled", "completed"].includes(row.status)) throw new Error("Only cancelled or completed workflows can be reopened.");
      updates.status = "hr_recommendation";
      updates.completed_at = null;
      updates.completed_by = null;
      break;
    default:
      throw new Error("Unsupported probation workflow action.");
  }

  const { data: updatedData, error: updateError } = await supabase
    .from("probation_evaluations")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();
  if (updateError) throw updateError;

  const updated = mapEvaluation(updatedData as ProbationEvaluationDbRow);
  await applyDecisionSideEffects(updated);
  await insertHistory(updated, action, actor, row.status, { decisionReason: cleanText(input.decisionReason), note });
  await notifyProbationWorkflow(
    updated,
    action.startsWith("approve") ? "Probation Decision Approved" : "Probation Workflow Updated",
    updated.decision === "terminate" ? "danger" : action.startsWith("approve") ? "success" : "warning",
  );
  return updated;
}

async function applyDecisionSideEffects(record: ProbationWorkflowRecord) {
  if (record.status !== "approved" && record.status !== "completed") return;

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const employeeUpdates: Record<string, unknown> = { updated_at: now };
  const probationUpdates: Record<string, unknown> = { updated_at: now };

  if (record.decision === "pass") {
    employeeUpdates.employment_status = "active";
    probationUpdates.status = "passed";
  } else if (record.decision === "extend") {
    employeeUpdates.probation_end_date = record.extensionEndDate;
    probationUpdates.probation_end_date = record.extensionEndDate;
    probationUpdates.status = "extended";
  } else if (record.decision === "terminate") {
    employeeUpdates.employment_status = "terminated";
    probationUpdates.status = "terminated";
  }

  if (Object.keys(employeeUpdates).length > 1) {
    await supabase.from("employees").update(employeeUpdates).eq("hr_id", record.employeeHrId);
  }
  if (record.probationId && Object.keys(probationUpdates).length > 1) {
    await supabase.from("employee_probation").update(probationUpdates).eq("id", record.probationId);
  }
}
