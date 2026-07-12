import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import {
  buildPayrollExpenseBreakdown,
  buildPayrollExpenseTrend,
  summarizePayrollExpenses,
  type PayrollExpenseBreakdownRow,
  type PayrollExpenseSummary,
  type PayrollExpenseTrendPoint,
} from "@/lib/outstation/expense-metrics";
import { PayrollConflictError } from "@/lib/payroll/errors";
import { roundCurrency } from "@/lib/payroll/money";
import { isDisposableExpenseReportRow, isDisposableExpenseRow } from "@/lib/fixture-hygiene";
import { mapOutstationRequestRowToPayrollApproval } from "@/lib/outstation/payroll-expense-mapping";
import { normalizeExpenseType, normalizeTransportation } from "@/lib/outstation/expense-taxonomy";
import { assertOutstationExpenseWorkflowTransition } from "@/lib/outstation/workflow";
import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getSupabaseRlsClientIfAvailable } from "@/lib/supabase/rls-server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertPermission,
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

// Only HR Manager (Super Admin) may reject payroll expenses.
// Finance Manager and CEO have no approval authority here.
const manualPayrollExpenseApproverRoles = new Set<PhoenixRole>([
  "Super Admin",
]);

// PM/GPM/TM line-managers — and the Marketing Manager (head of the Marketing
// department) — see their full downward team chain for expenses (self + all
// descendants), not just the line-name slice. This overrides the "LINE" scope that
// getExpensesScope returns for these roles so the expense dashboard mirrors the org
// hierarchy rather than a line-name filter. The Marketing Manager sits on the Head
// Office line while the PM/GPM they supervise sit on the business lines, so a
// same-line slice would silently drop the manager's own reports.
//
// The National Sales Manager is included for the inverse reason: the PM/GPM who
// promote a product LINE share that line's line_id but report to Marketing (A-9),
// not to the sales NSM. A role-blind LINE slice therefore pulls those PM/GPM (and
// any other non-report on the line) into the NSM's expense dashboard. HIERARCHY
// binds the NSM to exactly his own sales chain (RSM → DSM → MR), so PM/GPM/TM drop
// out by construction while every real report is still covered.
const PORTAL_HIERARCHY_EXPENSE_ROLES = new Set<PhoenixRole>([
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
  "Marketing Manager",
  "National Sales Manager",
]);

function canBypassPayrollExpenseLocks(accessContext: Pick<AccessContext, "role">) {
  return accessContext.role === "Super Admin";
}

export function canManuallyApprovePayrollExpenses(access: AccessContext) {
  return access.scope === "system" || manualPayrollExpenseApproverRoles.has(access.role);
}

export async function assertManualPayrollExpenseApprovalAccess(access: AccessContext) {
  await assertPermission(access, "expenses", "approve");

  if (!canManuallyApprovePayrollExpenses(access)) {
    throw new Error(
      "Forbidden: only HR Manager can review and reject payroll expenses.",
    );
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

export class PayrollExpenseLockSchemaError extends Error {
  constructor() {
    super(
      "Historical outstation expense payroll locks are not ready. Apply the outstation expense payroll locks migration before deleting or replacing uploaded expense reports.",
    );
    this.name = "PayrollExpenseLockSchemaError";
  }
}

export class PayrollExpenseReportLockedError extends Error {
  constructor(action: "deleted" | "replaced") {
    super(
      `This historical outstation upload has already been added to payroll and cannot be ${action}.`,
    );
    this.name = "PayrollExpenseReportLockedError";
  }
}

export function isPayrollExpenseLockSchemaMissing(error: unknown) {
  if (error instanceof PayrollExpenseLockSchemaError) return true;
  const message = expenseErrorMessage(error).toLowerCase();

  return (
    message.includes("imported_payroll_batch_id") ||
    message.includes("imported_to_payroll_at") ||
    message.includes("imported_to_payroll_by")
  );
}

export function isPayrollExpenseReportLocked(error: unknown) {
  return error instanceof PayrollExpenseReportLockedError;
}

function isOutstationRequestsSchemaMissing(error: unknown) {
  const message = expenseErrorMessage(error).toLowerCase();

  return (
    message.includes("outstation_expense_requests") ||
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

export function buildManagerMap(directory: Awaited<ReturnType<typeof getEmployeeDirectory>>) {
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

export function collectHierarchy(managerMap: Map<string, string[]>, rootHrId: string) {
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

  // Portal line-managers (PM/GPM/TM) and the Marketing Manager resolve to HIERARCHY so
  // the expense dashboard shows the full downward chain (self + direct + indirect
  // reports), not a line-name slice. The Marketing Manager is included because their
  // PM/GPM reports sit on the business lines (a different line from the Head Office line
  // the MM sits on), so a line-name slice would wrongly drop the manager's own team.
  const scope = PORTAL_HIERARCHY_EXPENSE_ROLES.has(accessContext.role) ? "HIERARCHY" : getExpensesScope({ role: accessContext.role });
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
    if (currentHrId) allowedHrIds.add(currentHrId);
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
    other: Number(row.other_amount ?? 0),
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
    transportationType: normalizeTransportation(
      String(row.transportation_type ?? ""),
      String(row.trip_type ?? ""),
      Number(row.meeting_amount ?? 0),
    ),
    travelCost: Number(row.travel_cost ?? 0),
    tripId: String(row.trip_id ?? ""),
    tripType: normalizeExpenseType(String(row.trip_type ?? "")),
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

function applyEmployeeHrIdInFilter<T extends { or: (value: string) => T }>(
  query: T,
  hrIds: string[],
) {
  const normalized = buildHrIdFilters(hrIds);
  if (normalized.length === 0) return query;

  return query.or(normalized.map((id) => `employee_hr_id.ilike.${id}`).join(","));
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

export async function listOutstationRequestExpenses(
  accessContext: AccessContext,
) {
  const accessFilter = await resolveExpenseAccessFilter(accessContext);
  const supabase = await getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin();
  let query = supabase
    .from("outstation_expense_requests")
    .select("*")
    .order("created_at", { ascending: false });

  const allowedHrIds = Array.from(accessFilter.allowedHrIds);
  if (!accessFilter.all) {
    if (allowedHrIds.length === 0) return [];
    query = applyEmployeeHrIdInFilter(query, allowedHrIds);
  }

  const { data, error } = await query;
  if (error) {
    if (isOutstationRequestsSchemaMissing(error)) return [];
    throw error;
  }

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map(mapOutstationRequestRowToPayrollApproval);
}

/**
 * Live/system-entered (or request-derived) outstation expenses are authoritative over
 * historical Excel-imported rows for the same trip: when a trip appears in both lists the
 * historical duplicate is dropped so a single trip is never double-counted. Returns the
 * historical rows with those duplicates removed; callers concatenate the two lists in
 * whatever order they render (live-first, historical-first, sorted, …).
 *
 * `tripId` is always a string here (empty string when a row has no trip), so a shared
 * empty-string key is treated as a single "no trip" bucket — matching the prior inline
 * behaviour at every call site exactly.
 */
export function dedupeHistoricalExpensesByTrip<T extends { tripId: string }>(
  historical: T[],
  live: ReadonlyArray<{ tripId: string }>,
): T[] {
  const liveTripIds = new Set(live.map((expense) => expense.tripId));
  return historical.filter((expense) => !liveTripIds.has(expense.tripId));
}

export async function listUnifiedOutstationExpenses(
  month: number | undefined,
  year: number | undefined,
  reportId: string | undefined,
  accessContext: AccessContext,
) {
  const [historicalExpenses, requestExpenses] = await Promise.all([
    listPayrollExpenses(month, year, reportId, accessContext),
    listOutstationRequestExpenses(accessContext),
  ]);
  const filteredRequestExpenses = reportId
    ? []
    : month && year
    ? requestExpenses.filter((expense) => expense.payoutMonth === month && expense.payoutYear === year)
    : requestExpenses;
  const dedupedHistoricalExpenses = dedupeHistoricalExpensesByTrip(
    historicalExpenses,
    filteredRequestExpenses,
  );

  return [...filteredRequestExpenses, ...dedupedHistoricalExpenses].sort((left, right) => {
    const leftTime = left.date ? new Date(left.date).getTime() : 0;
    const rightTime = right.date ? new Date(right.date).getTime() : 0;
    return rightTime - leftTime;
  });
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
    listUnifiedOutstationExpenses(undefined, undefined, undefined, accessContext),
    listPayrollExpenseReports(accessContext),
  ]);

  return buildPayrollExpenseMetrics({ expenses, reports });
}

export async function getPayrollExpenseDashboardData(
  accessContext: AccessContext,
): Promise<PayrollExpenseDashboardData> {
  const [directory, expenses, reports] = await Promise.all([
    getEmployeeDirectory(),
    listUnifiedOutstationExpenses(undefined, undefined, undefined, accessContext),
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

async function assertPayrollExpenseReportCanMutate(
  reportId: string,
  action: "deleted" | "replaced",
  accessContext: AccessContext,
) {
  const { data, error } = await getSupabaseAdmin()
    .from("payroll_expenses")
    .select("id,hr_approved,imported_payroll_batch_id,imported_to_payroll_at,status")
    .eq("report_id", reportId);

  if (error) {
    if (isPayrollExpenseLockSchemaMissing(error)) {
      throw new PayrollExpenseLockSchemaError();
    }
    throw error;
  }

  if (canBypassPayrollExpenseLocks(accessContext)) {
    return;
  }

  const locked = ((data ?? []) as Array<Record<string, unknown>>).some(
    (row) => row.imported_payroll_batch_id != null || row.imported_to_payroll_at != null,
  );

  if (locked) {
    throw new PayrollExpenseReportLockedError(action);
  }

  const workflowStatus = ((data ?? []) as Array<Record<string, unknown>>).some(
    (row) => Boolean(row.hr_approved),
  )
    ? "approved"
    : "pending";
  await assertOutstationExpenseWorkflowTransition({
    access: accessContext,
    actionKey: "delete_before_payroll",
    expectedNextStatus: "deleted",
    status: workflowStatus,
  });
}

export async function deletePayrollExpenseReport(reportId: string, accessContext: AccessContext) {
  await assertPayrollExpenseReportCanMutate(reportId, "deleted", accessContext);

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

  invalidateExecutiveDashboardCache("expense report deleted", ["expenses", "payroll"]);
  return { success: true };
}

export async function clearPayrollExpenseReportRows(reportId: string, accessContext: AccessContext) {
  await assertPayrollExpenseReportCanMutate(reportId, "replaced", accessContext);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("payroll_expenses")
    .delete()
    .eq("report_id", reportId);

  if (error) throw error;
  invalidateExecutiveDashboardCache("expense report rows cleared", ["expenses", "payroll"]);
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
  const hasManualPayrollApprovals = input.records.some((record) => Boolean(record.hrApproved));
  if (hasManualPayrollApprovals) {
    await assertManualPayrollExpenseApprovalAccess(accessContext);
    await assertOutstationExpenseWorkflowTransition({
      access: accessContext,
      actionKey: "approve",
      expectedNextStatus: "approved",
      status: "pending",
    });
  }

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
        total_expenses: roundCurrency(reportTotals.totalExpenses),
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
        total_expenses: roundCurrency(reportTotals.totalExpenses),
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
      hr_status: record.hr,
      km: record.km,
      location: record.location,
      meeting_amount: record.meetingAmount,
      open_status: record.open,
      other_amount: record.other,
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

  const saved = (data ?? []).map((row) => mapExpense(row as Record<string, unknown>));
  invalidateExecutiveDashboardCache("expense approvals saved", ["expenses", "payroll"]);
  return saved;
}

// Best-effort completion alert: when approved expenses are imported into a payroll
// run, tell each matched employee their expense is now in payroll (in-app + email +
// Telegram, generic — no amounts). Uses module "outstation" to match the rest of the
// expense-notification chain (Telegram-enabled, not payroll-sensitive). Idempotent per
// (batch, employee) so re-running an import never double-notifies. Never throws.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function notifyExpensesAddedToPayroll(input: { batchId: string; hrIds: string[]; month: number; year: number }) {
  try {
    const unique = Array.from(new Set(input.hrIds.map((hrId) => String(hrId ?? "").trim()).filter(Boolean)));
    if (unique.length === 0) return;
    const period = `${String(input.month).padStart(2, "0")}/${input.year}`;
    await Promise.allSettled(
      unique.map((hrId) =>
        createSystemNotification({
          actionUrl: "/employee-portals/expenses",
          category: "general",
          channels: ["in_app", "email", "telegram"],
          eventType: "added_to_payroll",
          message: `Your approved expense has been added to the ${period} payroll run and will be paid with that payroll.`,
          metadata: {
            actionUrl: "/employee-portals/expenses",
            idempotencyKey: `outstation:added_to_payroll:${input.batchId}:${hrId.toUpperCase()}`,
            month: input.month,
            period,
            year: input.year,
          },
          module: "outstation",
          priority: "normal",
          recipientHrId: hrId,
          recordId: input.batchId,
          subjectHrId: hrId,
          telegram: { buttons: [{ label: "Open Phoenix", url: "/employee-portals/expenses" }] },
          title: "Your expense was added to payroll",
        }),
      ),
    );
  } catch (error) {
    logNotificationSendFailure("payroll.notifyExpensesAddedToPayroll", error);
  }
}

export async function importApprovedExpensesToPayroll(input: {
  fileName: string;
  month: number;
  records?: Array<ExpenseTripRecord & { hrId?: string | null; hrApproved?: boolean; hrComment?: string }>;
  year: number;
}, accessContext: AccessContext) {
  if (input.records?.length) {
    throw new Error(
      "Save manual HR/admin expense approvals before importing. Payroll import does not accept unsaved approval rows.",
    );
  }

  const savedExpenses = await listPayrollExpenses(input.month, input.year, undefined, accessContext);
  if (savedExpenses.some((expense) => expense.hrApproved)) {
    await assertOutstationExpenseWorkflowTransition({
      access: accessContext,
      actionKey: "add_to_payroll",
      expectedNextStatus: "added_to_payroll",
      status: "approved",
    });
  }

  const supabase = getSupabaseAdmin();
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
    locked_expenses?: number;
    matched_employees?: string[];
    target_batch_id?: string | null;
    target_batch_month?: number | null;
    target_batch_year?: number | null;
  } | null;

  if (!result?.target_batch_id) {
    invalidateExecutiveDashboardCache("expenses imported to payroll", ["expenses", "payroll"]);
    return {
      importedEmployees: 0,
      importedTotal: 0,
      lockedExpenses: 0,
      matchedEmployees: [],
      saved: savedExpenses.length,
      targetBatch: null,
    };
  }

  invalidateExecutiveDashboardCache("expenses imported to payroll", ["expenses", "payroll"]);
  const matchedEmployees = Array.isArray(result.matched_employees) ? result.matched_employees.map(String) : [];
  const batchId = String(result.target_batch_id);
  const batchMonth = Number(result.target_batch_month);
  const batchYear = Number(result.target_batch_year);
  return {
    importedEmployees: Number(result.imported_employees ?? 0),
    importedTotal: Number(result.imported_total ?? 0),
    lockedExpenses: Number(result.locked_expenses ?? 0),
    matchedEmployees,
    saved: savedExpenses.length,
    targetBatch: {
      id: batchId,
      month: batchMonth,
      year: batchYear,
    },
  };
}
