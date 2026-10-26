import { isDevelopment } from "@/lib/env";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { rowSecurityClientFor } from "@/lib/supabase/rls-server";
import { quotedOrClause } from "@/lib/supabase/search-filter";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { isWithinManagerHierarchy, reportsToManagerSeat } from "@/lib/workforce/hierarchy-resolver";
import { isDisposablePayrollBatchRow } from "@/lib/fixture-hygiene";
import {
  getPayrollScope,
  normalizeHrId,
  normalizeHrIdForAccess,
  normalizeLineName,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { calculatePayrollParts, normalizePayrollPaymentMode, resolveFixedSalaryAmounts } from "@/lib/payroll/policy";
import { roundCurrency } from "@/lib/payroll/money";
import { PayrollConflictError } from "@/lib/payroll/errors";
import { getPayrollWorkflowTransition } from "@/lib/payroll/workflow";
import { assertPayrollWorkflowRegistryTransition } from "@/lib/payroll/workflow-registry";
import { isUuid } from "@/lib/http/uuid";
import type { SalaryValidationIssue, SalaryValidationRow } from "@/lib/payroll/salary-import";
import type {
  PayrollDashboardData,
  PayrollPeriodConflict,
  PayrollWorkflowAction,
  SalaryBatch,
  SalaryFlag,
  SalaryRecord,
} from "@/lib/payroll/types";

const emptyPayrollDashboard: PayrollDashboardData = {
  batch: null,
  batches: [],
  flags: [],
  previousRecords: [],
  records: [],
  resignationCandidateCount: 0,
  resignationCandidates: [],
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

function payrollErrorCode(error: unknown) {
  if (typeof error === "object" && error && "code" in error) {
    return String((error as { code?: unknown }).code ?? "");
  }

  return "";
}

function isDuplicatePayrollPeriodError(error: unknown) {
  const message = payrollErrorMessage(error).toLowerCase();
  return (
    payrollErrorCode(error) === "23505" &&
    (
      message.includes("already has a batch") ||
      message.includes("salary_batches_year_month_unique_idx") ||
      message.includes("salary_batches_period")
    )
  );
}

/**
 * The `salary_records_batch_hr_unique` index, added 2026-08-24: one salary record per employee per
 * batch, keyed on `lower(hr_id)`.
 *
 * Neither `phx_create_salary_batch` nor `phx_replace_salary_batch` carries an ON CONFLICT clause,
 * so before that index a sheet listing one employee on two lines produced two salary rows, two
 * payslips, and — once the outstation import runs — that employee's approved expense credited
 * twice, all without an error anywhere. It now fails the upload instead, which is the right moment
 * to find out: a sheet with one employee twice cannot be paid correctly at all.
 */
export function isDuplicateEmployeeInBatchError(error: unknown) {
  return (
    payrollErrorCode(error) === "23505" &&
    payrollErrorMessage(error).toLowerCase().includes("salary_records_batch_hr_unique")
  );
}

/** Only the three fields the message needs, so a caller — or a test — need not build a whole sheet row. */
export type DuplicateEmployeeRow = Pick<SalaryValidationRow, "hrId" | "fullName" | "row">;

/**
 * Name the duplicated people and the sheet rows they sit on.
 *
 * Read off the uploaded rows rather than parsed out of the Postgres detail line: the detail carries
 * only the hr_id, and the person fixing this needs a name and a row number to find it in their
 * file. Case- and whitespace-insensitive, matching the index expression exactly — 'PH-014' and
 * 'ph-014 ' are the same employee to the database and must read as the same employee here.
 */
export function duplicateEmployeeInBatchMessage(records: readonly DuplicateEmployeeRow[]) {
  const byEmployee = new Map<string, DuplicateEmployeeRow[]>();
  for (const row of records) {
    const key = row.hrId.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const existing = byEmployee.get(key);
    if (existing) {
      existing.push(row);
    } else {
      byEmployee.set(key, [row]);
    }
  }

  const duplicated = [...byEmployee.values()].filter((rows) => rows.length > 1);
  if (duplicated.length === 0) {
    // The index fired but the uploaded rows look clean — a concurrent upload of the same period is
    // the only way here. Say that rather than inventing a name.
    return "This month already has a salary record for one of these employees. Another payroll upload for the same month may have finished first — reload the batch and try again.";
  }

  const named = duplicated
    .map((rows) => `${rows[0].fullName} (sheet rows ${rows.map((row) => row.row).join(", ")})`)
    .join("; ");

  return `The uploaded sheet lists the same employee more than once for this month: ${named}. Each employee must appear on exactly one row — remove the duplicate and upload again.`;
}

function isMissingColumnError(error: unknown, columnName: string) {
  const message = payrollErrorMessage(error).toLowerCase();
  return (
    message.includes(`column \"${columnName}\"`) ||
    message.includes(`column ${columnName}`) ||
    message.includes(`.${columnName}`) ||
    message.includes(`${columnName} does not exist`)
  );
}

/** SQLSTATEs that genuinely mean "this object is not there". */
const PAYROLL_SCHEMA_MISSING_SQLSTATES = new Set([
  "42P01", // undefined_table
  "42883", // undefined_function
  "42703", // undefined_column
]);

/** PostgREST's own "not in the schema cache" codes. */
const PAYROLL_SCHEMA_MISSING_PGRST_CODES = new Set([
  "PGRST202", // function not found
  "PGRST205", // table not found
]);

/**
 * True only when payroll's tables/functions are genuinely ABSENT — the case the callers
 * deliberately degrade to an empty result for, because there is nothing to show yet.
 *
 * THE BUG THIS FIXES: this used to return true whenever the error message merely CONTAINED a
 * payroll table name. "permission denied for table salary_records" (42501) contains it. So
 * does a statement timeout on a query that touches it, and so does any RLS or grant change.
 * Every one of those was classified as "schema missing" and degraded to an empty result —
 * which the payroll dashboard renders as EGP 0.
 *
 * A confident zero on a payroll screen is worse than an error. Nobody investigates a number.
 *
 * Now: trust the error CODE when there is one. A code we recognise as "missing" means missing;
 * any OTHER code (42501 insufficient_privilege, 57014 query_canceled, …) is a real failure and
 * must surface rather than silently become zero. Only when no code is available do we fall
 * back to message shapes — and only to ones that actually assert absence, never to a bare
 * table name.
 */
export function isPayrollSchemaMissing(error: unknown) {
  const code = payrollErrorCode(error).trim().toUpperCase();
  if (code) {
    return (
      PAYROLL_SCHEMA_MISSING_SQLSTATES.has(code) ||
      PAYROLL_SCHEMA_MISSING_PGRST_CODES.has(code)
    );
  }

  const message = payrollErrorMessage(error).toLowerCase();
  return (
    message.includes("could not find the table") ||
    message.includes("could not find the function") ||
    message.includes("schema cache") ||
    (message.includes("does not exist") &&
      (message.includes("relation") || message.includes("function") || message.includes("table")))
  );
}

function buildPayrollIdentityFilterValue(hrId: string, mode: "exact" | "contains") {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return null;
  return mode === "contains" ? `%${normalized}%` : normalized;
}

/** One arm of the access filter, the value QUOTED.
 *
 * `normalizeHrId` trims and lower-cases; it does not restrict the character set (see
 * `canonicalHrIdKey` in `@/lib/hr-id`), so an id carrying a comma or a parenthesis used to end this
 * clause early and leave PostgREST a filter nobody wrote — on a payroll read, where the filter IS
 * the access boundary. The `%` of the contains mode goes INSIDE the quotes and is still a wildcard
 * there: quoting settles PostgREST's own filter grammar (`,` `(` `)`), and `ilike` reads its
 * wildcards from the value afterwards. */
function buildPayrollIdentityOrClause(
  hrId: string,
  mode: "exact" | "contains" = "exact",
) {
  const value = buildPayrollIdentityFilterValue(hrId, mode);
  if (!value) return null;
  return quotedOrClause("hr_id", "ilike", value);
}

type PayrollBatchLookupResult = {
  batchIds: Set<string>;
  schemaMissing: boolean;
  columnMissing: boolean;
};

// One request per column covering every allowed HR_ID at once (via an ILIKE OR
// clause), instead of a separate exact-match request per ID per column.
async function collectPayrollBatchIdsForColumnBatch(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  column: "hr_id",
  targetHrIds: string[],
): Promise<PayrollBatchLookupResult> {
  if (targetHrIds.length === 0) return { batchIds: new Set(), schemaMissing: false, columnMissing: false };

  // Each HR id is QUOTED: these come from the access scope, not from a validated character set, so
  // one carrying `,` or `)` would otherwise close its own arm and change what the rest of the OR
  // means (AGENTS.md MR-B04).
  const orClause = targetHrIds.map((id) => quotedOrClause(column, "ilike", id)).join(",");
  const { data, error } = await supabase
    .from("salary_records")
    .select("batch_id")
    .or(orClause);

  const schemaMissing = Boolean(error && isPayrollSchemaMissing(error));
  const columnMissing = false;

  if (error && !schemaMissing) {
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
    part1PaidAt: row.part1_paid_at ? new Date(String(row.part1_paid_at)).toISOString() : null,
    part1PaidBy: row.part1_paid_by ? String(row.part1_paid_by) : null,
    part2ReadyAt: row.part2_ready_at ? new Date(String(row.part2_ready_at)).toISOString() : null,
    part2ReadyBy: row.part2_ready_by ? String(row.part2_ready_by) : null,
    rejectedReason: row.rejected_reason ? String(row.rejected_reason) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function mapRecord(row: Record<string, unknown>): SalaryRecord {
  const baseSalary = Number(row.base_salary ?? 0);
  const expenses = Number(row.expenses ?? 0);
  const incentive = Number(row.incentive ?? 0);
  const overtime = Number(row.overtime ?? 0);
  const bonus = Number(row.bonus ?? 0);
  const extraCostOfLiving = Number(row.extra_cost_of_living ?? 0);
  const fuelAllowance = Number(row.fuel_allowance ?? 0);
  const socialInsurance = Number(row.social_insurance ?? 0);
  const employmentIncomeTax = Number(row.employment_income_tax ?? 0);
  const crm = Number(row.crm ?? 0);
  const fingerPrint = Number(row.finger_print ?? 0);
  const unpaidVacations = Number(row.unpaid_vacations ?? 0);
  const medicalInsurance = Number(row.medical_insurance ?? 0);
  const loans = Number(row.loans ?? 0);
  const otherDeductions = Number(row.other_deductions ?? 0);
  const otherAdditions = Number(row.other_additions ?? 0);
  const calculatedTotalAdditions =
    expenses + incentive + overtime + bonus + extraCostOfLiving + fuelAllowance + otherAdditions;
  const governmentalDeductions = Number(row.governmental_deductions ?? (socialInsurance + employmentIncomeTax));
  const calculatedTotalDeductions =
    crm +
    fingerPrint +
    unpaidVacations +
    medicalInsurance +
    loans +
    otherDeductions;
  const storedNetSalary = Number(row.net_salary ?? 0);
  // NULL on every row written before 2026-09-04 — the day count was genuinely
  // never recorded then, so 0 carries "not recorded" and readers print nothing
  // rather than inventing a full month.
  const workingDays = Math.max(0, Math.trunc(Number(row.working_days ?? 0)) || 0);
  const calendarDays = Math.max(0, Math.trunc(Number(row.calendar_days ?? 0)) || 0);
  const uploadedFirstPart = Number(row.first_part ?? 0);
  const uploadedSecondPart = Math.max(0, Number(row.second_part ?? 0));
  const paymentMode = row.payment_mode
    ? normalizePayrollPaymentMode(String(row.payment_mode))
    : uploadedFirstPart > 0 && uploadedFirstPart >= storedNetSalary - 1
      ? "one_part"
      : "two_parts";
  const fixedSalary = resolveFixedSalaryAmounts({
    baseSalary: baseSalary > 0 ? baseSalary : null,
    employmentIncomeTax,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: Number(row.gross_salary ?? 0),
    netSalary: storedNetSalary,
    socialInsurance,
  });
  const resolvedBaseSalary = fixedSalary.baseSalary;
  const netSalary = fixedSalary.netSalary;
  const parts = calculatePayrollParts({
    additions: expenses + incentive + overtime + bonus + otherAdditions,
    deductions: crm + fingerPrint + unpaidVacations + medicalInsurance + loans + otherDeductions,
    baseSalary: resolvedBaseSalary,
    extraCostOfLiving,
    fuelAllowance,
    netSalary,
    paymentMode,
    previousExpenses: 0,
    secondPartAdditions: expenses + incentive,
  });
  const grossSalary = fixedSalary.grossSalary;
  const totalAdditions = Number(row.total_additions ?? calculatedTotalAdditions);
  const totalDeductions = Number(row.total_deductions ?? calculatedTotalDeductions);
  const firstPart = row.first_part === null || row.first_part === undefined ? parts.firstPart : uploadedFirstPart;
  const secondPart = row.second_part === null || row.second_part === undefined ? parts.secondPart : uploadedSecondPart;
  const monthSalary = Number(row.month_salary ?? (firstPart + secondPart));

  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    baseSalary: resolvedBaseSalary,
    employeeCode: String(row.hr_id ?? ""),
    hrId: String(row.hr_id ?? ""),
    fullName: String(row.full_name ?? ""),
    nameAr: row.name_ar ? String(row.name_ar) : null,
    line: String(row.line ?? ""),
    area: String(row.area ?? ""),
    jobTitle: String(row.job_title ?? ""),
    grossSalary,
    expenses,
    incentive,
    overtime,
    bonus,
    extraCostOfLiving,
    fuelAllowance,
    otherAdditions,
    totalAdditions,
    socialInsurance,
    employmentIncomeTax,
    crm,
    fingerPrint,
    unpaidVacations,
    medicalInsurance,
    loans,
    otherDeductions,
    totalDeductions,
    netSalary,
    payrollComment: row.comment ? String(row.comment) : null,
    firstPart,
    governmentalDeductions,
    secondPart,
    monthSalary,
    paymentMode,
    hireDate: row.hire_date ? String(row.hire_date) : null,
    workingDays,
    calendarDays,
  };
}

/**
 * Which employees this VIEWER is allowed to see. Access scope is the ONLY limb that
 * may drop rows from a batch that already exists.
 *
 * A salary batch is a historical record of money already paid, so its membership is
 * fixed at the moment the batch is built. Re-deriving membership from present-day
 * employment (`employment_status` / `payroll_eligible`) silently deletes everyone who
 * resigned after being paid: June 2026 then reads as 103 of its 123 rows and
 * 2,267,000.00 of 2,667,500.00 EGP net — in the dashboard, the export AND the bank
 * transfer file, so real people go unpaid. Who belongs in a NEW batch is a build-time
 * question, answered period-aware by the payroll template roster and the
 * automated-payroll recommender; it is never a read-view filter.
 */
export type PayrollAccessFilter = {
  all: boolean;
  allowedHrIds: Set<string>;
};

// Seat-continuity-aware TEAM / HIERARCHY resolution, delegating to the canonical
// workforce resolver (src/lib/workforce/hierarchy-resolver.ts) instead of a private
// naive `manager_hr_id` adjacency walk. The naive walk was correct only because a DB
// trigger writes `manager_hr_id` + `pending_manager_replacement_for_hr_id` atomically;
// when a manager seat is vacant/reassigned it would attach reports to the wrong seat.
// The resolver additionally recognizes the departed manager's vacant seat, so a report
// orphaned upward after a resignation still resolves to the correct owner. Behaviour is
// unchanged for today's data (no pending marker) — it only becomes correct on vacancy.

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

  const canonicalViewerId = normalizeHrIdForAccess(currentHrId) ?? "";
  if (payrollScope === "TEAM") {
    const directReports = collectDirectReports(directory, canonicalViewerId);
    const allowed = normalizePayrollAllowedIds([...directReports, currentHrId]);
    return { all: false, allowedHrIds: allowed };
  }

  if (payrollScope === "HIERARCHY") {
    const hierarchy = collectHierarchy(directory, canonicalViewerId);
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

  const normalizedIds = Array.from(
    new Set(
      Array.from(accessFilter.allowedHrIds)
        .map((rawId) => normalizeHrId(rawId))
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (normalizedIds.length === 0) return new Set<string>();

  const hrIdResult = await collectPayrollBatchIdsForColumnBatch(supabase, "hr_id", normalizedIds);

  const batchIds = new Set<string>();
  hrIdResult.batchIds.forEach((batchId) => batchIds.add(batchId));

  return batchIds;
}

function filterPayrollQueryByAllowedHrIds<T extends { or: (value: string) => T; ilike?: (column: string, value: string) => T }>(
  query: T,
  allowedHrIds: Set<string>,
) {
  const ids = Array.from(allowedHrIds);
  if (ids.length === 0) return query;
  const conditions: string[] = [];
  for (const hrId of ids) {
    if (!hrId) continue;
    const normalized = normalizeHrId(hrId);
    const compact = normalizeHrIdForAccess(hrId);
    if (normalized) {
      const exact = buildPayrollIdentityOrClause(normalized, "exact");
      if (exact) conditions.push(exact);
    }
    if (compact && compact !== normalized) {
      const compactClause = buildPayrollIdentityOrClause(compact, "exact");
      if (compactClause) conditions.push(compactClause);
    }
  }

  if (conditions.length === 0) return query;
  return query.or(conditions.join(","));
}

/**
 * Narrows an existing batch's rows to what the viewer may see — access scope only.
 * See PayrollAccessFilter: adding an employment-status limb here removes people from
 * batches they were legitimately paid in.
 */
export function filterPayrollRowsByAccess<T extends Record<string, unknown>>(
  rows: T[],
  accessFilter: PayrollAccessFilter,
) {
  if (accessFilter.all) return rows;
  if (accessFilter.allowedHrIds.size === 0) return [];
  return rows.filter((row) => isPayrollRecordInScope(row, accessFilter.allowedHrIds));
}

export function filterPayrollFlagsByAccess(
  rows: SalaryFlag[],
  accessFilter: PayrollAccessFilter,
) {
  if (accessFilter.all) return rows;
  if (accessFilter.allowedHrIds.size === 0) return [];
  return rows.filter((row) => isPayrollFlagInScope(row, accessFilter.allowedHrIds));
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

async function withHireDates(records: SalaryRecord[]) {
  if (records.length === 0) {
    return records;
  }

  try {
    const directory = await getEmployeeDirectory();
    const hireDateByHrId = new Map<string, string | null>();

    directory.employees.forEach((employee) => {
      const keys = [
        employee.hrId,
        normalizeHrId(employee.hrId),
        normalizeHrIdForAccess(employee.hrId),
      ].filter(isNonEmptyString);

      keys.forEach((key) => {
        hireDateByHrId.set(key, employee.hireDate);
      });
    });

    const getDirectoryHireDate = (record: SalaryRecord) => {
      const keys = [
        record.hrId,
        record.employeeCode,
        normalizeHrId(record.hrId),
        normalizeHrId(record.employeeCode),
        normalizeHrIdForAccess(record.hrId),
        normalizeHrIdForAccess(record.employeeCode),
      ].filter(isNonEmptyString);

      for (const key of keys) {
        const hireDate = hireDateByHrId.get(key);
        if (hireDate) {
          return hireDate;
        }
      }

      return null;
    };

    return records.map((record) => ({
      ...record,
      hireDate: record.hireDate ?? getDirectoryHireDate(record) ?? null,
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

/**
 * Batch HEADERS only — period, file, status — and no employee row, which is why it takes no access:
 * every reader that turns a batch into people (`getPayrollDashboard`, `getSalaryBatchExport`,
 * `getLatestSalaryRecordsBefore`) narrows the rows by the viewer's access itself.
 */
export async function listSalaryBatches(): Promise<SalaryBatch[]> {
  const supabase = await rowSecurityClientFor("payroll.listSalaryBatches");
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

  return (data ?? [])
    .filter((row) => !isDisposablePayrollBatchRow(row as Record<string, unknown>))
    .map((row) => mapBatch(row as Record<string, unknown>));
}

export async function findSalaryBatchByPeriodAndHash(
  month: number,
  year: number,
  hash: string,
): Promise<SalaryBatch | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("salary_batches")
    .select("*")
    .eq("month", month)
    .eq("year", year)
    .eq("file_content_hash", hash)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? mapBatch(data as Record<string, unknown>) : null;
}

export async function findSalaryBatchForPeriod(month: number, year: number): Promise<SalaryBatch | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("salary_batches")
    .select("*")
    .eq("month", month)
    .eq("year", year)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? mapBatch(data as Record<string, unknown>) : null;
}

function payrollPeriodSortValue(batch: Pick<SalaryBatch, "month" | "year">) {
  return batch.year * 12 + batch.month;
}

export async function getLatestSalaryRecordsBefore(
  month: number,
  year: number,
  accessContext: AccessContext,
): Promise<SalaryRecord[]> {
  const supabase = await rowSecurityClientFor("payroll.getLatestSalaryRecordsBefore");
  const payrollAccessFilter = await resolvePayrollAccessFilter(accessContext);
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

  return filterPayrollRowsByAccess((data ?? []) as Array<Record<string, unknown>>, payrollAccessFilter).map((row) =>
    mapRecord(row),
  );
}

export async function getLatestSalaryExpenseTotalsBefore(
  month: number,
  year: number,
  accessContext: AccessContext,
): Promise<Map<string, number>> {
  const supabase = await rowSecurityClientFor("payroll.getLatestSalaryExpenseTotalsBefore");
  const payrollAccessFilter = await resolvePayrollAccessFilter(accessContext);
  const { data: batches, error: batchError } = await supabase
    .from("salary_batches")
    .select("id,file_name,uploaded_by,approved_by,month,year")
    .or(`year.lt.${year},and(year.eq.${year},month.lt.${month})`)
    .order("year", { ascending: false })
    .order("month", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(10);

  if (batchError) {
    if (isPayrollSchemaMissing(batchError)) return new Map();
    throw batchError;
  }

  const previousBatch = ((batches ?? []) as Array<Record<string, unknown>>)
    .find((batch) => !isDisposablePayrollBatchRow(batch));

  if (!previousBatch?.id) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("salary_records")
    .select("hr_id,expenses")
    .eq("batch_id", String(previousBatch.id));

  if (error) {
    if (isPayrollSchemaMissing(error)) return new Map();
    throw error;
  }

  const totals = new Map<string, number>();
  filterPayrollRowsByAccess((data ?? []) as Array<Record<string, unknown>>, payrollAccessFilter).forEach((row) => {
    const hrId = String(row.hr_id ?? "").trim();
    if (!hrId) return;
    totals.set(hrId, Number(row.expenses ?? 0));
  });

  return totals;
}

export async function getPayrollDashboard(
  batchId: string | undefined,
  accessContext: AccessContext,
): Promise<PayrollDashboardData> {
  const supabase = await rowSecurityClientFor("payroll.getPayrollDashboard");
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

  // Cross-reference this batch's HR IDs against the resignation-candidate registry so a
  // payroll approver reviewing the batch can see which rows were flagged as likely
  // resignations. The `employee_not_found` upload signal is intentionally kept out of
  // salary_flags governance (see payroll-engine-hardening tests) and lives only in the
  // Resignations report; this is a read-only cross-reference that surfaces it beside the
  // batch. The registry table is service-role-only (RLS) so it MUST be read via the admin
  // client, and the whole lookup is best-effort — it must never block the dashboard.
  const batchHrIds = Array.from(
    new Set(records.map((record) => record.hrId).filter(Boolean)),
  );
  let resignationCandidates: PayrollDashboardData["resignationCandidates"] = [];
  if (batchHrIds.length > 0) {
    try {
      // PostgREST folds every .in() value into the request URL; an unbatched array of a few
      // hundred ids can push the URL past undici's ~16KB header limit and throw
      // "TypeError: fetch failed" / HeadersOverflowError — a company-wide batch can have that
      // many hr_ids, so batch this lookup.
      const candidateRows: Array<Record<string, unknown>> = [];
      for (let i = 0; i < batchHrIds.length; i += 100) {
        const batch = batchHrIds.slice(i, i + 100);
        const { data, error: candidateError } = await getSupabaseAdmin()
          .from("payroll_resignation_candidates")
          .select("hr_id, employee_name, last_payout_month, last_payout_year")
          .in("hr_id", batch);
        if (candidateError) throw candidateError;
        candidateRows.push(...((data ?? []) as Array<Record<string, unknown>>));
      }
      resignationCandidates = candidateRows.map(
        (row) => ({
          fullName: String(row.employee_name ?? row.hr_id ?? ""),
          hrId: String(row.hr_id ?? ""),
          lastPayoutMonth: Number(row.last_payout_month ?? 0),
          lastPayoutYear: Number(row.last_payout_year ?? 0),
        }),
      );
    } catch {
      /* best-effort — never block the payroll dashboard on this cross-reference */
    }
  }

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

  const totalGross = roundCurrency(records.reduce((sum, r) => sum + r.grossSalary, 0));
  const totalNet = roundCurrency(records.reduce((sum, r) => sum + r.netSalary, 0));
  const totalAdditions = roundCurrency(records.reduce((sum, r) => sum + r.totalAdditions, 0));
  const totalGovtDeductions = roundCurrency(records.reduce((sum, r) => sum + r.governmentalDeductions, 0));
  const avgNet = records.length > 0 ? totalNet / records.length : 0;
  const anomalies = records.filter((r) => r.netSalary > avgNet * 2.25);
  const readinessRate = records.length > 0 ? (records.length - anomalies.length) / records.length : 1;

  return {
    batch,
    batches: visibleBatches,
    records,
    flags,
    previousRecords,
    resignationCandidates,
    resignationCandidateCount: resignationCandidates.length,
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
  const supabase = await rowSecurityClientFor("payroll.getSalaryBatchExport");
  const normalizedRequestedId = batchId.trim();
  let targetBatchId = normalizedRequestedId;
  const payrollAccessFilter = await resolvePayrollAccessFilter(accessContext);

  if (!isUuid(normalizedRequestedId)) {
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
  const buildFilteredRecordsQuery = () =>
    payrollAccessFilter.all
      ? buildRecordsQuery()
      : filterPayrollQueryByAllowedHrIds(
          buildRecordsQuery(),
          payrollAccessFilter.allowedHrIds,
        );

  const batchPromise = supabase
    .from("salary_batches")
    .select("*")
    .eq("id", targetBatchId)
    .maybeSingle();
  const recordsResult = await buildFilteredRecordsQuery();

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

const prePart1EditableSalaryBatchStatuses = new Set(["uploaded", "part1_ready", "rejected"]);
const part1PaidSalaryBatchStatuses = new Set([
  "part1_paid",
  "adjustments_open",
  "part2_ready",
  "under_review",
  "approved",
  "locked",
]);

export function isReplaceableSalaryBatchStatus(status: string) {
  return prePart1EditableSalaryBatchStatuses.has(status) && !part1PaidSalaryBatchStatuses.has(status);
}

function isSalaryBatchPart1Paid(batch: SalaryBatch) {
  return Boolean(batch.part1PaidAt) || part1PaidSalaryBatchStatuses.has(batch.status);
}

export function isReplaceableSalaryBatch(batch: SalaryBatch) {
  return isReplaceableSalaryBatchStatus(batch.status) && !isSalaryBatchPart1Paid(batch);
}

/**
 * Deleting a batch removes the batch, its salary_records and its salary_flags outright, so it is
 * strictly MORE destructive than replacing one and can never be permitted where a replace is
 * refused. That is why this is the replace predicate rather than a second, laxer notion of
 * "closed" — one definition, or this hole grows back.
 *
 * The real enforcement is in phx_delete_salary_batch, which now refuses BEFORE it bypasses the
 * three closed-month triggers (migration 20260912120000). This exists so the screen gets a 409 and
 * a sentence naming the month and its stage, rather than a raw Postgres P0001.
 */
export function isDeletableSalaryBatch(batch: SalaryBatch) {
  return isReplaceableSalaryBatch(batch);
}

export function assertSalaryBatchDeletable(batch: SalaryBatch): void {
  if (isDeletableSalaryBatch(batch)) return;
  throw new PayrollConflictError(
    `Payroll ${batch.month}/${batch.year} is ${batch.status.replace(/_/g, " ")} and cannot be deleted. ` +
      "A month that has reached this stage is never deleted; correct it in the next month instead.",
  );
}

export function payrollPeriodConflictForBatch(batch: SalaryBatch): PayrollPeriodConflict {
  const replaceable = isReplaceableSalaryBatch(batch);

  return {
    batchId: batch.id,
    fileName: batch.fileName,
    message: replaceable
      ? "A payroll upload already exists for this period. Replace the existing upload or cancel."
      : `Payroll ${batch.month}/${batch.year} is ${batch.status.replace(/_/g, " ")} and cannot be replaced.`,
    month: batch.month,
    replaceable,
    status: batch.status,
    year: batch.year,
  };
}

function assertSalaryBatchHasImportRows(recordCount: number, operation: "upload" | "replace") {
  if (recordCount === 0) {
    throw new Error(
      operation === "replace"
        ? "Payroll replacement file must include at least one salary row."
        : "Payroll upload file must include at least one salary row.",
    );
  }
}

export async function getSalaryBatchById(batchId: string): Promise<SalaryBatch | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("salary_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? mapBatch(data as Record<string, unknown>) : null;
}

type CreateSalaryBatchInput = {
  fileContentHash?: string | null;
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
    base_salary: row.baseSalary,
    bonus: row.bonus,
    crm: row.crm,
    hr_id: row.hrId,
    employment_income_tax: row.employmentIncomeTax,
    expenses: row.expenses,
    extra_cost_of_living: row.extraCostOfLiving,
    finger_print: row.fingerPrint,
    first_part: row.firstPart,
    fuel_allowance: row.fuelAllowance,
    full_name: row.fullName,
    governmental_deductions: row.governmentalDeductions,
    gross_salary: row.grossSalary,
    hire_date: row.hireDate,
    incentive: row.incentive,
    job_title: row.jobTitle,
    line: row.line,
    loans: row.loans,
    medical_insurance: row.medicalInsurance,
    month_salary: row.monthSalary,
    name_ar: row.nameAr,
    net_salary: row.netSalary,
    other_additions: row.otherAdditions,
    other_deductions: row.otherDeductions,
    overtime: row.overtime,
    comment: row.payrollComment,
    payment_mode: row.paymentMode,
    second_part: Math.max(0, row.secondPart),
    social_insurance: row.socialInsurance,
    total_additions: row.totalAdditions,
    total_deductions: row.totalDeductions,
    unpaid_vacations: row.unpaidVacations,
    // 0 means "not recorded" in the row model; store NULL rather than a zero day
    // count so the column keeps saying "we do not know" instead of "he worked no
    // days" (see 20260905001500_salary_records_working_days.sql).
    working_days: row.workingDays > 0 ? row.workingDays : null,
    calendar_days: row.calendarDays > 0 ? row.calendarDays : null,
  };
}

type SalaryRecordPayload = ReturnType<typeof salaryRecordPayload>;

const salaryRecordNumericColumns = new Set([
  "base_salary",
  "bonus",
  "crm",
  "employment_income_tax",
  "expenses",
  "extra_cost_of_living",
  "finger_print",
  "first_part",
  "fuel_allowance",
  "governmental_deductions",
  "gross_salary",
  "incentive",
  "loans",
  "medical_insurance",
  "month_salary",
  "net_salary",
  "other_additions",
  "other_deductions",
  "overtime",
  "second_part",
  "social_insurance",
  "total_additions",
  "total_deductions",
  "unpaid_vacations",
  "working_days",
  "calendar_days",
]);

function normalizePersistedValue(column: string, value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (column === "hire_date") return String(value).slice(0, 10);
  if (salaryRecordNumericColumns.has(column)) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : value;
  }
  return String(value);
}

/**
 * Every difference between the records a batch should hold and the ones it does hold: a person
 * missing, a column that disagrees (numbers compared at 2 dp), and — with `reportExtras` — a saved
 * person nobody expected. Pure, so the comparison itself is tested without a database.
 */
export function diffSalaryRecordPayloads(
  recordPayloads: ReadonlyArray<Record<string, unknown> & { hr_id: string }>,
  savedRows: ReadonlyArray<Record<string, unknown>>,
  options: { reportExtras?: boolean; columns?: ReadonlySet<string> } = {},
): string[] {
  const savedByHrId = new Map(
    savedRows.map((row) => [String(row.hr_id ?? "").trim().toLowerCase(), row]),
  );
  const mismatches: string[] = [];

  for (const payload of recordPayloads) {
    const hrId = payload.hr_id.trim();
    const saved = savedByHrId.get(hrId.toLowerCase());

    if (!saved) {
      mismatches.push(`${hrId}: row was not saved`);
      continue;
    }

    for (const [column, expectedValue] of Object.entries(payload)) {
      if (column === "batch_id") continue;
      if (options.columns && !options.columns.has(column)) continue;
      const expected = normalizePersistedValue(column, expectedValue);
      const actual = normalizePersistedValue(column, saved[column]);

      if (expected !== actual) {
        mismatches.push(`${hrId}.${column}: expected ${String(expected)}, saved ${String(actual)}`);
      }
    }
  }

  if (options.reportExtras) {
    const expectedIds = new Set(recordPayloads.map((payload) => payload.hr_id.trim().toLowerCase()));
    for (const [hrId, row] of savedByHrId) {
      if (!expectedIds.has(hrId)) mismatches.push(`${String(row.hr_id ?? hrId).trim()}: saved but not expected`);
    }
  }

  return mismatches;
}

async function readSalaryRecordsForBatch(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  batchId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await supabase
    .from("salary_records")
    .select("*")
    .eq("batch_id", batchId);

  if (error) {
    throw error;
  }
  return (data ?? []) as Array<Record<string, unknown>>;
}

/**
 * Whether an existing batch holds exactly these rows — every person, every column, and nobody else.
 * Returns the differences (empty when it does). Automated Payroll calls it before finalising a batch
 * an earlier publish left behind (audit 2026-10-23, S-PAY-09). A failed read throws: "could not
 * compare" is never "matched".
 */
export async function compareSalaryBatchRecords(
  batchId: string,
  records: SalaryValidationRow[],
): Promise<{ all: string[]; money: string[] }> {
  const supabase = getSupabaseAdmin();
  const payloads = records.map((row) => salaryRecordPayload(batchId, row));
  const saved = await readSalaryRecordsForBatch(supabase, batchId);
  return {
    all: diffSalaryRecordPayloads(payloads, saved, { reportExtras: true }),
    money: diffSalaryRecordPayloads(payloads, saved, { reportExtras: true, columns: SALARY_RECORD_MONEY_COLUMNS }),
  };
}

/**
 * The columns that decide what a person is paid and where it goes: every money figure plus the payment
 * mode. Name, title, area, line, hire date and the comment are read live from the directory and can
 * move between two publish attempts without anybody's pay moving.
 */
export const SALARY_RECORD_MONEY_COLUMNS: ReadonlySet<string> = new Set([
  ...[...salaryRecordNumericColumns].filter((column) => column !== "working_days" && column !== "calendar_days"),
  "payment_mode",
]);

async function verifySalaryRecordPayloads(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  batchId: string,
  recordPayloads: SalaryRecordPayload[],
) {
  if (recordPayloads.length === 0) {
    return;
  }

  const mismatches = diffSalaryRecordPayloads(recordPayloads, await readSalaryRecordsForBatch(supabase, batchId));

  if (mismatches.length > 0) {
    throw new Error(
      `Payroll upload did not persist all sheet columns correctly. ${mismatches.slice(0, 8).join("; ")}`,
    );
  }
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

export async function createSalaryBatch(input: CreateSalaryBatchInput) {
  assertSalaryBatchHasImportRows(input.records.length, "upload");

  const existingPeriodBatch = await findSalaryBatchForPeriod(input.month, input.year);
  if (existingPeriodBatch) {
    throw new PayrollConflictError(payrollPeriodConflictForBatch(existingPeriodBatch).message);
  }

  if (input.fileContentHash) {
    const existingHashBatch = await findSalaryBatchByPeriodAndHash(
      input.month,
      input.year,
      input.fileContentHash,
    );
    if (existingHashBatch) {
      throw new PayrollConflictError(
        "This exact file has already been uploaded for this payroll period.",
      );
    }
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const recordPayloads = input.records.map((row) =>
    salaryRecordPayload("", row),
  );
  const flagPayloads = input.validationWarnings.map((warning) =>
    salaryFlagPayload("", warning),
  );

  const { data: batchData, error: batchError } = await supabase.rpc(
    "phx_create_salary_batch",
    {
      p_created_at: now,
      p_file_content_hash: input.fileContentHash ?? null,
      p_file_name: input.fileName,
      p_flags: flagPayloads,
      p_month: input.month,
      p_records: recordPayloads,
      p_uploaded_by: input.uploadedBy,
      p_year: input.year,
    },
  );

  if (batchError) {
    if (
      isDuplicatePayrollPeriodError(batchError) ||
      payrollErrorMessage(batchError).toLowerCase().includes("already has a batch")
    ) {
      throw new PayrollConflictError(payrollErrorMessage(batchError));
    }

    if (isDuplicateEmployeeInBatchError(batchError)) {
      throw new PayrollConflictError(duplicateEmployeeInBatchMessage(input.records));
    }

    if (
      isMissingColumnError(batchError, "base_salary") ||
      isMissingColumnError(batchError, "governmental_deductions") ||
      isMissingColumnError(batchError, "hire_date") ||
      isMissingColumnError(batchError, "month_salary") ||
      isMissingColumnError(batchError, "name_ar") ||
      isMissingColumnError(batchError, "comment") ||
      isMissingColumnError(batchError, "payment_mode") ||
      isMissingColumnError(batchError, "working_days") ||
      isMissingColumnError(batchError, "calendar_days")
    ) {
      throw new Error(
        "Payroll schema is missing salary_records sheet-mapping columns. Run the salary_records SQL migration before uploading payroll.",
      );
    }

    throw batchError;
  }

  if (!batchData || typeof batchData !== "object") {
    throw new Error("Payroll batch could not be created.");
  }

  const batch = mapBatch(batchData as Record<string, unknown>);
  await verifySalaryRecordPayloads(supabase, batch.id, recordPayloads);
  invalidateExecutiveDashboardCache("payroll batch created", ["payroll"]);
  await writeRequiredAuditLog({
    actorLoginId: input.uploadedBy,
    entityId: batch.id,
    entityType: "payroll_batch",
    newValues: {
      fileName: batch.fileName,
      importedRecords: recordPayloads.length,
      governanceWarnings: flagPayloads.length,
      month: batch.month,
      status: batch.status,
      year: batch.year,
    },
    oldValues: null,
    summary: `Payroll salary file imported for ${batch.month}/${batch.year} (${recordPayloads.length} records).`,
  });

  return {
    batch,
    importedRecords: recordPayloads.length,
    governanceWarnings: flagPayloads.length,
  };
}

export async function deleteSalaryBatch(batchId: string, actor?: string | null) {
  const supabase = getSupabaseAdmin();
  // Read the batch BEFORE the RPC. phx_delete_salary_batch removes the row and its salary_records,
  // so afterwards there is nothing left to describe — and "a month's payroll disappeared" is
  // precisely the event the audit log exists to answer. A failure to read it must not block the
  // delete the caller is authorised to make, so fall back to recording that the read failed.
  let existing: SalaryBatch | null = null;
  try {
    existing = await getSalaryBatchById(batchId);
  } catch (error) {
    logError("Payroll batch could not be read before deletion", {
      labels: { event: "payroll_batch_predelete_read_failed", batchId },
      error,
    });
  }

  // A closed month is never deleted. The RPC refuses this too and is the actual boundary — it
  // covers every caller, including one that never comes through here. This check exists to turn
  // that refusal into a 409 naming the month and its stage.
  //
  // When the read above FAILED we cannot tell whether the month is closed, so there is nothing to
  // assert on and the call goes through to the RPC, which can read the row itself. That is the one
  // case where the comment above still holds: the read is best-effort, the RPC is not.
  if (existing) assertSalaryBatchDeletable(existing);

  const { error } = await supabase.rpc("phx_delete_salary_batch", {
    p_batch_id: batchId,
  });

  if (error) {
    if (isMissingColumnError(error, "phx_delete_salary_batch")) {
      throw new Error("Payroll admin delete RPC is missing. Run the payroll admin delete migration before deleting uploads.");
    }

    throw error;
  }

  invalidateExecutiveDashboardCache("payroll batch deleted", ["payroll"]);
  await writeRequiredAuditLog({
    actorLoginId: actor ?? null,
    entityId: batchId,
    entityType: "payroll_batch",
    newValues: null,
    oldValues: existing
      ? {
          approvedBy: existing.approvedBy,
          fileName: existing.fileName,
          month: existing.month,
          status: existing.status,
          uploadedBy: existing.uploadedBy,
          year: existing.year,
        }
      : { note: "Batch row could not be read before deletion." },
    summary: existing
      ? `Payroll batch deleted for ${existing.month}/${existing.year} (status ${existing.status}).`
      : "Payroll batch deleted.",
  });
  return true;
}

export async function replaceSalaryBatch(
  batchId: string,
  input: Omit<CreateSalaryBatchInput, "month" | "year">,
) {
  assertSalaryBatchHasImportRows(input.records.length, "replace");

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
  if (!isReplaceableSalaryBatch(existing)) {
    throw new PayrollConflictError(`Payroll batch cannot be replaced after Part 1 is paid or while status is ${existing.status}.`);
  }

  const now = new Date().toISOString();
  const recordPayloads = input.records.map((row) =>
    salaryRecordPayload(existing.id, row),
  );
  const flagPayloads = input.validationWarnings.map((warning) =>
    salaryFlagPayload(existing.id, warning),
  );

  const { data: updatedBatchData, error: replaceError } = await supabase.rpc(
    "phx_replace_salary_batch",
    {
      p_batch_id: existing.id,
      p_expected_month: existing.month,
      p_expected_year: existing.year,
      p_file_name: input.fileName,
      p_flags: flagPayloads,
      p_records: recordPayloads,
      p_uploaded_by: input.uploadedBy,
      p_updated_at: now,
    },
  );

  if (replaceError) {
    const message = payrollErrorMessage(replaceError);
    if (
      message.toLowerCase().includes("cannot be replaced") ||
      message.toLowerCase().includes("payroll batch period changed")
    ) {
      throw new PayrollConflictError(message);
    }

    if (isDuplicateEmployeeInBatchError(replaceError)) {
      throw new PayrollConflictError(duplicateEmployeeInBatchMessage(input.records));
    }
    if (
      isMissingColumnError(replaceError, "base_salary") ||
      isMissingColumnError(replaceError, "governmental_deductions") ||
      isMissingColumnError(replaceError, "month_salary") ||
      isMissingColumnError(replaceError, "payment_mode") ||
      isMissingColumnError(replaceError, "working_days") ||
      isMissingColumnError(replaceError, "calendar_days")
    ) {
      throw new Error(
        "Payroll schema is missing salary_records sheet-mapping columns. Run the salary_records SQL migration before replacing payroll.",
      );
    }
    throw replaceError;
  }

  if (!updatedBatchData || typeof updatedBatchData !== "object") {
    throw new Error("Payroll upload could not be updated.");
  }

  await verifySalaryRecordPayloads(supabase, existing.id, recordPayloads);
  invalidateExecutiveDashboardCache("payroll batch replaced", ["payroll"]);
  const replacedBatch = mapBatch(updatedBatchData as Record<string, unknown>);
  await writeRequiredAuditLog({
    actorLoginId: input.uploadedBy,
    entityId: existing.id,
    entityType: "payroll_batch",
    newValues: {
      fileName: replacedBatch.fileName,
      importedRecords: recordPayloads.length,
      governanceWarnings: flagPayloads.length,
      status: replacedBatch.status,
    },
    oldValues: { fileName: existing.fileName, status: existing.status },
    summary: `Payroll salary file replaced for ${existing.month}/${existing.year} (${recordPayloads.length} records).`,
  });

  return {
    batch: replacedBatch,
    importedRecords: recordPayloads.length,
    governanceWarnings: flagPayloads.length,
  };
}

export async function runPayrollWorkflow(
  batchId: string,
  action: PayrollWorkflowAction,
  accessContextOrActorName: Pick<AccessContext, "role"> | string,
  actorNameOrRejectedReason?: string,
  rejectedReasonInput?: string,
): Promise<SalaryBatch | null> {
  const accessContext = typeof accessContextOrActorName === "string"
    ? { role: "Super Admin" as const }
    : accessContextOrActorName;
  const actorName = typeof accessContextOrActorName === "string"
    ? accessContextOrActorName
    : actorNameOrRejectedReason ?? accessContext.role;
  const rejectedReason = typeof accessContextOrActorName === "string"
    ? actorNameOrRejectedReason
    : rejectedReasonInput;
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const { data: existingBatchData, error: existingBatchError } = await supabase
    .from("salary_batches")
    .select("status")
    .eq("id", batchId)
    .maybeSingle();

  if (existingBatchError) {
    throw existingBatchError;
  }

  if (!existingBatchData) {
    return null;
  }

  const currentStatus = String((existingBatchData as Record<string, unknown>).status ?? "");
  const transition = getPayrollWorkflowTransition(currentStatus, action, rejectedReason);
  await assertPayrollWorkflowRegistryTransition({
    access: accessContext,
    action,
    currentStatus,
    expectedNextStatus: transition.nextStatus,
  });
  const updates: Record<string, unknown> = { updated_at: now };
  updates.status = transition.nextStatus;

  if (transition.setApproved) {
    updates.approved_by = actorName;
    updates.approved_at = now;
  }

  if (transition.setPart1Paid) {
    updates.part1_paid_by = actorName;
    updates.part1_paid_at = now;
  }

  if (transition.setPart2Ready) {
    updates.part2_ready_by = actorName;
    updates.part2_ready_at = now;
  }

  if (transition.setLocked) {
    updates.locked_at = now;
  }

  if (transition.setRejected) {
    updates.rejected_reason = rejectedReason?.trim();
  }

  if (transition.clearRejectedReason) {
    updates.rejected_reason = null;
  }

  if (transition.clearPart2Ready) {
    updates.part2_ready_by = null;
    updates.part2_ready_at = null;
  }

  const { data, error } = await supabase
    .from("salary_batches")
    .update(updates)
    .eq("id", batchId)
    .eq("status", transition.expectedStatus)
    .select()
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new PayrollConflictError("Payroll workflow state changed. Refresh and retry.");
  }

  const updatedBatch = mapBatch(data as Record<string, unknown>);
  await writeRequiredAuditLog({
    actorLoginId: actorName,
    entityId: batchId,
    entityType: "payroll_batch",
    newValues: {
      action,
      approvedBy: transition.setApproved ? actorName : null,
      rejectedReason: rejectedReason?.trim() ?? null,
      status: transition.nextStatus,
    },
    oldValues: { status: currentStatus },
    summary: `Payroll workflow ${action}.`,
  });
  invalidateExecutiveDashboardCache("payroll workflow updated", ["payroll"]);

  return updatedBatch;
}
