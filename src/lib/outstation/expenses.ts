import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { nextPayrollPeriod } from "@/lib/outstation/payroll-period";
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
import { logError } from "@/lib/observability/log";
import {
  expenseDecisionsThatChanged,
  resyncPayrollExpenseStep,
  type ExpenseDecisionSnapshot,
  type ExpenseResyncOutcome,
} from "@/lib/automated-payroll/expense-resync";
import { isDisposableExpenseReportRow, isDisposableExpenseRow } from "@/lib/fixture-hygiene";
import { resolveOutstationCapturedLocation } from "@/lib/outstation/captured-location";
import { withLiveOutstationEmployeeNames } from "@/lib/outstation/employee-name";
import {
  mapOutstationRequestRowToPayrollApproval,
  outstationPharmacyWorkload,
} from "@/lib/outstation/payroll-expense-mapping";
import {
  planExpenseReportMutation,
  WorkflowExpenseReportProtectedError,
} from "@/lib/outstation/workflow-expense-report-guard";
import { applyLiveExpenseReportCounts } from "@/lib/outstation/expense-report-live-counts";
import { normalizeExpenseType, normalizeTransportation } from "@/lib/outstation/expense-taxonomy";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { fetchAllRows, POSTGREST_PAGE_SIZE } from "@/lib/outstation/page-all-rows";
import { quotedOrClause } from "@/lib/supabase/search-filter";
import {
  resolveExpenseDecisionWrite,
  type ExpenseDecisionWrite,
  type StoredExpenseDecision,
} from "@/lib/outstation/approval-state";
import { describeImportedHistoryRefusal, planImportedHistoryWrites } from "@/lib/outstation/imported-history";
import { assertNoWorkflowTripIds } from "@/lib/outstation/workflow-trip-id-guard";
import { assertOutstationExpenseWorkflowTransition } from "@/lib/outstation/workflow";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { expenseClaimsReadEnabled } from "@/lib/outstation/claims-read-flag";
import { rowSecurityClientFor } from "@/lib/supabase/rls-server";
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
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import { hrIdForStorage } from "@/lib/hr-id";
import { isWithinManagerHierarchy, reportsToManagerSeat } from "@/lib/workforce/hierarchy-resolver";
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
// The CEO has no approval authority here — read-only oversight. The Finance Manager is out of the
// module entirely as of 2026-08-10 (owner: "exclude him 100% from outstation or expenses"): the
// `outstation` key was removed from his matrix and getExpensesScope now returns SELF for the role,
// so resolveExpenseAccessFilter below yields him no rows even on the residual `expenses:read` he
// keeps for the marketing-request routes.
/** One upsert may return at most this many rows — see the write in savePayrollExpenseApprovals. */
const UPSERT_CHUNK_SIZE = POSTGREST_PAGE_SIZE;

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
export const PORTAL_HIERARCHY_EXPENSE_ROLES = new Set<PhoenixRole>([
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
    message.includes("outstation_expenses") ||
    message.includes("outstation_expense_reports") ||
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

/** Canonical hrId -> employee row, for isWithinManagerHierarchy's byCanonicalHrId input. */
function buildCanonicalHrIdIndex(
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
): Map<string, EmployeeDirectoryRow> {
  const byCanonicalHrId = new Map<string, EmployeeDirectoryRow>();
  directory.employees.forEach((employee) => {
    const key = normalizeHrIdForAccess(employee.hrId);
    if (key) byCanonicalHrId.set(key, employee);
  });
  return byCanonicalHrId;
}

/** Direct reports of the viewer's seat — TEAM scope. Seat-continuity aware. */
export function collectDirectReports(
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
  viewerCanonicalHrId: string,
): Set<string> {
  const allowed = new Set<string>();
  if (!viewerCanonicalHrId) return allowed;
  directory.employees.forEach((employee) => {
    if (reportsToManagerSeat({ employee, viewerCanonicalHrId, canonicalize: normalizeHrIdForAccess })) {
      const id = normalizeHrId(employee.hrId);
      if (id) allowed.add(id);
    }
  });
  return allowed;
}

/** Every employee in the viewer's full downward chain — HIERARCHY scope. Cycle-safe. */
export function collectHierarchy(
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
  viewerCanonicalHrId: string,
): Set<string> {
  const allowed = new Set<string>();
  if (!viewerCanonicalHrId) return allowed;
  const byCanonicalHrId = buildCanonicalHrIdIndex(directory);
  directory.employees.forEach((employee) => {
    if (isWithinManagerHierarchy({ employee, byCanonicalHrId, viewerCanonicalHrId, canonicalize: normalizeHrIdForAccess })) {
      const id = normalizeHrId(employee.hrId);
      if (id) allowed.add(id);
    }
  });
  return allowed;
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

// Exported for the phase-2 read path (claims-read.ts). Visibility here is application-scoped, not
// RLS-scoped, so the scope rule must have exactly ONE definition - a second copy that drifts is how
// a manager ends up seeing another line's claims.
export async function resolveExpenseAccessFilter(
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

  if (scope === "SELF") {
    return { all: false, allowedHrIds: new Set([currentHrId]) };
  }

  if (scope === "TEAM") {
    const allowed = collectDirectReports(directory, canonicalViewerId ?? "");
    allowed.add(currentHrId);
    return { all: false, allowedHrIds: allowed };
  }

  if (scope === "HIERARCHY") {
    const allowed = collectHierarchy(directory, canonicalViewerId ?? "");
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

/**
 * True when `targetHrId` falls within the caller's expense visibility scope
 * (self / team / hierarchy / line / company). Use this to authorize a read of a
 * specific caller-supplied employee HR id, instead of a blanket capability check
 * that would expose every employee. Canonical-compares to tolerate HR_ID casing.
 */
export async function canViewEmployeeExpenseScope(
  accessContext: AccessContext,
  targetHrId: string,
): Promise<boolean> {
  const filter = await resolveExpenseAccessFilter(accessContext);
  if (filter.all) return true;
  const canonicalTarget = normalizeHrIdForAccess(targetHrId);
  if (!canonicalTarget) return false;
  for (const allowed of filter.allowedHrIds) {
    if (normalizeHrIdForAccess(allowed) === canonicalTarget) return true;
  }
  return false;
}

async function getVisibleExpenseReportIds(
  supabase: SupabaseClient,
  accessFilter: ExpenseAccessFilter,
) {
  const allowedHrIds = Array.from(accessFilter.allowedHrIds);
  if (!accessFilter.all && allowedHrIds.length === 0) return new Set<string>();

  // Paged for the same reason as the reads above, and it matters more here than the row count
  // suggests: this set decides which REPORTS a scoped viewer is allowed to see at all, so a
  // truncated read does not shorten a list — it makes whole reports disappear for that person.
  const buildQuery = () => {
    let query = supabase
      .from("outstation_expenses")
      .select("report_id,hr_id")
      .not("report_id", "is", null)
      .order("id", { ascending: true });

    if (!accessFilter.all) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query = applyHrIdInFilter(query as any, allowedHrIds);
    }

    return query;
  };

  const { data, error } = await fetchAllRows((from, to) => buildQuery().range(from, to));
  if (error) {
    if (isPayrollExpensesSchemaMissing(error)) return new Set<string>();
    throw error;
  }

  return new Set(
    keepExpenseRowsInScope((data ?? []) as Array<Record<string, unknown>>, accessFilter, "hr_id")
      .map((row) => String(row.report_id))
      .filter(Boolean),
  );
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
    // Without this the approvals UI cannot see what it saved and silently falls back to `total`,
    // which is exactly how the edited amount used to disappear on reload.
    approvedAmount:
      row.approved_amount === null || row.approved_amount === undefined
        ? null
        : Number(row.approved_amount),
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
    other: Number(row.other_amount ?? 0),
    payoutMonth: Number(row.payout_month),
    payoutYear: Number(row.payout_year),
    // NULL stays NULL — "not counted separately" (a pre-split or imported row), never a zero.
    pharmacyWorkload: outstationPharmacyWorkload(row.pharmacy_workload),
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

// outstation_expenses only has hr_id — do NOT reference employee_hr_id or employee_code
function applyHrIdFilter<T extends { or: (value: string) => T; ilike: (column: string, value: string) => T }>(
  query: T,
  hrId: string,
) {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return query;
  const canonical = normalizeHrIdForAccess(normalized);

  // Both arms QUOTED: `normalizeHrId` and `normalizeHrIdForAccess` trim, lower-case and map an
  // alias — neither restricts the character set, so a `,` or `)` in an id would end its arm early
  // and leave PostgREST a filter nobody wrote, on the read that IS this module's access boundary
  // (AGENTS.md MR-B04).
  return query.or(
    quotedOrClause("hr_id", "ilike", normalized) +
      (canonical && canonical !== normalized ? `,${quotedOrClause("hr_id", "ilike", canonical)}` : ""),
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

/**
 * The access filter's SECOND half (audit 2026-10-26, L10): the rows a scoped read returned, narrowed
 * again in memory to the viewer's allowed HR ids.
 *
 * These reads may run on the service-role client (`rowSecurityClientFor`: a biometric or
 * skip-bridge sign-in has no Supabase session), where nothing but the query's own `.or(ilike …)`
 * stood between a scoped viewer and every row — one regression in that filter, or an allowed id
 * that normalises to nothing (`applyHrIdInFilter` then returns the query UNFILTERED), and it failed
 * open. This check fails closed instead.
 *
 * It never drops a row the query was meant to return: the query matches with `ilike` on exactly the
 * forms `buildHrIdFilters` produces, which is case-insensitive equality, and a row is kept when its
 * stored id lower-cased, or either normalised form of it, is one of those forms.
 */
export function keepExpenseRowsInScope<T extends Record<string, unknown>>(
  rows: T[],
  accessFilter: ExpenseAccessFilter,
  column: "hr_id" | "employee_hr_id",
): T[] {
  if (accessFilter.all) return rows;
  const allowed = new Set(
    buildHrIdFilters(Array.from(accessFilter.allowedHrIds)).map((id) => id.toLowerCase()),
  );
  if (allowed.size === 0) return [];
  return rows.filter((row) => {
    const stored = String(row[column] ?? "");
    return [stored.trim().toLowerCase(), normalizeHrId(stored), normalizeHrIdForAccess(stored)].some(
      (id) => Boolean(id) && allowed.has(String(id).toLowerCase()),
    );
  });
}

// outstation_expenses only has hr_id — do NOT reference employee_hr_id or employee_code
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

  const ors = normalized.map((id) => quotedOrClause("hr_id", "ilike", id)).join(",");

  return query.or(ors);
}

// Exported for the phase-2 read path (claims-read.ts), which reads `expense_claims` — that table
// keys on employee_hr_id, so this is the correct helper and applyHrIdInFilter (hr_id) is NOT.
// Shared rather than copied because outstation visibility is application-scoped, not RLS-scoped:
// a second, drifting copy of the scope rule is how a manager ends up seeing another line's claims.
export function applyEmployeeHrIdInFilter<T extends { or: (value: string) => T }>(
  query: T,
  hrIds: string[],
) {
  const normalized = buildHrIdFilters(hrIds);
  if (normalized.length === 0) return query;

  return query.or(normalized.map((id) => quotedOrClause("employee_hr_id", "ilike", id)).join(","));
}

export async function listPayrollExpenseReports(accessContext: AccessContext) {
  const supabase = await rowSecurityClientFor("outstation.listPayrollExpenseReports");
  const accessFilter = await resolveExpenseAccessFilter(accessContext);

  if (accessFilter.all) {
    const { data, error } = await fetchAllRows((from, to) =>
      supabase
        .from("outstation_expense_reports")
        .select("*")
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    );

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

  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — a national manager's hierarchy chain can reach that scale.
  const reportIds = Array.from(visibleReportIds);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < reportIds.length; i += 100) {
    const batch = reportIds.slice(i, i + 100);
    const { data, error } = await supabase
      .from("outstation_expense_reports")
      .select("*")
      .in("id", batch);

    if (error) {
      if (isPayrollExpensesSchemaMissing(error)) return [];
      throw error;
    }
    rows.push(...((data ?? []) as Record<string, unknown>[]));
  }
  rows.sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));

  return rows
    .filter((row) => !isDisposableExpenseReportRow(row))
    .map((row) => mapExpenseReport(row));
}

/**
 * Replace the stored `rowCount`/`totalExpenses`/`approvedRows` header on each report with its LIVE
 * totals, so an emptied report reads 0/0/0 and can never be mistaken for the one that still holds
 * the ledger. See `applyLiveExpenseReportCounts` for why the header goes stale. Only the admin
 * "Historical Outstation Uploads" route calls this; every other reader keeps the header, so the
 * change is confined to the one screen whose Delete button makes the confusion a data-loss trap.
 * The reports passed in are already access-scoped by `listPayrollExpenseReports`, so counting only
 * their ids reads nothing the caller may not see.
 */
export async function withLiveExpenseReportCounts(
  reports: PayrollExpenseReport[],
): Promise<PayrollExpenseReport[]> {
  if (reports.length === 0) return reports;

  const supabase = await rowSecurityClientFor("outstation.withLiveExpenseReportCounts");
  const reportIds = reports.map((report) => report.id).filter(Boolean);
  const rows: Record<string, unknown>[] = [];

  // Batch the ids at 100 for the same URL-header reason listPayrollExpenseReports does, and page
  // each batch (a single report can hold hundreds of rows) with a stable order so no row is counted
  // twice or missed.
  for (let i = 0; i < reportIds.length; i += 100) {
    const batch = reportIds.slice(i, i + 100);
    const { data, error } = await fetchAllRows((from, to) =>
      supabase
        .from("outstation_expenses")
        .select("report_id,total,hr_approved")
        .in("report_id", batch)
        .order("id", { ascending: true })
        .range(from, to),
    );

    if (error) {
      // A missing schema is the same "return what we have" signal listPayrollExpenseReports uses; the
      // reports keep their stored header rather than the whole screen failing.
      if (isPayrollExpensesSchemaMissing(error)) return reports;
      throw error;
    }

    rows.push(...((data ?? []) as Record<string, unknown>[]));
  }

  return applyLiveExpenseReportCounts(reports, rows);
}

export async function listPayrollExpenses(
  month: number | undefined,
  year: number | undefined,
  reportId: string | undefined,
  accessContext: AccessContext,
) {
  const accessFilter = await resolveExpenseAccessFilter(accessContext);
  const supabase = await rowSecurityClientFor("outstation.listPayrollExpenses");
  const allowedHrIds = Array.from(accessFilter.allowedHrIds);
  if (!accessFilter.all && allowedHrIds.length === 0) return [];

  // Rebuilt per page rather than built once: a PostgREST builder is consumed when it is awaited.
  const buildQuery = () => {
    let query = supabase
      .from("outstation_expenses")
      .select("*")
      .order("expense_date", { ascending: false })
      // Tiebreaker — `expense_date` repeats heavily (a whole team's trips share a day).
      .order("id", { ascending: true });

    if (!accessFilter.all) {
      query = applyHrIdInFilter(query, allowedHrIds);
    }

    if (month && year) {
      query = query.eq("payout_month", month).eq("payout_year", year);
    }

    if (reportId) {
      query = query.eq("report_id", reportId);
    }

    return query;
  };

  const { data, error } = await fetchAllRows((from, to) => buildQuery().range(from, to));

  if (error) {
    if (isPayrollExpensesSchemaMissing(error)) return [];
    throw error;
  }

  return keepExpenseRowsInScope((data ?? []) as Array<Record<string, unknown>>, accessFilter, "hr_id")
    .filter((row) => !isDisposableExpenseRow(row))
    .map((row) => mapExpense(row));
}

export async function listOutstationRequestExpenses(
  accessContext: AccessContext,
) {
  const accessFilter = await resolveExpenseAccessFilter(accessContext);
  const supabase = await rowSecurityClientFor("outstation.listOutstationRequestExpenses");
  const allowedHrIds = Array.from(accessFilter.allowedHrIds);
  if (!accessFilter.all && allowedHrIds.length === 0) return [];

  const buildQuery = () => {
    let query = supabase
      .from("outstation_expense_requests")
      .select("*")
      .order("created_at", { ascending: false })
      // Tiebreaker — several requests are submitted in the same second by the same sync.
      .order("id", { ascending: true });

    if (!accessFilter.all) {
      query = applyEmployeeHrIdInFilter(query, allowedHrIds);
    }

    return query;
  };

  const { data, error } = await fetchAllRows((from, to) => buildQuery().range(from, to));
  if (error) {
    if (isOutstationRequestsSchemaMissing(error)) return [];
    throw error;
  }

  const mapped = keepExpenseRowsInScope((data ?? []) as Array<Record<string, unknown>>, accessFilter, "employee_hr_id").map(
    mapOutstationRequestRowToPayrollApproval,
  );
  // Brick / area / region per row, so the approvals decision panel can show a place name
  // instead of the raw coordinate pair — same enrichment service.ts already does for the
  // admin request detail. One cached centroid load for the whole list either way.
  return Promise.all(
    mapped.map(async (expense) => ({
      ...expense,
      capturedLocation: await resolveOutstationCapturedLocation({
        latitude: expense.capturedLatitude,
        longitude: expense.capturedLongitude,
      }),
    })),
  );
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

/**
 * Carries HR's stored decision back onto the request row that shadows it.
 *
 * `outstation_expense_requests` has no `approved_amount` column — a Phoenix-submitted request keeps
 * HR's trimmed figure on its LINKED `outstation_expenses` row instead. That linked row is exactly
 * the one `dedupeHistoricalExpensesByTrip` is about to drop, so without this the queue reloads
 * showing the employee's full claim again and the deduction silently disappears from the screen
 * (it stays in the database and still reaches payroll, which is the worse half of the bug).
 *
 * The request row stays authoritative for everything else — status above all. Only the two fields
 * it cannot store itself are taken, and `hrComment` only when the request has none of its own, so a
 * rejection reason written on the request is never overwritten by an older expense-row comment.
 */
export function carryStoredDecisionOntoRequestExpenses<
  T extends { approvedAmount: number | null; hrComment: string; tripId: string },
>(
  live: T[],
  historical: ReadonlyArray<{ approvedAmount: number | null; hrComment: string; tripId: string }>,
): T[] {
  const storedByTrip = new Map(historical.map((expense) => [expense.tripId, expense]));
  return live.map((expense) => {
    const stored = storedByTrip.get(expense.tripId);
    if (!stored) return expense;
    return {
      ...expense,
      approvedAmount: expense.approvedAmount ?? stored.approvedAmount,
      hrComment: expense.hrComment?.trim() ? expense.hrComment : stored.hrComment,
    };
  });
}

/**
 * Show the employee's CURRENT record name on rows that were written with an older one.
 *
 * `specialist` is a snapshot: both sources freeze the name at write time, so a correction to the
 * employee record never travels backwards into rows already stored. One cached directory read
 * covers the whole list, and a row whose HR id the directory does not know — an imported historical
 * trip carrying only a name — keeps exactly what it was stored with.
 *
 * READ-SIDE ONLY. Nothing here writes: the stored column stays the record of what the row was
 * created with. This is also deliberately not a money path — the two readers that decide what
 * payroll actually PAYS (recommend.ts and getApprovedExpenseTotalsForPayroll) read
 * `outstation_expenses` directly and are untouched, exactly as the phase-2 note below says.
 *
 * NOT APPLIED ON THE `readLegacyTables` PATH, and that is the point of the exclusion. The Expense
 * Approvals screen posts back the rows it read, and the payload writes `specialist` — so resolving
 * there would quietly rewrite the stored label of every row in the report on the next Save,
 * imported pre-July history included. An editor reads the table it edits.
 */
async function withLiveSpecialistNames<T extends { hrId?: string | null; specialist: string }>(
  expenses: T[],
): Promise<T[]> {
  return withLiveOutstationEmployeeNames(
    expenses,
    (expense) => ({ hrId: expense.hrId, storedName: expense.specialist }),
    (expense, specialist) => ({ ...expense, specialist }),
  );
}

export async function listUnifiedOutstationExpenses(
  month: number | undefined,
  year: number | undefined,
  reportId: string | undefined,
  accessContext: AccessContext,
  options: {
    /**
     * Read the legacy tables even when the `expense_claims` mirror is switched on — for the Expense
     * Approvals screen, which WRITES to those tables and must read back what it just wrote.
     *
     * Served from the mirror, that screen showed a decision undone after every Save (2026-09-18:
     * two trips approved at 22:57 Cairo came back Pending, because the mirror was last rebuilt at
     * 22:51). Worse, the mirror carries no report id, no workload and no route, and Save posts the
     * rows it read — so each Save re-stamped every imported trip onto a brand-new report and wrote
     * the mirror's blanks over the originals. An editor has to read the table it edits.
     */
    readLegacyTables?: boolean;
  } = {},
) {
  // ── PHASE 2 read switch (OFF by default) ───────────────────────────────────────────────────
  // `expense_claims` already holds the same trips this union produces, and
  // `v_expense_claims_parity` proves the two agree row by row. When PHOENIX_EXPENSE_CLAIMS_READ
  // is set, read the ONE table instead of unioning two and deduping.
  //
  // Deliberately NOT on a money path. The two paths that decide what payroll actually PAYS read
  // `outstation_expenses` directly and are untouched here:
  //   - src/lib/automated-payroll/recommend.ts  (the wizard's Expenses step)
  //   - getApprovedExpenseTotalsForPayroll      (the payroll template pre-fill)
  // Flipping this flag changes what an approver SEES, never what an employee is PAID. Those two
  // move in a later, separately reviewable step.
  //
  // Dynamic import, not static: claims-read.ts imports resolveExpenseAccessFilter and
  // applyEmployeeHrIdInFilter from THIS file, so a static import would close a module cycle.
  //
  // `reportId` stays on the legacy path on purpose. It scopes to an `outstation_expense_reports`
  // row, and 36 of those 38 are the synthetic `.workflow` artefacts the new model deliberately
  // does not reproduce — `expense_claims.import_id` points only at the 2 real uploads. Serving a
  // report-scoped read from the new model would quietly return a different set, which is exactly
  // the divergence this phase exists to rule out.
  //
  // THE FLAG IS CHECKED BEFORE THE IMPORT, NOT AFTER. It used to be the other way round, which
  // meant every call with no reportId loaded `claims-read.ts` whether the flag was on or off —
  // making the default-OFF path do new work at runtime that the default-off promise said it would
  // not. `expenseClaimsReadEnabled` therefore lives in `claims-read-flag.ts`, which imports
  // nothing, so asking the question costs nothing and pulls in nothing.
  //
  // An editor that asked for the legacy tables never reaches the switch at all (see
  // `readLegacyTables`). The guard line inside is pinned verbatim by
  // tests/outstation-claims-read-flag.test.ts, so this condition wraps it rather than joining it.
  if (!options.readLegacyTables) {
    if (!reportId && expenseClaimsReadEnabled()) {
      const { listExpenseClaims } = await import("@/lib/outstation/claims-read");
      return withLiveSpecialistNames(await listExpenseClaims(month, year, accessContext));
    }
  }

  const [historicalExpenses, requestExpenses] = await Promise.all([
    listPayrollExpenses(month, year, reportId, accessContext),
    listOutstationRequestExpenses(accessContext),
  ]);
  const filteredRequestExpenses = reportId
    ? []
    : month && year
    ? requestExpenses.filter((expense) => expense.payoutMonth === month && expense.payoutYear === year)
    : requestExpenses;
  // Enrich BEFORE the dedup: the row being read from is the row about to be dropped.
  const enrichedRequestExpenses = carryStoredDecisionOntoRequestExpenses(
    filteredRequestExpenses,
    historicalExpenses,
  );
  const dedupedHistoricalExpenses = dedupeHistoricalExpensesByTrip(
    historicalExpenses,
    enrichedRequestExpenses,
  );

  const unified = [...enrichedRequestExpenses, ...dedupedHistoricalExpenses].sort((left, right) => {
    const leftTime = left.date ? new Date(left.date).getTime() : 0;
    const rightTime = right.date ? new Date(right.date).getTime() : 0;
    return rightTime - leftTime;
  });

  // See withLiveSpecialistNames: the editor path keeps the stored labels, because its Save writes
  // back what it read.
  return options.readLegacyTables ? unified : withLiveSpecialistNames(unified);
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
  // The file name is half of the workflow-report test: an empty workflow report has no rows to read.
  const { data: report, error: reportError } = await getSupabaseAdmin()
    .from("outstation_expense_reports")
    .select("file_name")
    .eq("id", reportId)
    .maybeSingle();

  if (reportError) throw reportError;

  // Paged because this is a LOCK, and it is read with `.some()`. A truncated read cannot report a
  // false lock, only a missing one — so past 1,000 rows this would quietly permit deleting or
  // replacing a report whose later rows are already in a paid payroll batch. `trip_id` is the other
  // half of the workflow-report test, and `hr_id`/`specialist` name the people in its refusal.
  const { data, error } = await fetchAllRows((from, to) =>
    getSupabaseAdmin()
      .from("outstation_expenses")
      .select("id,hr_approved,hr_id,imported_payroll_batch_id,imported_to_payroll_at,specialist,status,trip_id")
      .eq("report_id", reportId)
      .order("id", { ascending: true })
      .range(from, to),
  );

  if (error) {
    if (isPayrollExpenseLockSchemaMissing(error)) {
      throw new PayrollExpenseLockSchemaError();
    }
    throw error;
  }

  // An app trip's payroll report is refused FIRST, for every role: the Super Admin bypass below is
  // for a paid historical upload, never for an app trip. See workflow-expense-report-guard.ts.
  const plan = planExpenseReportMutation({
    bypassPaidLock: canBypassPayrollExpenseLocks(accessContext),
    fileName: (report as { file_name?: unknown } | null)?.file_name,
    rows: (data ?? []) as Array<Record<string, unknown>>,
  });

  if (plan.outcome === "workflow_report") {
    const named = await withLiveOutstationEmployeeNames(
      plan.appTripRows,
      (row) => ({ hrId: row.hr_id ? String(row.hr_id) : null, storedName: String(row.specialist ?? "") }),
      (row, specialist) => ({ ...row, specialist }),
    );
    throw new WorkflowExpenseReportProtectedError(
      action,
      named.map((row) => String(row.specialist ?? "")),
      plan.appTripRows.length,
    );
  }

  if (plan.outcome === "paid") {
    throw new PayrollExpenseReportLockedError(action);
  }

  if (plan.transitionFrom === null) {
    return;
  }

  await assertOutstationExpenseWorkflowTransition({
    access: accessContext,
    actionKey: "delete_before_payroll",
    expectedNextStatus: "deleted",
    status: plan.transitionFrom,
  });
}

export async function deletePayrollExpenseReport(reportId: string, accessContext: AccessContext) {
  await assertPayrollExpenseReportCanMutate(reportId, "deleted", accessContext);

  const supabase = getSupabaseAdmin();
  const { error: rowsError } = await supabase
    .from("outstation_expenses")
    .delete()
    .eq("report_id", reportId);

  if (rowsError) throw rowsError;

  const { error: reportError } = await supabase
    .from("outstation_expense_reports")
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
    .from("outstation_expenses")
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
  const supabase = await rowSecurityClientFor("outstation.getApprovedExpenseTotalsForPayroll");
  const allowedHrIds = Array.from(accessFilter.allowedHrIds);
  if (!accessFilter.all && allowedHrIds.length === 0) return new Map<string, number>();

  // THIS ONE IS MONEY. It pre-fills what payroll reimburses, so a silent truncation here does not
  // make a screen look short — it pays people less than they are owed, with nothing to notice.
  const buildQuery = () => {
    let query = supabase
      .from("outstation_expenses")
      .select("hr_id,total,approved_amount,hr_approved,payout_year,trip_id,source_file_name,specialist,description")
      .eq("payout_month", month)
      .eq("payout_year", year)
      .eq("hr_approved", true)
      .order("id", { ascending: true });

    if (!accessFilter.all) {
      query = applyHrIdInFilter(query, allowedHrIds);
    }

    return query;
  };

  const { data, error } = await fetchAllRows((from, to) => buildQuery().range(from, to));

  if (error) {
    if (isPayrollExpensesSchemaMissing(error)) return new Map<string, number>();
    throw error;
  }

  const totals = new Map<string, number>();
  keepExpenseRowsInScope((data ?? []) as Array<Record<string, unknown>>, accessFilter, "hr_id")
    .filter((row) => !isDisposableExpenseRow(row))
    .forEach((row) => {
      const hrId = String(row.hr_id ?? "").trim();
      if (!hrId) return;
      const payable = payableExpenseAmount(
        row.approved_amount as number | null | undefined,
        row.total as number | null | undefined,
      );
      totals.set(hrId, (totals.get(hrId) ?? 0) + payable);
    });

  return totals;
}

export async function savePayrollExpenseApprovals(input: {
  fileName: string;
  records: Array<ExpenseTripRecord & {
    approvedAmount?: number | null;
    hrId?: string | null;
    hrApproved?: boolean;
    hrComment?: string;
    /**
     * True = this save re-pushes a trip's own figures and must not touch the HR decision already
     * on the row (the outstation workflow). Absent/false = this save IS the decision (the Expense
     * Approvals screen). See resolveExpenseDecisionWrite.
     */
    preserveExistingDecision?: boolean;
    reportId?: string | null;
  }>;
  reportId?: string | null;
}, accessContext: AccessContext, options?: {
  /**
   * True ONLY for the outstation workflow's own push of an app trip (service.ts). An
   * `OUTSTATION-<n>` row is that trip's payroll record, and this save upserts on `trip_id`, so any
   * other caller carrying one would overwrite the trip's money and workload. Never set it from a
   * route. See workflow-trip-id-guard.ts.
   */
  allowWorkflowTripIds?: boolean;
  /**
   * True ONLY for the Expense Approvals decision-save (POST /api/admin/outstation/expenses). That
   * screen decides an already-imported trip; it never edits a trip's workload, Other or claimed
   * total, and its Save posts those columns back exactly as it loaded them. So for a trip that
   * already exists, this save writes the STORED workload (AM · PM · Pharmacies), Other and total,
   * not whatever the request carried — a hand-built POST cannot re-import the Expense Approvals
   * download's own shape (workload → 0, Other dropped) onto a historical trip through this route,
   * the way a file upload was refused in expense-import.ts. The file import (analyze / replace) and
   * the workflow push leave this off, because setting those columns from the file IS their job.
   */
  preserveImportedValues?: boolean;
  /** Receives what the payroll resync did, so the save can say when a decision did NOT reach payroll (audit finding 47). */
  onPayrollResync?: (outcomes: ExpenseResyncOutcome[]) => void;
  /**
   * True for the two SPREADSHEET UPLOAD routes (analyze + report replace). An upload re-imports a
   * sheet's trip data; the importer's rows carry no `hrApproved`, `approvedAmount` or `hrComment`,
   * so without this every existing trip in the file has its HR decision reset — hr_approved back to
   * false, approved_amount to NULL, the approver and reason cleared — and payroll re-pays the full
   * claim once the trip is re-approved. It is also the hole that made the review screen's own
   * download impossible to re-upload safely. So an upload preserves whatever HR already decided on a
   * row it overwrites, exactly like the workflow's figures-only re-push, and a sheet's Status column
   * can NEVER approve a trip. See resolveExpenseDecisionWrite / imported-history.ts.
   */
  preserveStoredDecisions?: boolean;
  /**
   * Report id to CLEAR before the upsert — the report-replace route. The clear must run AFTER this
   * save has read the rows it is about to overwrite, or the stored decisions it exists to preserve
   * are already deleted when it looks (the replace route used to clear first, which is why a replace
   * dropped every HR decision even with preservation on). Kept inside the save so read-then-clear is
   * ordered by construction, not by two calls a route could reorder.
   */
  replaceReportRowsFirst?: string;
}) {
  // FIRST, before any read and before the report row is minted: a refusal here writes nothing.
  if (!options?.allowWorkflowTripIds) {
    assertNoWorkflowTripIds(input.records);
  }

  // A spreadsheet upload is never an HR decision — see `preserveStoredDecisions` above. Applied per
  // record so the workflow's own `preserveExistingDecision: true` still wins even without the option.
  const preserveStoredDecisions = options?.preserveStoredDecisions === true;
  const recordPreservesDecision = (record: { preserveExistingDecision?: boolean }) =>
    preserveStoredDecisions || Boolean(record.preserveExistingDecision);

  // WHO APPROVED IT - and this column does NOT hold only people.
  //
  // `outstation_expenses.approved_by` feeds `expense_claims.decided_by_hr_id` through
  // phx_refresh_expense_claims, which is the screen that answers "who decided this claim".
  // Three different kinds of value legitimately live here, measured on production 2026-09-05:
  //
  //   b-10          71 rows   a real HR id, stored as the LOWERCASE comparison key - the bug
  //   system        15 rows   a marker: no session decided this, the workflow did
  //   dev.preview    1 row    a login id with no employees row behind it
  //
  // So ONLY the HR-id branch is canonicalised. Running the whole expression through
  // hrIdForStorage would write SYSTEM and DEV.PREVIEW, and the claims screen would then show
  // a shouty non-person in the decided-by column - a regression dressed as a repair.
  //
  // The chain is otherwise unchanged: hr id, else the normalised login id, else the marker.
  // The column name is why this one hid so long - it does not end in `_hr_id`, so the
  // repo-wide raw-write sweep in tests/hr-id-storage-casing.test.ts cannot see it by shape.
  const approvedBy =
    hrIdForStorage(accessContext.hrId)
    ?? resolveEmployeeIdentityId(accessContext)
    ?? accessContext.loginId
    ?? "system";
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();

  // Read BEFORE the gate, not just before the write: what a record ends up writing to the
  // decision columns depends on what is already stored, and so does whether this save is an
  // approval decision at all. `before` doubles as the resync diff's left-hand side, so the two
  // reads this used to need are one.
  const existingRows = await readExistingExpenseRows(
    supabase,
    input.records.map((record) => String(record.tripId ?? "")).filter(Boolean),
  );
  const storedByTripId = new Map(
    existingRows.map((row) => [String(row.trip_id ?? ""), toStoredExpenseDecision(row)] as const),
  );
  // The import-set figures each existing trip already carries. Read only for `preserveImportedValues`:
  // a decision-save writes these back unchanged so nothing but the HR decision can move on this route.
  const storedImportByTripId = new Map(
    existingRows.map((row) => [String(row.trip_id ?? ""), toStoredImportValues(row)] as const),
  );
  const before = existingRows.map(toExpenseDecisionSnapshot);

  // Report-replace clears the report's rows here, AFTER the read above — so a trip kept in the new
  // file has already had its stored decision captured into `storedByTripId`, and the preserve step
  // below writes it straight back. A trip dropped from the new file is not in `input.records`, was
  // not read, and stays deleted. See `replaceReportRowsFirst`.
  if (options?.replaceReportRowsFirst) {
    await clearPayrollExpenseReportRows(options.replaceReportRowsFirst, accessContext);
  }

  // IMPORTED HISTORY IS VALUES ONLY — owner ruling 2026-09-12, see imported-history.ts. Enforced
  // here as well as on the screen, so the rule does not rest on a hidden button. A trip dated before
  // July 2026 whose decision this save would CHANGE is refused before anything is written; one that is
  // merely carried along in its report's record set keeps its stored decision exactly, instead of
  // being re-stamped with today's approver. The workflow's own re-push already preserves, so it is
  // left out of the check.
  const importedHistory = planImportedHistoryWrites({
    records: input.records
      .filter((record) => !recordPreservesDecision(record))
      .map((record) => ({
        approvedAmount: record.approvedAmount,
        date: record.date,
        hrApproved: record.hrApproved,
        hrComment: record.hrComment,
        specialist: record.specialist,
        status: record.status,
        total: record.total,
        tripId: String(record.tripId ?? ""),
      })),
    storedByTripId,
  });
  if (importedHistory.refused.length > 0) {
    throw new Error(describeImportedHistoryRefusal(importedHistory.refused));
  }

  // Index-aligned with input.records, so the payload below cannot miss one.
  const decisions: ExpenseDecisionWrite[] = input.records.map((record) =>
    resolveExpenseDecisionWrite({
      approvedBy,
      claimedTotal: record.total,
      incoming: {
        approvedAmount: record.approvedAmount,
        hrApproved: record.hrApproved,
        hrComment: record.hrComment,
        hrStatus: record.hr,
        status: record.status,
      },
      now,
      preserveExistingDecision:
        recordPreservesDecision(record) || importedHistory.preserveTripIds.has(String(record.tripId ?? "")),
      stored: storedByTripId.get(String(record.tripId ?? "")) ?? null,
    }),
  );

  // Gated on what this save actually DECIDES, not on what the records happen to carry. A
  // carry-forward writes the stored decision back unchanged and exercises no approval authority,
  // which is what lets an employee add a ticket to their own accepted trip without holding the
  // HR Manager rights the approvals screen needs.
  const hasManualPayrollApprovals = decisions.some((decision) => decision.decidesApproval);
  if (hasManualPayrollApprovals) {
    // BEFORE the permission check, not after: a dev-preview session can hold any role it likes,
    // so every check below would pass for it. On 2026-09-03 one approved a real 383.62 expense on
    // production and the claims screen then named `dev.preview` as the decider. The guard carries
    // no environment term on purpose - see preview-session-guard.ts for why an
    // isProductionRuntime() check would have waved this exact caller through.
    assertRealSessionForDecision(accessContext, "approve an outstation expense");
    await assertManualPayrollExpenseApprovalAccess(accessContext);
    await assertOutstationExpenseWorkflowTransition({
      access: accessContext,
      actionKey: "approve",
      expectedNextStatus: "approved",
      status: "pending",
    });
  }

  const employeeByName = await employeeCodeBySpecialist();
  const reportTotals = input.records.reduce(
    (summary, record, index) => {
      const date = record.date ? new Date(record.date) : null;
      // The resolved decision, not the record: on a carry-forward the record still says
      // "Approved" while the row it writes stays rejected, and counting the record would make the
      // report header disagree with its own rows.
      summary.approvedRows += decisions[index].hrApproved ? 1 : 0;
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
      .from("outstation_expense_reports")
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
      .from("outstation_expense_reports")
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

  const payload = input.records.map((record, index) => {
    const period = nextPayrollPeriod(record.date);
    const hrId =
      record.hrId?.trim() ||
      employeeNameKeys(record.specialist)
        .map((key) => employeeByName.get(key))
        .find(Boolean) ||
      null;
    // Every decision column comes from the one resolver above, so a workflow re-push cannot write
    // half a decision. `total` below still carries the employee's claim, so reducing a claim stays
    // auditable instead of overwriting the evidence.
    const decision = decisions[index];

    // On the Expense Approvals decision-save, a trip that already exists keeps its STORED workload,
    // Other and claimed total — the screen never edits those, so a request that carries different
    // ones is not a decision but an attempt to re-import over a historical trip. New trips (no stored
    // row) are written as sent, since there is nothing yet to protect. See resolveExpenseImportWrite.
    const importWrite = resolveExpenseImportWrite({
      preserve: Boolean(options?.preserveImportedValues),
      record,
      stored: storedImportByTripId.get(String(record.tripId ?? "")) ?? null,
    });

    return {
      allowance: record.allowance,
      am_workload: importWrite.amWorkload,
      approved_amount: decision.approvedAmount,
      approved_at: decision.approvedAt,
      approved_by: decision.approvedBy,
      description: record.description,
      hr_id: hrId,
      expense_date: record.date || null,
      from_location: record.from,
      hr_approved: decision.hrApproved,
      hr_comment: decision.hrComment,
      hr_notes: record.hrNotes,
      hr_status: decision.hrStatus,
      km: record.km,
      location: record.location,
      meeting_amount: record.meetingAmount,
      other_amount: importWrite.other,
      payout_month: period.month,
      payout_year: period.year,
      // AM · PM · Pharmacies. An Excel row carries the third figure from its Pharmacy Workload column;
      // a blank cell, or an older sheet without that column, writes NULL (not counted separately), never 0.
      pharmacy_workload: importWrite.pharmacyWorkload,
      pm_workload: importWrite.pmWorkload,
      request_type: record.requestType,
      report_id: reportId,
      source_file_name: input.fileName,
      source_row: record.row,
      specialist: record.specialist,
      status: decision.status,
      to_date: record.toDate || null,
      to_location: record.to,
      total: importWrite.total,
      transportation_type: record.transportationType,
      travel_cost: record.travelCost,
      trip_id: record.tripId,
      trip_type: record.tripType,
      updated_at: now,
    };
  });

  // `before` was read at the top of this function, so the resync below is limited to the rows
  // this save actually moved. This screen submits a report's full record set on every save, so
  // without the diff one save would clear a hand-typed wizard figure for every employee in the
  // report — including the ones nobody looked at.
  // Chunked because the WRITE is not capped but the RETURNED representation is. A single upsert of
  // more than 1,000 rows would write them all and hand back only the first 1,000 — and `data` is
  // both what the screen re-renders from AND the right-hand side of the resync diff below, so the
  // rows past the cap would be written to the database and then silently left out of any open
  // payroll run. Below 1,000 rows this is exactly one request, identical to before; the largest
  // report in production held 327 on 2026-09-08.
  const written: Array<Record<string, unknown>> = [];
  for (let start = 0; start < payload.length; start += UPSERT_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from("outstation_expenses")
      .upsert(payload.slice(start, start + UPSERT_CHUNK_SIZE), { onConflict: "trip_id" })
      .select("*");

    if (error) throw error;
    written.push(...((data ?? []) as Array<Record<string, unknown>>));
  }

  const saved = written.map((row) => mapExpense(row));

  // A confirmed payroll Expenses step is a frozen snapshot and will otherwise keep paying the
  // figures it was confirmed with — see expense-resync.ts for the July 2026 run this cost.
  const payrollResync = await resyncPayrollExpenseStepForRows(
    before,
    written.map((row) => toExpenseDecisionSnapshot(row)),
  );
  options?.onPayrollResync?.(payrollResync);

  invalidateExecutiveDashboardCache("expense approvals saved", ["expenses", "payroll"]);
  return saved;
}

/** Row shape the expense→payroll resync diffs on. Kept narrow: this runs on every approval save. */
const EXPENSE_DECISION_COLUMNS =
  "trip_id,hr_id,total,approved_amount,hr_approved,status,payout_month,payout_year";

function toExpenseDecisionSnapshot(row: Record<string, unknown>): ExpenseDecisionSnapshot {
  const numberOrNull = (value: unknown) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    approvedAmount: numberOrNull(row.approved_amount),
    hrApproved: row.hr_approved === true,
    hrId: row.hr_id == null ? null : String(row.hr_id),
    payoutMonth: numberOrNull(row.payout_month),
    payoutYear: numberOrNull(row.payout_year),
    status: row.status == null ? null : String(row.status),
    total: numberOrNull(row.total),
    tripId: String(row.trip_id ?? ""),
  };
}

/**
 * The decision columns a carry-forward needs on top of the resync diff's own set: the reason HR
 * gave, the label they left, and who signed it off. Reading the diff columns without these is how
 * an amount survives a re-push while the reason behind it silently reverts.
 */
// The workload trio and Other join the read so `preserveImportedValues` can write a trip's STORED
// figures back on a decision-save. `total` already rides in EXPENSE_DECISION_COLUMNS.
const EXPENSE_PRESERVED_IMPORT_COLUMNS = "am_workload,pm_workload,pharmacy_workload,other_amount";
const EXPENSE_CARRY_FORWARD_COLUMNS =
  `${EXPENSE_DECISION_COLUMNS},approved_at,approved_by,hr_comment,hr_status,${EXPENSE_PRESERVED_IMPORT_COLUMNS}`;

/** The import-set figures a save writes to `outstation_expenses`, and preserves on a decision-save. */
export type ExpenseImportValues = {
  amWorkload: number | null;
  other: number;
  pharmacyWorkload: number | null;
  pmWorkload: number | null;
  total: number;
};

/**
 * The import-set figures a stored trip already carries, read back for `preserveImportedValues`. A
 * blank workload cell is NULL, never 0 — the AM · PM · Pharmacies rule (a 0 would claim none were
 * visited); a missing money cell is 0. Written back verbatim, so a decision-save never re-imports
 * a trip's workload or Other from the request body.
 */
function toStoredImportValues(row: Record<string, unknown>): ExpenseImportValues {
  const intOrNull = (value: unknown) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const moneyOrZero = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    amWorkload: intOrNull(row.am_workload),
    other: moneyOrZero(row.other_amount),
    pharmacyWorkload: intOrNull(row.pharmacy_workload),
    pmWorkload: intOrNull(row.pm_workload),
    total: moneyOrZero(row.total),
  };
}

/**
 * The import-set figures ONE upsert writes. Pure, so the guard can be tested without a database.
 *
 * On a decision-save (`preserve`) with a trip that ALREADY exists (`stored`), the stored figures win
 * over whatever the request carried — the Expense Approvals screen never edits a trip's workload,
 * Other or claimed total, so a body that differs is not a decision but an attempt to re-import over a
 * historical trip (the download vector, expense-import.ts). Every other case — a file import, a
 * workflow push, or a brand-new trip with nothing stored to protect — writes the record's own values.
 */
export function resolveExpenseImportWrite(input: {
  preserve: boolean;
  record: { amWorkload: number; other: number; pharmacyWorkload?: number | null; pmWorkload: number; total: number };
  stored: ExpenseImportValues | null;
}): ExpenseImportValues {
  if (input.preserve && input.stored) return input.stored;
  return {
    amWorkload: input.record.amWorkload,
    other: input.record.other,
    pharmacyWorkload: input.record.pharmacyWorkload ?? null,
    pmWorkload: input.record.pmWorkload,
    total: input.record.total,
  };
}

function toStoredExpenseDecision(row: Record<string, unknown>): StoredExpenseDecision {
  const approvedAmount = Number(row.approved_amount);
  return {
    approvedAmount:
      row.approved_amount === null ||
      row.approved_amount === undefined ||
      !Number.isFinite(approvedAmount)
        ? null
        : approvedAmount,
    approvedAt: row.approved_at == null ? null : String(row.approved_at),
    approvedBy: row.approved_by == null ? null : String(row.approved_by),
    hrApproved: row.hr_approved === true,
    hrComment: String(row.hr_comment ?? ""),
    hrStatus: String(row.hr_status ?? ""),
    status: String(row.status ?? ""),
  };
}

/**
 * Best-effort read of the rows a save is about to write. Returns an empty list on a missing-schema
 * error so the save the user actually asked for still lands (the resync then degrades to "resync
 * nothing we can prove changed", and a carry-forward degrades to today's overwrite rather than
 * failing outright).
 */
async function readExistingExpenseRows(
  supabase: SupabaseClient,
  tripIds: string[],
): Promise<Array<Record<string, unknown>>> {
  if (tripIds.length === 0) return [];
  // Chunked because a PostgREST `.in()` carrying a few hundred ids comes back EMPTY with no
  // error, and an empty read here reads as "no row exists yet" — which would turn a carry-forward
  // back into the overwrite it exists to prevent, on the biggest saves only.
  const rows: Array<Record<string, unknown>> = [];
  for (let start = 0; start < tripIds.length; start += 50) {
    const { data, error } = await supabase
      .from("outstation_expenses")
      .select(EXPENSE_CARRY_FORWARD_COLUMNS)
      .in("trip_id", tripIds.slice(start, start + 50));
    if (error) {
      if (isPayrollExpensesSchemaMissing(error)) return [];
      throw error;
    }
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  return rows;
}

/**
 * Push a changed expense decision into any open payroll run for its payout period.
 *
 * Never throws — the decision has already been written and is what the user asked for; a resync
 * failure must not roll it back or read as "save failed". resyncPayrollExpenseStep already logs.
 */
async function resyncPayrollExpenseStepForRows(
  before: ExpenseDecisionSnapshot[],
  after: ExpenseDecisionSnapshot[],
): Promise<ExpenseResyncOutcome[]> {
  try {
    const target = expenseDecisionsThatChanged(before, after);
    // Returned, not discarded: a skip because Part 2 is already confirmed means the decision did not
    // reach payroll, and only the caller can say so to the person saving (audit finding 47).
    return await resyncPayrollExpenseStep(target);
  } catch (error) {
    logError("Outstation: payroll expense resync could not run after an approval save", {
      labels: { event: "outstation_expense_resync_dispatch_failed" },
      error,
    });
    return [];
  }
}

/**
 * Same push, for the paths that DELETE an expense row outright (rejecting or deleting an
 * outstation request) instead of upserting one. The row is already gone, so the "after" side is
 * empty and every removed trip counts as changed.
 */
export async function resyncPayrollExpenseStepForRemovedTrips(
  removed: Array<Record<string, unknown>>,
): Promise<ExpenseResyncOutcome[]> {
  return resyncPayrollExpenseStepForRows(removed.map(toExpenseDecisionSnapshot), []);
}

/** Columns a caller must select before deleting, so the removed rows can still be resynced. */
export const EXPENSE_DECISION_SELECT = EXPENSE_DECISION_COLUMNS;

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
    carried_forward_rows?: number;
    carried_forward_total?: number;
    current_period_total?: number;
    imported_employees?: number;
    imported_total?: number;
    locked_expenses?: number;
    matched_employees?: string[];
    stranded_employees?: number;
    stranded_rows?: number;
    stranded_total?: number;
    target_batch_id?: string | null;
    target_batch_month?: number | null;
    target_batch_year?: number | null;
  } | null;

  if (!result?.target_batch_id) {
    invalidateExecutiveDashboardCache("expenses imported to payroll", ["expenses", "payroll"]);
    return {
      carriedForwardRows: 0,
      carriedForwardTotal: 0,
      currentPeriodTotal: 0,
      importedEmployees: 0,
      importedTotal: 0,
      lockedExpenses: 0,
      matchedEmployees: [],
      saved: savedExpenses.length,
      strandedEmployees: 0,
      strandedRows: 0,
      strandedTotal: 0,
      targetBatch: null,
    };
  }

  invalidateExecutiveDashboardCache("expenses imported to payroll", ["expenses", "payroll"]);
  const matchedEmployees = Array.isArray(result.matched_employees) ? result.matched_employees.map(String) : [];
  const batchId = String(result.target_batch_id);
  const batchMonth = Number(result.target_batch_month);
  const batchYear = Number(result.target_batch_year);
  return {
    // Carried-forward money is reported separately from this month's on purpose. Folding the two
    // into one total is how an expense approved in, say, April silently shows up looking like a
    // July claim — and the person reconciling payroll has no way to notice.
    carriedForwardRows: Number(result.carried_forward_rows ?? 0),
    carriedForwardTotal: Number(result.carried_forward_total ?? 0),
    currentPeriodTotal: Number(result.current_period_total ?? 0),
    importedEmployees: Number(result.imported_employees ?? 0),
    importedTotal: Number(result.imported_total ?? 0),
    lockedExpenses: Number(result.locked_expenses ?? 0),
    matchedEmployees,
    saved: savedExpenses.length,
    // Approved and unpaid, but the employee is not in this batch — a leaver, typically. Surfaced so
    // it can be chased rather than disappearing the way it did before carry-forward existed.
    strandedEmployees: Number(result.stranded_employees ?? 0),
    strandedRows: Number(result.stranded_rows ?? 0),
    strandedTotal: Number(result.stranded_total ?? 0),
    targetBatch: {
      id: batchId,
      month: batchMonth,
      year: batchYear,
    },
  };
}
