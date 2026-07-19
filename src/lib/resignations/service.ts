
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { canSeeEmployee, hrIdsMatch, normalizeHrId, systemAccessContext, type AccessContext } from "@/lib/auth/permissions";
import { resolveCanonicalActorHrId } from "@/lib/auth/canonical-actor";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { getEmployeeDirectory, getEmployeeDirectoryRows, invalidateEmployeeDirectoryCache } from "@/lib/employees/employee-directory";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { assertResignationWorkflowTransition } from "@/lib/employee-lifecycle/workflow";
import { createSystemNotification } from "@/lib/notifications/system";
import { disableTelegramForIdentity } from "@/lib/notifications/settings";
import type { PayrollResignationCandidate } from "@/lib/payroll/salary-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { generateShortVacancyCode } from "@/lib/workforce/vacancy-code";

import type {
  CreateResignationInput,
  ResignationDashboardData,
  EmployeeResignationInput,
  PayrollResignationCandidateRecord,
  ResignationRecord,
  ResignationStatus,
  ResignationWorkflowAction,
  UpdateResignationDatesInput,
} from "./types";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;
type DirectoryEmployee = Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"][number];
const terminalEmployeeStatuses = [
  "inactive",
  "Inactive",
  "INACTIVE",
  "resigned",
  "Resigned",
  "RESIGNED",
  "terminated",
  "Terminated",
  "TERMINATED",
];

type ResignationRow = {
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  completed_at?: string | null;
  completed_by?: string | null;
  created_at: string;
  created_by: string | null;
  effective_date?: string | null;
  id: string;
  employee_hr_id: string;
  employee_name: string;
  exit_status?: string | null;
  job_title: string | null;
  last_working_date?: string | null;
  line_name: string | null;
  notes?: string | null;
  reason: string | null;
  resignation_date?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  rejected_at?: string | null;
  rejected_by?: string | null;
  rejected_reason?: string | null;
  status?: ResignationStatus | null;
  submitted_date?: string | null;
  updated_at: string;
  workflow_notes?: string | null;
};

type PayrollResignationCandidateRow = {
  id: string;
  area_name: string | null;
  created_by: string | null;
  employee_name: string;
  first_seen_at: string;
  hire_date: string | null;
  hr_id: string;
  job_title: string | null;
  last_payout_month: number;
  last_payout_year: number;
  last_seen_at: string;
  line_name: string | null;
  name_ar: string | null;
  source_file_name: string | null;
  source_row: number | null;
  updated_at: string;
};

type HistoricalResignedEmployeeRow = {
  created_at: string | null;
  employment_status: string | null;
  exit_reason?: string | null;
  exit_status?: string | null;
  full_name: string;
  nickname?: string | null;
  hr_id: string;
  job_title: string | null;
  last_working_date?: string | null;
  lines?: { name: string | null } | Array<{ name: string | null }> | null;
  positions?: { title: string | null } | Array<{ title: string | null }> | null;
  resignation_date?: string | null;
  updated_at: string | null;
};

function asIso(value: string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value: string | null | undefined) {
  if (value === null || value === undefined) return "";
  const raw = String(value).trim();
  if (!raw || raw.toLowerCase() === "null" || raw.toLowerCase() === "undefined") return "";
  return raw.slice(0, 10);
}

function cleanText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function lowerErrorMessage(error: unknown) {
  return resignationErrorMessage(error).toLowerCase();
}

function isMissingSchemaMessage(error: unknown) {
  const message = lowerErrorMessage(error);
  return (
    message.includes("could not find the table") ||
    message.includes("could not find the") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist")) ||
    (message.includes("column") && message.includes("does not exist"))
  );
}

function isMissingResignationRpc(error: unknown) {
  const message = lowerErrorMessage(error);
  return (
    message.includes("phx_resign_employee_and_open_vacancy") ||
    message.includes("could not find the function") ||
    (message.includes("function") && message.includes("does not exist")) ||
    message.includes("pgrst202")
  );
}

function isLastWorkingDateConstraintError(error: unknown) {
  const message = lowerErrorMessage(error);
  return (
    message.includes("last_working_date") &&
    message.includes("null value") &&
    message.includes("employee_resignations")
  );
}

function isMissingColumn(error: unknown, column: string) {
  return lowerErrorMessage(error).includes(column.toLowerCase());
}

function missingColumnFromError(error: unknown, columns: string[]) {
  return columns.find((column) => isMissingColumn(error, column)) ?? null;
}

function schemaReadinessError(scope: string, error: unknown) {
  const message = resignationErrorMessage(error);
  return new Error(`Missing or outdated resignation schema item while ${scope}: ${message}`);
}

function dateOnly(value: string | null | undefined) {
  const text = cleanText(value);
  return text ? text.slice(0, 10) : null;
}

function firstRelationName(
  relation: { name?: string | null; title?: string | null } | Array<{ name?: string | null; title?: string | null }> | null | undefined,
  key: "name" | "title",
) {
  const row = Array.isArray(relation) ? relation[0] : relation;
  return row?.[key] ?? null;
}

function normalizeEmployeeExitStatus(value: string | null | undefined) {
  const status = cleanText(value)?.toLowerCase() ?? "resigned";
  if (!["resigned", "terminated", "inactive"].includes(status)) {
    throw new Error("Resignation employee status must be resigned, terminated, or inactive.");
  }
  return status;
}

function normalizeSubmittedDate(input: CreateResignationInput) {
  return normalizeDate(input.submittedDate || input.submitted_date) || todayDate();
}

function normalizeLastWorkingDate(input: CreateResignationInput) {
  return (
    normalizeDate(input.lastWorkingDate || input.last_working_date || input.effectiveDate || input.effective_date) ||
    todayDate()
  );
}

function resolveSubmittedByHrId(
  actor: string,
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
) {
  return directory.employees.some((employee) => hrIdsMatch(employee.hrId, actor)) ? actor : null;
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
  const submittedDate =
    dateOnly(row.submitted_date) ??
    dateOnly(row.resignation_date) ??
    dateOnly(row.created_at) ??
    todayDate();
  const effectiveDate =
    dateOnly(row.effective_date) ??
    dateOnly(row.last_working_date) ??
    submittedDate;
  const status = (cleanText(row.status) ?? cleanText(row.exit_status) ?? "submitted") as ResignationStatus;

  return {
    id: row.id,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    employeeStatus: null,
    jobTitle: row.job_title,
    lineName: row.line_name,
    submittedDate,
    effectiveDate,
    reason: row.reason,
    workflowNotes: row.workflow_notes ?? row.notes ?? null,
    status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    createdBy: row.created_by ?? null,
    reviewedAt: asIso(row.reviewed_at),
    reviewedBy: row.reviewed_by ?? null,
    approvedAt: asIso(row.approved_at),
    approvedBy: row.approved_by ?? null,
    rejectedAt: asIso(row.rejected_at),
    rejectedBy: row.rejected_by ?? null,
    rejectedReason: row.rejected_reason ?? null,
    completedAt: asIso(row.completed_at),
    completedBy: row.completed_by ?? null,
    cancelledAt: asIso(row.cancelled_at),
    cancelledBy: row.cancelled_by ?? null,
  };
}

function mapPayrollResignationCandidate(row: PayrollResignationCandidateRow): PayrollResignationCandidateRecord {
  return {
    id: row.id,
    areaName: row.area_name,
    createdBy: row.created_by,
    employeeName: row.employee_name,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    hireDate: row.hire_date,
    hrId: row.hr_id,
    jobTitle: row.job_title,
    lastPayoutMonth: Number(row.last_payout_month),
    lastPayoutYear: Number(row.last_payout_year),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    lineName: row.line_name,
    nameAr: row.name_ar,
    sourceFileName: row.source_file_name,
    sourceRow: row.source_row === null || row.source_row === undefined ? null : Number(row.source_row),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapLegacyResignationEmployee(row: HistoricalResignedEmployeeRow): ResignationRecord {
  const submittedDate =
    dateOnly(row.resignation_date) ??
    dateOnly(row.last_working_date) ??
    dateOnly(row.updated_at) ??
    todayDate();
  const effectiveDate =
    dateOnly(row.last_working_date) ??
    dateOnly(row.resignation_date) ??
    submittedDate;
  const status = cleanText(row.exit_status) === "cancelled" ? "cancelled" : "completed";
  const updatedAt = row.updated_at ? new Date(row.updated_at).toISOString() : new Date(0).toISOString();
  const createdAt = row.created_at ? new Date(row.created_at).toISOString() : updatedAt;

  return {
    approvedAt: null,
    approvedBy: null,
    cancelledAt: status === "cancelled" ? updatedAt : null,
    cancelledBy: null,
    completedAt: status === "completed" ? updatedAt : null,
    completedBy: null,
    createdAt,
    createdBy: null,
    effectiveDate,
    employeeHrId: row.hr_id,
    employeeName: resolveEmployeeDisplayName(row.full_name, row.nickname),
    employeeStatus: row.employment_status ?? null,
    id: `legacy:${row.hr_id}`,
    jobTitle: row.job_title ?? firstRelationName(row.positions, "title"),
    lineName: firstRelationName(row.lines, "name"),
    reason:
      row.exit_reason ??
      `Historical lifecycle status: ${row.employment_status ?? "resigned"}.`,
    rejectedAt: null,
    rejectedBy: null,
    rejectedReason: null,
    reviewedAt: null,
    reviewedBy: null,
    status,
    submittedDate,
    updatedAt,
    workflowNotes: "Compatibility record generated from employee lifecycle data because no resignation workflow record exists.",
  };
}

async function loadHistoricalResignedEmployees(supabase: SupabaseClient) {
  // Compatibility path for databases where the backfill migration has not run yet.
  // It intentionally reads terminal employees directly without changing the active Employees directory.
  const joinedResult = await supabase
    .from("employees")
    .select(
      "hr_id,full_name,nickname,job_title,employment_status,resignation_date,last_working_date,exit_reason,exit_status,created_at,updated_at,lines(name),positions(title)",
    )
    .in("employment_status", terminalEmployeeStatuses)
    .order("updated_at", { ascending: false });

  let data: unknown[] | null = joinedResult.data;
  let error = joinedResult.error;

  if (error && (error.message.toLowerCase().includes("relationship") || isMissingSchemaMessage(error))) {
    const fallbackResult = await supabase
      .from("employees")
      .select(
        "hr_id,full_name,nickname,job_title,employment_status,created_at,updated_at",
      )
      .in("employment_status", terminalEmployeeStatuses)
      .order("updated_at", { ascending: false });

    data = fallbackResult.data;
    error = fallbackResult.error;
  }

  if (error) {
    throw schemaReadinessError("loading historical resigned employees from employees", error);
  }

  return (data ?? []) as HistoricalResignedEmployeeRow[];
}

async function notifyResignationWorkflow(
  record: {
    effectiveDate: string;
    employeeHrId: string;
    employeeName: string;
    id?: string;
    status: string;
  },
  title: string,
  tone: "success" | "warning" | "danger" | "neutral" = "warning",
) {
  const actionUrl = record.id
    ? `/admin/approvals-hub?module=resignation&id=${encodeURIComponent(record.id)}`
    : "/admin/approvals-hub?module=resignation";
  // The admin-editable resignation_workflow template renders an employee detail table
  // (Department/Position/Last Working Day) and a "Dear {{managerName}}" greeting. The
  // minimal record passed here lacks those fields, so load the directory row defensively
  // to populate them — a directory failure must never block the resignation notification.
  let resignationDetail: Awaited<ReturnType<typeof getEmployeeDirectoryRows>>[number] | null = null;
  try {
    const directory = await getEmployeeDirectoryRows();
    resignationDetail =
      directory.find((row) => normalizeHrId(row.hrId) === normalizeHrId(record.employeeHrId)) ?? null;
  } catch {
    resignationDetail = null;
  }
  await createSystemNotification({
    actionUrl,
    actorId: "system",
    email: {
      ctaHref: actionUrl,
      ctaLabel: "Review in Action Center",
      employeeHrId: record.employeeHrId,
      metrics: [
        { label: "Employee", value: `${record.employeeName} (${record.employeeHrId})` },
        { label: "Status", value: record.status },
        { label: "Effective date", value: record.effectiveDate },
      ],
      notificationType: "resignation",
      subject: `Phoenix ${title} - ${record.employeeName}`,
      summary: `Resignation workflow for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
      // Tokens the resignation_workflow template uses but the metric mapping never fills.
      templateContext: {
        date: record.effectiveDate,
        endDate: record.effectiveDate,
        jobTitle: resignationDetail?.jobTitle ?? "—",
        line: resignationDetail?.lineName ?? "—",
        managerName: resignationDetail?.managerName ?? "Team",
      },
      title,
      tone,
    },
    eventType: "workflow_updated",
    message: `Resignation workflow for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
    metadata: {
      effectiveDate: record.effectiveDate,
      employeeHrId: record.employeeHrId,
      idempotencyKey: `resignation:${record.employeeHrId}:${record.status}:${record.effectiveDate}`,
      status: record.status,
    },
    module: "resignations",
    priority: tone === "danger" ? "critical" : "high",
    subjectHrId: record.employeeHrId,
    title,
  });
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
    message.includes("payroll_resignation_candidates") ||
    message.includes("position_vacancies") ||
    message.includes("phx_resign_employee_and_open_vacancy") ||
    isMissingSchemaMessage(error)
  );
}

function periodSortValue(month: number, year: number) {
  return year * 100 + month;
}

export async function upsertPayrollResignationCandidates(input: {
  actor: string | null;
  candidates: PayrollResignationCandidate[];
  month: number;
  sourceFileName: string;
  year: number;
}) {
  const candidatesByHrId = new Map<string, PayrollResignationCandidate>();
  input.candidates.forEach((candidate) => {
    const hrId = candidate.hrId.trim();
    if (!hrId) return;
    candidatesByHrId.set(hrId, { ...candidate, hrId });
  });

  const candidates = Array.from(candidatesByHrId.values());
  if (candidates.length === 0) return 0;

  const supabase = getSupabaseAdmin();
  const hrIds = candidates.map((candidate) => candidate.hrId);
  const { data: existingRows, error: existingError } = await supabase
    .from("payroll_resignation_candidates")
    .select("hr_id,last_payout_month,last_payout_year")
    .in("hr_id", hrIds);

  if (existingError) throw existingError;

  const existingByHrId = new Map(
    ((existingRows ?? []) as Array<Record<string, unknown>>).map((row) => [
      String(row.hr_id ?? ""),
      {
        month: Number(row.last_payout_month ?? 0),
        year: Number(row.last_payout_year ?? 0),
      },
    ]),
  );
  const currentPeriod = periodSortValue(input.month, input.year);
  const now = new Date().toISOString();
  const payload = candidates
    .filter((candidate) => {
      const existing = existingByHrId.get(candidate.hrId);
      if (!existing) return true;
      return currentPeriod >= periodSortValue(existing.month, existing.year);
    })
    .map((candidate) => ({
      area_name: candidate.area,
      created_by: input.actor,
      employee_name: candidate.fullName || candidate.hrId,
      hire_date: candidate.hireDate,
      hr_id: candidate.hrId,
      job_title: candidate.jobTitle,
      last_payout_month: input.month,
      last_payout_year: input.year,
      last_seen_at: now,
      line_name: candidate.line,
      name_ar: candidate.nameAr,
      source_file_name: input.sourceFileName,
      source_row: candidate.row,
      updated_at: now,
    }));

  if (payload.length === 0) return 0;

  const { error } = await supabase
    .from("payroll_resignation_candidates")
    .upsert(payload, {
      onConflict: "hr_id",
    });

  if (error) throw error;
  return payload.length;
}

function isCompanyResignationReader(access: AccessContext) {
  return (
    access.scope === "system" ||
    access.scope === "company" ||
    access.role === "Super Admin" ||
    access.role === "CEO"
  );
}

export async function getResignationsDashboardData(access?: AccessContext): Promise<ResignationDashboardData> {
  const supabase = getSupabaseAdmin();
  const directory = await getEmployeeDirectory();
  const [resignationsResult, candidatesResult, historicalEmployees] = await Promise.all([
    supabase
      .from("employee_resignations")
      .select("*")
      .order("effective_date", { ascending: true })
      .order("created_at", { ascending: false }),
    supabase
      .from("payroll_resignation_candidates")
      .select("*")
      .order("last_payout_year", { ascending: false })
      .order("last_payout_month", { ascending: false })
      .order("updated_at", { ascending: false }),
    loadHistoricalResignedEmployees(supabase),
  ]);

  if (resignationsResult.error) throw resignationsResult.error;
  if (candidatesResult.error) throw candidatesResult.error;

  const employeesByHrId = new Map(directory.employees.map((employee) => [normalizeHrId(employee.hrId), employee]));
  const allWorkflowRecords = (resignationsResult.data ?? []).map((row) => {
    const record = mapResignation(row as ResignationRow);
    return {
      ...record,
      employeeStatus: employeesByHrId.get(normalizeHrId(record.employeeHrId))?.employmentStatus ?? record.employeeStatus ?? null,
    };
  });
  const scopedAccess = access ?? systemAccessContext;
  const workflowRecords = isCompanyResignationReader(scopedAccess)
    ? allWorkflowRecords
    : allWorkflowRecords.filter((record) => {
        const employee = employeesByHrId.get(normalizeHrId(record.employeeHrId));
        return employee ? canSeeEmployee(scopedAccess, employee) : false;
      });
  const workflowHrIds = new Set(workflowRecords.map((record) => normalizeHrId(record.employeeHrId)));
  const legacyRecords = historicalEmployees
    .filter((employee) => !workflowHrIds.has(normalizeHrId(employee.hr_id)))
    .map(mapLegacyResignationEmployee);
  const records = [...workflowRecords, ...legacyRecords].sort((left, right) => {
    const dateCompare = right.submittedDate.localeCompare(left.submittedDate);
    return dateCompare || left.employeeName.localeCompare(right.employeeName);
  });
  const payrollCandidates = (candidatesResult.data ?? []).map((row) => {
    const candidate = mapPayrollResignationCandidate(row as PayrollResignationCandidateRow);
    return {
      ...candidate,
      employeeName: employeesByHrId.get(normalizeHrId(candidate.hrId))?.displayName ?? candidate.employeeName,
    };
  });
  const employees = directory.employees
    .map((employee) => ({
      jobTitle: employee.positionTitle ?? employee.jobTitle ?? null,
      label: `${employee.displayName} (${employee.hrId})`,
      lineName: employee.lineName ?? null,
      value: employee.hrId,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const summary = {
    active: records.filter((record) => ["submitted", "under_review", "approved"].includes(record.status)).length,
    approved: records.filter((record) => record.status === "approved").length,
    completed: records.filter((record) => record.status === "completed").length,
    payrollCandidates: payrollCandidates.length,
    pending: records.filter((record) => ["submitted", "under_review"].includes(record.status)).length,
    total: records.length,
  };

  return { employees, payrollCandidates, records, summary };
}

/**
 * Submitter-side view: the resignation request(s) the caller filed themselves.
 * Used by the consolidated Actions "My requests" tab. Scoped strictly to the
 * caller's own HR_ID — never surfaces another employee's resignation.
 */
export async function getMyResignations(access: AccessContext): Promise<ResignationRecord[]> {
  const hrId = access.hrId?.trim();
  if (!hrId) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_resignations")
    .select("*")
    .eq("employee_hr_id", hrId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => mapResignation(row as ResignationRow));
}

async function assertResignationRuntimeSchema(
  supabase: SupabaseClient,
  options: { requireVacancies?: boolean } = {},
) {
  const checks = [
    {
      label: "employees.hr_id/full_name/employment_status",
      query: supabase
        .from("employees")
        .select("hr_id,full_name,nickname,employment_status")
        .limit(1),
    },
    ...(options.requireVacancies
      ? [
          {
            label: "position_vacancies core columns",
            query: supabase
              .from("position_vacancies")
              .select("id,vacancy_code,status")
              .limit(1),
          },
        ]
      : []),
  ];

  for (const check of checks) {
    const { error } = await check.query;
    if (error) {
      throw schemaReadinessError(`checking ${check.label}`, error);
    }
  }

  const modernResignationSchema = await supabase
    .from("employee_resignations")
    .select("id,employee_hr_id,employee_name,submitted_date,effective_date,status")
    .limit(1);
  if (!modernResignationSchema.error) {
    return;
  }

  const legacyResignationSchema = await supabase
    .from("employee_resignations")
    .select("id,employee_hr_id,resignation_date,last_working_date,exit_status")
    .limit(1);
  if (!legacyResignationSchema.error) {
    return;
  }

  throw schemaReadinessError("checking employee_resignations modern/legacy columns", modernResignationSchema.error);
}

async function insertResignationRecord(
  supabase: SupabaseClient,
  input: {
    actor: string;
    effectiveDate: string;
    employee: DirectoryEmployee;
    reason: string | null;
    submittedByHrId: string | null;
    submittedDate: string;
    workflowNotes: string | null;
    vacancyId?: number | null;
  },
) {
  const now = new Date().toISOString();
  const workflowNotes = appendWorkflowNote(
    null,
    input.actor,
    "submitted resignation",
    input.workflowNotes,
  );
  const basePayload = {
    created_at: now,
    created_by: input.actor,
    effective_date: input.effectiveDate,
    employee_hr_id: input.employee.hrId,
    employee_name: input.employee.fullName,
    job_title: input.employee.positionTitle ?? input.employee.jobTitle ?? null,
    line_name: input.employee.lineName ?? null,
    reason: input.reason,
    status: "submitted" as const,
    submitted_date: input.submittedDate,
    updated_at: now,
    workflow_notes: workflowNotes,
  };
  const payload: Record<string, unknown> = {
    ...basePayload,
    create_vacancy: Boolean(input.vacancyId),
    exit_status: "submitted" as const,
    last_working_date: input.effectiveDate,
    notes: input.workflowNotes ?? input.reason,
    resignation_date: input.submittedDate,
    submitted_by_hr_id: input.submittedByHrId,
    vacancy_id: input.vacancyId ?? null,
  };
  const optionalColumns = [
    "create_vacancy",
    "effective_date",
    "exit_status",
    "notes",
    "resignation_date",
    "submitted_by_hr_id",
    "submitted_date",
    "vacancy_id",
    "workflow_notes",
  ];

  for (let attempt = 0; attempt <= optionalColumns.length; attempt++) {
    const { data, error } = await supabase
      .from("employee_resignations")
      .insert(payload)
      .select("id")
      .single();

    if (!error) {
      return String((data as { id: string }).id);
    }

    const missingColumn = missingColumnFromError(error, optionalColumns);
    if (missingColumn) {
      delete payload[missingColumn];
      continue;
    }

    throw schemaReadinessError("writing employee_resignations", error);
  }

  throw new Error("Unable to insert resignation after removing unsupported optional columns.");
}

async function insertFallbackVacancy(
  supabase: SupabaseClient,
  employee: DirectoryEmployee,
  effectiveDate: string,
  vacancyCode: string,
) {
  const now = new Date().toISOString();
  const payload = {
    area_id: employee.areaId,
    created_at: now,
    department_id: employee.departmentId,
    job_title: employee.jobTitle ?? employee.positionTitle ?? null,
    line_id: employee.lineId,
    manager_hr_id: employee.managerHrId,
    manager_name: employee.managerName ?? null,
    note: `Auto-opened from resignation of ${employee.fullName} (${employee.hrId}). Effective ${effectiveDate}.`,
    position_id: employee.positionId,
    region_name: employee.regionName ?? null,
    replacement_for_hr_id: employee.hrId,
    status: "open",
    updated_at: now,
    vacancy_code: vacancyCode,
  };

  const fullResult = await supabase
    .from("position_vacancies")
    .insert(payload)
    .select("id")
    .single();

  if (!fullResult.error) {
    return Number((fullResult.data as { id: number }).id);
  }

  if (!isMissingSchemaMessage(fullResult.error)) {
    throw fullResult.error;
  }

  const minimalResult = await supabase
    .from("position_vacancies")
    .insert({
      job_title: payload.job_title,
      status: "open",
      updated_at: now,
      vacancy_code: vacancyCode,
    })
    .select("id")
    .single();

  if (minimalResult.error) {
    throw schemaReadinessError("writing position_vacancies", minimalResult.error);
  }

  return Number((minimalResult.data as { id: number }).id);
}

async function ensureResignationVacancyOwnership(
  supabase: SupabaseClient,
  employee: DirectoryEmployee,
  vacancyCode: string,
) {
  const cleanVacancyCode = String(vacancyCode ?? "").trim();
  if (!cleanVacancyCode) {
    return;
  }

  const now = new Date().toISOString();
  const fullPayload = {
    manager_hr_id: employee.managerHrId,
    manager_name: employee.managerName ?? null,
    replacement_for_hr_id: employee.hrId,
    updated_at: now,
  };

  const fullResult = await supabase
    .from("position_vacancies")
    .update(fullPayload)
    .eq("vacancy_code", cleanVacancyCode);

  if (!fullResult.error) {
    return;
  }

  if (!isMissingSchemaMessage(fullResult.error)) {
    throw fullResult.error;
  }

  const fallbackResult = await supabase
    .from("position_vacancies")
    .update({
      manager_hr_id: employee.managerHrId,
      manager_name: employee.managerName ?? null,
      updated_at: now,
    })
    .eq("vacancy_code", cleanVacancyCode);

  if (fallbackResult.error && !isMissingSchemaMessage(fallbackResult.error)) {
    throw fallbackResult.error;
  }
}

async function updateEmployeeLifecycleFallback(
  supabase: SupabaseClient,
  employeeHrId: string,
  input: {
    effectiveDate: string;
    employeeStatus: string;
    reason: string | null;
    submittedDate: string;
  },
) {
  const optionalColumns = [
    "exit_reason",
    "exit_status",
    "last_working_date",
    "organogram_visible",
    "payroll_eligible",
    "resignation_date",
  ];
  const payload: Record<string, unknown> = {
    employment_status: input.employeeStatus,
    exit_reason: input.reason,
    exit_status: "submitted",
    last_working_date: input.effectiveDate,
    organogram_visible: false,
    payroll_eligible: false,
    resignation_date: input.submittedDate,
    updated_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt <= optionalColumns.length; attempt++) {
    const { error } = await supabase
      .from("employees")
      .update(payload)
      .eq("hr_id", employeeHrId);

    if (!error) {
      return;
    }

    const missingColumn = optionalColumns.find((column) => isMissingColumn(error, column));
    if (missingColumn) {
      delete payload[missingColumn];
      continue;
    }

    throw schemaReadinessError("updating employees lifecycle columns", error);
  }

  throw new Error("Unable to update employee lifecycle after removing unsupported optional columns.");
}

async function normalizeTerminalEmployeeLifecycleFlags(
  supabase: SupabaseClient,
  employeeHrId: string,
) {
  const { error: rpcError } = await supabase.rpc(
    "phx_normalize_terminal_employee_lifecycle_flags",
    { p_employee_hr_id: employeeHrId },
  );

  if (rpcError && !isMissingSchemaMessage(rpcError)) {
    throw schemaReadinessError("normalizing terminal employee lifecycle flags", rpcError);
  }

  if (rpcError) {
    const { error } = await supabase
      .from("employees")
      .update({
        organogram_visible: false,
        payroll_eligible: false,
        updated_at: new Date().toISOString(),
      })
      .eq("hr_id", employeeHrId)
      .in("employment_status", ["resigned", "terminated", "inactive"]);

    if (error && !isMissingSchemaMessage(error)) {
      throw schemaReadinessError("normalizing terminal employee lifecycle flags", error);
    }
  }
}

async function deactivateEmployeeAccessIfSupported(supabase: SupabaseClient, employeeHrId: string) {
  const appAuthResult = await supabase
    .from("app_auth_users")
    .update({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("hr_id", employeeHrId);

  if (appAuthResult.error && !isMissingSchemaMessage(appAuthResult.error)) {
    throw appAuthResult.error;
  }

  const accessProfileResult = await supabase
    .from("user_access_profiles")
    .update({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("hr_id", employeeHrId);

  if (accessProfileResult.error && !isMissingSchemaMessage(accessProfileResult.error)) {
    throw accessProfileResult.error;
  }

  await disableTelegramForIdentity({
    actorLoginId: "system",
    hrId: employeeHrId,
    reason: "Employee resigned, terminated, or deactivated.",
  });
}

async function resignEmployeeWithFallback(
  supabase: SupabaseClient,
  input: {
    actor: string;
    effectiveDate: string;
    employee: DirectoryEmployee;
    employeeStatus: string;
    reason: string | null;
    submittedByHrId: string | null;
    submittedDate: string;
    vacancyCode: string;
    workflowNotes: string | null;
  },
) {
  // Fallback is intentionally non-RPC for environments where the migration has not been applied.
  // Keep it conservative and schema-tolerant, then rely on the migration/RPC for transactionality.
  await assertResignationRuntimeSchema(supabase, { requireVacancies: true });
  const vacancyId = await insertFallbackVacancy(
    supabase,
    input.employee,
    input.effectiveDate,
    input.vacancyCode,
  );
  const resignationId = await insertResignationRecord(supabase, {
    actor: input.actor,
    effectiveDate: input.effectiveDate,
    employee: input.employee,
    reason: input.reason,
    submittedByHrId: input.submittedByHrId,
    submittedDate: input.submittedDate,
    vacancyId,
    workflowNotes: input.workflowNotes,
  });

  await updateEmployeeLifecycleFallback(supabase, input.employee.hrId, {
    effectiveDate: input.effectiveDate,
    employeeStatus: input.employeeStatus,
    reason: input.reason,
    submittedDate: input.submittedDate,
  });
  await deactivateEmployeeAccessIfSupported(supabase, input.employee.hrId);

  return {
    employeeHrId: input.employee.hrId,
    employeeStatus: input.employeeStatus,
    resignationId,
    usedFallback: true,
    vacancyCode: input.vacancyCode,
  };
}

export async function createResignation(
  input: CreateResignationInput,
  actor: string,
  access?: Pick<AccessContext, "role">,
) {
  const employeeHrId = String(input.employeeHrId ?? "").trim();
  const submittedDate = normalizeSubmittedDate(input);
  const effectiveDate = normalizeLastWorkingDate(input);

  if (!employeeHrId) throw new Error("Employee HR ID is required.");

  if (effectiveDate < submittedDate) {
    throw new Error("Effective resignation date cannot be before the submitted date.");
  }

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find((item) => hrIdsMatch(item.hrId, employeeHrId));
  if (!employee) throw new Error("Employee was not found in the directory.");

  return createResignationForEmployee({
    ...input,
    submittedDate,
    effectiveDate,
  }, actor, employee, access);
}

async function createResignationForEmployee(
  input: CreateResignationInput,
  actor: string,
  employee: DirectoryEmployee,
  access?: Pick<AccessContext, "role">,
) {
  const submittedDate = normalizeSubmittedDate(input);
  const effectiveDate = normalizeLastWorkingDate(input);
  const directory = await getEmployeeDirectory();
  const submittedByHrId = resolveSubmittedByHrId(actor, directory);
  const supabase = getSupabaseAdmin();
  await assertResignationWorkflowTransition({
    access,
    action: "submit",
    expectedNextStatus: "resignation_submitted",
    status: "new",
  });
  const resignationId = await insertResignationRecord(supabase, {
    actor,
    effectiveDate,
    employee,
    reason: cleanText(input.reason),
    submittedByHrId,
    submittedDate,
    workflowNotes: cleanText(input.workflowNotes),
  });

  await notifyResignationWorkflow(
    {
      effectiveDate,
      employeeHrId: employee.hrId,
      employeeName: employee.displayName,
      id: resignationId,
      status: "submitted",
    },
    "Resignation Submitted",
    "warning",
  );
  invalidateExecutiveDashboardCache("resignation workflow created", ["resignations"]);
  return resignationId;
}

function vacancyCodeFromEmployee(hrId: string, effectiveDate: string) {
  return generateShortVacancyCode({
    parts: [effectiveDate],
    primary: hrId,
  });
}

export async function resignEmployeeAndOpenVacancy(
  hrId: string,
  input: EmployeeResignationInput,
  actor: string,
  access?: AccessContext,
  options?: { suppressWorkflowNotification?: boolean },
) {
  const employeeHrId = String(hrId || input.employeeHrId || "").trim();
  if (!employeeHrId) {
    throw new Error("Employee HR ID is required.");
  }

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find((item) => hrIdsMatch(item.hrId, employeeHrId));
  if (!employee) {
    throw new Error("Employee was not found in the directory.");
  }

  const supabase = getSupabaseAdmin();
  const submittedDate = normalizeSubmittedDate(input);
  const effectiveDate = normalizeLastWorkingDate(input);
  const employeeStatus = normalizeEmployeeExitStatus(input.employeeStatus);
  const directoryForActor = await getEmployeeDirectory();
  const submittedByHrId = resolveSubmittedByHrId(actor, directoryForActor);
  const vacancyCode = vacancyCodeFromEmployee(employeeHrId, effectiveDate);
  const workflowNotesWithReference = [
    cleanText(input.workflowNotes),
    `Termination/vacancy reference: ${vacancyCode}`,
  ].filter(Boolean).join("\n");

  if (effectiveDate < submittedDate) {
    throw new Error("Effective resignation date cannot be before the submitted date.");
  }

  await assertResignationWorkflowTransition({
    access,
    action: "submit",
    expectedNextStatus: "resignation_submitted",
    status: "new",
  });

  const scopedAccess = access ?? systemAccessContext;
  if (!canSeeEmployee(scopedAccess, employee)) {
    throw new Error(`Forbidden: ${scopedAccess.role} cannot access employee ${employee.hrId}.`);
  }

  const rpcResult = await supabase.rpc("phx_resign_employee_and_open_vacancy", {
    p_actor: actor,
    p_effective_date: effectiveDate,
    p_employee_hr_id: employeeHrId,
    p_employee_status: employeeStatus,
    p_reason: cleanText(input.reason),
    p_submitted_by_hr_id: submittedByHrId,
    p_submitted_date: submittedDate,
    p_vacancy_code: vacancyCode,
    p_workflow_notes: workflowNotesWithReference,
  });

  let result: {
    employee_hr_id?: string;
    employee_status?: string;
    resignation_id?: string;
    used_fallback?: boolean;
    vacancy_code?: string;
  };

  if (rpcResult.error) {
    if (!isMissingResignationRpc(rpcResult.error) && !isLastWorkingDateConstraintError(rpcResult.error)) {
      if (isMissingSchemaMessage(rpcResult.error)) {
        throw schemaReadinessError("calling phx_resign_employee_and_open_vacancy", rpcResult.error);
      }
      throw new Error(rpcResult.error.message);
    }

    const fallbackResult = await resignEmployeeWithFallback(supabase, {
      actor,
      effectiveDate,
      employee,
      employeeStatus,
      reason: cleanText(input.reason),
      submittedByHrId,
      submittedDate,
      vacancyCode,
      workflowNotes: workflowNotesWithReference,
    });

    result = {
      employee_hr_id: fallbackResult.employeeHrId,
      employee_status: fallbackResult.employeeStatus,
      resignation_id: fallbackResult.resignationId,
      used_fallback: true,
      vacancy_code: fallbackResult.vacancyCode,
    };
  } else {
    result = (rpcResult.data ?? {}) as {
      employee_hr_id?: string;
      employee_status?: string;
      resignation_id?: string;
      vacancy_code?: string;
    };
  }

  await updateEmployeeLifecycleFallback(supabase, employeeHrId, {
    effectiveDate,
    employeeStatus: result.employee_status ?? employeeStatus,
    reason: cleanText(input.reason),
    submittedDate,
  });
  await ensureResignationVacancyOwnership(supabase, employee, result.vacancy_code ?? vacancyCode);
  await normalizeTerminalEmployeeLifecycleFlags(supabase, employeeHrId);
  // Telegram deactivation is an external API call and cannot run inside the RPC's SQL
  // transaction, so it must happen here unconditionally — not only on the JS fallback
  // path (resignEmployeeWithFallback -> deactivateEmployeeAccessIfSupported), or every
  // RPC-path resignation would silently stop disabling the employee's Telegram access.
  await disableTelegramForIdentity({
    actorLoginId: "system",
    hrId: employeeHrId,
    reason: "Employee resigned, terminated, or deactivated.",
  });

  const { data: existingAuditRows, error: auditLookupError } = await supabase
    .from("audit_logs")
    .select("id")
    .eq("entity_type", "employee_resignation")
    .eq("entity_id", employeeHrId)
    .limit(1);
  if (auditLookupError) throw auditLookupError;

  if ((existingAuditRows ?? []).length === 0) {
    await writeRequiredAuditLog({
      actorLoginId: actor,
      entityId: employeeHrId,
      entityType: "employee_resignation",
      newValues: {
        employeeStatus: result.employee_status ?? employeeStatus,
        organogramVisible: false,
        payrollEligible: false,
        resignationId: result.resignation_id ?? null,
        vacancyCode: result.vacancy_code ?? vacancyCode,
      },
      oldValues: {
        employeeStatus: employee.employmentStatus,
        organogramVisible: employee.organogramVisible,
        payrollEligible: employee.payrollEligible,
      },
      summary: "Employee resigned or terminated and vacancy was opened.",
    });
  }

  // A probation-sourced termination must NOT be announced as a voluntary "Resignation Submitted"
  // (wrong framing, wrong recipient list, never reviewed for probation). The caller suppresses this;
  // the dedicated probation-termination notification (owner-confirmed recipients) is handled separately.
  if (!options?.suppressWorkflowNotification) {
    await notifyResignationWorkflow(
      {
        effectiveDate,
        employeeHrId: employee.hrId,
        employeeName: employee.displayName,
        id: result.resignation_id,
        status: "submitted",
      },
      "Resignation Submitted",
      "warning",
    );
  }

  invalidateEmployeeDirectoryCache();
  invalidateExecutiveDashboardCache("employee resigned and vacancy opened", ["resignations", "employees", "vacancies", "payroll"]);

  return {
    employeeHrId: result.employee_hr_id ?? employeeHrId,
    employeeStatus: result.employee_status ?? employeeStatus,
    resignationId: result.resignation_id ?? "",
    usedFallback: result.used_fallback ?? false,
    vacancyCode: result.vacancy_code ?? vacancyCode,
  };
}

function normalizeResignationDateUpdate(
  input: UpdateResignationDatesInput,
  current: Pick<ResignationRecord, "effectiveDate" | "submittedDate">,
) {
  const submittedDate =
    normalizeDate(input.submittedDate || input.submitted_date || input.resignationDate || current.submittedDate);
  const effectiveDate =
    normalizeDate(
      input.effectiveDate ||
        input.effective_date ||
        input.lastWorkingDate ||
        input.last_working_date ||
        current.effectiveDate,
    ) || submittedDate;

  if (!submittedDate) throw new Error("Resignation date is required.");
  if (!effectiveDate) throw new Error("Effective resignation date is required.");
  if (effectiveDate < submittedDate) {
    throw new Error("Effective resignation date cannot be before the submitted date.");
  }

  return { effectiveDate, submittedDate };
}

async function updateEmployeeResignationDatesFallback(
  supabase: SupabaseClient,
  employeeHrId: string,
  dates: { effectiveDate: string; submittedDate: string },
) {
  const optionalColumns = ["last_working_date", "resignation_date"];
  const payload: Record<string, unknown> = {
    last_working_date: dates.effectiveDate,
    resignation_date: dates.submittedDate,
    updated_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt <= optionalColumns.length; attempt++) {
    const { error } = await supabase
      .from("employees")
      .update(payload)
      .eq("hr_id", employeeHrId);

    if (!error) return;

    const missingColumn = optionalColumns.find((column) => isMissingColumn(error, column));
    if (missingColumn) {
      delete payload[missingColumn];
      continue;
    }

    throw schemaReadinessError("updating employee resignation date columns", error);
  }

  throw new Error("Unable to update employee resignation date columns after removing unsupported optional columns.");
}

async function loadHistoricalResignedEmployeeByHrId(supabase: SupabaseClient, hrId: string) {
  const dbHrId = normalizeHrId(hrId)?.toUpperCase() ?? hrId.trim().toUpperCase();
  const joinedResult = await supabase
    .from("employees")
    .select(
      "hr_id,full_name,nickname,job_title,employment_status,resignation_date,last_working_date,exit_reason,exit_status,created_at,updated_at,lines(name),positions(title)",
    )
    .eq("hr_id", dbHrId)
    .maybeSingle();

  let data: unknown | null = joinedResult.data;
  let error = joinedResult.error;

  if (error && (error.message.toLowerCase().includes("relationship") || isMissingSchemaMessage(error))) {
    const fallbackResult = await supabase
      .from("employees")
      .select("hr_id,full_name,nickname,job_title,employment_status,created_at,updated_at,resignation_date,last_working_date")
      .eq("hr_id", dbHrId)
      .maybeSingle();

    data = fallbackResult.data;
    error = fallbackResult.error;
  }

  if (error) {
    throw schemaReadinessError("loading legacy resignation employee by HR ID", error);
  }

  return data as HistoricalResignedEmployeeRow | null;
}

async function updateModernResignationDates(
  supabase: SupabaseClient,
  row: ResignationRow,
  dates: { effectiveDate: string; submittedDate: string },
  actor: string,
) {
  const current = mapResignation(row);
  const note = `Submitted ${current.submittedDate} -> ${dates.submittedDate}; effective ${current.effectiveDate} -> ${dates.effectiveDate}`;
  const optionalColumns = [
    "effective_date",
    "last_working_date",
    "resignation_date",
    "submitted_date",
    "workflow_notes",
  ];
  const payload: Record<string, unknown> = {
    effective_date: dates.effectiveDate,
    last_working_date: dates.effectiveDate,
    resignation_date: dates.submittedDate,
    submitted_date: dates.submittedDate,
    updated_at: new Date().toISOString(),
    workflow_notes: appendWorkflowNote(row.workflow_notes, actor, "updated resignation dates", note),
  };

  for (let attempt = 0; attempt <= optionalColumns.length; attempt++) {
    const { data, error } = await supabase
      .from("employee_resignations")
      .update(payload)
      .eq("id", row.id)
      .select("*")
      .single();

    if (!error) {
      return data as ResignationRow;
    }

    const missingColumn = missingColumnFromError(error, optionalColumns);
    if (missingColumn) {
      delete payload[missingColumn];
      continue;
    }

    throw schemaReadinessError("updating employee_resignations date columns", error);
  }

  throw new Error("Unable to update resignation dates after removing unsupported optional columns.");
}

async function auditResignationDateUpdate(
  actor: string,
  record: Pick<ResignationRecord, "effectiveDate" | "employeeHrId" | "id" | "submittedDate">,
  dates: { effectiveDate: string; submittedDate: string },
) {
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: record.employeeHrId,
    entityType: "employee_resignation",
    newValues: {
      effectiveDate: dates.effectiveDate,
      resignationId: record.id,
      submittedDate: dates.submittedDate,
    },
    oldValues: {
      effectiveDate: record.effectiveDate,
      resignationId: record.id,
      submittedDate: record.submittedDate,
    },
    summary: "Resignation dates updated.",
  });
}

export async function updateResignationDates(
  id: string,
  input: UpdateResignationDatesInput,
  actor: string,
) {
  const resignationId = String(id ?? "").trim();
  if (!resignationId) throw new Error("Resignation record ID is required.");

  const supabase = getSupabaseAdmin();
  if (resignationId.startsWith("legacy:")) {
    const employeeHrId = resignationId.slice("legacy:".length).trim();
    if (!employeeHrId) throw new Error("Legacy resignation HR ID is required.");

    const employee = await loadHistoricalResignedEmployeeByHrId(supabase, employeeHrId);
    if (!employee) return null;

    const current = mapLegacyResignationEmployee(employee);
    const dates = normalizeResignationDateUpdate(input, current);
    await updateEmployeeResignationDatesFallback(supabase, employee.hr_id, dates);
    await auditResignationDateUpdate(actor, current, dates);
    invalidateEmployeeDirectoryCache();
    invalidateExecutiveDashboardCache("resignation dates updated", ["resignations", "employees", "vacancies"]);

    const updatedEmployee = await loadHistoricalResignedEmployeeByHrId(supabase, employeeHrId);
    return updatedEmployee ? mapLegacyResignationEmployee(updatedEmployee) : current;
  }

  const { data, error } = await supabase
    .from("employee_resignations")
    .select("*")
    .eq("id", resignationId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as ResignationRow;
  const current = mapResignation(row);
  const dates = normalizeResignationDateUpdate(input, current);
  const updatedRow = await updateModernResignationDates(supabase, row, dates, actor);
  const updatedRecord = mapResignation(updatedRow);

  await updateEmployeeResignationDatesFallback(supabase, updatedRecord.employeeHrId, dates);
  await auditResignationDateUpdate(actor, current, dates);
  invalidateEmployeeDirectoryCache();
  invalidateExecutiveDashboardCache("resignation dates updated", ["resignations", "employees", "vacancies"]);

  return updatedRecord;
}

export async function runResignationWorkflow(
  id: string,
  action: ResignationWorkflowAction,
  actor: string,
  note?: string | null,
  rejectedReason?: string | null,
  access?: AccessContext,
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
  const currentStatus = (cleanText(row.status) ?? cleanText(row.exit_status) ?? "submitted") as ResignationStatus;
  const expectedNextStatusByAction: Record<ResignationWorkflowAction, string> = {
    approve: "resignation_approved",
    cancel: "resignation_cancelled",
    complete: "resignation_completed",
    mark_review: "resignation_under_review",
    reject: "resignation_rejected",
    reopen: "resignation_under_review",
  };
  await assertResignationWorkflowTransition({
    access,
    action,
    expectedNextStatus: expectedNextStatusByAction[action],
    status: currentStatus,
  });

  // getEmployeeDirectory() excludes inactive/terminated employees with no way to opt back in,
  // but resignation actions (approve/complete/etc) routinely target an employee whose status has
  // already flipped -- use the inactive-inclusive lookup so the scope check itself doesn't throw
  // a false Forbidden for every caller (including Super Admin) once that happens.
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const employee = directory.find((item) => hrIdsMatch(item.hrId, row.employee_hr_id)) ?? { hrId: row.employee_hr_id, managerHrId: null };
  const scopedAccess = access ?? systemAccessContext;
  if (!canSeeEmployee(scopedAccess, employee)) {
    throw new Error(`Forbidden: ${scopedAccess.role} cannot access employee ${row.employee_hr_id}.`);
  }

  const now = new Date().toISOString();
  // Persist the canonical HR_ID (never a login token) so the Approvals Hub history matches.
  const actorHrId = await resolveCanonicalActorHrId(actor);
  const updates: Record<string, unknown> = {
    exit_status: currentStatus,
    notes: note ? appendWorkflowNote(row.reason, actorHrId, action, note) : row.reason,
    updated_at: now,
    workflow_notes: appendWorkflowNote(row.workflow_notes, actorHrId, action, note),
  };

  switch (action) {
    case "mark_review":
      if (currentStatus === "completed") throw new Error("Completed resignations cannot be reviewed again.");
      updates.status = "under_review";
      updates.exit_status = "submitted";
      updates.reviewed_at = now;
      updates.reviewed_by = actorHrId;
      updates.rejected_reason = null;
      break;
    case "approve":
      if (!["submitted", "under_review"].includes(currentStatus)) {
        throw new Error("Only submitted or under-review resignations can be approved.");
      }
      updates.status = "approved";
      updates.exit_status = "approved";
      updates.approved_at = now;
      updates.approved_by = actorHrId;
      updates.rejected_reason = null;
      break;
    case "reject":
      if (currentStatus === "completed") throw new Error("Completed resignations cannot be rejected.");
      updates.status = "rejected";
      updates.exit_status = "cancelled";
      updates.rejected_at = now;
      updates.rejected_by = actorHrId;
      updates.rejected_reason = cleanText(rejectedReason) ?? "No reason provided.";
      break;
    case "complete":
      if (currentStatus !== "approved") {
        throw new Error("Only approved resignations can be completed.");
      }
      updates.status = "completed";
      updates.exit_status = "completed";
      updates.completed_at = now;
      updates.completed_by = actorHrId;
      break;
    case "cancel":
      if (currentStatus === "completed") throw new Error("Completed resignations cannot be cancelled.");
      updates.status = "cancelled";
      updates.exit_status = "cancelled";
      updates.cancelled_at = now;
      updates.cancelled_by = actorHrId;
      break;
    case "reopen":
      if (!["rejected", "cancelled", "approved"].includes(currentStatus)) {
        throw new Error("Only rejected, cancelled, or approved resignations can be reopened.");
      }
      updates.status = "under_review";
      updates.exit_status = "submitted";
      updates.reviewed_at = now;
      updates.reviewed_by = actorHrId;
      updates.rejected_reason = null;
      break;
    default:
      throw new Error("Unsupported resignation workflow action.");
  }

  const { data: updated, error: updateError } = await supabase
    .from("employee_resignations")
    .update(updates)
    .eq("id", id)
    .eq("updated_at", row.updated_at)
    .select("*")
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updated) throw new Error("Resignation workflow was updated by another user. Refresh and try again.");
  const record = mapResignation(updated as ResignationRow);
  await notifyResignationWorkflow(
    record,
    action === "approve"
      ? "Resignation Approved"
      : action === "reject"
        ? "Resignation Rejected"
        : action === "complete"
          ? "Resignation Completed"
          : "Resignation Workflow Updated",
    action === "reject" || action === "cancel" ? "danger" : action === "approve" || action === "complete" ? "success" : "warning",
  );
  invalidateExecutiveDashboardCache("resignation workflow updated", ["resignations", "employees", "vacancies"]);
  return record;
}

export async function runResignationSlaDaily(): Promise<{ processed: number; errors: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_resignations")
    .select("id, employee_name, employee_hr_id, effective_date, created_at, status")
    .in("status", ["submitted", "under_review"]);
  if (error) return { processed: 0, errors: 1 };

  const { data: hrApprovers } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .in("role", ["Super Admin"])
    .eq("is_active", true);
  const hrHrIds = (hrApprovers ?? []).map((a) => String(a.hr_id)).filter(Boolean);
  if (hrHrIds.length === 0) return { processed: 0, errors: 0 };

  let processed = 0;
  let errors = 0;
  const now = Date.now();
  for (const row of data ?? []) {
    const ageDays = Math.max(0, Math.floor((now - new Date(row.created_at as string).getTime()) / 86400000));
    if (ageDays < 5) continue;
    for (const hrId of hrHrIds) {
      try {
        await createSystemNotification({
          channels: ["email"],
          eventType: "resignation_sla_reminder",
          message: `${String(row.employee_name)}'s resignation (effective: ${String(row.effective_date)}) has been pending ${ageDays} day${ageDays === 1 ? "" : "s"} with no final decision.`,
          metadata: { idempotencyKey: `resignation:${String(row.id)}:sla:${hrId}:${today}` },
          module: "resignation",
          priority: "high",
          recipientHrId: hrId,
          title: "Resignation pending decision",
          actionUrl: `/admin/approvals-hub?module=resignation&id=${String(row.id)}`,
          email: {
            ctaHref: `/admin/approvals-hub?module=resignation&id=${String(row.id)}`,
            ctaLabel: "Review resignation",
            tone: "danger" as const,
          },
        });
        processed++;
      } catch (error) {
        console.error(error, { tags: { cron: "resignation-sla-reminder", recipientHrId: hrId } });
        errors++;
      }
    }
  }
  return { processed, errors };
}
