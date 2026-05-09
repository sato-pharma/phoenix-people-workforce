import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type {
  CreateResignationInput,
  ResignationDashboardData,
  EmployeeResignationInput,
  ResignationRecord,
  ResignationStatus,
  ResignationWorkflowAction,
} from "./types";

type ResignationRow = {
  id: string;
  employee_hr_id: string;
  employee_name: string;
  job_title: string | null;
  line_name: string | null;
  submitted_date: string;
  effective_date: string;
  reason: string | null;
  workflow_notes: string | null;
  status: ResignationStatus;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejected_reason: string | null;
  completed_at: string | null;
  completed_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
};

function asIso(value: string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.slice(0, 10);
}

function cleanText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function resolveSubmittedByHrId(
  actor: string,
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
) {
  return directory.employees.some((employee) => employee.hrId === actor) ? actor : null;
}

function appendWorkflowNote(
  existing: string | null | undefined,
  actor: string,
  action: string,
  note?: string | null,
) {
  const entry = `[${new Date().toISOString()}] ${actor}: ${action}${note ? ` - ${note}` : ""}`;
  return existing ? `${existing}\n${entry}` : entry;
}

function mapResignation(row: ResignationRow): ResignationRecord {
  return {
    id: row.id,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    jobTitle: row.job_title,
    lineName: row.line_name,
    submittedDate: row.submitted_date,
    effectiveDate: row.effective_date,
    reason: row.reason,
    workflowNotes: row.workflow_notes,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    createdBy: row.created_by,
    reviewedAt: asIso(row.reviewed_at),
    reviewedBy: row.reviewed_by,
    approvedAt: asIso(row.approved_at),
    approvedBy: row.approved_by,
    rejectedAt: asIso(row.rejected_at),
    rejectedBy: row.rejected_by,
    rejectedReason: row.rejected_reason,
    completedAt: asIso(row.completed_at),
    completedBy: row.completed_by,
    cancelledAt: asIso(row.cancelled_at),
    cancelledBy: row.cancelled_by,
  };
}

export function resignationErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

export function isResignationsSchemaMissing(error: unknown) {
  const message = resignationErrorMessage(error).toLowerCase();
  return (
    message.includes("employee_resignations") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export async function getResignationsDashboardData(): Promise<ResignationDashboardData> {
  const supabase = getSupabaseAdmin();
  const directory = await getEmployeeDirectory();
  const { data, error } = await supabase
    .from("employee_resignations")
    .select("*")
    .order("effective_date", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) throw error;

  const records = (data ?? []).map((row) => mapResignation(row as ResignationRow));
  const employees = directory.employees
    .map((employee) => ({
      jobTitle: employee.positionTitle ?? employee.jobTitle ?? null,
      label: `${employee.fullName} (${employee.hrId})`,
      lineName: employee.lineName ?? null,
      value: employee.hrId,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const summary = {
    active: records.filter((record) => ["submitted", "under_review", "approved"].includes(record.status)).length,
    approved: records.filter((record) => record.status === "approved").length,
    completed: records.filter((record) => record.status === "completed").length,
    pending: records.filter((record) => ["submitted", "under_review"].includes(record.status)).length,
    total: records.length,
  };

  return { employees, records, summary };
}

export async function createResignation(
  input: CreateResignationInput,
  actor: string,
) {
  const employeeHrId = String(input.employeeHrId ?? "").trim();
  const submittedDate = normalizeDate(input.submittedDate) || todayDate();
  const effectiveDate = normalizeDate(input.effectiveDate);
  if (!employeeHrId) throw new Error("Employee HR ID is required.");
  if (!effectiveDate) throw new Error("Effective resignation date is required.");
  if (effectiveDate < submittedDate) {
    throw new Error("Effective resignation date cannot be before the submitted date.");
  }

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find((item) => item.hrId === employeeHrId);
  if (!employee) throw new Error("Employee was not found in the directory.");
  return createResignationForEmployee(input, actor, employee);
}

async function createResignationForEmployee(
  input: CreateResignationInput,
  actor: string,
  employee: Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"][number],
) {
  const employeeHrId = String(input.employeeHrId ?? "").trim();
  const submittedDate = normalizeDate(input.submittedDate) || todayDate();
  const effectiveDate = normalizeDate(input.effectiveDate);
  const directory = await getEmployeeDirectory();
  const submittedByHrId = resolveSubmittedByHrId(actor, directory);

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const payload = {
    create_vacancy: true,
    created_at: now,
    created_by: actor,
    effective_date: effectiveDate,
    employee_hr_id: employee.hrId,
    employee_name: employee.fullName,
    exit_status: "submitted" as const,
    job_title: employee.positionTitle ?? employee.jobTitle ?? null,
    last_working_date: effectiveDate,
    line_name: employee.lineName ?? null,
    notes: cleanText(input.workflowNotes) ?? cleanText(input.reason),
    reason: cleanText(input.reason),
    resignation_date: submittedDate,
    status: "submitted" as const,
    submitted_date: submittedDate,
    submitted_by_hr_id: submittedByHrId,
    workflow_notes: appendWorkflowNote(null, actor, "submitted resignation", cleanText(input.workflowNotes)),
    updated_at: now,
  };

  const { data, error } = await supabase
    .from("employee_resignations")
    .insert(payload)
    .select("id")
    .single();
  if (error) throw error;
  return String((data as { id: string }).id);
}

function vacancyCodeFromEmployee(hrId: string) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `resignation_${hrId}_${stamp}`;
}

export async function resignEmployeeAndOpenVacancy(
  hrId: string,
  input: EmployeeResignationInput,
  actor: string,
) {
  const employeeHrId = String(hrId || input.employeeHrId || "").trim();
  if (!employeeHrId) {
    throw new Error("Employee HR ID is required.");
  }

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find((item) => item.hrId === employeeHrId);
  if (!employee) {
    throw new Error("Employee was not found in the directory.");
  }

  const resignationId = await createResignationForEmployee(
    {
      employeeHrId,
      effectiveDate: input.effectiveDate,
      reason: input.reason,
      submittedDate: input.submittedDate,
      workflowNotes: input.workflowNotes,
    },
    actor,
    employee,
  );

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const employeeStatus = cleanText(input.employeeStatus) ?? "terminated";

  const { error: employeeError } = await supabase
    .from("employees")
    .update({
      employment_status: employeeStatus,
      exit_reason: cleanText(input.reason),
      exit_status: "submitted",
      last_working_date: input.effectiveDate,
      resignation_date: input.submittedDate,
      updated_at: now,
    })
    .eq("hr_id", employeeHrId);

  if (employeeError) {
    throw new Error(employeeError.message);
  }

  const vacancyPayload = {
    area_id: employee.areaId,
    created_at: now,
    department_id: employee.departmentId,
    job_title: employee.jobTitle ?? employee.positionTitle ?? null,
    line_id: employee.lineId,
    manager_hr_id: employee.managerHrId,
    manager_name: employee.managerName ?? null,
    note: `Auto-opened from resignation of ${employee.fullName} (${employee.hrId}). Effective ${input.effectiveDate}.`,
    position_id: employee.positionId,
    region_name: employee.regionName ?? null,
    status: "open",
    updated_at: now,
    vacancy_code: vacancyCodeFromEmployee(employeeHrId),
  };

  const { data: vacancyRow, error: vacancyError } = await supabase
    .from("position_vacancies")
    .insert(vacancyPayload)
    .select("id")
    .single();

  if (vacancyError) {
    throw new Error(vacancyError.message);
  }

  const vacancyId =
    vacancyRow && typeof vacancyRow === "object"
      ? Number((vacancyRow as { id?: unknown }).id ?? 0)
      : null;

  const resignationUpdates: Record<string, unknown> = {
    updated_at: now,
  };
  if (vacancyId) {
    resignationUpdates.vacancy_id = vacancyId;
  }

  const { error: resignationUpdateError } = await supabase
    .from("employee_resignations")
    .update(resignationUpdates)
    .eq("id", resignationId);

  if (resignationUpdateError) {
    throw new Error(resignationUpdateError.message);
  }

  return {
    employeeHrId,
    employeeStatus,
    resignationId,
    vacancyCode: String(vacancyPayload.vacancy_code),
  };
}

export async function runResignationWorkflow(
  id: string,
  action: ResignationWorkflowAction,
  actor: string,
  note?: string | null,
  rejectedReason?: string | null,
) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_resignations")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as ResignationRow;
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    exit_status: row.status,
    notes: note ? appendWorkflowNote(row.reason, actor, action, note) : row.reason,
    updated_at: now,
    workflow_notes: appendWorkflowNote(row.workflow_notes, actor, action, note),
  };

  switch (action) {
    case "mark_review":
      if (row.status === "completed") throw new Error("Completed resignations cannot be reviewed again.");
      updates.status = "under_review";
      updates.exit_status = "submitted";
      updates.reviewed_at = now;
      updates.reviewed_by = actor;
      updates.rejected_reason = null;
      break;
    case "approve":
      if (!["submitted", "under_review"].includes(row.status)) {
        throw new Error("Only submitted or under-review resignations can be approved.");
      }
      updates.status = "approved";
      updates.exit_status = "approved";
      updates.approved_at = now;
      updates.approved_by = actor;
      updates.rejected_reason = null;
      break;
    case "reject":
      if (row.status === "completed") throw new Error("Completed resignations cannot be rejected.");
      updates.status = "rejected";
      updates.exit_status = "cancelled";
      updates.rejected_at = now;
      updates.rejected_by = actor;
      updates.rejected_reason = cleanText(rejectedReason) ?? "No reason provided.";
      break;
    case "complete":
      if (row.status !== "approved") {
        throw new Error("Only approved resignations can be completed.");
      }
      updates.status = "completed";
      updates.exit_status = "completed";
      updates.completed_at = now;
      updates.completed_by = actor;
      break;
    case "cancel":
      if (row.status === "completed") throw new Error("Completed resignations cannot be cancelled.");
      updates.status = "cancelled";
      updates.exit_status = "cancelled";
      updates.cancelled_at = now;
      updates.cancelled_by = actor;
      break;
    case "reopen":
      if (!["rejected", "cancelled", "approved"].includes(row.status)) {
        throw new Error("Only rejected, cancelled, or approved resignations can be reopened.");
      }
      updates.status = "under_review";
      updates.exit_status = "submitted";
      updates.reviewed_at = now;
      updates.reviewed_by = actor;
      updates.rejected_reason = null;
      break;
    default:
      throw new Error("Unsupported resignation workflow action.");
  }

  const { data: updated, error: updateError } = await supabase
    .from("employee_resignations")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) throw updateError;
  return mapResignation(updated as ResignationRow);
}
