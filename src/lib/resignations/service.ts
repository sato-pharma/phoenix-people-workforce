import { getEmployeeDirectory, invalidateEmployeeDirectoryCache } from "@/lib/employees/employee-directory";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import type { PayrollResignationCandidate } from "@/lib/payroll/salary-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type {
  CreateResignationInput,
  ResignationDashboardData,
  EmployeeResignationInput,
  PayrollResignationCandidateRecord,
  ResignationRecord,
  ResignationStatus,
  ResignationWorkflowAction,
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
  const raw = String(value ?? "").trim();
  if (!raw) return "";
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
    employeeName: row.full_name,
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
      "hr_id,full_name,job_title,employment_status,resignation_date,last_working_date,exit_reason,exit_status,created_at,updated_at,lines(name),positions(title)",
    )
    .in("employment_status", terminalEmployeeStatuses)
    .order("updated_at", { ascending: false });

  let data: unknown[] | null = joinedResult.data;
  let error = joinedResult.error;

  if (error && (error.message.toLowerCase().includes("relationship") || isMissingSchemaMessage(error))) {
    const fallbackResult = await supabase
      .from("employees")
      .select(
        "hr_id,full_name,job_title,employment_status,created_at,updated_at",
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
    status: string;
  },
  title: string,
  tone: "success" | "warning" | "danger" | "neutral" = "warning",
) {
  await safeSendNotificationEmail({
    ctaHref: "/resignations",
    ctaLabel: "Open resignations",
    employeeHrId: record.employeeHrId,
    metrics: [
      { label: "Employee", value: `${record.employeeName} (${record.employeeHrId})` },
      { label: "Status", value: record.status },
      { label: "Effective date", value: record.effectiveDate },
    ],
    notificationType: "resignation",
    subject: `Phoenix ${title} - ${record.employeeName}`,
    summary: `Resignation workflow for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
    title,
    tone,
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

export async function getResignationsDashboardData(): Promise<ResignationDashboardData> {
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

  const workflowRecords = (resignationsResult.data ?? []).map((row) => mapResignation(row as ResignationRow));
  const workflowHrIds = new Set(workflowRecords.map((record) => record.employeeHrId.trim().toUpperCase()));
  const legacyRecords = historicalEmployees
    .filter((employee) => !workflowHrIds.has(employee.hr_id.trim().toUpperCase()))
    .map(mapLegacyResignationEmployee);
  const records = [...workflowRecords, ...legacyRecords].sort((left, right) => {
    const dateCompare = right.submittedDate.localeCompare(left.submittedDate);
    return dateCompare || left.employeeName.localeCompare(right.employeeName);
  });
  const payrollCandidates = (candidatesResult.data ?? []).map((row) =>
    mapPayrollResignationCandidate(row as PayrollResignationCandidateRow),
  );
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
    payrollCandidates: payrollCandidates.length,
    pending: records.filter((record) => ["submitted", "under_review"].includes(record.status)).length,
    total: records.length,
  };

  return { employees, payrollCandidates, records, summary };
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
        .select("hr_id,full_name,employment_status")
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

async function deactivateEmployeeAccessIfSupported(supabase: SupabaseClient, employeeHrId: string) {
  const { error } = await supabase
    .from("app_auth_users")
    .update({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("hr_id", employeeHrId);

  if (error && !isMissingSchemaMessage(error)) {
    throw error;
  }
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
  employee: DirectoryEmployee,
) {
  const submittedDate = normalizeDate(input.submittedDate) || todayDate();
  const effectiveDate = normalizeDate(input.effectiveDate);
  const directory = await getEmployeeDirectory();
  const submittedByHrId = resolveSubmittedByHrId(actor, directory);
  const supabase = getSupabaseAdmin();
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
      employeeName: employee.fullName,
      status: "submitted",
    },
    "Resignation Submitted",
    "warning",
  );
  return resignationId;
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

  const supabase = getSupabaseAdmin();
  const submittedDate = normalizeDate(input.submittedDate) || todayDate();
  const effectiveDate = normalizeDate(input.effectiveDate);
  const employeeStatus = normalizeEmployeeExitStatus(input.employeeStatus);
  const directoryForActor = await getEmployeeDirectory();
  const submittedByHrId = resolveSubmittedByHrId(actor, directoryForActor);
  const vacancyCode = vacancyCodeFromEmployee(employeeHrId);

  if (!effectiveDate) {
    throw new Error("Effective resignation date is required.");
  }

  if (effectiveDate < submittedDate) {
    throw new Error("Effective resignation date cannot be before the submitted date.");
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
    p_workflow_notes: cleanText(input.workflowNotes),
  });

  let result: {
    employee_hr_id?: string;
    employee_status?: string;
    resignation_id?: string;
    used_fallback?: boolean;
    vacancy_code?: string;
  };

  if (rpcResult.error) {
    if (!isMissingResignationRpc(rpcResult.error)) {
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
      workflowNotes: cleanText(input.workflowNotes),
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

  await notifyResignationWorkflow(
    {
      effectiveDate,
      employeeHrId: employee.hrId,
      employeeName: employee.fullName,
      status: "submitted",
    },
    "Resignation Submitted",
    "warning",
  );

  invalidateEmployeeDirectoryCache();

  return {
    employeeHrId: result.employee_hr_id ?? employeeHrId,
    employeeStatus: result.employee_status ?? employeeStatus,
    resignationId: result.resignation_id ?? "",
    usedFallback: result.used_fallback ?? false,
    vacancyCode: result.vacancy_code ?? vacancyCode,
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
  const currentStatus = (cleanText(row.status) ?? cleanText(row.exit_status) ?? "submitted") as ResignationStatus;
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    exit_status: currentStatus,
    notes: note ? appendWorkflowNote(row.reason, actor, action, note) : row.reason,
    updated_at: now,
    workflow_notes: appendWorkflowNote(row.workflow_notes, actor, action, note),
  };

  switch (action) {
    case "mark_review":
      if (currentStatus === "completed") throw new Error("Completed resignations cannot be reviewed again.");
      updates.status = "under_review";
      updates.exit_status = "submitted";
      updates.reviewed_at = now;
      updates.reviewed_by = actor;
      updates.rejected_reason = null;
      break;
    case "approve":
      if (!["submitted", "under_review"].includes(currentStatus)) {
        throw new Error("Only submitted or under-review resignations can be approved.");
      }
      updates.status = "approved";
      updates.exit_status = "approved";
      updates.approved_at = now;
      updates.approved_by = actor;
      updates.rejected_reason = null;
      break;
    case "reject":
      if (currentStatus === "completed") throw new Error("Completed resignations cannot be rejected.");
      updates.status = "rejected";
      updates.exit_status = "cancelled";
      updates.rejected_at = now;
      updates.rejected_by = actor;
      updates.rejected_reason = cleanText(rejectedReason) ?? "No reason provided.";
      break;
    case "complete":
      if (currentStatus !== "approved") {
        throw new Error("Only approved resignations can be completed.");
      }
      updates.status = "completed";
      updates.exit_status = "completed";
      updates.completed_at = now;
      updates.completed_by = actor;
      break;
    case "cancel":
      if (currentStatus === "completed") throw new Error("Completed resignations cannot be cancelled.");
      updates.status = "cancelled";
      updates.exit_status = "cancelled";
      updates.cancelled_at = now;
      updates.cancelled_by = actor;
      break;
    case "reopen":
      if (!["rejected", "cancelled", "approved"].includes(currentStatus)) {
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
  return record;
}
