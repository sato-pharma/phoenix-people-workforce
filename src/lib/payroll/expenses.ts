import { randomUUID } from "node:crypto";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  buildPayrollExpenseBreakdown,
  buildPayrollExpenseTrend,
  summarizePayrollExpenses,
  type PayrollExpenseBreakdownRow,
  type PayrollExpenseSummary,
  type PayrollExpenseTrendPoint,
} from "@/lib/payroll/expense-metrics";
import { PayrollConflictError } from "@/lib/payroll/errors";
import { isDisposableExpenseReportRow, isDisposableExpenseRow } from "@/lib/fixture-hygiene";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getSupabaseRlsClientIfAvailable } from "@/lib/supabase/rls-server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canAccess,
  getExpensesScope,
  resolveEmployeeIdentityId,
  normalizeHrId,
  normalizeHrIdForAccess,
  normalizeLineName,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import type {
  EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import type {
  ExpenseTripRecord,
  PayrollExpenseApproval,
  PayrollExpenseReport,
} from "@/lib/payroll/types";

export type PayrollExpenseMetrics = PayrollExpenseSummary & {
  reportCount: number;
};

export type PayrollExpenseDashboardData = {
  breakdown: PayrollExpenseBreakdownRow[];
  employees: EmployeeDirectoryRow[];
  expenses: PayrollExpenseApproval[];
  metrics: PayrollExpenseMetrics;
  reports: PayrollExpenseReport[];
  trend: PayrollExpenseTrendPoint[];
};

const payrollExpenseApprovalRoles = new Set<PhoenixRole>(["CEO", "Finance Manager", "Super Admin"]);

export async function canApprovePayrollExpenses(accessContext: AccessContext) {
  if (accessContext.scope === "system") return true;
  if (!payrollExpenseApprovalRoles.has(accessContext.role)) return false;
  return canAccess(accessContext, "expenses", "approve");
}

async function assertPayrollExpenseApprovalAuthority(accessContext: AccessContext) {
  if (!await canApprovePayrollExpenses(accessContext)) {
    throw new Error("Forbidden: only Finance, CEO, or Super Admin can approve payroll expenses.");
  }
}

function expenseErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

export function isPayrollExpensesSchemaMissing(error: unknown) {
  const message = expenseErrorMessage(error).toLowerCase();

  return (
    message.includes("payroll_expenses") ||
    message.includes("payroll_expense_reports") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function mapExpenseReport(row: Record<string, unknown>): PayrollExpenseReport {
  return {
    approvedRows: Number(row.approved_rows ?? 0),
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : "",
    fileName: String(row.file_name ?? ""),
    id: String(row.id ?? ""),
    rowCount: Number(row.row_count ?? 0),
    totalExpenses: Number(row.total_expenses ?? 0),
    tripDateFrom: row.trip_date_from ? new Date(String(row.trip_date_from)).toISOString() : null,
    tripDateTo: row.trip_date_to ? new Date(String(row.trip_date_to)).toISOString() : null,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : "",
  };
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function cleanText(value: string | null | undefined) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function employeeNameKeys(...values: Array<string | null | undefined>) {
  const keys = new Set<string>();

  values.forEach((value) => {
    const raw = cleanText(value);
    if (!raw) return;

    const compacted = normalizeName(raw);
    if (compacted) keys.add(compacted);

    const parts = raw.split(/[\s._-]+/g).filter(Boolean);
    if (parts.length >= 2) {
      keys.add(normalizeName(`${parts[0]} ${parts[parts.length - 1]}`));
    }
  });

  return Array.from(keys);
}

type ExpenseAccessFilter = {
  all: boolean;
  allowedHrIds: Set<string>;
};

function buildManagerMap(directory: Awaited<ReturnType<typeof getEmployeeDirectory>>) {
  const managerMap = new Map<string, string[]>();
  directory.employees.forEach((employee) => {
    const managerId = normalizeHrIdForAccess(employee.managerHrId);
    const employeeId = normalizeHrId(employee.hrId);
    if (!managerId || !employeeId) return;
    const list = managerMap.get(managerId) ?? [];
    list.push(employeeId);
    managerMap.set(managerId, list);
  });
  return managerMap;
}

function collectHierarchy(managerMap: Map<string, string[]>, rootHrId: string) {
  const allowedHrIds = new Set<string>();
  const canonicalRoot = normalizeHrIdForAccess(rootHrId);
  if (!canonicalRoot) return allowedHrIds;

  const queue: string[] = [canonicalRoot];
  while (queue.length > 0) {
    const managerId = queue.shift();
    if (!managerId) continue;
    for (const subordinateId of managerMap.get(managerId) ?? []) {
      const normalizedSub = normalizeHrId(subordinateId);
      if (normalizedSub && !allowedHrIds.has(normalizedSub)) {
        allowedHrIds.add(normalizedSub);
        const canonicalSub = normalizeHrIdForAccess(normalizedSub);
        if (canonicalSub) queue.push(canonicalSub);
      }
    }
  }
  return allowedHrIds;
}

type LineFallbackOptions = {
  areaId?: number | null;
  lineId?: number | null;
  lineName?: string | null;
};

function collectLineHrIds(
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
  options: LineFallbackOptions = {},
) {
  const targetLine = normalizeLineName(options.lineName);
  const targetLineId = Number.isFinite(options.lineId as number | null) ? options.lineId : null;
  const targetAreaId = Number.isFinite(options.areaId as number | null) ? options.areaId : null;

  const lineHrIds = new Set<string>();

  directory.employees.forEach((employee) => {
    if (
      (targetLineId !== null && employee.lineId === targetLineId) ||
      (targetLine && normalizeLineName(employee.lineName) === targetLine) ||
      (targetLineId === null && !targetLine && targetAreaId !== null && employee.areaId === targetAreaId)
    ) {
      const employeeId = normalizeHrId(employee.hrId);
      if (employeeId) lineHrIds.add(employeeId);
    }
  });

  if (lineHrIds.size > 0 || targetLineId !== null || targetLine || targetAreaId !== null) {
    return lineHrIds;
  }

  directory.employees.forEach((employee) => {
    const employeeId = normalizeHrId(employee.hrId);
    if (employeeId) lineHrIds.add(employeeId);
  });

  return lineHrIds;
}

async function resolveExpenseAccessFilter(
  accessContext: AccessContext,
): Promise<ExpenseAccessFilter> {
  if (accessContext.scope === "system") {
    return { all: true, allowedHrIds: new Set() };
  }

  if (!(await canAccess(accessContext, "expenses", "read"))) {
    return { all: false, allowedHrIds: new Set() };
  }

  const scope = getExpensesScope({ role: accessContext.role });
  const currentHrId = resolveEmployeeIdentityId(accessContext);

  if (scope === "COMPANY") return { all: true, allowedHrIds: new Set() };
  if (scope === "NONE" || !currentHrId) return { all: false, allowedHrIds: new Set() };

  const directory = await getEmployeeDirectory();
  const canonicalViewerId = normalizeHrIdForAccess(currentHrId);
  const viewer = canonicalViewerId ? directory.employees.find(e => normalizeHrIdForAccess(e.hrId) === canonicalViewerId) : null;
  const managerMap = buildManagerMap(directory);

  if (scope === "SELF") {
    return { all: false, allowedHrIds: new Set([currentHrId]) };
  }

  if (scope === "TEAM") {
    const canonicalId = normalizeHrIdForAccess(currentHrId);
    const allowed = new Set(canonicalId ? managerMap.get(canonicalId) ?? [] : []);
    allowed.add(currentHrId);
    return { all: false, allowedHrIds: allowed };
  }

  if (scope === "HIERARCHY") {
    const allowed = collectHierarchy(managerMap, currentHrId);
    allowed.add(currentHrId);
    return { all: false, allowedHrIds: allowed };
  }

  if (scope === "LINE" && viewer) {
    const allowedHrIds = collectLineHrIds(directory, {
      areaId: viewer.areaId,
      lineId: viewer.lineId,
      lineName: viewer.lineName,
    });
    return { all: false, allowedHrIds };
  }

  if (scope === "LINE") {
    return { all: false, allowedHrIds: new Set([currentHrId]) };
  }

  return { all: false, allowedHrIds: new Set() };
}

async function getVisibleExpenseReportIds(
  supabase: SupabaseClient,
  accessFilter: ExpenseAccessFilter,
) {
  let query = supabase
    .from("payroll_expenses")
    .select("report_id")
    .not("report_id", "is", null);
  const allowedHrIds = Array.from(accessFilter.allowedHrIds);

  if (!accessFilter.all) {
    if (allowedHrIds.length === 0) return new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = applyHrIdInFilter(query as any, allowedHrIds);
  }

  const { data, error } = await query;
  if (error) {
    if (isPayrollExpensesSchemaMissing(error)) return new Set<string>();
    throw error;
  }

  return new Set(
    (data ?? [])
      .map((row) => String((row as { report_id?: unknown }).report_id))
      .filter(Boolean),
  );
}

function nextPayrollPeriod(dateValue: string) {
  const date = new Date(dateValue);
  const base = Number.isNaN(date.getTime()) ? new Date() : date;
  const month = base.getMonth() + 2;

  if (month > 12) {
    return { month: 1, year: base.getFullYear() + 1 };
  }

  return { month, year: base.getFullYear() };
}

async function employeeCodeBySpecialist() {
  const directory = await getEmployeeDirectory();
  const byName = new Map<string, string>();

  directory.employees.forEach((employee) => {
    employeeNameKeys(employee.fullName, employee.nameAr, employee.crmUsername).forEach((key) => {
      byName.set(key, employee.hrId);
    });
  });

  return byName;
}

function mapExpense(row: Record<string, unknown>): PayrollExpenseApproval {
  const mappedHrId = row.hr_id
    ? String(row.hr_id)
    : row.employee_hr_id
      ? String(row.employee_hr_id)
      : row.employee_code
        ? String(row.employee_code)
        : null;

  return {
    allowance: Number(row.allowance ?? 0),
    amWorkload: Number(row.am_workload ?? 0),
    approvedAt: row.approved_at ? new Date(String(row.approved_at)).toISOString() : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    date: row.expense_date ? new Date(String(row.expense_date)).toISOString() : "",
    description: String(row.description ?? ""),
    hrId: mappedHrId,
    from: String(row.from_location ?? ""),
    hr: String(row.hr_status ?? ""),
    hrApproved: Boolean(row.hr_approved),
    hrComment: String(row.hr_comment ?? ""),
    hrNotes: String(row.hr_notes ?? ""),
    km: Number(row.km ?? 0),
    location: String(row.location ?? ""),
    meetingAmount: Number(row.meeting_amount ?? 0),
    open: String(row.open_status ?? ""),
    payoutMonth: Number(row.payout_month),
    payoutYear: Number(row.payout_year),
    pmWorkload: Number(row.pm_workload ?? 0),
    requestType: String(row.request_type ?? ""),
    row: Number(row.source_row ?? 0),
    reportId: row.report_id ? String(row.report_id) : null,
    sourceFileName: String(row.source_file_name ?? ""),
    specialist: String(row.specialist ?? ""),
    status: String(row.status ?? ""),
    to: String(row.to_location ?? ""),
    toDate: row.to_date ? new Date(String(row.to_date)).toISOString() : "",
    total: Number(row.total ?? 0),
    transportationType: String(row.transportation_type ?? ""),
    travelCost: Number(row.travel_cost ?? 0),
    tripId: String(row.trip_id ?? ""),
    tripType: String(row.trip_type ?? ""),
  };
}

// payroll_expenses only has hr_id — do NOT reference employee_hr_id or employee_code
function applyHrIdFilter<T extends { or: (value: string) => T; ilike: (column: string, value: string) => T }>(
  query: T,
  hrId: string,
) {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return query;
  const canonical = normalizeHrIdForAccess(normalized);

  return query.or(
    `hr_id.ilike.${normalized}` +
      (canonical && canonical !== normalized ? `,hr_id.ilike.${canonical}` : ""),
  );
}

function buildHrIdFilters(hrIds: string[]) {
  const normalized = new Set<string>();

  hrIds.forEach((rawId) => {
    const normalizedId = normalizeHrId(rawId);
    const canonicalId = normalizeHrIdForAccess(rawId);

    if (normalizedId) normalized.add(normalizedId);
    if (canonicalId) normalized.add(canonicalId);
  });

  return Array.from(normalized);
}

// payroll_expenses only has hr_id — do NOT reference employee_hr_id or employee_code
function applyHrIdInFilter<T extends { or: (value: string) => T; ilike: (column: string, value: string) => T }>(
  query: T,
  hrIds: string[],
) {
  const normalized = buildHrIdFilters(hrIds);

  if (normalized.length === 0) {
    return query;
  }

  if (normalized.length === 1) {
    return applyHrIdFilter(query, normalized[0]);
  }

  const ors = normalized.map((id) => `hr_id.ilike.${id}`).join(",");

  return query.or(ors);
}

export async function listPayrollExpenseReports(accessContext: AccessContext) {
  const supabase = await getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin();
  const accessFilter = await resolveExpenseAccessFilter(accessContext);

  if (accessFilter.all) {
    const { data, error } = await supabase
      .from("payroll_expense_reports")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      if (isPayrollExpensesSchemaMissing(error)) return [];
      throw error;
    }

    return (data ?? [])
      .filter((row) => !isDisposableExpenseReportRow(row as Record<string, unknown>))
      .map((row) => mapExpenseReport(row as Record<string, unknown>));
  }

  const visibleReportIds = await getVisibleExpenseReportIds(supabase, accessFilter);

  if (visibleReportIds.size === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("payroll_expense_reports")
    .select("*")
    .in("id", Array.from(visibleReportIds))
    .order("created_at", { ascending: false });

  if (error) {
    if (isPayrollExpensesSchemaMissing(error)) return [];
    throw error;
  }

  return (data ?? [])
    .filter((row) => !isDisposableExpenseReportRow(row as Record<string, unknown>))
    .map((row) => mapExpenseReport(row as Record<string, unknown>));
}

export async function listPayrollExpenses(
  month: number | undefined,
  year: number | undefined,
  reportId: string | undefined,
  accessContext: AccessContext,
) {
  const accessFilter = await resolveExpenseAccessFilter(accessContext);
  const supabase = await getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin();
  let query = supabase
    .from("payroll_expenses")
    .select("*")
    .order("expense_date", { ascending: false });

  const allowedHrIds = Array.from(accessFilter.allowedHrIds);
  if (!accessFilter.all) {
    if (allowedHrIds.length === 0) return [];
    query = applyHrIdInFilter(query, allowedHrIds);
  }

  if (month && year) {
    query = query.eq("payout_month", month).eq("payout_year", year);
  }

  if (reportId) {
    query = query.eq("report_id", reportId);
  }

  const { data, error } = await query;

  if (error) {
    if (isPayrollExpensesSchemaMissing(error)) return [];
    throw error;
  }

  return (data ?? [])
    .filter((row) => !isDisposableExpenseRow(row as Record<string, unknown>))
    .map((row) => mapExpense(row as Record<string, unknown>));
}

export function buildPayrollExpenseMetrics(input: {
  expenses: PayrollExpenseApproval[];
  reports?: PayrollExpenseReport[];
}): PayrollExpenseMetrics {
  return {
    ...summarizePayrollExpenses(input.expenses),
    reportCount: input.reports?.length ?? 0,
  };
}

export async function getPayrollExpenseMetrics(
  accessContext: AccessContext,
): Promise<PayrollExpenseMetrics> {
  const [expenses, reports] = await Promise.all([
    listPayrollExpenses(undefined, undefined, undefined, accessContext),
    listPayrollExpenseReports(accessContext),
  ]);

  return buildPayrollExpenseMetrics({ expenses, reports });
}

export async function getPayrollExpenseDashboardData(
  accessContext: AccessContext,
): Promise<PayrollExpenseDashboardData> {
  const [directory, expenses, reports] = await Promise.all([
    getEmployeeDirectory(),
    listPayrollExpenses(undefined, undefined, undefined, accessContext),
    listPayrollExpenseReports(accessContext),
  ]);

  return {
    breakdown: buildPayrollExpenseBreakdown(expenses),
    employees: directory.employees,
    expenses,
    metrics: buildPayrollExpenseMetrics({ expenses, reports }),
    reports,
    trend: buildPayrollExpenseTrend(expenses),
  };
}

export async function deletePayrollExpenseReport(reportId: string) {
  const supabase = getSupabaseAdmin();
  const { error: rowsError } = await supabase
    .from("payroll_expenses")
    .delete()
    .eq("report_id", reportId);

  if (rowsError) throw rowsError;

  const { error: reportError } = await supabase
    .from("payroll_expense_reports")
    .delete()
    .eq("id", reportId);

  if (reportError) throw reportError;

  return { success: true };
}

export async function clearPayrollExpenseReportRows(reportId: string) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("payroll_expenses")
    .delete()
    .eq("report_id", reportId);

  if (error) throw error;
}

export async function getApprovedExpenseTotalsForPayroll(
  month: number,
  year: number,
  accessContext: AccessContext,
) {
  // Optimized narrow-query equivalent of getApprovedExpenseTotalsByHrId for payroll template generation.
  const accessFilter = await resolveExpenseAccessFilter(accessContext);
  const supabase = await getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin();
  let query = supabase
    .from("payroll_expenses")
    .select("hr_id,total,hr_approved,payout_year,trip_id,source_file_name,specialist,description")
    .eq("payout_month", month)
    .eq("payout_year", year)
    .eq("hr_approved", true);

  const allowedHrIds = Array.from(accessFilter.allowedHrIds);
  if (!accessFilter.all) {
    if (allowedHrIds.length === 0) return new Map<string, number>();
    query = applyHrIdInFilter(query, allowedHrIds);
  }

  const { data, error } = await query;

  if (error) {
    if (isPayrollExpensesSchemaMissing(error)) return new Map<string, number>();
    throw error;
  }

  const totals = new Map<string, number>();
  ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => !isDisposableExpenseRow(row))
    .forEach((row) => {
      const hrId = String(row.hr_id ?? "").trim();
      if (!hrId) return;
      totals.set(hrId, (totals.get(hrId) ?? 0) + Number(row.total ?? 0));
    });

  return totals;
}

export async function savePayrollExpenseApprovals(input: {
  fileName: string;
  records: Array<ExpenseTripRecord & {
    hrId?: string | null;
    hrApproved?: boolean;
    hrComment?: string;
    reportId?: string | null;
  }>;
  reportId?: string | null;
}, accessContext: AccessContext) {
  await assertPayrollExpenseApprovalAuthority(accessContext);

  const approvedBy = resolveEmployeeIdentityId(accessContext) ?? accessContext.loginId ?? "system";
  const now = new Date().toISOString();
  const employeeByName = await employeeCodeBySpecialist();
  const supabase = getSupabaseAdmin();
  const reportTotals = input.records.reduce(
    (summary, record) => {
      const date = record.date ? new Date(record.date) : null;
      summary.approvedRows += record.hrApproved ? 1 : 0;
      summary.rowCount += 1;
      summary.totalExpenses += record.total;

      if (date && !Number.isNaN(date.getTime())) {
        const isoDate = date.toISOString().slice(0, 10);
        summary.tripDateFrom = summary.tripDateFrom && summary.tripDateFrom < isoDate
          ? summary.tripDateFrom
          : isoDate;
        summary.tripDateTo = summary.tripDateTo && summary.tripDateTo > isoDate
          ? summary.tripDateTo
          : isoDate;
      }

      return summary;
    },
    {
      approvedRows: 0,
      rowCount: 0,
      totalExpenses: 0,
      tripDateFrom: null as string | null,
      tripDateTo: null as string | null,
    },
  );
  let reportId = input.reportId ?? input.records.find((record) => record.reportId)?.reportId ?? null;

  if (reportId) {
    const { error } = await supabase
      .from("payroll_expense_reports")
      .update({
        approved_rows: reportTotals.approvedRows,
        file_name: input.fileName,
        row_count: reportTotals.rowCount,
        total_expenses: reportTotals.totalExpenses,
        trip_date_from: reportTotals.tripDateFrom,
        trip_date_to: reportTotals.tripDateTo,
        updated_at: now,
      })
      .eq("id", reportId);

    if (error) throw error;
  } else {
    const { data: report, error } = await supabase
      .from("payroll_expense_reports")
      .insert({
        approved_rows: reportTotals.approvedRows,
        file_name: input.fileName,
        row_count: reportTotals.rowCount,
        total_expenses: reportTotals.totalExpenses,
        trip_date_from: reportTotals.tripDateFrom,
        trip_date_to: reportTotals.tripDateTo,
        updated_at: now,
      })
      .select("id")
      .single();

    if (error) throw error;
    reportId = String(report.id);
  }

  const payload = input.records.map((record) => {
    const period = nextPayrollPeriod(record.date);
    const hrId =
      record.hrId?.trim() ||
      employeeNameKeys(record.specialist)
        .map((key) => employeeByName.get(key))
        .find(Boolean) ||
      null;
    const approved = Boolean(record.hrApproved);

    return {
      allowance: record.allowance,
      am_workload: record.amWorkload,
      approved_at: approved ? now : null,
      approved_by: approved ? approvedBy : null,
      description: record.description,
      hr_id: hrId,
      expense_date: record.date || null,
      from_location: record.from,
      hr_approved: approved,
      hr_comment: record.hrComment ?? "",
      hr_notes: record.hrNotes,
      hr_status: approved ? "Approved" : (record.hr?.trim() || "Pending HR review"),
      km: record.km,
      location: record.location,
      meeting_amount: record.meetingAmount,
      open_status: record.open,
      payout_month: period.month,
      payout_year: period.year,
      pm_workload: record.pmWorkload,
      request_type: record.requestType,
      report_id: reportId,
      source_file_name: input.fileName,
      source_row: record.row,
      specialist: record.specialist,
      status: record.status,
      to_date: record.toDate || null,
      to_location: record.to,
      total: record.total,
      transportation_type: record.transportationType,
      travel_cost: record.travelCost,
      trip_id: record.tripId,
      trip_type: record.tripType,
      updated_at: now,
    };
  });

  const { data, error } = await supabase
    .from("payroll_expenses")
    .upsert(payload, { onConflict: "trip_id" })
    .select("*");

  if (error) throw error;

  return (data ?? []).map((row) => mapExpense(row as Record<string, unknown>));
}

export async function setPayrollExpenseApproval(
  tripId: string,
  accessContext: AccessContext,
  input: { comment?: string | null; hrApproved: boolean },
) {
  await assertPayrollExpenseApprovalAuthority(accessContext);

  const cleanTripId = String(tripId ?? "").trim();
  if (!cleanTripId) throw new Error("Expense trip ID is required.");

  const supabase = getSupabaseAdmin();
  const { data: existingData, error: existingError } = await supabase
    .from("payroll_expenses")
    .select("*")
    .eq("trip_id", cleanTripId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (!existingData) throw new Error("Expense row was not found.");

  const existing = mapExpense(existingData as Record<string, unknown>);
  const approved = Boolean(input.hrApproved);

  // Idempotency guard: if already in the requested approval state, return
  // without a DB write — prevents double-reset of approved_at timestamp.
  if (existing.hrApproved === approved) {
    return existing;
  }

  const now = new Date().toISOString();
  const approvedBy = resolveEmployeeIdentityId(accessContext) ?? accessContext.loginId ?? "system";
  const comment = String(input.comment ?? existing.hrComment ?? "").trim();
  const { data: updatedData, error: updateError } = await supabase
    .from("payroll_expenses")
    .update({
      approved_at: approved ? now : null,
      approved_by: approved ? approvedBy : null,
      hr_approved: approved,
      hr_comment: comment,
      hr_status: approved ? "Approved" : "Pending HR review",
      updated_at: now,
    })
    .eq("trip_id", cleanTripId)
    .select("*")
    .single();

  if (updateError) throw updateError;

  const reportId = String((existingData as Record<string, unknown>).report_id ?? "");
  if (reportId) {
    await recomputePayrollExpenseReportTotals(reportId, supabase);
  }

  return mapExpense(updatedData as Record<string, unknown>);
}

export async function decidePayrollExpenseApproval(
  tripId: string,
  accessContext: AccessContext,
  input: { comment?: string | null; decision: "approve" | "reject" },
) {
  await assertPayrollExpenseApprovalAuthority(accessContext);

  const cleanTripId = String(tripId ?? "").trim();
  if (!cleanTripId) throw new Error("Expense trip ID is required.");
  if (input.decision === "reject" && !String(input.comment ?? "").trim()) {
    throw new Error("A rejection comment is required.");
  }

  const supabase = getSupabaseAdmin();
  const { data: existingData, error: existingError } = await supabase
    .from("payroll_expenses")
    .select("*")
    .eq("trip_id", cleanTripId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (!existingData) throw new Error("Expense row was not found.");

  const existing = mapExpense(existingData as Record<string, unknown>);
  const approved = input.decision === "approve";

  // Idempotency guard: if already in the requested decision state, return
  // without a DB write — prevents re-approval from overwriting audit metadata.
  if ((approved && existing.status === "approved") || (!approved && existing.status === "rejected")) {
    return { previous: existing, updated: existing };
  }

  const now = new Date().toISOString();
  const approvedBy = resolveEmployeeIdentityId(accessContext) ?? accessContext.loginId ?? "system";
  const { data: updatedData, error: updateError } = await supabase
    .from("payroll_expenses")
    .update({
      approved_at: approved ? now : null,
      approved_by: approved ? approvedBy : null,
      hr_approved: approved,
      hr_comment: String(input.comment ?? "").trim(),
      hr_status: approved ? "Approved" : "Rejected",
      status: approved ? "approved" : "rejected",
      updated_at: now,
    })
    .eq("trip_id", cleanTripId)
    .select("*")
    .single();

  if (updateError) throw updateError;

  const reportId = String((existingData as Record<string, unknown>).report_id ?? "");
  if (reportId) {
    await recomputePayrollExpenseReportTotals(reportId, supabase);
  }

  return {
    previous: existing,
    updated: mapExpense(updatedData as Record<string, unknown>),
  };
}

async function recomputePayrollExpenseReportTotals(reportId: string, supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("payroll_expenses")
    .select("expense_date,total,hr_approved")
    .eq("report_id", reportId);

  if (error) throw error;

  const totals = ((data ?? []) as Array<Record<string, unknown>>).reduce<{
    approvedRows: number;
    rowCount: number;
    totalExpenses: number;
    tripDateFrom: string | null;
    tripDateTo: string | null;
  }>(
    (summary, row) => {
      const date = row.expense_date ? new Date(String(row.expense_date)) : null;
      summary.approvedRows += row.hr_approved ? 1 : 0;
      summary.rowCount += 1;
      summary.totalExpenses += Number(row.total ?? 0);

      if (date && !Number.isNaN(date.getTime())) {
        const isoDate = date.toISOString().slice(0, 10);
        summary.tripDateFrom = summary.tripDateFrom && summary.tripDateFrom < isoDate
          ? summary.tripDateFrom
          : isoDate;
        summary.tripDateTo = summary.tripDateTo && summary.tripDateTo > isoDate
          ? summary.tripDateTo
          : isoDate;
      }

      return summary;
    },
    {
      approvedRows: 0,
      rowCount: 0,
      totalExpenses: 0,
      tripDateFrom: null as string | null,
      tripDateTo: null as string | null,
    },
  );

  const updateResult = await supabase
    .from("payroll_expense_reports")
    .update({
      approved_rows: totals.approvedRows,
      row_count: totals.rowCount,
      total_expenses: totals.totalExpenses,
      trip_date_from: totals.tripDateFrom,
      trip_date_to: totals.tripDateTo,
      updated_at: new Date().toISOString(),
    })
    .eq("id", reportId);

  if (updateResult.error) throw updateResult.error;
}

export async function importApprovedExpensesToPayroll(input: {
  fileName: string;
  month: number;
  records?: Array<ExpenseTripRecord & { hrId?: string | null; hrApproved?: boolean; hrComment?: string }>;
  year: number;
}, accessContext: AccessContext) {
  const importJobId = randomUUID();
  const supabase = getSupabaseAdmin();

  // Pre-flight: verify the target salary batch is in a state that can receive
  // expense imports. Fail fast BEFORE writing expense rows so a blocked import
  // does not dirty the payroll_expenses table.
  const { data: batchRow } = await supabase
    .from("salary_batches")
    .select("id, status")
    .eq("month", input.month)
    .eq("year", input.year)
    .maybeSingle();

  if (batchRow) {
    const batchStatus = String((batchRow as Record<string, unknown>).status ?? "");
    const blockedStatuses = ["locked", "approved", "rejected"];
    if (blockedStatuses.includes(batchStatus)) {
      throw new PayrollConflictError(
        `Cannot import expenses: the ${input.year}/${input.month} payroll batch is already ${batchStatus}. Reopen the batch before importing.`,
      );
    }
  }

  console.info(
    `[payroll-expenses] import job ${importJobId} started — ${input.year}/${input.month}, file: ${input.fileName}`,
  );

  const savedExpenses = input.records?.length
    ? await savePayrollExpenseApprovals({
        fileName: input.fileName,
        records: input.records,
      }, accessContext)
    : await listPayrollExpenses(input.month, input.year, undefined, accessContext);
  const { data: importResult, error: importError } = await supabase.rpc(
    "phx_import_approved_expenses_to_payroll",
    {
      p_month: input.month,
      p_year: input.year,
    },
  );

  if (importError) {
    const message = expenseErrorMessage(importError);
    if (message.toLowerCase().includes("cannot import expenses")) {
      throw new PayrollConflictError(message);
    }
    throw importError;
  }

  const result = (importResult ?? null) as {
    imported_employees?: number;
    imported_total?: number;
    matched_employees?: string[];
    target_batch_id?: string | null;
    target_batch_month?: number | null;
    target_batch_year?: number | null;
  } | null;

  if (!result?.target_batch_id) {
    console.info(`[payroll-expenses] import job ${importJobId} completed — no target batch matched`);
    return {
      importedEmployees: 0,
      importedTotal: 0,
      matchedEmployees: [],
      saved: savedExpenses.length,
      targetBatch: null,
    };
  }

  console.info(
    `[payroll-expenses] import job ${importJobId} completed — batch ${result.target_batch_id}, ` +
    `imported ${result.imported_employees ?? 0} employees, total ${result.imported_total ?? 0}`,
  );

  return {
    importedEmployees: Number(result.imported_employees ?? 0),
    importedTotal: Number(result.imported_total ?? 0),
    matchedEmployees: Array.isArray(result.matched_employees) ? result.matched_employees.map(String) : [],
    saved: savedExpenses.length,
    targetBatch: {
      id: String(result.target_batch_id),
      month: Number(result.target_batch_month),
      year: Number(result.target_batch_year),
    },
  };
}
