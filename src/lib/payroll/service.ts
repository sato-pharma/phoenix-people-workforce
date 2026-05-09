import { isDevelopment } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getSupabaseRlsClientIfAvailable } from "@/lib/supabase/rls-server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  getPayrollScope,
  normalizeHrId,
  normalizeHrIdForAccess,
  normalizeLineName,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import type { SalaryValidationIssue, SalaryValidationRow } from "@/lib/payroll/salary-import";
import type { PayrollDashboardData, SalaryBatch, SalaryFlag, SalaryRecord } from "@/lib/payroll/types";

const emptyPayrollDashboard: PayrollDashboardData = {
  batch: null,
  batches: [],
  flags: [],
  previousRecords: [],
  records: [],
  scope: "all_time",
  summary: {
    anomalyCount: 0,
    readinessRate: 1,
    totalAdditions: 0,
    totalEmployees: 0,
    totalGovernmentDeductions: 0,
    totalGross: 0,
    totalNet: 0,
  },
};

function payrollErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }

  return String(error);
}

function isLikelyUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isMissingColumnError(error: unknown, columnName: string) {
  const message = payrollErrorMessage(error).toLowerCase();
  return message.includes(`column \"${columnName}\"`) || message.includes(`column ${columnName}`);
}

export function isPayrollSchemaMissing(error: unknown) {
  const message = payrollErrorMessage(error).toLowerCase();

  return (
    message.includes("salary_batches") ||
    message.includes("salary_records") ||
    message.includes("salary_flags") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function buildPayrollIdentityFilterValue(hrId: string, mode: "exact" | "contains") {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return null;
  return mode === "contains" ? `%${normalized}%` : normalized;
}

function buildPayrollIdentityOrClause(
  hrId: string,
  mode: "exact" | "contains" = "exact",
  includeEmployeeCode = true,
) {
  const value = buildPayrollIdentityFilterValue(hrId, mode);
  if (!value) return null;
  const clauses = [`hr_id.ilike.${value}`];
  if (includeEmployeeCode) {
    clauses.push(`employee_code.ilike.${value}`);
  }
  return clauses.join(",");
}

type PayrollBatchLookupResult = {
  batchIds: Set<string>;
  schemaMissing: boolean;
  columnMissing: boolean;
};

async function collectPayrollBatchIdsForColumn(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  column: "hr_id" | "employee_code",
  targetHrId: string,
  mode: "exact" | "contains",
): Promise<PayrollBatchLookupResult> {
  const filterValue = buildPayrollIdentityFilterValue(targetHrId, mode);
  if (!filterValue) return { batchIds: new Set(), schemaMissing: false, columnMissing: false };

  const { data, error } = await supabase
    .from("salary_records")
    .select("batch_id")
    .ilike(column, filterValue);

  const schemaMissing = Boolean(error && isPayrollSchemaMissing(error));
  const columnMissing = Boolean(error && isMissingColumnError(error, column));

  if (error && !schemaMissing && !columnMissing) {
    throw error;
  }

  const batchIds = new Set<string>();
  (data ?? []).forEach((row) => {
    const batchId = (row as Record<string, unknown>).batch_id;
    if (typeof batchId === "string") {
      batchIds.add(batchId);
    }
  });

  return { batchIds, schemaMissing, columnMissing };
}

function mapBatch(row: Record<string, unknown>): SalaryBatch {
  return {
    id: String(row.id),
    fileName: String(row.file_name ?? ""),
    month: Number(row.month),
    year: Number(row.year),
    status: String(row.status) as SalaryBatch["status"],
    uploadedBy: row.uploaded_by ? String(row.uploaded_by) : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: row.approved_at ? new Date(String(row.approved_at)).toISOString() : null,
    lockedAt: row.locked_at ? new Date(String(row.locked_at)).toISOString() : null,
    rejectedReason: row.rejected_reason ? String(row.rejected_reason) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function mapRecord(row: Record<string, unknown>): SalaryRecord {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    employeeCode: String(row.employee_code ?? row.hr_id ?? ""),
    hrId: String(row.hr_id ?? ""),
    fullName: String(row.full_name ?? ""),
    line: String(row.line ?? ""),
    area: String(row.area ?? ""),
    jobTitle: String(row.job_title ?? ""),
    grossSalary: Number(row.gross_salary ?? 0),
    expenses: Number(row.expenses ?? 0),
    incentive: Number(row.incentive ?? 0),
    overtime: Number(row.overtime ?? 0),
    bonus: Number(row.bonus ?? 0),
    extraCostOfLiving: Number(row.extra_cost_of_living ?? 0),
    fuelAllowance: Number(row.fuel_allowance ?? 0),
    otherAdditions: Number(row.other_additions ?? 0),
    totalAdditions: Number(row.total_additions ?? 0),
    socialInsurance: Number(row.social_insurance ?? 0),
    employmentIncomeTax: Number(row.employment_income_tax ?? 0),
    crm: Number(row.crm ?? 0),
    fingerPrint: Number(row.finger_print ?? 0),
    unpaidVacations: Number(row.unpaid_vacations ?? 0),
    medicalInsurance: Number(row.medical_insurance ?? 0),
    loans: Number(row.loans ?? 0),
    otherDeductions: Number(row.other_deductions ?? 0),
    totalDeductions: Number(row.total_deductions ?? 0),
    netSalary: Number(row.net_salary ?? 0),
    firstPart: Number(row.first_part ?? 0),
    secondPart: Number(row.second_part ?? 0),
    hireDate: row.hire_date ? String(row.hire_date) : null,
  };
}

type PayrollAccessFilter = {
  all: boolean;
  allowedHrIds: Set<string>;
};

function buildManagerMap(directory: Awaited<ReturnType<typeof getEmployeeDirectory>>) {
  const managerMap = new Map<string, string[]>();
  directory.employees.forEach((employee) => {
    const managerId = normalizeHrId(employee.managerHrId);
    const employeeId = normalizeHrId(employee.hrId);
    if (!managerId || !employeeId) return;
    const list = managerMap.get(managerId) ?? [];
    list.push(employeeId);
    managerMap.set(managerId, list);
  });
  return managerMap;
}

function collectPayrollHierarchy(
  managerMap: Map<string, string[]>,
  rootHrId: string,
) {
  const allowedHrIds = new Set<string>();
  const queue: string[] = [rootHrId];
  while (queue.length > 0) {
    const managerId = queue.shift();
    if (!managerId) continue;
    for (const subordinateId of managerMap.get(managerId) ?? []) {
      if (!allowedHrIds.has(subordinateId)) {
        allowedHrIds.add(subordinateId);
        queue.push(subordinateId);
      }
    }
  }
  return allowedHrIds;
}

function normalizePayrollAllowedIds(values: readonly string[]) {
  const normalized = new Set<string>();
  values.forEach((value) => {
    const normalizedValue = normalizeHrId(value);
    const canonicalValue = normalizeHrIdForAccess(value);
    if (normalizedValue) normalized.add(normalizedValue);
    if (canonicalValue) normalized.add(canonicalValue);
  });
  return normalized;
}

function getPayrollAllowedHrIdsForLine(
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
  line: string | null,
) {
  if (!line) return new Set<string>();
  const target = normalizeLineName(line);
  const allowed: string[] = [];
  directory.employees.forEach((employee) => {
    if (normalizeLineName(employee.lineName) === target) {
      const normalized = normalizeHrId(employee.hrId);
      if (normalized) allowed.push(normalized);
    }
  });
  return normalizePayrollAllowedIds(allowed);
}

function isPayrollRecordInScope(row: Record<string, unknown>, allowedHrIds: Set<string>) {
  const hrValues = [
    String(row.hr_id ?? ""),
    String(row.employee_code ?? ""),
  ];
  return hrValues.some((value) => {
    const normalized = normalizeHrId(value);
    const canonical = normalizeHrIdForAccess(value);
    if (normalized && allowedHrIds.has(normalized)) return true;
    if (canonical && allowedHrIds.has(canonical)) return true;
    return false;
  });
}

function isPayrollFlagInScope(flag: SalaryFlag, allowedHrIds: Set<string>) {
  if (!flag.hrId) return true;
  const normalized = normalizeHrId(flag.hrId);
  const canonical = normalizeHrIdForAccess(flag.hrId);
  if (normalized && allowedHrIds.has(normalized)) return true;
  if (canonical && allowedHrIds.has(canonical)) return true;
  return false;
}

async function resolvePayrollAccessFilter(
  accessContext: AccessContext,
): Promise<PayrollAccessFilter> {
  if (accessContext.scope === "system") {
    return { all: true, allowedHrIds: new Set() };
  }

  const currentHrId = resolveEmployeeIdentityId(accessContext);
  const payrollScope = getPayrollScope(accessContext);

  if (payrollScope === "COMPANY") {
    return { all: true, allowedHrIds: new Set() };
  }

  if (!currentHrId) {
    return { all: false, allowedHrIds: new Set() };
  }

  if (payrollScope === "NONE") {
    return { all: false, allowedHrIds: new Set() };
  }

  const directory = await getEmployeeDirectory();
  const directoryByHrId = new Map(
    directory.employees.map((employee) => [normalizeHrId(employee.hrId), employee]),
  );

  if (payrollScope === "SELF") {
    return { all: false, allowedHrIds: new Set([currentHrId]) };
  }

  const managerMap = buildManagerMap(directory);
  if (payrollScope === "TEAM") {
    const directReports = managerMap.get(currentHrId) ?? [];
    const allowed = normalizePayrollAllowedIds([...directReports, currentHrId]);
    return { all: false, allowedHrIds: allowed };
  }

  if (payrollScope === "HIERARCHY") {
    const hierarchy = collectPayrollHierarchy(managerMap, currentHrId);
    hierarchy.add(currentHrId);
    return { all: false, allowedHrIds: hierarchy };
  }

  const viewer = directoryByHrId.get(currentHrId);
  if (payrollScope === "LINE") {
    const allowed = getPayrollAllowedHrIdsForLine(directory, viewer?.lineName ?? null);
    allowed.add(currentHrId);
    return { all: false, allowedHrIds: allowed };
  }

  return { all: false, allowedHrIds: new Set([currentHrId]) };
}

async function getVisiblePayrollBatchIds(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  accessFilter: PayrollAccessFilter,
): Promise<Set<string> | null> {
  if (accessFilter.all) return null;
  if (accessFilter.allowedHrIds.size === 0) return new Set<string>();

  const batchIds = new Set<string>();
  const ids = Array.from(accessFilter.allowedHrIds);
  const processed = new Set<string>();

  for (const rawId of ids) {
    const normalized = normalizeHrId(rawId);
    if (!normalized || processed.has(normalized)) continue;
    processed.add(normalized);

    const hrIdResult = await collectPayrollBatchIdsForColumn(
      supabase,
      "hr_id",
      normalized,
      "exact",
    );
    const employeeCodeResult = await collectPayrollBatchIdsForColumn(
      supabase,
      "employee_code",
      normalized,
      "exact",
    );

    hrIdResult.batchIds.forEach((batchId) => batchIds.add(batchId));
    employeeCodeResult.batchIds.forEach((batchId) => batchIds.add(batchId));

    const schemaMissing = hrIdResult.schemaMissing && employeeCodeResult.schemaMissing;
    if (!schemaMissing && batchIds.size === 0 && (employeeCodeResult.batchIds.size > 0 || hrIdResult.batchIds.size > 0)) {
      if (!hrIdResult.columnMissing) {
        const fallbackHrResult = await collectPayrollBatchIdsForColumn(
          supabase,
          "hr_id",
          normalized,
          "contains",
        );
        fallbackHrResult.batchIds.forEach((batchId) => batchIds.add(batchId));
      }

      if (!employeeCodeResult.columnMissing) {
        const fallbackEmployeeCodeResult = await collectPayrollBatchIdsForColumn(
          supabase,
          "employee_code",
          normalized,
          "contains",
        );
        fallbackEmployeeCodeResult.batchIds.forEach((batchId) => batchIds.add(batchId));
      }
    }
  }

  if (batchIds.size === 0) {
    return accessFilter.all ? null : new Set<string>();
  }

  return batchIds;
}

function filterPayrollQueryByAllowedHrIds<T extends { or: (value: string) => T; ilike?: (column: string, value: string) => T }>(
  query: T,
  allowedHrIds: Set<string>,
  options?: { includeEmployeeCode?: boolean },
) {
  const ids = Array.from(allowedHrIds);
  if (ids.length === 0) return query;
  const conditions: string[] = [];
  const includeEmployeeCode = options?.includeEmployeeCode ?? true;
  for (const hrId of ids) {
    if (!hrId) continue;
    const normalized = normalizeHrId(hrId);
    const compact = normalizeHrIdForAccess(hrId);
    if (normalized) {
      const exact = buildPayrollIdentityOrClause(normalized, "exact", includeEmployeeCode);
      if (exact) conditions.push(exact);
    }
    if (compact && compact !== normalized) {
      const compactClause = buildPayrollIdentityOrClause(compact, "exact", includeEmployeeCode);
      if (compactClause) conditions.push(compactClause);
    }
  }

  if (conditions.length === 0) return query;
  return query.or(conditions.join(","));
}

function filterPayrollRowsByAccess<T extends Record<string, unknown>>(
  rows: T[],
  accessFilter: PayrollAccessFilter,
) {
  if (accessFilter.all) return rows;
  if (accessFilter.allowedHrIds.size === 0) return [];
  return rows.filter((row) => isPayrollRecordInScope(row, accessFilter.allowedHrIds));
}

function filterPayrollFlagsByAccess(
  rows: SalaryFlag[],
  accessFilter: PayrollAccessFilter,
) {
  if (accessFilter.all) return rows;
  if (accessFilter.allowedHrIds.size === 0) return [];
  return rows.filter((row) => isPayrollFlagInScope(row, accessFilter.allowedHrIds));
}
async function withHireDates(records: SalaryRecord[]) {
  if (records.length === 0) {
    return records;
  }

  try {
    const directory = await getEmployeeDirectory();
    const hireDateByHrId = new Map(
      directory.employees.map((employee) => [employee.hrId, employee.hireDate]),
    );

    return records.map((record) => ({
      ...record,
      hireDate: record.hireDate ?? hireDateByHrId.get(record.hrId) ?? null,
    }));
  } catch {
    return records;
  }
}

function mapFlag(row: Record<string, unknown>): SalaryFlag {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    hrId: row.hr_id ? String(row.hr_id) : null,
    flagType: String(row.flag_type ?? ""),
    severity: String(row.severity ?? "info") as SalaryFlag["severity"],
    message: String(row.message ?? ""),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export async function listSalaryBatches(): Promise<SalaryBatch[]> {
  const supabase = await getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin();
  const { data, error } = await supabase
    .from("salary_batches")
    .select("*")
    .order("year", { ascending: false })
    .order("month", { ascending: false });

  if (error) {
    if (isPayrollSchemaMissing(error)) {
      return [];
    }

    throw error;
  }

  return (data ?? []).map((row) => mapBatch(row as Record<string, unknown>));
}

function payrollPeriodSortValue(batch: Pick<SalaryBatch, "month" | "year">) {
  return batch.year * 12 + batch.month;
}

export async function getLatestSalaryRecordsBefore(
  month: number,
  year: number,
): Promise<SalaryRecord[]> {
  const supabase = await getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin();
  const targetPeriod = year * 12 + month;
  const batches = await listSalaryBatches();
  const previousBatch = batches
    .filter((batch) => payrollPeriodSortValue(batch) < targetPeriod)
    .sort((left, right) => payrollPeriodSortValue(right) - payrollPeriodSortValue(left))[0];

  if (!previousBatch) {
    return [];
  }

  const { data, error } = await supabase
    .from("salary_records")
    .select("*")
    .eq("batch_id", previousBatch.id);

  if (error) {
    if (isPayrollSchemaMissing(error)) {
      return [];
    }

    throw error;
  }

  return (data ?? []).map((row) => mapRecord(row as Record<string, unknown>));
}

export async function getPayrollDashboard(
  batchId: string | undefined,
  accessContext: AccessContext,
): Promise<PayrollDashboardData> {
  const supabase = await getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin();
  const payrollAccessFilter = await resolvePayrollAccessFilter(accessContext);

  const batches = await listSalaryBatches();
  const visibleBatchIds = await getVisiblePayrollBatchIds(supabase, payrollAccessFilter);
  const visibleBatches = visibleBatchIds ? batches.filter((batch) => visibleBatchIds.has(batch.id)) : batches;
  const scope: PayrollDashboardData["scope"] = batchId ? "batch" : "all_time";
  
  // Default to the latest batch if no batchId provided, to avoid loading everything
  const batch = batchId
    ? visibleBatches.find((b) => b.id === batchId) ?? visibleBatches[0]
    : visibleBatches[0];

  if (!batch) {
    return {
      ...emptyPayrollDashboard,
      batches: visibleBatches,
      scope,
    };
  }

  // If scope is all_time, we still only load the selected batch for now to keep it fast
  // or we could implement a true all-time summary if needed.
  // For now, let's just make sure we don't load ALL records for ALL batches by default.
  
  const recordsQuery = supabase
    .from("salary_records")
    .select("*")
    .eq("batch_id", batch.id);
  const scopedRecordsQuery = payrollAccessFilter.all
    ? recordsQuery
    : filterPayrollQueryByAllowedHrIds(recordsQuery, payrollAccessFilter.allowedHrIds);
  const flagsQuery = supabase.from("salary_flags").select("*").eq("batch_id", batch.id);

  const [recordsResult, flagsResult] = await Promise.all([
    scopedRecordsQuery,
    flagsQuery,
  ]);

  if (recordsResult.error) {
    if (isPayrollSchemaMissing(recordsResult.error)) {
      return {
      ...emptyPayrollDashboard,
      batches: visibleBatches,
      scope,
    };
  }

    throw recordsResult.error;
  }

  if (flagsResult.error) {
    if (isPayrollSchemaMissing(flagsResult.error)) {
      return {
      ...emptyPayrollDashboard,
      batches: visibleBatches,
      scope,
    };
  }

    throw flagsResult.error;
  }

  const filteredRecords = filterPayrollRowsByAccess(
    (recordsResult.data ?? []) as Array<Record<string, unknown>>,
    payrollAccessFilter,
  );
  const records = await withHireDates(
    (filteredRecords as Record<string, unknown>[]).map((row) => mapRecord(row as Record<string, unknown>)),
  );
  const flags = filterPayrollFlagsByAccess(
    (flagsResult.data ?? []).map((row) => mapFlag(row as Record<string, unknown>)),
    payrollAccessFilter,
  );

  // Load previous period for delta comparison when the dashboard is scoped to one batch.
  const prevBatch = visibleBatches.find((b) => b.id !== batch.id);
  let previousRecords: SalaryRecord[] = [];
  if (scope === "batch" && prevBatch) {
    let prevQuery = supabase
      .from("salary_records")
      .select("*")
      .eq("batch_id", prevBatch.id);
    prevQuery = payrollAccessFilter.all
      ? prevQuery
      : filterPayrollQueryByAllowedHrIds(prevQuery, payrollAccessFilter.allowedHrIds);
    const scopedPrevResult = await prevQuery;

    if (scopedPrevResult.error) {
      if (isPayrollSchemaMissing(scopedPrevResult.error)) {
        previousRecords = [];
      } else {
        throw scopedPrevResult.error;
      }
    }

    const filteredPrevRows = filterPayrollRowsByAccess(
      (scopedPrevResult.data ?? []) as Array<Record<string, unknown>>,
      payrollAccessFilter,
    );
    previousRecords = await withHireDates(
      (filteredPrevRows as Record<string, unknown>[]).map((row) => mapRecord(row)),
    );
  }

  const totalGross = records.reduce((sum, r) => sum + r.grossSalary, 0);
  const totalNet = records.reduce((sum, r) => sum + r.netSalary, 0);
  const totalAdditions = records.reduce((sum, r) => sum + r.totalAdditions, 0);
  const totalGovtDeductions = records.reduce((sum, r) => sum + r.socialInsurance + r.employmentIncomeTax, 0);
  const avgNet = records.length > 0 ? totalNet / records.length : 0;
  const anomalies = records.filter((r) => r.netSalary > avgNet * 2.25);
  const readinessRate = records.length > 0 ? (records.length - anomalies.length) / records.length : 1;

  return {
    batch,
    batches: visibleBatches,
    records,
    flags,
    previousRecords,
    scope,
    summary: {
      totalEmployees: records.length,
      totalGross,
      totalNet,
      totalAdditions,
      totalGovernmentDeductions: totalGovtDeductions,
      anomalyCount: anomalies.length,
      readinessRate,
    },
  };
}

export async function getSalaryBatchExport(
  batchId: string,
  accessContext: AccessContext,
): Promise<{
  batch: SalaryBatch;
  records: SalaryRecord[];
} | null> {
  const supabase = await getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin();
  const normalizedRequestedId = batchId.trim();
  let targetBatchId = normalizedRequestedId;
  const payrollAccessFilter = await resolvePayrollAccessFilter(accessContext);

  if (!isLikelyUuid(normalizedRequestedId)) {
    const numericRecordId = Number.parseInt(normalizedRequestedId, 10);
    if (Number.isInteger(numericRecordId) && String(numericRecordId) === normalizedRequestedId) {
      const lookup = await supabase
        .from("salary_records")
        .select("batch_id")
        .eq("id", numericRecordId)
        .maybeSingle();

      if (lookup.error) {
        throw lookup.error;
      }

      if (!lookup.data || !(lookup.data as Record<string, unknown>).batch_id) {
        return null;
      }

      targetBatchId = String((lookup.data as Record<string, unknown>).batch_id);
    } else {
      return null;
    }
  }

  const buildRecordsQuery = () => supabase.from("salary_records").select("*").eq("batch_id", targetBatchId);
  const buildFilteredRecordsQuery = (includeEmployeeCode = false) =>
    payrollAccessFilter.all
      ? buildRecordsQuery()
      : filterPayrollQueryByAllowedHrIds(
          buildRecordsQuery(),
          payrollAccessFilter.allowedHrIds,
          { includeEmployeeCode },
        );

  const batchPromise = supabase
    .from("salary_batches")
    .select("*")
    .eq("id", targetBatchId)
    .maybeSingle();
  let recordsResult = await buildFilteredRecordsQuery(false);
  if (
    recordsResult.error &&
    !payrollAccessFilter.all &&
    isMissingColumnError(recordsResult.error, "employee_code")
  ) {
    if (isDevelopment) {
      console.debug("[employee-portal] salary_records query missing employee_code column; fallback to hr_id only", {
        batchId: targetBatchId,
      });
    }
    recordsResult = await buildFilteredRecordsQuery(false);
  }

  const batchResult = await batchPromise;

  if (batchResult.error) {
    throw new Error(`salary_batches query failed${isDevelopment ? `: ${payrollErrorMessage(batchResult.error)}` : ""}`);
  }

  if (recordsResult.error) {
    throw new Error(`salary_records query failed${isDevelopment ? `: ${payrollErrorMessage(recordsResult.error)}` : ""}`);
  }

  if (!batchResult.data) {
    return null;
  }

  const rows = filterPayrollRowsByAccess(
    (recordsResult.data ?? []) as Array<Record<string, unknown>>,
    payrollAccessFilter,
  );

  if (isDevelopment) {
    console.debug("[employee-portal] getSalaryBatchExport records count before access filter:", recordsResult.data?.length ?? 0);
    console.debug("[employee-portal] getSalaryBatchExport records count after access filter:", rows.length);
  }

  return {
    batch: mapBatch(batchResult.data as Record<string, unknown>),
    records: await withHireDates(
      (rows as Record<string, unknown>[]).map((row) => mapRecord(row as Record<string, unknown>)),
    ),
  };
}

type CreateSalaryBatchInput = {
  fileName: string;
  month: number;
  records: SalaryValidationRow[];
  uploadedBy: string | null;
  validationWarnings: SalaryValidationIssue[];
  year: number;
};

function salaryRecordPayload(batchId: string, row: SalaryValidationRow) {
  return {
    area: row.area,
    batch_id: batchId,
    bonus: row.bonus,
    hr_id: row.hrId,
    employment_income_tax: row.employmentIncomeTax,
    expenses: row.expenses,
    extra_cost_of_living: row.extraCostOfLiving,
    finger_print: row.fingerPrint,
    first_part: row.firstPart,
    fuel_allowance: row.fuelAllowance,
    full_name: row.fullName,
    gross_salary: row.grossSalary,
    incentive: row.incentive,
    job_title: row.jobTitle,
    line: row.line,
    loans: row.loans,
    medical_insurance: row.medicalInsurance,
    net_salary: row.netSalary,
    other_additions: row.otherAdditions,
    other_deductions: row.otherDeductions,
    overtime: row.overtime,
    second_part: row.secondPart,
    social_insurance: row.socialInsurance,
    total_additions: row.totalAdditions,
    total_deductions: row.totalDeductions,
    unpaid_vacations: row.unpaidVacations,
  };
}

function salaryFlagPayload(batchId: string, warning: SalaryValidationIssue) {
  return {
    batch_id: batchId,
    hr_id: warning.hrId ?? null,
    flag_type: warning.code,
    message: `Row ${warning.row}${warning.column ? ` / ${warning.column}` : ""}: ${warning.message}`,
    severity: "warning",
  };
}

async function cleanupSalaryBatch(batchId: string) {
  const supabase = getSupabaseAdmin();
  await supabase.from("salary_batches").delete().eq("id", batchId);
}

export async function createSalaryBatch(input: CreateSalaryBatchInput) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const { data: batchData, error: batchError } = await supabase
    .from("salary_batches")
    .insert({
      file_name: input.fileName,
      month: input.month,
      status: "uploaded",
      updated_at: now,
      uploaded_by: input.uploadedBy,
      year: input.year,
    })
    .select()
    .single();

  if (batchError || !batchData) {
    throw batchError ?? new Error("Payroll batch could not be created.");
  }

  const batch = mapBatch(batchData as Record<string, unknown>);

  try {
    const recordPayloads = input.records.map((row) =>
      salaryRecordPayload(batch.id, row),
    );

    if (recordPayloads.length > 0) {
      const { error } = await supabase.from("salary_records").insert(recordPayloads);

      if (error) {
        throw error;
      }
    }

    const flagPayloads = input.validationWarnings.map((warning) =>
      salaryFlagPayload(batch.id, warning),
    );

    if (flagPayloads.length > 0) {
      const { error } = await supabase.from("salary_flags").insert(flagPayloads);

      if (error) {
        throw error;
      }
    }

    return {
      batch,
      importedRecords: recordPayloads.length,
      governanceWarnings: flagPayloads.length,
    };
  } catch (error) {
    await cleanupSalaryBatch(batch.id);
    throw error;
  }
}

export async function deleteSalaryBatch(batchId: string) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("salary_batches").delete().eq("id", batchId);

  if (error) {
    throw error;
  }

  return true;
}

export async function replaceSalaryBatch(
  batchId: string,
  input: Omit<CreateSalaryBatchInput, "month" | "year">,
) {
  const supabase = getSupabaseAdmin();
  const { data: existingBatchData, error: batchError } = await supabase
    .from("salary_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();

  if (batchError) throw batchError;
  if (!existingBatchData) {
    throw new Error("Payroll upload not found.");
  }

  const existing = mapBatch(existingBatchData as Record<string, unknown>);

  const replacement = await createSalaryBatch({
    ...input,
    month: existing.month,
    year: existing.year,
  });

  try {
    await deleteSalaryBatch(batchId);
  } catch (error) {
    await cleanupSalaryBatch(replacement.batch.id);
    throw error;
  }

  return replacement;
}

export async function runPayrollWorkflow(
  batchId: string,
  action: "mark_review" | "approve" | "lock" | "reject" | "reopen",
  actorName: string,
  rejectedReason?: string
): Promise<SalaryBatch | null> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const updates: Record<string, unknown> = { updated_at: now };

  switch (action) {
    case "mark_review":
      updates.status = "under_review";
      break;
    case "approve":
      updates.status = "approved";
      updates.approved_by = actorName;
      updates.approved_at = now;
      break;
    case "lock":
      updates.status = "locked";
      updates.locked_at = now;
      break;
    case "reject":
      updates.status = "rejected";
      updates.rejected_reason = rejectedReason ?? "No reason provided.";
      break;
    case "reopen":
      updates.status = "uploaded";
      updates.rejected_reason = null;
      break;
  }

  const { data, error } = await supabase
    .from("salary_batches")
    .update(updates)
    .eq("id", batchId)
    .select()
    .maybeSingle();

  if (error || !data) return null;
  return mapBatch(data as Record<string, unknown>);
}
