import { cache } from "react";

import { canonicalHrIdForDisplay, hrIdsMatch } from "@/lib/hr-id";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { describeIncompleteWindow, resolveIncentiveWindow } from "@/lib/incentives/semester";
import { measurePediaAchievement } from "@/lib/incentives/pedia-achievement";
import { calculatePediaSplitIncentive, pediaSplitApplies } from "@/lib/incentives/pedia-split";
import {
  canSeeEmployee,
  resolveEmployeeIdentityId,
  getSalesScope,
  normalizeHrId,
  normalizeHrIdForAccess,
  normalizeRole,
  normalizeLineName,
  type AccessContext,
  type BusinessScope,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { devSafePromiseAll } from "@/lib/utils/dev-safe-promise-all";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { uploadedEmployeePhotoUrl } from "@/lib/employees/employee-photo";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { daysBetweenDateOnly } from "@/lib/date-only";
import {
  createPortalSalesLineScope,
  employeeMatchesPortalSalesScope,
} from "@/lib/employee-portal/sales-scope";
import { isEmployeePortalBetaNavEnabled } from "@/lib/employee-portal/navigation";
import { logError } from "@/lib/observability/log";
import { loadOfferOutBySeat } from "@/lib/offers/seat-offers";
import { offerSeatKeyForVacancy, type SeatOfferOut } from "@/lib/offers/seat-offer-label";
import {
  buildCompanyDsmPerformanceFromSos,
  buildCompanyMedRepPerformanceFromSos,
  buildDsmTeamPerformanceFromSos,
  buildNsmDsmPerformanceFromSos,
  buildRmRegionalPerformanceFromSos,
  type SosCompanyLineMeta,
} from "@/lib/employee-portal/sos-team-performance";
import { SALES_LINES, resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { periodLabel } from "@/lib/business-review/period-format";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import { SALES_VS_TARGET_FLOOR, loadAchievementRange, loadPublishedPeriodKeys, salesVsTargetPeriods } from "@/lib/sales/vs-target";
import { latestPublishedPeriodForLine, rankLineAchieversForPeriod } from "@/lib/employee-portal/line-top-achievers";
import { getEmployeeDirectory, type EmployeeDirectoryData, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  isDateWithinLifecycleRiskWindow,
  lifecycleRiskWindows,
  probationEndDateFromHire,
  resolveEmployeeLifecycleJourney,
} from "@/lib/lifecycle-risk/metrics";
import { classifyEmployeeNode } from "@/lib/workforce-classification";
import { salesRecordMatchesSeatContinuity } from "@/lib/workforce/seat-lifecycle";
import {
  lineScopeIncludesEmployee,
  normalizeRegionLabel,
  isWithinManagerHierarchy,
  regionsWithinManagerHierarchy,
  reportsToManagerSeat,
  sameWorkforceLine,
  selectVacantManagerSeat,
  type ResolvedVacantSeat,
} from "@/lib/workforce/hierarchy-resolver";
import { canAccessCompanyVacancies } from "@/lib/reports/organogram";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import {
  buildPayrollExpenseDsmSummaries,
  summarizePayrollExpenses,
} from "@/lib/outstation/expense-metrics";
import { expenseApprovalState } from "@/lib/outstation/approval-state";
import { isImportedHistoryTrip } from "@/lib/outstation/imported-history";
import { roundCurrency } from "@/lib/payroll/money";
import {
  dedupeHistoricalExpensesByTrip,
  listOutstationRequestExpenses,
  listPayrollExpenseReports,
  listPayrollExpenses,
} from "@/lib/outstation/expenses";
import {
  calculatePayrollParts,
  normalizePayrollPaymentMode,
  resolveFixedSalaryAmounts,
} from "@/lib/payroll/policy";
import { quotedOrClause } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  PayrollExpenseApproval,
  PayrollExpenseReport,
  SalaryRecord,
} from "@/lib/payroll/types";
import { buildPortalSalesDashboardMetrics } from "@/lib/sales/metrics";
import type { SalesDashboardData } from "@/lib/sales/types";
import { calculateIncentive2026 } from "@/lib/incentives/scheme-2026";
import { canonicalSalesLine } from "@/lib/sales/others";
import { getMarketingRequestDraftWorkspace } from "@/lib/marketing-requests/service";
import { resolveViewerAllowedLines } from "@/lib/auth/scope-visibility";
import { withLiveOutstationEmployeeNames } from "@/lib/outstation/employee-name";
import { mapOutstationRequestRowToPayrollApproval } from "@/lib/outstation/payroll-expense-mapping";
import { getVacationPlatformMetricRows } from "@/lib/vacation/service";
import {
  loadCanonicalPortalSalesRows,
  selectCanonicalRowsForHrIds,
} from "@/lib/employee-portal/portal-sales-canonical";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmployeePortalDocument = {
  category: string;
  createdAt: string | null;
  id: string;
  name: string;
  status: string;
  url: string | null;
};

export type SalaryTrendPoint = {
  grossSalary: number;
  label: string;
  month: number;
  netSalary: number;
  totalAdditions: number;
  totalDeductions: number;
  year: number;
};

export type EmploymentJourney = {
  contractRenewalDate: string | null;
  contractSignedDate: string | null;
  daysUntilProbationEnd: number | null;
  daysUntilRenewal: number | null;
  hireDate: string | null;
  probationActive: boolean;
  probationEndDate: string | null;
  renewalRisk: "critical" | "healthy" | "missing" | "upcoming" | "warning";
  serviceDurationDays: number;
};

export type PortalNotification = {
  category: string;
  href: string | null;
  id: string;
  message: string;
  scheduledFor: string | null;
  sentAt: string | null;
  status: string;
  subject: string;
};

export type PortalInsight = {
  kind: "critical" | "info" | "warning";
  message: string;
};

export type EmployeePortalData = {
  access: {
    expensesRows: number;
    payrollPeriods: number;
    salesScope: BusinessScope;
    teamMembers: number;
  };
  batchStatus: string | null;
  documents: EmployeePortalDocument[];
  employee: EmployeeDirectoryRow;
  employmentJourney: EmploymentJourney;
  expenses: {
    approvedAmount: number;
    approvedCount: number;
    latestEntries: Array<{
      date: string;
      description: string;
      hrApproved: boolean;
      hrNotes: string;
      status: string;
      total: number;
    }>;
    latestSubmittedAt: string | null;
    pendingAmount: number;
    pendingCount: number;
    totalAmount: number;
    totalRows: number;
  };
  insights: PortalInsight[];
  latestRecord: SalaryRecord | null;
  notifications: PortalNotification[];
  payroll: {
    batchId: string | null;
    batchLabel: string;
    grossSalary: number;
    latestHireDate: string | null;
    line: string | null;
    netSalary: number;
    totalAdditions: number;
    totalDeductions: number;
    salaryTrend: SalaryTrendPoint[];
    netVsLastMonth: number | null;
    grossVsLastMonth: number | null;
    deductionsVsLastMonth: number | null;
    bonus: number;
    incentive: number;
    loans: number;
    otherDeductions: number;
    socialInsurance: number;
    incomeTax: number;
    fuelAllowance: number;
    extraCostOfLiving: number;
  };
  payslips: {
    latestBatchId: string | null;
    latestBatchLabel: string | null;
    periods: number;
  };
  previousRecord: SalaryRecord | null;
  sales: {
    achievementRate: number;
    activeProducts: number;
    lineLabel: string | null;
    targetValue: number;
    totalValue: number;
    unitsSold: number;
  };
  salaryTrend: SalaryTrendPoint[];
};

type PortalPayrollSourceRow = Record<string, unknown>;

type PortalSalesFilters = {
  family?: string;
  month?: string | number | null;
  period?: string | null;
  product?: string;
  products?: string[];
  salesType?: string;
  year?: string | number | null;
  territory?: string;
  sales_type?: string;
  line?: string | string[] | null;
};

type PortalPayrollRecord = SalaryRecord & {
  createdAt?: string | null;
  month?: number | null;
  period?: string | null;
  status?: string | null;
  year?: number | null;
};

type PayrollBatchRow = {
  batchId: string;
  id: string;
  createdAt: string;
  label: string;
  month?: number | null;
  status: string;
  year?: number | null;
};

type EmployeePortalPayrollDashboard = {
  batch: PayrollBatchRow | null;
  batches: PayrollBatchRow[];
  previousRecords: SalaryRecord[];
  records: PortalPayrollRecord[];
  scope: "all_time" | "batch";
};

type PortalCurrentUser = {
  hrId: string | null;
  line: string | null;
  loginId: string;
  managerHrId: string | null;
  name: string | null;
  salesScopeOverride: string | null;
  role: string;
};

type PortalAuthRow = {
  hr_id: string | null;
  line: string | null;
  login_id: string | null;
  manager_hr_id: string | null;
  name: string | null;
  role: string | null;
  sales_scope_override: string | null;
};

export const EMPLOYEE_PORTAL_PROFILE_NOT_LINKED_MESSAGE =
  "Your employee profile is not linked yet. Please contact HR.";

type PortalSalesNormalized = {
  hrId: string;
  managerHrId: string | null;
  family: string;
  line: string | null;
  month: number | null;
  period: string;
  product: string;
  /** The product CODE (`GU001`, `LA002`, …) beside the display name — see CanonicalPortalSalesRow
   * in portal-sales-canonical.ts. The Pedia split incentive keys on it; nothing keys on the name. */
  productCode: string;
  salesType: string;
  salesUnits: number;
  salesValue: number;
  targetValue: number;
  territory: string;
  year: number | null;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deliberate no-op: informational traces that would be noise in production.
 * NEVER route a failed query through this — use logPortalFailure.
 */
function logPortalDebug(message: string, payload?: unknown) {
  void message;
  void payload;
}

/**
 * A portal query that FAILED, as opposed to one that legitimately returned nothing.
 *
 * Every one of these used to go through logPortalDebug, which discards its arguments. The
 * caller then returned an empty array, so a failed payslip or sales read rendered as
 * "no payslips" / no sales — identical to the honest empty state, and invisible in logs,
 * Sentry and app_error_events alike. An employee looking at an empty Payslips tab had no way
 * to tell "you have none" from "we could not read them", and neither did anyone supporting
 * them.
 *
 * This does not change what the employee SEES — the callers still degrade to empty, so one
 * transient failure cannot blank the whole portal — but the failure is now diagnosable
 * instead of silent.
 */
function logPortalFailure(message: string, payload?: unknown) {
  logError(`employee-portal: ${message}`, {
    labels: { event: "employee_portal_query_failed" },
    error: payload,
  });
}

function resolvePortalSalesLineFilter(
  currentUser: Pick<PortalCurrentUser, "line">,
  employee?: Pick<EmployeeDirectoryRow, "lineName"> | null,
) {
  const line = normalizeFilter(employee?.lineName) ?? normalizeFilter(currentUser.line);
  return line ? resolvePortalSalesFilterLineValues(line) : [];
}

function resolvePortalSalesFilterLineValues(value: string | string[] | null | undefined) {
  const rawValues = Array.isArray(value) ? value : value == null ? [] : [value];
  const lineCandidates = new Set<string>();

  rawValues.forEach((entry) => {
    const currentLine = normalizeFilter(entry);
    if (!currentLine) return;

    lineCandidates.add(currentLine);

    const normalized = canonicalSalesLine(currentLine);
    if (normalized === "cns") {
      lineCandidates.add("O-3");
      lineCandidates.add("cns");
    }

    if (normalized === "o 3") {
      lineCandidates.add("CNS");
      lineCandidates.add("cns");
    }

    if (normalized === "o 2" || normalized === "anti infective") {
      lineCandidates.add("O-2");
      lineCandidates.add("anti infective");
    }
  });

  return Array.from(lineCandidates);
}

function isPortalFilterText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSalesFilterToken(value: unknown): string {
  const token = normalizeFilter(value);
  return token ? token.toLowerCase() : "";
}

function parseSalesFilterMonth(value: unknown): number | null {
  if (!isPortalFilterText(value)) return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function toText(value: unknown) {
  if (value == null) return "";
  return String(value).trim();
}

function toSafeArray<T>(value: Array<T> | null | undefined) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown) {
  if (value == null || value === "") return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function positiveMoneyOrNull(value: number | null | undefined) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function finiteMoneyOrNull(value: number | null | undefined) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function fetchEmployeeSalaryStructure(hrId: string) {
  const { data } = await getSupabaseAdmin()
    .from("employee_salary_structure")
    .select("base_salary,cost_of_living,fuel_allowance,social_insurance,income_taxes")
    .eq("employee_hr_id", canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase())
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    baseSalary: Number(data.base_salary),
    costOfLiving: Number(data.cost_of_living ?? 0),
    fuelAllowance: Number(data.fuel_allowance ?? 0),
    socialInsurance: Number(data.social_insurance ?? 0),
    incomeTaxes: Number(data.income_taxes ?? 0),
  };
}

type FixedSalaryReference = {
  baseSalary: number;
  basicSalary: number;
  extraCostOfLiving: number;
  fuelAllowance: number;
  grossSalary: number;
  netSalary: number;
  socialInsurance: number;
  taxes: number;
};

function resolveFixedSalaryReference({
  employee,
  fallbackAllowances,
  salaryStructure,
}: {
  employee: EmployeeDirectoryRow;
  fallbackAllowances: { extraCostOfLiving: number; fuelAllowance: number };
  salaryStructure: Awaited<ReturnType<typeof fetchEmployeeSalaryStructure>>;
}): FixedSalaryReference {
  const extraCostOfLiving =
    finiteMoneyOrNull(salaryStructure?.costOfLiving) ??
    finiteMoneyOrNull(employee.extraCostOfLiving) ??
    fallbackAllowances.extraCostOfLiving;
  const fuelAllowance =
    finiteMoneyOrNull(salaryStructure?.fuelAllowance) ??
    finiteMoneyOrNull(employee.fuelAllowance) ??
    fallbackAllowances.fuelAllowance;

  const baseSalary =
    positiveMoneyOrNull(salaryStructure?.baseSalary) ??
    positiveMoneyOrNull(employee.baseSalary) ??
    null;
  const fixedSalary = resolveFixedSalaryAmounts({
    baseSalary,
    basicSalary: positiveMoneyOrNull(employee.basicSalary),
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: positiveMoneyOrNull(employee.grossSalary),
    netSalary: positiveMoneyOrNull(employee.netSalary),
    socialInsurance:
      finiteMoneyOrNull(salaryStructure?.socialInsurance) ??
      finiteMoneyOrNull(employee.socialInsurance) ??
      0,
    taxes:
      finiteMoneyOrNull(salaryStructure?.incomeTaxes) ??
      finiteMoneyOrNull(employee.taxes) ??
      0,
  });
  const socialInsurance =
    finiteMoneyOrNull(salaryStructure?.socialInsurance) ??
    finiteMoneyOrNull(employee.socialInsurance) ??
    0;
  const taxes =
    finiteMoneyOrNull(salaryStructure?.incomeTaxes) ??
    finiteMoneyOrNull(employee.taxes) ??
    0;

  return {
    baseSalary: fixedSalary.baseSalary,
    basicSalary: fixedSalary.basicSalary,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: fixedSalary.grossSalary,
    netSalary: fixedSalary.netSalary,
    socialInsurance,
    taxes,
  };
}

function pickText(row: PortalPayrollSourceRow, keys: string[]) {
  for (const key of keys) {
    const value = toText((row as Record<string, unknown>)[key]);
    if (value) return value;
  }
  return "";
}

function pickNumber(row: PortalPayrollSourceRow, keys: string[]) {
  for (const key of keys) {
    const value = toNumber((row as Record<string, unknown>)[key]);
    if (value !== 0 || (key in (row as Record<string, unknown>))) return value;
  }
  return 0;
}

function parsePeriodToMonthYear(value: string) {
  const [yearText, monthText] = value.split("-").map((entry) => entry.trim());
  const year = Number(yearText);
  const month = Number(monthText);
  if (Number.isFinite(year) && Number.isFinite(month)) return { month, year };
  return null;
}

function normalizeTeamComparisonPeriod(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "all" || normalized === "all periods" || normalized === "all-periods" || normalized === "all_periods") return null;
  return /^\d{4}-\d{2}$/.test(normalized) ? normalized : null;
}

export function normalizeTeamComparisonPeriods(value: string | string[] | null | undefined) {
  const values = Array.isArray(value) ? value : [value];
  return Array.from(
    new Set(
      values
        .flatMap((entry) => String(entry ?? "").split(","))
        .map((entry) => normalizeTeamComparisonPeriod(entry))
        .filter(Boolean) as string[],
    ),
  ).sort();
}

function toInt(value: unknown): number | null {
  const normalized = Number(toText(value));
  return Number.isFinite(normalized) ? normalized : null;
}

function pickOptionalText(row: Record<string, unknown>, keys: string[]) {
  const text = pickText(row as PortalPayrollSourceRow, keys);
  return text.length > 0 ? text : null;
}

function mapPayrollRecordFromPayslipView(row: PortalPayrollSourceRow): PortalPayrollRecord {
  const period = pickText(row, ["period", "payroll_period"]);
  const year = parseIntValue(row, ["year", "payroll_year"]);
  const month = parseIntValue(row, ["month", "payroll_month"]);
  const fullName = pickText(row, ["full_name", "employee_name", "name", "employee"]);
  const hasFirstPart = pickOptionalText(row, ["first_part"]) !== null;
  const hasSecondPart = pickOptionalText(row, ["second_part"]) !== null;
  const hasTotalAdditions = pickOptionalText(row, ["total_additions", "totalAdditions"]) !== null;
  const hasTotalDeductions =
    pickOptionalText(row, ["total_deductions", "totalDeductions", "deductions"]) !== null;

  const mapped = {
    area: pickText(row, ["area", "line", "employee_line"]),
    batchId: pickText(row, ["batch_id", "batchId", "payroll_batch_id"]),
    baseSalary: pickNumber(row, ["base_salary", "baseSalary"]),
    bonus: pickNumber(row, ["bonus", "incentive_bonus", "extra_bonus"]),
    // 0 when the payslip view does not carry the column, or when the row
    // predates the Working Days rule (2026-09-04) — both mean "not recorded",
    // and the portal prints nothing rather than inventing a day count.
    calendarDays: pickNumber(row, ["calendar_days", "calendarDays"]),
    crm: pickNumber(row, ["crm"]),
    employeeCode: pickText(row, ["employee_code", "employee_hr_id", "hr_id", "emp_code"]),
    hrId: pickText(row, ["hr_id", "employee_hr_id", "employee_code"]),
    employmentIncomeTax: pickNumber(row, ["employment_income_tax", "employmentTax", "income_tax"]),
    expenses: pickNumber(row, ["expenses"]),
    extraCostOfLiving: pickNumber(row, ["extra_cost_of_living"]),
    fingerPrint: pickNumber(row, ["finger_print", "fingerprint"]),
    firstPart: pickNumber(row, ["first_part"]),
    fuelAllowance: pickNumber(row, ["fuel_allowance"]),
    fullName,
    governmentalDeductions: pickNumber(row, ["governmental_deductions", "governmentalDeductions"]),
    grossSalary: pickNumber(row, ["gross_salary", "grossSalary", "gross"]),
    hireDate: pickOptionalText(row, ["hire_date", "hireDate", "contract_start_date"]) as string | null,
    id: pickText(row, ["id", "record_id"]),
    incentive: pickNumber(row, ["incentive"]),
    jobTitle: pickText(row, ["job_title", "jobTitle"]),
    line: pickText(row, ["line", "area", "employee_line"]),
    loans: pickNumber(row, ["loans", "loan"]),
    medicalInsurance: pickNumber(row, ["medical_insurance", "medicalInsurance"]),
    monthSalary: pickNumber(row, ["month_salary", "monthSalary"]),
    nameAr: pickOptionalText(row, ["name_ar", "arabic_name", "employee_name_ar"]),
    netSalary: pickNumber(row, ["net_salary", "netSalary", "net"]),
    otherAdditions: pickNumber(row, ["other_additions"]),
    otherDeductions: pickNumber(row, ["other_deductions"]),
    overtime: pickNumber(row, ["overtime"]),
    payrollComment: pickOptionalText(row, ["comment", "payroll_comment", "notes"]),
    paymentMode: pickText(row, ["payment_mode", "paymentMode", "salary_payment_mode"]),
    secondPart: pickNumber(row, ["second_part"]),
    status: pickText(row, ["status", "batch_status", "payroll_status"]),
    socialInsurance: pickNumber(row, ["social_insurance", "socialInsurance"]),
    totalAdditions: pickNumber(row, ["total_additions", "totalAdditions"]),
    totalDeductions: pickNumber(row, ["total_deductions", "totalDeductions", "deductions"]),
    year,
    month,
    createdAt: pickText(row, ["created_at", "createdAt", "date"]),
    period,
    unpaidVacations: pickNumber(row, ["unpaid_vacations", "unpaidVacations"]),
    workingDays: pickNumber(row, ["working_days", "workingDays"]),
  };

  const calculatedTotalAdditions =
    mapped.expenses +
    mapped.incentive +
    mapped.overtime +
    mapped.bonus +
    mapped.extraCostOfLiving +
    mapped.fuelAllowance +
    mapped.otherAdditions;
  const calculatedTotalDeductions =
    mapped.socialInsurance +
    mapped.employmentIncomeTax +
    mapped.crm +
    mapped.fingerPrint +
    mapped.unpaidVacations +
    mapped.medicalInsurance +
    mapped.loans +
    mapped.otherDeductions;
  const paymentMode = mapped.paymentMode
    ? normalizePayrollPaymentMode(mapped.paymentMode)
    : mapped.firstPart > 0 && mapped.firstPart >= mapped.netSalary - 1
      ? "one_part"
      : "two_parts";
  const fixedSalary = resolveFixedSalaryAmounts({
    baseSalary: mapped.baseSalary,
    employmentIncomeTax: mapped.employmentIncomeTax,
    extraCostOfLiving: mapped.extraCostOfLiving,
    fuelAllowance: mapped.fuelAllowance,
    grossSalary: mapped.grossSalary,
    netSalary: mapped.netSalary,
    socialInsurance: mapped.socialInsurance,
  });
  const parts = calculatePayrollParts({
    additions: mapped.expenses + mapped.incentive + mapped.overtime + mapped.bonus + mapped.otherAdditions,
    deductions:
      mapped.crm +
      mapped.fingerPrint +
      mapped.unpaidVacations +
      mapped.medicalInsurance +
      mapped.loans +
      mapped.otherDeductions,
    baseSalary: fixedSalary.baseSalary,
    extraCostOfLiving: mapped.extraCostOfLiving,
    fuelAllowance: mapped.fuelAllowance,
    paymentMode,
    previousExpenses: 0,
    secondPartAdditions: mapped.expenses + mapped.incentive,
  });
  const totalAdditions = hasTotalAdditions ? mapped.totalAdditions : calculatedTotalAdditions;
  const totalDeductions = hasTotalDeductions ? mapped.totalDeductions : calculatedTotalDeductions;
  const firstPart = hasFirstPart ? mapped.firstPart : parts.firstPart;
  const secondPart = hasSecondPart ? Math.max(0, mapped.secondPart) : parts.secondPart;

  return {
    ...mapped,
    baseSalary: fixedSalary.baseSalary,
    firstPart,
    governmentalDeductions: mapped.governmentalDeductions > 0
      ? mapped.governmentalDeductions
      : mapped.socialInsurance + mapped.employmentIncomeTax,
    grossSalary: fixedSalary.grossSalary,
    monthSalary: mapped.monthSalary > 0
      ? mapped.monthSalary
      : firstPart + secondPart,
    netSalary: fixedSalary.netSalary,
    paymentMode,
    secondPart,
    totalAdditions,
    totalDeductions,
  };
}

function isPayrollRowForCurrentEmployee(row: PortalPayrollSourceRow, normalizedHrId: string | null) {
  if (!normalizedHrId) return false;
  const canonicalHrId = normalizeHrIdForAccess(normalizedHrId) ?? null;
  const candidates = [
    pickText(row, ["hr_id", "employee_hr_id", "employee_code"]),
    pickText(row, ["employee_code", "hr_id", "employee_hr_id"]),
    pickText(row, ["emp_code", "employee_id"]),
  ].flatMap((value) => {
    const normalized = normalizeHrId(value);
    const canonical = normalizeHrIdForAccess(value);
    const values: string[] = [];
    if (normalized) values.push(normalized);
    if (canonical && canonical !== normalized) values.push(canonical);
    return values;
  });

  const identitySet = new Set(candidates);
  if (identitySet.has(normalizedHrId)) return true;
  if (canonicalHrId && identitySet.has(canonicalHrId)) return true;
  return false;
}

function parseIntValue(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = toInt((row as Record<string, unknown>)[key]);
    if (value !== null) return value;
  }
  return null;
}

function mapSalaryTrendPointFromHistoryView(row: PortalPayrollSourceRow): SalaryTrendPoint | null {
  const month = parseIntValue(row, ["month", "payroll_month"]);
  const year = parseIntValue(row, ["year", "payroll_year"]);
  if (!month || !year) return null;

  const label = formatBatchLabel(month, year);
  return {
    grossSalary: toNumber((row as Record<string, unknown>).gross_salary ?? (row as Record<string, unknown>).grossSalary),
    label,
    month,
    netSalary: toNumber((row as Record<string, unknown>).net_salary ?? (row as Record<string, unknown>).netSalary),
    totalAdditions: toNumber((row as Record<string, unknown>).total_additions ?? (row as Record<string, unknown>).totalAdditions),
    totalDeductions: toNumber((row as Record<string, unknown>).total_deductions ?? (row as Record<string, unknown>).totalDeductions),
    year,
  };
}

// hasMissingColumnError() lived here. Its only callers were the phantom-column probes in
// fetchPortalPayslips, and it was the thing that made them look safe: it treated ANY 42703 as
// "that column is missing, carry on", so a query against a column that never existed reported
// itself as a handled condition instead of a mistake. Removed with them. isMissingColumnError()
// below is a different, narrower helper and is still in use.

function buildSalaryTrendFromRecords(records: PortalPayrollRecord[]): SalaryTrendPoint[] {
  const rows = toSafeArray(records)
    .map((record) => {
      const month = Number(record.month ?? 0);
      const year = Number(record.year ?? 0);
      if (!month || !year) return null;

      return {
        grossSalary: Number(record.grossSalary ?? 0),
        label: formatBatchLabel(month, year),
        month,
        netSalary: Number(record.netSalary ?? 0),
        totalAdditions: Number(record.totalAdditions ?? 0),
        totalDeductions: Number(record.totalDeductions ?? 0),
        year,
      };
    })
    .filter((point): point is SalaryTrendPoint => Boolean(point))
    .sort((left, right) => left.year * 12 + left.month - (right.year * 12 + right.month));

  return rows.slice(-6);
}

function normalizeFilter(value: unknown) {
  return isPortalFilterText(value) ? value.trim() : null;
}

export function toCanonicalPortalHrId(hrId: string | null | undefined) {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return null;
  return normalizeHrIdForAccess(normalized) || normalized;
}

function findDirectoryEmployeeByHrId(
  directory: EmployeeDirectoryData,
  hrId: string | null | undefined,
) {
  const currentCanonical = toCanonicalPortalHrId(hrId);
  if (!currentCanonical) return null;

  return (
    directory.employees.find(
      (employee) => toCanonicalPortalHrId(employee.hrId) === currentCanonical,
    ) ?? null
  );
}

/**
 * Authoritatively resolves a manager's display name directly from the employees
 * table by HR_ID. Used so an employee's own hero card always shows their direct
 * manager even under self-scope (where the scoped directory may not surface the
 * manager record). Returns null only when there is genuinely no manager (CEO/top).
 *
 * MEMOIZED PER REQUEST (React cache(), 2026-10-01, "slow to transfer between page and page"): the
 * portal shell in the layout and the page under it both name the same manager on a hard load, and
 * each asked the employees table twice to do it. Keyed on the HR id string (compared by value), so
 * one request resolves it once; cache() never spans two requests, so a manager change made a
 * moment ago is still read live on the next one. It never throws — every read ignores its error.
 */
const resolveDirectManagerName = cache(async (employeeHrId: string | null | undefined) => {
  const target = String(employeeHrId ?? "").trim();
  if (!target) return null;
  const supabase = getSupabaseAdmin();
  // Live lookup of the CURRENT manager_hr_id (the cached directory can be stale
  // right after a manager change) AND the manager's display name, in ONE read through the
  // `employees_manager_hr_id_fkey` self-reference (Phoenix CRM performance audit, 2026-10-16: the two
  // reads below ran one after the other on every portal page's first load). Should the embed ever be
  // refused, the two-read path below answers exactly as before.
  const { data: joined, error: joinError } = await supabase
    .from("employees")
    .select("manager_hr_id, manager:manager_hr_id(full_name,nickname)")
    .eq("hr_id", target)
    .maybeSingle();
  if (!joinError) {
    const row = joined as { manager_hr_id?: string | null; manager?: unknown } | null;
    if (!String(row?.manager_hr_id ?? "").trim()) return null;
    const embedded = (Array.isArray(row?.manager) ? row?.manager[0] : row?.manager) as
      | { full_name?: string | null; nickname?: string | null }
      | null
      | undefined;
    const embeddedName = embedded?.full_name;
    return embeddedName ? resolveEmployeeDisplayName(String(embeddedName), embedded?.nickname) : null;
  }
  const { data: self } = await supabase
    .from("employees")
    .select("manager_hr_id")
    .eq("hr_id", target)
    .maybeSingle();
  const managerHrId = String((self as { manager_hr_id?: string | null } | null)?.manager_hr_id ?? "").trim();
  if (!managerHrId) return null;
  const { data: manager } = await supabase
    .from("employees")
    .select("full_name,nickname")
    .eq("hr_id", managerHrId)
    .maybeSingle();
  const managerRow = manager as { full_name?: string | null; nickname?: string | null } | null;
  const fullName = managerRow?.full_name;
  return fullName ? resolveEmployeeDisplayName(String(fullName), managerRow?.nickname) : null;
});

function formatBatchLabel(month?: number | null, year?: number | null) {
  if (!month || !year) return "No payroll period";
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function isMissingDocumentColumn(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("column") && message.includes("does not exist");
}

function isMissingColumnError(error: unknown, columnName: string) {
  if (!error) return false;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("column") && message.includes("does not exist") && message.includes(columnName.toLowerCase());
}

function isMissingDocumentTable(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("employee_documents") ||
    (message.includes("relation") && message.includes("does not exist")) ||
    message.includes("schema cache")
  );
}

function documentText(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function documentUrl(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function mapDocument(row: Record<string, unknown>, index: number): EmployeePortalDocument {
  return {
    category: documentText(
      row.document_type ?? row.category ?? row.type ?? row.document_category,
      "HR Document",
    ),
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    id: String(row.id ?? row.document_id ?? `doc-${index + 1}`),
    name: documentText(
      row.file_name ?? row.document_name ?? row.name ?? row.title,
      `Document ${index + 1}`,
    ),
    status: documentText(row.status ?? row.verification_status, "Available"),
    url: documentUrl(row.file_url ?? row.public_url ?? row.storage_url ?? row.path),
  };
}

async function listEmployeeDocuments(hrId: string): Promise<EmployeePortalDocument[]> {
  const supabase = getSupabaseAdmin();
  const queries = [
    () => supabase.from("employee_documents").select("*").eq("employee_hr_id", canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()).order("created_at", { ascending: false }),
    () => supabase.from("employee_documents").select("*").eq("hr_id", canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()).order("created_at", { ascending: false }),
  ];

  for (const runQuery of queries) {
    const { data, error } = await runQuery();

    if (!error) {
      return (data ?? []).map((row, index) => mapDocument(row as Record<string, unknown>, index));
    }

    if (isMissingDocumentTable(error)) {
      return [];
    }

    if (!isMissingDocumentColumn(error)) {
      throw error;
    }
  }

  return [];
}

function computeEmploymentJourney(employee: EmployeeDirectoryRow): EmploymentJourney {
  return resolveEmployeeLifecycleJourney({
    contractRenewalDate: employee.contractRenewalDate,
    contractSignedDate: employee.hireDate,
    hireDate: employee.hireDate,
  });
}

async function fetchSalaryTrend(
  hrId: string,
  batchMap: Map<string, { month: number; year: number }>,
): Promise<SalaryTrendPoint[]> {
  if (!hrId) return [];

  const supabase = getSupabaseAdmin();
  const normalizedHrId = normalizeHrId(hrId) ?? "";

  try {
    const baseQuery = supabase
      .from("v_employee_portal_salary_history")
      .select("*")
      .eq("hr_id", normalizedHrId);
    const { data, error } = await baseQuery;
    if (error) {
      logPortalFailure("salary history query error", { error, hrId: normalizedHrId });
      return [];
    }

    const points: SalaryTrendPoint[] = (data ?? [])
      .map((row) => {
        const mapped = mapSalaryTrendPointFromHistoryView(row as PortalPayrollSourceRow);
        if (!mapped) return null;

        const batchIdCandidates = toSafeArray([
          String((row as Record<string, unknown>).batch_id ?? ""),
          String((row as Record<string, unknown>).payroll_batch_id ?? ""),
          String((row as Record<string, unknown>).batch ?? ""),
        ])
          .map((value) => value.trim())
          .filter(Boolean);
        const matchedBatchId = batchIdCandidates.find((batchId) => batchMap.has(batchId));
        const batch = matchedBatchId ? batchMap.get(matchedBatchId) : null;
        if (!batch) {
          return mapped;
        }

        return {
          ...mapped,
          label: formatBatchLabel(batch.month, batch.year),
          month: batch.month,
          year: batch.year,
        };
      })
      .filter(Boolean) as SalaryTrendPoint[];

    return points
      .sort((left, right) => left.year * 12 + left.month - (right.year * 12 + right.month))
      .slice(-6);
  } catch (error) {
    logPortalFailure("salary history query error", { error, hrId: normalizedHrId });
    return [];
  }
}

async function fetchPortalNotifications(hrId: string): Promise<PortalNotification[]> {
  const supabase = getSupabaseAdmin();
  const canonicalHrId = canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase();
  try {
    const { data } = await supabase
      .from("notification_events")
      .select("id,category,subject,scheduled_for,sent_at,status,metadata,recipients")
      // The first arm is the ordinary `or=` filter grammar, so its value is QUOTED —
      // `canonicalHrIdForDisplay` maps and upper-cases an id, it does not restrict its characters,
      // and a `,` in one would end the arm early and leave the second one reading as a condition of
      // its own (AGENTS.md MR-B04). The second arm is NOT that grammar: `cs.{…}` is a PostgreSQL
      // array literal, whose own escaping this repo has not measured against production, so it is
      // deliberately left exactly as it was.
      .or(`${quotedOrClause("employee_hr_id", "eq", canonicalHrId)},recipients.cs.{${canonicalHrId}}`)
      .order("scheduled_for", { ascending: false })
      .limit(5);

    return (data ?? []).filter((row) => {
      const r = row as Record<string, unknown>;
      if (String(r.category ?? "").toLowerCase() !== "probation") return true;
      const recipients = Array.isArray(r.recipients) ? r.recipients : [];
      return recipients.some((recipient) => hrIdsMatch(String(recipient ?? "").trim(), hrId));
    }).map((row) => {
      const r = row as Record<string, unknown>;
      const metadata = r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
        ? r.metadata as Record<string, unknown>
        : {};
      return {
        category: String(r.category ?? "General"),
        href: typeof metadata.href === "string" ? metadata.href : null,
        id: String(r.id ?? ""),
        message: typeof metadata.message === "string" ? metadata.message : String(r.subject ?? "Notification"),
        scheduledFor: r.scheduled_for ? new Date(String(r.scheduled_for)).toISOString() : null,
        sentAt: r.sent_at ? new Date(String(r.sent_at)).toISOString() : null,
        status: String(r.status ?? "pending"),
        subject: String(r.subject ?? "Notification"),
      };
    });
  } catch {
    return [];
  }
}

function resolveSalesFilterValues(filters: PortalSalesFilters) {
  const products = toSafeArray(filters.products).map((value) => value.trim()).filter(Boolean);
  const lineValues = resolvePortalSalesFilterLineValues(filters.line);
  return {
    family: normalizeFilter(filters.family) ?? undefined,
    month: parseSalesFilterMonth(filters.month),
    period: normalizeFilter(filters.period) ?? undefined,
    product: normalizeFilter(filters.product) ?? undefined,
    products: products.length > 0 ? products : undefined,
    salesType: normalizeSalesFilterToken(filters.salesType),
    sales_type: normalizeSalesFilterToken(filters.sales_type),
    territory: normalizeFilter(filters.territory) ?? undefined,
    year: normalizeFilter(filters.year) ?? undefined,
    line: lineValues.length > 0 ? lineValues : undefined,
  };
}

// MEMOIZED PER REQUEST (React cache(), 2026-10-01, "slow to transfer between page and page"): the
// portal shell, the page and the loaders the page calls (getMedicalRepPortalData, then
// getEmployeePortalData inside it, and every team/vacancy panel) each resolved the viewer again —
// one to two app_auth_users reads apiece on every navigation. `access` is the request-cached object
// resolveAccessContextFromPage hands every caller by reference, so it is a stable key. No caller
// mutates the returned object (it is only read), and cache() never spans two requests.
const resolvePortalCurrentUser = cache(async (access: AccessContext): Promise<PortalCurrentUser> => {
  const supabase = getSupabaseAdmin();
  const fallbackHr = normalizeHrId(resolveEmployeeIdentityId(access));
  const loginId = normalizeHrId(access.loginId);

  let row: PortalAuthRow | null = null;
  if (loginId) {
    const { data: loginData } = await supabase
      .from("app_auth_users")
      .select("login_id,hr_id,line,manager_hr_id,name,role,sales_scope_override")
      .eq("login_id", loginId)
      .maybeSingle();
    if (loginData) row = loginData as PortalAuthRow;
  }

  if (!row && fallbackHr) {
    const { data: hrData } = await supabase
      .from("app_auth_users")
      .select("login_id,hr_id,line,manager_hr_id,name,role,sales_scope_override")
      .eq("hr_id", fallbackHr)
      .maybeSingle();
    if (hrData) row = hrData as PortalAuthRow;
  }

  const resolvedHrId = normalizeHrId(row?.hr_id) ?? normalizeHrId(fallbackHr);
  const resolvedSalesScopeOverride = normalizeFilter(row?.sales_scope_override);
  const scopedRole = row?.role ? normalizeRole(row.role) : normalizeRole(access.role);

  const currentUser = {
    hrId: resolvedHrId ? resolvedHrId.toUpperCase().trim() : null,
    line: normalizeFilter(row?.line) || null,
    loginId: (row?.login_id || access.loginId || "") as string,
    managerHrId: normalizeFilter(row?.manager_hr_id),
    name: normalizeFilter(row?.name),
    role: (scopedRole || access.role) as PhoenixRole,
    salesScopeOverride: (resolvedSalesScopeOverride
      ? resolvedSalesScopeOverride.toUpperCase()
      : null) as BusinessScope | null,
  };

  try {
    const directory = await getEmployeeDirectory();
    const employee =
      findDirectoryEmployeeByHrId(directory, currentUser.hrId) ??
      findDirectoryEmployeeByHrId(directory, access.hrId) ??
      findDirectoryEmployeeByHrId(directory, access.loginId);

    if (employee) {
      currentUser.hrId = employee.hrId;
      currentUser.line = currentUser.line ?? employee.lineName;
      currentUser.managerHrId = currentUser.managerHrId ?? employee.managerHrId;
      currentUser.name = currentUser.name ?? employee.displayName;
    }
  } catch {
    // Keep the auth-derived identity if the directory is temporarily unavailable.
  }

  return currentUser;
});

async function fetchPortalPayslips(hrId: string): Promise<PortalPayrollRecord[]> {
  const supabase = getSupabaseAdmin();
  const normalizedHrId = normalizeHrId(hrId) ?? "";
  const canonicalHrId = normalizeHrIdForAccess(normalizedHrId);
  if (!normalizedHrId) return [];

  const buildPayslipQuery = () => supabase
      .from("salary_records")
      .select("*, salary_batches!inner(year, month, status)")
      .in("salary_batches.status", ["approved", "locked"])
      .order("year", { foreignTable: "salary_batches", ascending: false })
      .order("month", { foreignTable: "salary_batches", ascending: false })
      .order("created_at", { ascending: false });

  /**
   * `salary_records` identifies the employee by `hr_id` AND NOTHING ELSE.
   *
   * This used to probe `employee_hr_id` and then `employee_code` as fallbacks, each guarded by a
   * "did that column exist?" check on the error it came back with. Neither column has ever
   * existed on this table — verified against the live `information_schema` of BOTH production and
   * staging — so the guards were reading a 42703 they had just caused. The cost was 70 failed
   * queries a day on production (35 for each phantom column, measured 2026-09-29): work Postgres
   * did and threw away, and 70 red `column ... does not exist` lines a day in the error log,
   * which is where a real fault has to be noticed.
   *
   * They were unreachable as fallbacks too: the exact-match branch could never reach
   * `employee_code`, because the `employee_hr_id` probe immediately before it always failed with
   * exactly the missing-column error that gated it. Both errors came from the canonical-id retry
   * lower down, whose guards inspected an error variable that was still null.
   *
   * The `ilike` contains-retry on `hr_id` below is the part that does real work and stays: an HR
   * id is stored with inconsistent casing and padding, so an exact match legitimately misses rows
   * that the canonical form finds.
   */
  const runPayslipQuery = async (value: string, exact = true) => {
    const query = exact
      ? buildPayslipQuery().ilike("hr_id", value)
      : buildPayslipQuery().ilike("hr_id", `%${value}%`);
    return query;
  };

  try {
    const exactMatch = await runPayslipQuery(normalizedHrId);
    // Surfaced rather than swallowed: a real read failure used to fall through the probes and
    // return an empty payslip list with nothing logged, which is indistinguishable from "this
    // employee has no payslips". The catch below logs it.
    if (exactMatch.error) throw exactMatch.error;
    const collected = [...toSafeArray(exactMatch.data)];

    if (collected.length === 0 && canonicalHrId && canonicalHrId !== normalizedHrId) {
      const byCanonicalContains = await runPayslipQuery(canonicalHrId, false);
      if (byCanonicalContains.error) throw byCanonicalContains.error;
      collected.push(...toSafeArray(byCanonicalContains.data));
    }

    const data = collected;
    const dataById = new Map<string, Record<string, unknown>>();
    data.forEach((row) => {
      const r = row as Record<string, unknown>;
      const rowId = String(r.id ?? `${r.batch_id ?? r.payroll_batch_id ?? "unknown"}-${r.month ?? r.payroll_month ?? "na"}-${r.year ?? r.payroll_year ?? "na"}`);
      dataById.set(rowId, r);
    });

    const mapped = [...dataById.values()]
      .filter((row) => isPayrollRowForCurrentEmployee(row as unknown as PortalPayrollSourceRow, normalizedHrId))
      .map((row) => {
        // Merge batch data into the row for the mapper
        const batchData = (row as Record<string, unknown>).salary_batches as Record<string, unknown> | undefined;
        const merged = {
          ...(row as Record<string, unknown>),
          year: batchData?.year,
          month: batchData?.month,
          status: batchData?.status,
        };
        return mapPayrollRecordFromPayslipView(merged as unknown as PortalPayrollSourceRow);
      });

    return mapped;
  } catch (error) {
    logPortalFailure("payroll query exception", { error, hr_id: normalizedHrId });
    return [];
  }
}

function resolvePortalBatchLabel(row: {
  month?: number | null;
  period?: string | null;
  year?: number | null;
}) {
  if (row.year && row.month) return formatBatchLabel(row.month, row.year);
  if (row.period) {
    const parsed = parsePeriodToMonthYear(row.period);
    if (parsed) return formatBatchLabel(parsed.month, parsed.year);
  }
  return "No payroll period";
}

function buildEmployeePayrollBatches(records: PortalPayrollRecord[]) {
  const map = new Map<string, PayrollBatchRow>();

  records.forEach((record) => {
    const batchId = record.batchId?.trim();
    if (!batchId || map.has(batchId)) return;
    const label = resolvePortalBatchLabel({
      month: record.month,
      period: record.period,
      year: record.year,
    });

    map.set(batchId, {
      id: batchId,
      batchId,
      createdAt: record.createdAt ?? new Date().toISOString(),
      label,
      month: record.month,
      status: record.status || "unknown",
      year: record.year,
    });
  });

  return [...map.values()].sort((left, right) => {
    const leftSort = (left.year ?? 0) * 12 + (left.month ?? 0);
    const rightSort = (right.year ?? 0) * 12 + (right.month ?? 0);
    return rightSort - leftSort;
  });
}

async function fetchPortalSalesRecords(
  hrId: string | string[] | null,
  filters: PortalSalesFilters = {},
): Promise<PortalSalesNormalized[]> {
  const hrIds = Array.isArray(hrId)
    ? (hrId.map((id) => normalizeHrId(id)).filter(Boolean) as string[])
    : hrId ? ([normalizeHrId(hrId)].filter(Boolean) as string[]) : [];
  const canonicalHrIds = Array.from(
    new Set(
      hrIds
        .map((id) => normalizeHrIdForAccess(id))
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const queryHrIds = Array.from(new Set([...hrIds, ...canonicalHrIds]));

  if (queryHrIds.length === 0 && !filters.line) return [];

  const normalizedFilters = resolveSalesFilterValues(filters);

  try {
    // Rule #1: SoS Monthly Closing is the only sales truth, so the portal reads the same
    // engine as the closing view and /sales-vs-target rather than the legacy
    // `v_employee_portal_sales`, which restates the same reps by up to −34%.
    //
    // One load for the whole window, narrowed in memory twice — the seat-continuity pass
    // below needs the same rows, and re-querying for them would buy nothing.
    const canonicalRows = await loadCanonicalPortalSalesRows(normalizedFilters);
    const directRecords =
      queryHrIds.length > 0 ? selectCanonicalRowsForHrIds(canonicalRows, queryHrIds) : canonicalRows;
    const continuityRecords = await selectPortalSalesSeatContinuityRecords({
      canonicalRows,
      currentHrIds: queryHrIds,
      filters,
    });
    return mergePortalSalesRecords([...directRecords, ...continuityRecords]);
  } catch (error) {
    logPortalFailure("sales query exception", { error, hr_ids: queryHrIds });
    return [];
  }
}

function portalSalesRecordKey(record: PortalSalesNormalized) {
  return [
    record.hrId,
    record.managerHrId ?? "",
    record.line ?? "",
    record.territory,
    record.period,
    record.product,
    record.salesType,
    record.salesUnits,
    record.salesValue,
    record.targetValue,
  ].join("|").toLowerCase();
}

function mergePortalSalesRecords(records: PortalSalesNormalized[]) {
  const seen = new Set<string>();
  const merged: PortalSalesNormalized[] = [];

  for (const record of records) {
    const key = portalSalesRecordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }

  return merged;
}

async function fetchPreviousSeatHrIdsForReplacement(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  currentHrId: string,
) {
  try {
    const { data, error } = await supabase
      .from("position_vacancies")
      .select("replacement_for_hr_id")
      .eq("filled_by_hr_id", currentHrId)
      .eq("status", "filled");

    if (error) {
      if (isMissingColumnError(error, "filled_by_hr_id") || isMissingColumnError(error, "replacement_for_hr_id")) {
        return [];
      }
      throw error;
    }

    return Array.from(
      new Set(
        ((data ?? []) as Array<{ replacement_for_hr_id?: string | null }>)
          .map((row) => normalizeHrId(row.replacement_for_hr_id))
          .filter((value): value is string => Boolean(value)),
      ),
    );
  } catch (error) {
    logPortalFailure("sales continuity vacancy lookup failed", { currentHrId, error });
    return [];
  }
}

/**
 * The rows a person inherits from the seat they took over.
 *
 * Canonical attribution resolves the occupant as of each period, so a replacement's own rows
 * start the month they arrived — the predecessor's months stay attributed to the predecessor.
 * That is correct bookkeeping and wrong for a portal, where the rep opens the page expecting
 * their territory's history. This pass adds those months back, using the SAME line+area+manager
 * predicate the legacy path used, applied to rows already loaded rather than re-queried.
 */
async function selectPortalSalesSeatContinuityRecords({
  canonicalRows,
  currentHrIds,
  filters,
}: {
  canonicalRows: PortalSalesNormalized[];
  currentHrIds: string[];
  filters: PortalSalesFilters;
}) {
  if (currentHrIds.length === 0 || filters.line) return [];

  const supabase = getSupabaseAdmin();
  const directory = await getEmployeeDirectory();
  const seats = (
    await devSafePromiseAll(
      currentHrIds.map((currentHrId) => async () => {
        const employee = findDirectoryEmployeeByHrId(directory, currentHrId);
        if (!employee?.lineName && !employee?.areaName) return null;
        const previousHrIds = await fetchPreviousSeatHrIdsForReplacement(supabase, currentHrId);
        return { currentHrId, employee, previousHrIds };
      }),
    )
  ).filter((seat): seat is {
    currentHrId: string;
    employee: EmployeeDirectoryRow;
    previousHrIds: string[];
  } => Boolean(seat));

  if (seats.length === 0) return [];

  try {
    // The predicate itself requires the line to match, so narrowing the rows by line first —
    // as the legacy query did — would only save work, never change the answer.
    return canonicalRows.filter((record) =>
      seats.some(({ currentHrId, employee, previousHrIds }) =>
        salesRecordMatchesSeatContinuity(
          {
            employeeHrId: record.hrId,
            hrId: record.hrId,
            line: record.line,
            managerHrId: record.managerHrId,
            territory: record.territory,
          },
          {
            areaId: employee.areaId,
            areaName: employee.areaName,
            currentHrId,
            lineId: employee.lineId,
            lineName: employee.lineName,
            managerHrId: employee.managerHrId,
            positionId: employee.positionId,
            positionTitle: employee.positionTitle,
            previousHrIds,
          },
        ),
      ),
    );
  } catch (error) {
    logPortalFailure("sales continuity match failed", { currentHrIds, error });
    return [];
  }
}

async function getEmployeePortalPayrollDashboard(hrId: string): Promise<EmployeePortalPayrollDashboard> {
  const records = await fetchPortalPayslips(hrId);
  const sortedRecords = [...records].sort((left, right) => {
    const leftValue = (left.year ?? 0) * 12 + (left.month ?? 0);
    const rightValue = (right.year ?? 0) * 12 + (right.month ?? 0);
    return rightValue - leftValue || (right.createdAt || "").localeCompare(left.createdAt || "");
  });

  const batches = buildEmployeePayrollBatches(sortedRecords);

  return {
    batch: batches.length > 0 ? batches[0] : null,
    batches,
    previousRecords: sortedRecords.slice(1) as SalaryRecord[],
    records: sortedRecords,
    scope: "batch",
  };
}

/**
 * The portal's sales dashboard PLUS the rows it was built from.
 *
 * The rows come back because the Pedia split incentive needs a per-PRODUCT reading of the same
 * data (src/lib/incentives/pedia-achievement.ts), and the dashboard has already folded products
 * away by the time it is returned. Re-fetching them downstream would re-run the seat-continuity
 * pass — a real query, not a cached one — for rows this call already holds.
 */
type ScopedPortalSales = {
  dashboard: SalesDashboardData;
  records: PortalSalesNormalized[];
};

async function getEmployeePortalSalesDashboard(
  hrId: string | string[] | null,
  filters: PortalSalesFilters = {},
): Promise<ScopedPortalSales> {
  const salesRecords = await fetchPortalSalesRecords(hrId, filters);
  const dashboard = buildPortalSalesDashboardMetrics(salesRecords);

  const products = Array.from(new Set(salesRecords.map((record) => record.product).filter(Boolean))).sort();
  const families = Array.from(new Set(salesRecords.map((record) => record.family).filter(Boolean))).sort();
  const periods = Array.from(new Set(salesRecords.map((record) => record.period).filter(Boolean))).sort();
  const salesTypes = Array.from(new Set(salesRecords.map((record) => record.salesType).filter(Boolean))).sort();
  const territories = Array.from(new Set(salesRecords.map((record) => record.territory).filter(Boolean))).sort();

  return {
    dashboard: {
      ...dashboard,
      summary: dashboard.summary ?? {},
      filters: {
        families,
        lines: [],
        periods,
        products,
        salesTypes,
        territories,
        managers: [],
      },
    },
    records: salesRecords,
  };
}

function salesDashboardHasData(dashboard: SalesDashboardData | null) {
  if (!dashboard) return false;
  const summary = dashboard.summary ?? {};
  return (
    Number(summary.totalApprovedSales ?? 0) > 0 ||
    Number(summary.totalApprovedTarget ?? 0) > 0 ||
    Number(summary.unitsSold ?? 0) > 0 ||
    toSafeArray(dashboard.trend).length > 0 ||
    toSafeArray(dashboard.productPerformance).length > 0 ||
    toSafeArray(dashboard.familyMatrix).length > 0
  );
}

async function getScopedEmployeePortalSalesDashboard({
  line,
  salesScope,
  targetSalesHrIds,
}: {
  line: string[];
  salesScope: BusinessScope;
  targetSalesHrIds: string[];
}): Promise<ScopedPortalSales> {
  if (salesScope === "LINE") {
    const byLine = line.length > 0
      ? await getEmployeePortalSalesDashboard(null, { line })
      : null;
    if (byLine && salesDashboardHasData(byLine.dashboard)) return byLine;

    if (targetSalesHrIds.length > 0) {
      logPortalDebug("line sales query returned no rows; falling back to visible HR IDs", {
        line,
        targetSalesHrIds: targetSalesHrIds.length,
      });
      return getEmployeePortalSalesDashboard(targetSalesHrIds, {});
    }

    return byLine ?? getEmployeePortalSalesDashboard([], {});
  }

  return getEmployeePortalSalesDashboard(targetSalesHrIds, {});
}

function formatCurrencyEGP(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function computeInsights(data: {
  employmentJourney: EmploymentJourney;
  expenses: { approvedAmount: number };
  latestRecord: SalaryRecord | null;
  previousRecord: SalaryRecord | null;
  salaryTrend: SalaryTrendPoint[];
  sales: { achievementRate: number; targetValue: number; totalValue: number };
}): PortalInsight[] {
  const insights: PortalInsight[] = [];

  // Derive salary delta from records if available, otherwise fall back to trend data
  const hasDelta =
    data.latestRecord && data.previousRecord
      ? { curr: data.latestRecord.netSalary, prev: data.previousRecord.netSalary }
      : data.salaryTrend.length >= 2
        ? {
            curr: data.salaryTrend[data.salaryTrend.length - 1].netSalary,
            prev: data.salaryTrend[data.salaryTrend.length - 2].netSalary,
          }
        : null;

  if (hasDelta) {
    const diff = hasDelta.curr - hasDelta.prev;
    if (Math.abs(diff) > 0 && hasDelta.prev > 0) {
      const pct = ((Math.abs(diff) / hasDelta.prev) * 100).toFixed(1);
      insights.push({
        kind: diff >= 0 ? "info" : "warning",
        message: diff >= 0
          ? `Your net salary increased by ${pct}% compared to the previous payroll month.`
          : `Your net salary decreased by ${pct}% compared to the previous payroll month.`,
      });
    }
  } else if (data.salaryTrend.length === 0) {
    insights.push({ kind: "info", message: "No payroll data has been uploaded for your employee record yet." });
  }

  if (data.latestRecord) {
    const prominent: string[] = [];
    if (data.latestRecord.loans > 0) prominent.push("loans");
    if (data.latestRecord.fingerPrint > 0) prominent.push("fingerprint deductions");
    if (prominent.length > 0) {
      insights.push({ kind: "info", message: `Your deductions this month include ${prominent.join(" and ")}.` });
    }
  }

  const { renewalRisk, daysUntilRenewal } = data.employmentJourney;
  if (renewalRisk === "critical" && daysUntilRenewal !== null) {
    insights.push({ kind: "critical", message: `Your contract renewal is due in ${daysUntilRenewal} day${daysUntilRenewal === 1 ? "" : "s"}. Contact HR immediately.` });
  } else if (renewalRisk === "warning" && daysUntilRenewal !== null) {
    insights.push({ kind: "warning", message: `Your contract renewal is coming up in ${daysUntilRenewal} days.` });
  } else if (renewalRisk === "upcoming" && daysUntilRenewal !== null) {
    insights.push({ kind: "info", message: `Your contract renewal is scheduled in ${daysUntilRenewal} days.` });
  }

  if (data.expenses.approvedAmount > 0) {
    insights.push({ kind: "info", message: `You have ${formatCurrencyEGP(data.expenses.approvedAmount)} in approved expenses.` });
  }

  if (data.sales.targetValue > 0) {
    const ach = (data.sales.achievementRate * 100).toFixed(1);
    insights.push({
      kind: data.sales.achievementRate >= 1 ? "info" : data.sales.achievementRate >= 0.75 ? "info" : "warning",
      message: `Your sales achievement is ${ach}% of target for the current period.`,
    });

    // Add English incentive gap insight
    if (data.sales.achievementRate < 1) {
      const gap = Math.max(0, data.sales.targetValue - data.sales.totalValue);
      if (gap > 0) {
        insights.push({
          kind: "info",
          message: `You are ${formatCurrencyEGP(gap)} away from reaching your target to unlock full incentives.`,
        });
      }
    } else {
      insights.push({
        kind: "info",
        message: "Great job! You have reached your target and are now in over-achievement.",
      });
    }
  }

  return insights;
}

function fallbackEmployee(access: AccessContext): EmployeeDirectoryRow {
  const hrId = access.hrId ?? access.loginId ?? "Unknown";

  return {
    areaId: null,
    areaName: null,
    bankAccount: null,
    bankName: null,
    baseSalary: null,
    basicSalary: null,
    birthDate: null,
    // The HR record fields. Null here for the same reason every other field is: this row stands in
    // for an employee the directory could not answer for, so it asserts nothing about them.
    birthPlace: null,
    qualification: null,
    universityName: null,
    collegeMajor: null,
    seniorYear: null,
    contractDuration: null,
    probationEndDate: null,
    medicalInsuranceCardReceivedDate: null,
    socialInsuranceStartDate: null,
    kaabElamaalNumber: null,
    kaabElamaalIssuer: null,
    kaabElamaalIssueDate: null,
    kaabElamaalRefund: null,
    contractType: null,
    contractRenewalDate: null,
    createdAt: new Date(0).toISOString(),
    crmId: null,
    crmUsername: null,
    departmentId: null,
    departmentName: null,
    education: null,
    employmentStatus: "active",
    extraCostOfLiving: null,
    fullName: access.loginId ?? hrId,
    displayName: access.loginId ?? hrId,
    nickname: null,
    gender: null,
    fuelAllowance: null,
    grossSalary: null,
    hasBankAccount: null,
    // A fallback row stands in for an employee the directory could not resolve, so it claims
    // nothing about what is on file — the same posture as hasPhoto beside it.
    hasCv: false,
    hasPhoto: false,
    healthCardStatus: null,
    healthCardNumber: null,
    healthCardReceivedDate: null,
    hireDate: null,
    hrId,
    jobTitle: access.role,
    lastWorkingDate: null,
    lineId: null,
    lineName: null,
    managerHrId: null,
    managerName: null,
    pendingManagerReplacementForHrId: null,
    medicalInsurance: null,
    medicalInsuranceStatus: null,
    medicalInsuranceNumber: null,
    mobileNumber: null,
    nameAr: null,
    nationalId: null,
    netSalary: null,
    organogramVisible: true,
    payrollEligible: true,
    salaryPaymentMode: "two_parts",
    positionId: null,
    positionTitle: null,
    residenceAddress: null,
    residenceArea: null,
    residenceCity: null,
    residenceGeocodeStatus: null,
    residenceLatitude: null,
    residenceLongitude: null,
    regionName: null,
    resignationDate: null,
    socialInsurance: null,
    socialInsuranceWage: null,
    socialInsuranceStatus: null,
    socialInsuranceNumber: null,
    taxes: null,
    teamId: null,
    teamName: null,
    updatedAt: new Date(0).toISOString(),
    workEmail: null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getEmployeePortalData(
  access: AccessContext,
  prefetched?: {
    payroll?: EmployeePortalPayrollDashboard | null;
    sales?: SalesDashboardData | null;
    directory?: EmployeeDirectoryData | null;
    expenses?: PayrollExpenseApproval[] | null;
    expenseReports?: PayrollExpenseReport[] | null;
  }
): Promise<EmployeePortalData> {
  const currentUser = await resolvePortalCurrentUser(access);
  const currentHrId = normalizeHrId(currentUser.hrId) ?? "";
  const salesScope = getSalesScope({
    role: currentUser.role as PhoenixRole,
    salesScopeOverride: currentUser.salesScopeOverride as BusinessScope,
  });

  logPortalDebug("portal currentUser", currentUser);

  if (!currentHrId) {
    const employee = fallbackEmployee(access);
    const employmentJourney = computeEmploymentJourney(employee);
    return {
      access: {
        expensesRows: 0,
        payrollPeriods: 0,
        salesScope,
        teamMembers: 0,
      },
      batchStatus: null,
      documents: [],
      employee,
      employmentJourney,
      expenses: {
        approvedAmount: 0,
        approvedCount: 0,
        latestEntries: [],
        latestSubmittedAt: null,
        pendingAmount: 0,
        pendingCount: 0,
        totalAmount: 0,
        totalRows: 0,
      },
      insights: [{ kind: "warning", message: EMPLOYEE_PORTAL_PROFILE_NOT_LINKED_MESSAGE }],
      latestRecord: null,
      notifications: [],
      payroll: {
        batchId: null,
        batchLabel: "No payroll period",
        grossSalary: 0,
        latestHireDate: null,
        line: employee.lineName,
        netSalary: 0,
        totalAdditions: 0,
        totalDeductions: 0,
        salaryTrend: [],
        netVsLastMonth: null,
        grossVsLastMonth: null,
        deductionsVsLastMonth: null,
        bonus: 0,
        incentive: 0,
        loans: 0,
        otherDeductions: 0,
        socialInsurance: 0,
        incomeTax: 0,
        fuelAllowance: 0,
        extraCostOfLiving: 0,
      },
      payslips: {
        latestBatchId: null,
        latestBatchLabel: null,
        periods: 0,
      },
      previousRecord: null,
      sales: {
        achievementRate: 0,
        activeProducts: 0,
        lineLabel: employee.lineName ?? null,
        targetValue: 0,
        totalValue: 0,
        unitsSold: 0,
      },
      salaryTrend: [],
    };
  }

  const directory = prefetched?.directory ?? await getEmployeeDirectory();

  const employee = findDirectoryEmployeeByHrId(directory, currentHrId) ?? fallbackEmployee(access);
  const salesLineFilter = resolvePortalSalesLineFilter(currentUser, employee);

  const visibleTeamMembers = directory.employees.filter((row) => {
    const rowHrId = normalizeHrId(row.hrId);
    return rowHrId !== currentHrId && canSeeEmployee(access, row);
  });

  const targetSalesHrIds = [currentHrId];
  if (salesScope !== "SELF") {
    const teamHrIds = visibleTeamMembers.map((m) => normalizeHrId(m.hrId)).filter(Boolean) as string[];
    targetSalesHrIds.push(...teamHrIds);
  }

  const [payroll, sales, expenses, expenseReports, documents, notifications] = await devSafePromiseAll([
    () => prefetched?.payroll != null ? Promise.resolve(prefetched.payroll) : getEmployeePortalPayrollDashboard(currentHrId),
    // This caller wants the dashboard alone — the per-product rows the scoped loader now also
    // returns are only needed by the Pedia split, which is computed by the caller that prefetches.
    async () => {
      if (prefetched?.sales != null) return prefetched.sales;
      const scoped = await getScopedEmployeePortalSalesDashboard({
        line: salesLineFilter,
        salesScope,
        targetSalesHrIds,
      });
      return scoped.dashboard;
    },
    async () => {
      if (prefetched?.expenses != null) return prefetched.expenses;
      // Awaited first, deliberately: passing withLivePortalExpenseNames bare to .then() lets
      // devSafePromiseAll's `() => Promise<unknown>` constraint fix its type parameter to
      // `unknown`, and the whole tuple element degrades with it.
      return withLivePortalExpenseNames(
        await listPayrollExpenses(undefined, undefined, undefined, { ...access, hrId: currentHrId }),
      );
    },
    () => prefetched?.expenseReports != null ? Promise.resolve(prefetched.expenseReports) : listPayrollExpenseReports({ ...access, hrId: currentHrId }),
    () => listEmployeeDocuments(currentHrId),
    () => fetchPortalNotifications(currentHrId),
  ]);

  const latestExpense = expenses[0] ?? null;
  const latestRecord = payroll.records[0] ?? null;
  const previousRecord = payroll.previousRecords?.[0] ?? null;
  const latestBatch = payroll.batch ?? payroll.batches[0] ?? null;
  const salesSummary = sales.summary ?? {};

  // Build batch map for trend lookup
  const batchMap = new Map(payroll.batches.map((b) => [b.id, { 
    month: b.month ?? 1, 
    year: b.year ?? 2024 
  }]));
  let salaryTrend = await fetchSalaryTrend(currentHrId, batchMap);
  if (salaryTrend.length === 0 && payroll.records.length > 0) {
    salaryTrend = buildSalaryTrendFromRecords(payroll.records);
  }

  const netVsLastMonth = latestRecord && previousRecord && previousRecord.netSalary > 0
    ? ((latestRecord.netSalary - previousRecord.netSalary) / previousRecord.netSalary) * 100
    : null;
  const grossVsLastMonth = latestRecord && previousRecord && previousRecord.grossSalary > 0
    ? ((latestRecord.grossSalary - previousRecord.grossSalary) / previousRecord.grossSalary) * 100
    : null;
  const deductionsVsLastMonth = latestRecord && previousRecord && previousRecord.totalDeductions > 0
    ? ((latestRecord.totalDeductions - previousRecord.totalDeductions) / previousRecord.totalDeductions) * 100
    : null;

  const employmentJourney = computeEmploymentJourney(employee);

  const expenseSummary = summarizePayrollExpenses(expenses);
  const latestEntries = expenses.slice(0, 5).map((row) => ({
    date: row.date ?? "",
    description: row.description ?? row.requestType ?? "Expense",
    hrApproved: row.hrApproved,
    hrNotes: row.hrNotes ?? "",
    status: row.status ?? "pending",
    total: row.total,
  }));

  const insightInput = {
    employmentJourney,
    expenses: { approvedAmount: expenseSummary.approvedAmount },
    latestRecord,
    previousRecord,
    salaryTrend,
    sales: {
      achievementRate: Number(salesSummary.achievementRate ?? 0),
      targetValue: Number(salesSummary.totalApprovedTarget ?? 0),
      totalValue: Number(salesSummary.totalApprovedSales ?? 0),
    },
  };
  const insights = computeInsights(insightInput);
  const fallbackAllowances = resolveStandardSalaryAllowances({
    departmentName: employee.departmentName,
    employeeHrId: currentHrId,
    jobTitle: employee.jobTitle,
    lineName: employee.lineName,
    month: latestBatch?.month,
    positionTitle: employee.positionTitle,
    year: latestBatch?.year,
  });
  const salaryStructure = currentHrId ? await fetchEmployeeSalaryStructure(currentHrId) : null;
  const fixedSalary = resolveFixedSalaryReference({
    employee,
    fallbackAllowances,
    salaryStructure,
  });

  return {
    access: {
      expensesRows: expenses.length,
      payrollPeriods: payroll.batches.length,
      salesScope: salesScope,
      teamMembers: visibleTeamMembers.length,
    },
    batchStatus: latestBatch?.status ?? null,
    documents,
    employee,
    employmentJourney,
    expenses: {
      approvedAmount: expenseSummary.approvedAmount,
      approvedCount: expenseSummary.approvedRows,
      latestEntries,
      latestSubmittedAt: latestExpense?.date ?? expenseReports[0]?.createdAt ?? null,
      pendingAmount: expenseSummary.pendingAmount,
      pendingCount: expenseSummary.pendingRows,
      totalAmount: expenseSummary.totalAmount,
      totalRows: expenseSummary.totalRows,
    },
    insights,
    latestRecord,
    notifications,
    payroll: {
      batchId: latestBatch?.id ?? null,
      batchLabel: formatBatchLabel(latestBatch?.month, latestBatch?.year),
      grossSalary: fixedSalary.grossSalary,
      latestHireDate: latestRecord?.hireDate ?? employee.hireDate ?? null,
      line: latestRecord?.line ?? employee.lineName ?? null,
      netSalary: fixedSalary.netSalary,
      totalAdditions: latestRecord?.totalAdditions ?? 0,
      totalDeductions: latestRecord?.totalDeductions ?? 0,
      salaryTrend: salaryTrend,
      netVsLastMonth,
      grossVsLastMonth,
      deductionsVsLastMonth,
      bonus: latestRecord?.bonus ?? 0,
      incentive: latestRecord?.incentive ?? 0,
      loans: latestRecord?.loans ?? 0,
      otherDeductions: latestRecord?.otherDeductions ?? 0,
      socialInsurance: fixedSalary.socialInsurance,
      incomeTax: fixedSalary.taxes,
      fuelAllowance: fixedSalary.fuelAllowance,
      extraCostOfLiving: fixedSalary.extraCostOfLiving,
    },
    payslips: {
      latestBatchId: latestBatch?.id ?? null,
      latestBatchLabel: latestBatch ? formatBatchLabel(latestBatch.month, latestBatch.year) : null,
      periods: payroll.batches.length,
    },
    previousRecord,
    sales: {
      achievementRate: Number(salesSummary.achievementRate ?? 0),
      activeProducts: Number(salesSummary.activeProducts ?? 0),
      lineLabel: employee.lineName ?? null,
      targetValue: Number(salesSummary.totalApprovedTarget ?? 0),
      totalValue: Number(salesSummary.totalApprovedSales ?? 0),
      unitsSold: Number(salesSummary.unitsSold ?? 0),
    },
    salaryTrend,
  };
}

export async function getEmployeePortalProfile(access: AccessContext) {
  const data = await getEmployeePortalData(access);

  return {
    access: data.access,
    documents: data.documents,
    employee: data.employee,
  };
}

export type MedicalRepPortalData = {
  /**
   * Whether Beta employee-portal modules should be surfaced in the UI, resolved
   * server-side from PHOENIX_PORTAL_SHOW_BETA_NAV. Mirrors the nav-layer gating
   * so dashboard quick-actions for Beta modules (e.g. Marketing Requests) stay
   * hidden by default. Optional: only populated for full dashboard payloads.
   */
  betaNavEnabled?: boolean;
  employee: {
    area: string | null;
    department: string | null;
    fullName: string;
    hrId: string;
    line: string | null;
    manager: string | null;
    /** Same-origin route URL for an uploaded profile photo, or null/undefined to use the bundled static photo / initials. */
    photoUrl?: string | null;
    roleLabel: string;
    status: string;
    territory: string | null;
  };
  orgStructure: {
    actualNow: number;
    compositionLabel: string | null;
    districtManagerVacancies: number;
    scope: "line" | "team";
    scopeLabel: string;
    totalStructure: number;
    vacancies: number;
  } | null;
  workforce: {
    activeHeadcount: number;
    contractRenewalsDue: number;
    dataCoveragePercent: number;
    missingEmployeeData: number;
    newHires: number;
    openVacancies: number;
    pendingApprovals: number;
    probationDue: number;
    scopeLabel: string;
  };
  empty: {
    payroll: boolean;
    profile: boolean;
    sales: boolean;
  };
  hrContract: {
    contractRenewalDate: string | null;
    contractSignedDate: string | null;
    daysUntilRenewal: number | null;
    employmentStatus: string;
    hireDate: string | null;
    payrollEligibility: "Eligible" | "Pending";
    probationStatus: "Completed" | "Not Started" | "On Probation";
    serviceDurationText: string;
  };
  insights: string[];
  overview: {
    employeesOnLeaveToday: Array<{
      departmentName: string | null;
      employeeHrId: string;
      employeeName: string;
      endDate: string;
      id: string;
      lineName: string | null;
      startDate: string;
      vacationType: string;
    }>;
    myActions: Array<{
      count: number;
      href: string;
      id: string;
      label: string;
    }>;
    vacancyDetails: EmployeePortalVacanciesData | null;
  };
  payroll: {
      batchId: string | null;
      baseSalary: number;
      firstPart: number;
      grossSalary: number;
      internalDeductions: number;
      latestPayslip: {
        baseSalary: number;
        basicSalary: number;
        /** Calendar days in the period. 0 when the period predates the column. */
        calendarDays: number;
        firstPart: number;
        grossSalary: number;
        netSalary: number;
        secondPart: number;
        totalAdditions: number;
        totalDeductions: number;
        /**
         * Days the employee was on payroll. The figures beside it are the FULL
         * contract (they always have been here — this block is built from the
         * contract, not from the record), so on a partial month this is the only
         * thing that explains why the money paid was smaller.
         */
        workingDays: number;
      };
      latestBatchLabel: string;
      latestBatchStatus: string | null;
      netSalary: number;
      payslipRows: Array<{
        createdAt: string;
        id: string;
        label: string;
        status: string;
      }>;
      secondPart: number;
      statutoryDeductions: number;
      totalAdditions: number;
      totalDeductions: number;
      salaryTrend: SalaryTrendPoint[];
      netVsLastMonth: number | null;
      grossVsLastMonth: number | null;
      deductionsVsLastMonth: number | null;
      bonus: number;
      incentive: number;
      basicSalary: number;
      incentiveTarget: number;
      allPeriodsIncentive: number;
      allPeriodsIncentiveTarget: number;
      allPeriodsAchievementPercent: number;
      loans: number;
      otherDeductions: number;
      socialInsurance: number;
      incomeTax: number;
      fuelAllowance: number;
      extraCostOfLiving: number;
    };
  sales: {
    /**
     * What the VIEWER is entitled to see — not a statement about the figures below.
     *
     * `getSalesScope` has no switch arm for roles that do not sell, so the two HR seats and
     * Financial Advisor all fall to its NONE default. A NONE viewer is then fail-closed to empty
     * line/region/area sets, which means every sales number in this block is a legitimate zero
     * rather than a measurement of anything. The dashboard reads this field to decide whether to
     * render the sales panels at all, because a zeroed strip reading "Achievement Rate 0.0% —
     * Needs attention" on an HR coordinator's home page is not empty space, it is an accusation.
     */
    viewerSalesScope: BusinessScope;
    achievementPercent: number;
    currentMonthLabel: string;
    currentMonthSales: number;
    currentMonthTarget: number;
    /** The semester the incentive figures are computed over, e.g. "Semester 2 2026". */
    incentiveSemesterLabel: string | null;
    /**
     * The Pedia split incentive, or NULL on every other line and before Semester 2 2026.
     *
     * Null means "this seat is paid on one figure", NOT "a split worth nothing" — a renderer that
     * reads the amounts without checking for null first would put two EGP 0 halves on a CNS rep's
     * tab. See src/lib/incentives/pedia-split.ts for the rule.
     */
    pediaSplit: {
      /** Guamusin + Ivyronc over the semester. */
      satoAchievementPercent: number;
      satoSales: number;
      /** 0 means no Sato target loaded for the window — read it before rendering the percentage,
       * exactly as `incentiveSemesterTarget` is read for the total. */
      satoTarget: number;
      /** One month of basic at the Sato achievement. */
      satoHalfAmount: number;
      /** One month of basic at the total achievement. */
      totalHalfAmount: number;
      /** The two halves added — what the rep is paid, and the same number as `payroll.incentive`. */
      payoutAmount: number;
      payoutPercentage: number;
      semesterTargetIncentive: number;
    } | null;
    /** Sales and target summed over that semester alone. `incentiveSemesterTarget` is what tells a
     * 0% achievement apart from an absent one: it is 0 for every rep until their first month of the
     * semester is uploaded, and `overviewAchievementPercent` is 0 with it. Render "No target yet",
     * never "0.0%" — one is a fact about the data, the other is an accusation. */
    incentiveSemesterSales: number;
    incentiveSemesterTarget: number;
    /** Non-null when that semester is not fully loaded — names the months, so a rep can never read
     * a partial figure as their settled payout. See describeIncompleteWindow. */
    incentiveWindowNotice: string | null;
    overviewAchievementPercent: number;
    overviewSales: number;
    overviewTarget: number;
    growthVsLastMonthPercent: number | null;
    familyContribution: Array<{ name: string; sales: number; units: number; salesPercentage?: number; unitsPercentage?: number }>;
    productContribution: Array<{ name: string; sales: number; units: number; salesPercentage?: number; unitsPercentage?: number }>;
    territories: Array<{ name: string; sales: number; target: number; achievementPercent: number }>;
    linePerformance: Array<{ name: string; sales: number; target: number; achievementPercent: number }>;
    teamComparisonPeriod: string | null;
    rankInTeam: { position: number; total: number } | null;
    teamComparison: Array<{
      achievementPercent: number;
      name: string;
      position: number;
      sales: number;
      target: number;
    }>;
    leadingMedicalRep: {
      achievementPercent: number;
      name: string;
      position: number;
      sales: number;
      target: number;
    } | null;
    topProduct: string | null;
    topProductSalesValue: number;
      trend: Array<{
      period: string;
      sales: number;
      target: number;
    }>;
    units: number;
  };
  workload?: {
    totalTrips: number;
    totalDistance: number;
    totalExpenses: number;
    activeEmployees: number;
    avgCostPerTrip: number;
    workloadOverview: Array<{ label: string; value: string; delta: string }>;
    tripsVsDistanceTrend: Array<{ month: string; trips: number; distance: number }>;
    workloadDistribution: Array<{ name: string; value: number; color: string }>;
    heatmapData: {
      trips: number[];
      distance: number[];
      expenses: number[];
    };
    employeePerformance: Array<{ name: string; role: string; trips: number; distance: number; activeDays: number }>;
    expenseAnalysis: Array<{ label: string; value: string; delta: string }>;
    expenseTrend: Array<{ month: string; expenses: number }>;
    territoryAnalysis: Array<{ territory: string; trips: number; distance: number; expenses: number }>;
    recentTrips: Array<{ id: string; date: string; employee: string; role: string; from: string; to: string; type: string; distance: number; cost: number }>;
    expenseRows: Array<PayrollExpenseApproval & { location: string }>;
    hasWorkloadFields: boolean;
    availableEmployees: Array<{ id: string; name: string }>;
    availableTerritories: string[];
  };
};

/**
 * Lightweight shell-only data for the Employee Portal chrome.
 * Keep this limited to profile, role, nav visibility inputs, and basic contract
 * context. Do not add dashboard, chart, payroll history, request lists, or other
 * page-heavy data here; those belong in route-specific loaders.
 */
export type EmployeePortalShellData = Pick<MedicalRepPortalData, "employee" | "hrContract">;

export const getEmployeePortalShellData = cache(async (access: AccessContext): Promise<EmployeePortalShellData> => {
  // The directory does not depend on who the viewer is, so it loads beside the viewer's own auth row instead of
  // after it (performance brief, 2026-10-23): the shell used to pay the two reads one after the other.
  const [currentUser, directory] = await Promise.all([
    resolvePortalCurrentUser(access),
    getEmployeeDirectory(),
  ]);
  const currentHrId = normalizeHrId(currentUser.hrId);
  const employee = currentHrId
    ? findDirectoryEmployeeByHrId(directory, currentHrId) ?? fallbackEmployee(access)
    : fallbackEmployee(access);
  const employmentJourney = computeEmploymentJourney(employee);
  const daysUntilProbationEnd = employmentJourney.daysUntilProbationEnd;
  const probationStatus: MedicalRepPortalData["hrContract"]["probationStatus"] =
    daysUntilProbationEnd === null
      ? "Not Started"
      : daysUntilProbationEnd > 0
        ? "On Probation"
        : "Completed";

  const [manager, photoUrl] = await Promise.all([
    resolveDirectManagerName(employee.hrId),
    uploadedEmployeePhotoUrl(employee.hrId),
  ]);

  return {
    employee: {
      area: employee.areaName,
      department: employee.departmentName,
      fullName: employee.displayName,
      hrId: employee.hrId,
      line: employee.lineName,
      manager: manager ?? employee.managerName,
      photoUrl,
      roleLabel: employee.jobTitle || employee.positionTitle || currentUser.role || "Employee",
      status: employee.employmentStatus ?? "active",
      territory: employee.regionName ?? employee.areaName,
    },
    hrContract: {
      contractRenewalDate: employmentJourney.contractRenewalDate,
      contractSignedDate: employmentJourney.contractSignedDate,
      daysUntilRenewal: employmentJourney.daysUntilRenewal,
      employmentStatus: employee.employmentStatus ?? "active",
      hireDate: employee.hireDate,
      payrollEligibility: employee.netSalary || employee.grossSalary ? "Eligible" : "Pending",
      probationStatus,
      serviceDurationText: serviceDurationText(employmentJourney.serviceDurationDays),
    },
  };
});

async function buildEmployeePortalOverviewData(input: {
  access: AccessContext;
  currentHrId: string | null;
  pendingExpenseCount: number;
}): Promise<MedicalRepPortalData["overview"]> {
  const today = new Date().toISOString().slice(0, 10);

  const [vacationRowsResult, marketingWorkspace, vacancyDetails] = await devSafePromiseAll([
    // Only two counts are read below (pending approvals, my pending requests), never the full
    // report — getVacationPlatformMetricRows returns the SAME scoped+decision-marked rows as the
    // full vacation report builder but skips holiday/eligibility/SLA-run enrichment those counts
    // never touch. See its own doc comment for the equivalence proof.
    () => getVacationPlatformMetricRows(input.access).catch(() => null),
    () => getMarketingRequestDraftWorkspace(input.access).catch(() => null),
    () => getEmployeePortalVacancies(input.access).catch(() => null),
  ]);

  const vacationRows = vacationRowsResult ?? [];
  const pendingVacationApprovals = vacationRows.filter((row) => row.status === "pending_manager" && row.canDecide).length;
  const myPendingVacationRequests = vacationRows.filter((row) => {
    return row.status === "pending_manager" && normalizeHrId(row.employeeHrId) === input.currentHrId;
  }).length;
  const activeLeaveToday = vacationRows
    .filter((row) => row.status === "approved" && row.startDate <= today && row.endDate >= today)
    .sort((left, right) => left.employeeName.localeCompare(right.employeeName))
    .map((row) => ({
      departmentName: row.departmentName,
      employeeHrId: row.employeeHrId,
      employeeName: row.employeeName,
      endDate: row.endDate,
      id: row.id,
      lineName: row.lineName,
      startDate: row.startDate,
      vacationType: row.vacationType,
    }));

  const marketingDrafts = marketingWorkspace?.drafts.length ?? 0;

  const myActions: MedicalRepPortalData["overview"]["myActions"] = [
    {
      count: pendingVacationApprovals,
      href: "/leave-management/vacation-report?status=pending_manager",
      id: "vacation-approvals",
      label: "Vacation approvals waiting",
    },
    {
      count: myPendingVacationRequests,
      href: "/leave-management/vacation-report?status=pending_manager",
      id: "my-vacation-requests",
      label: "Vacation requests pending decision",
    },
    {
      count: marketingDrafts,
      href: "/employee-portals/marketing-requests",
      id: "marketing-drafts",
      label: "Marketing request drafts",
    },
    {
      count: input.pendingExpenseCount,
      href: "/employee-portals/expense-dashboard",
      id: "expense-actions",
      label: "Expense actions pending",
    },
  ].filter((item) => item.count > 0);

  return {
    employeesOnLeaveToday: activeLeaveToday,
    myActions,
    vacancyDetails,
  };
}

export async function getPayslipPortalData(access: AccessContext): Promise<MedicalRepPortalData> {
  const currentUser = await resolvePortalCurrentUser(access);
  const currentHrId = normalizeHrId(currentUser.hrId);
  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): the payslip history
  // and the salary structure are keyed by the viewer's HR id alone, and the manager's name and the
  // photo by the directory row alone — none reads another's answer, so they overlap instead of
  // queueing one behind the other. Every value below is still computed from the same four answers.
  // The payroll pair never rejects (each swallows its own read error), so the directory is still
  // the only read here whose failure can fail the page, exactly as before.
  const [identity, payrollDashboard, salaryStructure] = await Promise.all([
    (async () => {
      const directory = await getEmployeeDirectory();
      const employee = currentHrId
        ? findDirectoryEmployeeByHrId(directory, currentHrId) ?? fallbackEmployee(access)
        : fallbackEmployee(access);
      const [manager, photoUrl] = await Promise.all([
        resolveDirectManagerName(employee.hrId),
        uploadedEmployeePhotoUrl(employee.hrId),
      ]);
      return { employee, manager, photoUrl };
    })(),
    currentHrId ? getEmployeePortalPayrollDashboard(currentHrId) : Promise.resolve(null),
    currentHrId ? fetchEmployeeSalaryStructure(currentHrId) : Promise.resolve(null),
  ]);
  const { employee } = identity;
  const profileLinked =
    currentHrId !== null && toCanonicalPortalHrId(employee.hrId) === toCanonicalPortalHrId(currentHrId);
  const latestRecord = payrollDashboard?.records[0] ?? null;
  const previousRecord = payrollDashboard?.previousRecords[0] ?? null;
  const latestBatch = payrollDashboard?.batch ?? payrollDashboard?.batches[0] ?? null;
  const employmentJourney = computeEmploymentJourney(employee);
  const daysUntilProbationEnd = employmentJourney.daysUntilProbationEnd;
  const probationStatus: MedicalRepPortalData["hrContract"]["probationStatus"] =
    daysUntilProbationEnd === null
      ? "Not Started"
      : daysUntilProbationEnd > 0
        ? "On Probation"
        : "Completed";
  const fallbackAllowances = resolveStandardSalaryAllowances({
    departmentName: employee.departmentName,
    employeeHrId: currentHrId,
    jobTitle: employee.jobTitle,
    lineName: employee.lineName,
    month: latestBatch?.month,
    positionTitle: employee.positionTitle,
    year: latestBatch?.year,
  });
  const fixedSalary = resolveFixedSalaryReference({
    employee,
    fallbackAllowances,
    salaryStructure,
  });
  const payrollParts = calculatePayrollParts({
    baseSalary: fixedSalary.baseSalary,
    extraCostOfLiving: fixedSalary.extraCostOfLiving,
    fuelAllowance: fixedSalary.fuelAllowance,
  });
  const latestPayslip = {
    baseSalary: fixedSalary.baseSalary,
    basicSalary: fixedSalary.basicSalary,
    calendarDays: latestRecord?.calendarDays ?? 0,
    firstPart: latestRecord?.firstPart ?? fixedSalary.basicSalary,
    grossSalary: fixedSalary.grossSalary,
    netSalary: fixedSalary.netSalary,
    secondPart: latestRecord?.secondPart ?? payrollParts.secondPart,
    totalAdditions: latestRecord?.totalAdditions ?? 0,
    totalDeductions: latestRecord?.totalDeductions ?? 0,
    workingDays: latestRecord?.workingDays ?? 0,
  };
  const salaryTrend = payrollDashboard?.records.length
    ? buildSalaryTrendFromRecords(payrollDashboard.records)
    : [];
  const netVsLastMonth = latestRecord && previousRecord && previousRecord.netSalary > 0
    ? ((latestRecord.netSalary - previousRecord.netSalary) / previousRecord.netSalary) * 100
    : null;
  const grossVsLastMonth = latestRecord && previousRecord && previousRecord.grossSalary > 0
    ? ((latestRecord.grossSalary - previousRecord.grossSalary) / previousRecord.grossSalary) * 100
    : null;
  const deductionsVsLastMonth = latestRecord && previousRecord && previousRecord.totalDeductions > 0
    ? ((latestRecord.totalDeductions - previousRecord.totalDeductions) / previousRecord.totalDeductions) * 100
    : null;
  const statutoryDeductions = latestRecord
    ? latestRecord.governmentalDeductions || (latestRecord.socialInsurance || 0) + (latestRecord.employmentIncomeTax || 0)
    : 0;
  const payrollEligibility: "Eligible" | "Pending" = latestBatch?.status === "locked" || latestBatch?.status === "approved"
    ? "Eligible"
    : "Pending";
  const fixedIncentiveSalary = {
    baseSalary: fixedSalary.baseSalary,
    basicSalary: fixedSalary.basicSalary,
    extraCostOfLiving: fixedSalary.extraCostOfLiving,
    fuelAllowance: fixedSalary.fuelAllowance,
    grossSalary: fixedSalary.grossSalary,
    netSalary: fixedSalary.netSalary,
    socialInsurance: fixedSalary.socialInsurance,
    taxes: fixedSalary.taxes,
  };
  const incentiveCalc = calculateIncentive2026({
    ...fixedIncentiveSalary,
    achievementPercent: 0,
  });
  const insights = computeInsights({
    employmentJourney,
    expenses: { approvedAmount: 0 },
    latestRecord,
    previousRecord,
    salaryTrend,
    sales: {
      achievementRate: 0,
      targetValue: 0,
      totalValue: 0,
    },
  }).map((insight) => insight.message);

  return {
    employee: {
      area: employee.areaName,
      department: employee.departmentName,
      fullName: employee.displayName,
      hrId: employee.hrId,
      line: employee.lineName,
      manager: identity.manager ?? employee.managerName,
      photoUrl: identity.photoUrl,
      roleLabel: employee.jobTitle || employee.positionTitle || currentUser.role || "Employee",
      status: employee.employmentStatus ?? "active",
      territory: employee.regionName ?? employee.areaName,
    },
    orgStructure: null,
    workforce: {
      activeHeadcount: 0,
      contractRenewalsDue: 0,
      dataCoveragePercent: 0,
      missingEmployeeData: 0,
      newHires: 0,
      openVacancies: 0,
      pendingApprovals: 0,
      probationDue: 0,
      scopeLabel: employee.displayName,
    },
    empty: {
      payroll: (payrollDashboard?.records.length ?? 0) === 0,
      profile: !profileLinked,
      sales: true,
    },
    hrContract: {
      contractRenewalDate: employmentJourney.contractRenewalDate,
      contractSignedDate: employmentJourney.contractSignedDate,
      daysUntilRenewal: employmentJourney.daysUntilRenewal,
      employmentStatus: employee.employmentStatus ?? "active",
      hireDate: employee.hireDate,
      payrollEligibility,
      probationStatus,
      serviceDurationText: serviceDurationText(employmentJourney.serviceDurationDays),
    },
    insights,
    overview: {
      employeesOnLeaveToday: [],
      myActions: [],
      vacancyDetails: null,
    },
    payroll: {
      batchId: latestBatch?.id ?? null,
      baseSalary: fixedSalary.baseSalary,
      firstPart: latestRecord?.firstPart ?? 0,
      grossSalary: latestPayslip.grossSalary,
      internalDeductions: latestRecord?.totalDeductions ?? 0,
      latestPayslip,
      latestBatchLabel: latestBatch ? formatBatchLabel(latestBatch.month, latestBatch.year) : "No payroll period",
      latestBatchStatus: latestBatch?.status ?? null,
      netSalary: latestPayslip.netSalary,
      payslipRows: (payrollDashboard?.batches ?? []).map((batch) => ({
        createdAt: batch.createdAt,
        id: batch.id,
        label: formatBatchLabel(batch.month, batch.year),
        status: batch.status,
      })),
      secondPart: latestRecord?.secondPart ?? 0,
      statutoryDeductions,
      totalAdditions: latestRecord?.totalAdditions ?? 0,
      totalDeductions: latestRecord?.totalDeductions ?? 0,
      salaryTrend,
      netVsLastMonth,
      grossVsLastMonth,
      deductionsVsLastMonth,
      bonus: latestRecord?.bonus ?? 0,
      incentive: incentiveCalc.payoutAmount,
      basicSalary: incentiveCalc.basicSalary,
      incentiveTarget: incentiveCalc.semesterTargetIncentive / 6,
      allPeriodsIncentive: incentiveCalc.payoutAmount,
      allPeriodsIncentiveTarget: incentiveCalc.semesterTargetIncentive / 6,
      allPeriodsAchievementPercent: 0,
      loans: latestRecord?.loans ?? 0,
      otherDeductions: latestRecord?.otherDeductions ?? 0,
      socialInsurance: fixedSalary.socialInsurance,
      incomeTax: fixedSalary.taxes,
      fuelAllowance: fixedSalary.fuelAllowance,
      extraCostOfLiving: fixedSalary.extraCostOfLiving,
    },
    sales: {
      // This payload is built for the payslips pages and carries NO sales data by construction —
      // every figure below is a hard-coded zero. NONE is therefore the honest answer, not a
      // restriction: were the overview dashboard ever rendered from it, the fail-closed gate would
      // correctly hide panels that could only display zeros. The three callers today
      // (app/payslips, app/employee-portals/payslips, the workspace payslips page) render the
      // payroll section alone, so nothing reads this field yet.
      viewerSalesScope: "NONE",
      achievementPercent: 0,
      currentMonthLabel: "No period",
      currentMonthSales: 0,
      currentMonthTarget: 0,
      // No sales data at all: there is no semester to name and nothing to call provisional. The
      // surrounding empty state already tells the rep their data is not linked yet.
      incentiveSemesterLabel: null,
      incentiveSemesterSales: 0,
      incentiveSemesterTarget: 0,
      incentiveWindowNotice: null,
      // No sales at all, so no split either — null, never two zero halves.
      pediaSplit: null,
      overviewAchievementPercent: 0,
      overviewSales: 0,
      overviewTarget: 0,
      growthVsLastMonthPercent: null,
      familyContribution: [],
      productContribution: [],
      territories: [],
      linePerformance: [],
      teamComparisonPeriod: null,
      rankInTeam: null,
      teamComparison: [],
      leadingMedicalRep: null,
      topProduct: null,
      topProductSalesValue: 0,
      trend: [],
      units: 0,
    },
  };
}

export function toPeriodLabel(value: string) {
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function expensePeriodKey(expense: {
  date?: string | null;
  payoutMonth?: number | null;
  payoutYear?: number | null;
}) {
  const rawDate = String(expense.date ?? "").trim();
  if (rawDate) {
    const date = new Date(rawDate);
    if (!Number.isNaN(date.getTime())) {
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    }
  }

  if (
    Number.isFinite(expense.payoutYear as number | null) &&
    Number.isFinite(expense.payoutMonth as number | null)
  ) {
    return `${expense.payoutYear}-${String(expense.payoutMonth).padStart(2, "0")}`;
  }

  return null;
}

function normalizeExpenseRequestType(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return normalized || "Other";
}

function isMissingOutstationTable(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("outstation_expense_requests") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function mapOutstationExpenseToPayrollApproval(row: Record<string, unknown>): PayrollExpenseApproval {
  return mapOutstationRequestRowToPayrollApproval(row);
}

/**
 * Show the employee's CURRENT record name on portal expense rows.
 *
 * `specialist` is a snapshot frozen at write time, so a correction to an employee record never
 * reaches rows already stored — see employee-name.ts. The portal is not a self-only screen: the
 * Team Comparison view reads a manager's whole DSM line, and the personal reads run under the
 * caller's expense ACCESS SCOPE, so a manager's list carries other people's names. Those names
 * surface on the recent-trips table (`employee`) and on the workload dashboard (`ownerName`).
 *
 * READ-SIDE ONLY, like every other seam: the stored column keeps what the row was written with.
 * Applied here rather than inside listPayrollExpenses itself, because that reader is also what the
 * Expense Approvals editor reads through — and that screen writes back the rows it read.
 */
async function withLivePortalExpenseNames<T extends { hrId?: string | null; specialist: string }>(
  expenses: T[],
): Promise<T[]> {
  return withLiveOutstationEmployeeNames(
    expenses,
    (expense) => ({ hrId: expense.hrId, storedName: expense.specialist }),
    (expense, specialist) => ({ ...expense, specialist }),
  );
}

async function listOutstationExpensesForPortal(hrIds?: Array<string | null | undefined>) {
  const normalizedFilter = new Set(
    (hrIds ?? [])
      .map((hrId) => normalizeHrIdForAccess(hrId))
      .filter(Boolean) as string[],
  );

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingOutstationTable(error)) return [];
    throw new Error(error.message);
  }

  return withLivePortalExpenseNames(
    ((data ?? []) as Array<Record<string, unknown>>)
      .map(mapOutstationExpenseToPayrollApproval)
      .filter((expense) => {
        if (normalizedFilter.size === 0) return true;
        const canonicalHrId = normalizeHrIdForAccess(expense.hrId);
        return Boolean(canonicalHrId && normalizedFilter.has(canonicalHrId));
      }),
  );
}

function serviceDurationText(days: number) {
  if (!Number.isFinite(days) || days <= 0) return "0 Months";
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  if (years > 0 && months > 0) return `${years} Yrs ${months} Mos`;
  if (years > 0) return `${years} Yrs`;
  return `${months} Mos`;
}

function isActiveDirectoryEmployee(employee: Pick<EmployeeDirectoryRow, "employmentStatus">) {
  return classifyEmployeeNode(employee).eligible_for_headcount;
}

export function isMedicalRepDirectoryEmployee(
  employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">,
) {
  const normalizedTitle = `${employee.jobTitle ?? ""} ${employee.positionTitle ?? ""}`.toLowerCase();
  return (
    resolveJobFunctionRole(employee.jobTitle) === "Medical Rep" ||
    resolveJobFunctionRole(employee.positionTitle) === "Medical Rep" ||
    normalizedTitle.includes("medical representative") ||
    normalizedTitle.includes("medical rep")
  );
}

function isNationalSalesManagerDirectoryEmployee(
  employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">,
) {
  return resolveJobFunctionRole(employee.jobTitle) === "National Sales Manager" || resolveJobFunctionRole(employee.positionTitle) === "National Sales Manager";
}

function isGroupProductManagerDirectoryEmployee(
  employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">,
) {
  return resolveJobFunctionRole(employee.jobTitle) === "Group Product Manager" || resolveJobFunctionRole(employee.positionTitle) === "Group Product Manager";
}

function isLineStructureDirectoryEmployee(
  employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">,
) {
  return (
    isNationalSalesManagerDirectoryEmployee(employee) ||
    isDistrictManagerEmployee(employee) ||
    isGroupProductManagerDirectoryEmployee(employee) ||
    isMedicalRepDirectoryEmployee(employee)
  );
}

function isCompanyWorkforceRole(role: PhoenixRole) {
  return role === "Super Admin" || role === "CEO" || role === "Finance Manager";
}

function isLineWorkforceRole(role: PhoenixRole) {
  return (
    role === "National Sales Manager" ||
    role === "Product Manager" ||
    role === "Group Product Manager" ||
    role === "SFE Manager" ||
    role === "Training Manager" ||
    role === "Marketing Manager"
  );
}

/**
 * Owner rule (2026-07-18): a Regional Manager owns exactly ONE product line across a specific set
 * of regions — unlike the other line-workforce roles above, RM is also REGION-bounded, so it is
 * NOT part of isLineWorkforceRole. The region set is derived from the RM's own management subtree
 * (regionsWithinManagerHierarchy), since the RM's own region_name is a coarse parent label that
 * doesn't string-match the finer labels on their reports. Shared with double-visit-analytics +
 * weekly-planning so the same reps count everywhere.
 */
function regionalManagerScopeRows<T extends { hrId: string; lineId?: number | null; lineName?: string | null; managerHrId?: string | null; regionName?: string | null }>(
  rows: readonly T[],
  employee: EmployeeDirectoryRow,
  directory: readonly EmployeeDirectoryRow[],
  currentCanonicalHrId: string | null,
): T[] {
  if (!currentCanonicalHrId) return [];
  const regionKeys = regionsWithinManagerHierarchy(directory, currentCanonicalHrId, normalizeHrIdForAccess);
  if (regionKeys.size === 0) return [];
  return rows.filter((row) => {
    if (!sameWorkforceLine(employee, row)) return false;
    const region = normalizeRegionLabel(row.regionName);
    return Boolean(region && regionKeys.has(region));
  });
}

function isTeamWorkforceRole(role: PhoenixRole) {
  return role === "District Manager" || role === "Manager";
}

function resolvePortalWorkforceRows({
  currentUser,
  directory,
  employee,
}: {
  currentUser: PortalCurrentUser;
  directory: EmployeeDirectoryData;
  employee: EmployeeDirectoryRow;
}) {
  const role = normalizeRole(currentUser.role);
  const currentCanonicalHrId = normalizeHrIdForAccess(currentUser.hrId);
  const currentLine = normalizeLineName(currentUser.line ?? employee.lineName);
  const activeRows = directory.employees.filter(isActiveDirectoryEmployee);

  if (isCompanyWorkforceRole(role)) return activeRows;

  if (role === "Regional Manager") {
    return regionalManagerScopeRows(activeRows, employee, directory.employees, currentCanonicalHrId);
  }

  if (isLineWorkforceRole(role)) {
    return activeRows.filter((row) => {
      if (typeof employee.lineId === "number" && typeof row.lineId === "number") {
        return row.lineId === employee.lineId;
      }
      return normalizeLineName(row.lineName) === currentLine;
    });
  }

  if (isTeamWorkforceRole(role)) {
    return activeRows.filter((row) => {
      const rowCanonicalHrId = normalizeHrIdForAccess(row.hrId);
      const managerCanonicalHrId = normalizeHrIdForAccess(row.managerHrId);
      return Boolean(
        (rowCanonicalHrId && currentCanonicalHrId && rowCanonicalHrId === currentCanonicalHrId) ||
          (managerCanonicalHrId && currentCanonicalHrId && managerCanonicalHrId === currentCanonicalHrId),
      );
    });
  }

  return activeRows.filter((row) => normalizeHrIdForAccess(row.hrId) === currentCanonicalHrId);
}

function resolvePortalWorkforceScopeLabel({
  currentUser,
  employee,
}: {
  currentUser: PortalCurrentUser;
  employee: EmployeeDirectoryRow;
}) {
  const role = normalizeRole(currentUser.role);
  if (isCompanyWorkforceRole(role)) return "Company";
  if (role === "Regional Manager") return "Your regions";
  if (isLineWorkforceRole(role)) return employee.lineName ?? currentUser.line ?? "Your line";
  if (isTeamWorkforceRole(role)) return "Your team";
  return employee.displayName;
}

function countRowsWithUpcomingDate(
  rows: EmployeeDirectoryRow[],
  resolveDate: (row: EmployeeDirectoryRow) => string | null,
  windowDays: number,
) {
  return rows.filter((row) => isDateWithinLifecycleRiskWindow(resolveDate(row), windowDays)).length;
}

function buildPortalWorkforceSummary({
  pendingApprovals,
  rows,
  scopeLabel,
  vacancySummary,
}: {
  pendingApprovals: number;
  rows: EmployeeDirectoryRow[];
  scopeLabel: string;
  vacancySummary: PortalVacancySummary;
}): MedicalRepPortalData["workforce"] {
  const today = new Date();
  const missingEmployeeData = rows.filter((row) => {
    return !row.hireDate || !row.lineName || !row.managerHrId || !row.jobTitle;
  }).length;
  const newHires = rows.filter((row) => {
    const days = daysBetweenDateOnly(row.hireDate, today);
    return days !== null && days >= 0 && days <= 30;
  }).length;
  const probationDue = countRowsWithUpcomingDate(
    rows,
    (row) => probationEndDateFromHire(row.hireDate),
    lifecycleRiskWindows.probationRiskDays,
  );
  const contractRenewalsDue = countRowsWithUpcomingDate(
    rows,
    (row) => computeEmploymentJourney(row).contractRenewalDate,
    lifecycleRiskWindows.contractRiskDays,
  );
  const dataCoveragePercent = rows.length > 0
    ? ((rows.length - missingEmployeeData) / rows.length) * 100
    : 0;

  return {
    activeHeadcount: rows.length,
    contractRenewalsDue,
    dataCoveragePercent,
    missingEmployeeData,
    newHires,
    openVacancies: vacancySummary.openVacancies,
    pendingApprovals,
    probationDue,
    scopeLabel,
  };
}

type PortalVacancySummary = {
  districtManagerVacancies: number;
  groupProductManagerVacancies: number;
  lineStructureVacancies: number;
  medicalRepVacancies: number;
  nationalSalesManagerVacancies: number;
  openVacancies: number;
};

function emptyPortalVacancySummary(): PortalVacancySummary {
  return {
    districtManagerVacancies: 0,
    groupProductManagerVacancies: 0,
    lineStructureVacancies: 0,
    medicalRepVacancies: 0,
    nationalSalesManagerVacancies: 0,
    openVacancies: 0,
  };
}

async function fetchOpenVacancySummaryForScope({
  currentUser,
  directory,
  employee,
}: {
  currentUser: PortalCurrentUser;
  directory: EmployeeDirectoryData;
  employee: EmployeeDirectoryRow;
}): Promise<PortalVacancySummary> {
  const role = normalizeRole(currentUser.role);
  const currentLine = normalizeLineName(currentUser.line ?? employee.lineName);
  const currentCanonicalHrId = normalizeHrIdForAccess(currentUser.hrId);
  const regionalManagerRegionKeys =
    role === "Regional Manager" && currentCanonicalHrId
      ? regionsWithinManagerHierarchy(directory.employees, currentCanonicalHrId, normalizeHrIdForAccess)
      : null;
  const supabase = getSupabaseAdmin();

  try {
    const rows = await fetchAllRows<{
      area_id?: number | null;
      id: number;
      job_title: string | null;
      line_id: number | null;
      lines?: { name: string | null } | null;
      manager_hr_id: string | null;
      note?: string | null;
      position_id?: number | null;
      positions?: { title: string | null } | null;
      region_name?: string | null;
      vacancy_code: string | null;
    }>(() => {
      let query = supabase
        .from("position_vacancies")
        .select("id,vacancy_code,job_title,line_id,manager_hr_id,note,region_name,area_id,position_id,lines(name),positions(title)")
        .eq("status", "open");

      if (isTeamWorkforceRole(role) && currentUser.hrId) {
        query = query.eq("manager_hr_id", currentUser.hrId);
      } else if ((role === "Regional Manager" || isLineWorkforceRole(role)) && typeof employee.lineId === "number") {
        // RM's authoritative region bound is applied client-side below (regionalManagerRegionKeys);
        // this is only the coarse line_id pre-filter, same as the other line-workforce roles.
        query = query.eq("line_id", employee.lineId);
      }

      return query;
    }, "id");

    const scopedRows = rows.filter((row) => {
      if (isCompanyWorkforceRole(role)) return true;
      if (role === "Regional Manager") {
        if (!regionalManagerRegionKeys || regionalManagerRegionKeys.size === 0) return false;
        if (typeof employee.lineId !== "number" || row.line_id !== employee.lineId) return false;
        const region = normalizeRegionLabel(row.region_name);
        return Boolean(region && regionalManagerRegionKeys.has(region));
      }
      if (isLineWorkforceRole(role)) {
        if (typeof employee.lineId === "number" && typeof row.line_id === "number") {
          return row.line_id === employee.lineId;
        }
        return normalizeLineName(row.lines?.name ?? null) === currentLine;
      }
      if (isTeamWorkforceRole(role)) {
        const managerCanonicalHrId = normalizeHrIdForAccess(row.manager_hr_id);
        return Boolean(
          managerCanonicalHrId &&
            currentCanonicalHrId &&
            managerCanonicalHrId === currentCanonicalHrId,
        );
      }
      return false;
    });

    const uniqueRows = uniqueVacancyRows(scopedRows);
    const districtManagerVacancies = uniqueRows.filter((row) =>
      isDistrictManagerVacancyTitle(row.job_title, row.positions?.title),
    ).length;
    const medicalRepVacancies = uniqueRows.filter((row) =>
      isMedicalRepVacancyTitle(row.job_title, row.positions?.title),
    ).length;
    const nationalSalesManagerVacancies = uniqueRows.filter((row) =>
      isNationalSalesManagerVacancyTitle(row.job_title, row.positions?.title),
    ).length;
    const groupProductManagerVacancies = uniqueRows.filter((row) =>
      isGroupProductManagerVacancyTitle(row.job_title, row.positions?.title),
    ).length;

    return {
      districtManagerVacancies,
      groupProductManagerVacancies,
      lineStructureVacancies:
        districtManagerVacancies +
        medicalRepVacancies +
        nationalSalesManagerVacancies +
        groupProductManagerVacancies,
      medicalRepVacancies,
      nationalSalesManagerVacancies,
      openVacancies: uniqueRows.length,
    };
  } catch (error) {
    logPortalFailure("open vacancy summary query failed", error);
    return {
      districtManagerVacancies: 0,
      groupProductManagerVacancies: 0,
      lineStructureVacancies: 0,
      medicalRepVacancies: 0,
      nationalSalesManagerVacancies: 0,
      openVacancies: 0,
    };
  }
}

async function resolvePortalStructureSummary({
  access,
  currentUser,
  directory,
  employee,
  vacancySummary,
}: {
  access: AccessContext;
  currentUser: PortalCurrentUser;
  directory: EmployeeDirectoryData;
  employee: EmployeeDirectoryRow;
  vacancySummary: PortalVacancySummary;
}): Promise<MedicalRepPortalData["orgStructure"]> {
  const currentRole = normalizeRole(currentUser.role);
  const isDsm = currentRole === "District Manager";
  const isNsm = currentRole === "National Sales Manager";
  if (!isDsm && !isNsm) return null;

  const currentCanonicalHrId = normalizeHrIdForAccess(currentUser.hrId);
  const currentLine = normalizeLineName(currentUser.line ?? employee.lineName);
  const isCurrentLineRow = (row: EmployeeDirectoryRow) => {
    if (typeof employee.lineId === "number" && typeof row.lineId === "number") {
      return row.lineId === employee.lineId;
    }
    return normalizeLineName(row.lineName) === currentLine;
  };

  const activeRows = directory.employees.filter((row) => {
    if (!isActiveDirectoryEmployee(row)) return false;

    if (isNsm) {
      return isCurrentLineRow(row) && isLineStructureDirectoryEmployee(row);
    }

    const managerCanonicalHrId = normalizeHrIdForAccess(row.managerHrId);
    return Boolean(
      isMedicalRepDirectoryEmployee(row) &&
        managerCanonicalHrId &&
        currentCanonicalHrId &&
        managerCanonicalHrId === currentCanonicalHrId,
    );
  });

  void access;
  const vacancyCount = isNsm ? vacancySummary.lineStructureVacancies : vacancySummary.openVacancies;
  const actualNow = activeRows.length;
  const activeNationalSalesManagers = activeRows.filter(isNationalSalesManagerDirectoryEmployee).length;
  const activeDistrictManagers = activeRows.filter(isDistrictManagerEmployee).length;
  const activeGroupProductManagers = activeRows.filter(isGroupProductManagerDirectoryEmployee).length;
  const activeMedicalReps = activeRows.filter(isMedicalRepDirectoryEmployee).length;

  return {
    actualNow,
    compositionLabel: isNsm
      ? formatLineStructureComposition({
          districtManagers: activeDistrictManagers + vacancySummary.districtManagerVacancies,
          groupProductManagers:
            activeGroupProductManagers + vacancySummary.groupProductManagerVacancies,
          medicalRepresentatives: activeMedicalReps + vacancySummary.medicalRepVacancies,
          nationalSalesManagers:
            activeNationalSalesManagers + vacancySummary.nationalSalesManagerVacancies,
        })
      : null,
    districtManagerVacancies: vacancySummary.districtManagerVacancies,
    scope: isNsm ? "line" : "team",
    scopeLabel: isNsm
      ? employee.lineName ?? currentUser.line ?? "Your line"
      : employee.displayName,
    totalStructure: actualNow + vacancyCount,
    vacancies: vacancyCount,
  };
}

function formatLineStructureComposition({
  districtManagers,
  groupProductManagers,
  medicalRepresentatives,
  nationalSalesManagers,
}: {
  districtManagers: number;
  groupProductManagers: number;
  medicalRepresentatives: number;
  nationalSalesManagers: number;
}) {
  const compactCount = (value: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
      Number.isFinite(value) ? value : 0,
    );

  return [
    `${compactCount(nationalSalesManagers)} National Sales Manager${nationalSalesManagers === 1 ? "" : "s"}`,
    `${compactCount(districtManagers)} District Manager${districtManagers === 1 ? "" : "s"}`,
    `${compactCount(groupProductManagers)} Group Product Manager${groupProductManagers === 1 ? "" : "s"}`,
    `${compactCount(medicalRepresentatives)} Medical Representative${medicalRepresentatives === 1 ? "" : "s"}`,
  ].join(" + ");
}

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

// ── Portal performance target aggregation ─────────────────────────────────────
// A rep/DSM's target for a (territory, period, product) can appear on several sales
// rows — the SAME figure repeated across the Retail/Stores/Discount or duplicate rows
// for that cell (an "echo"), OR genuinely different figures that are additive. We SUM
// the DISTINCT target values per key: an echo (identical to the cent) is counted once,
// while genuinely different targets add up. This realizes the additive intent (matching
// the admin Source-of-Sales dashboard) without double-counting a repeated target.
// Values are compared per integer cent to absorb floating-point representation noise.
export function addDistinctTargetValue(map: Map<string, Set<number>>, key: string, target: number): void {
  if (!Number.isFinite(target) || target <= 0) return;
  const cents = Math.round(target * 100);
  let set = map.get(key);
  if (!set) {
    set = new Set<number>();
    map.set(key, set);
  }
  set.add(cents);
}

export function sumDistinctTargetValues(set: Set<number> | undefined): number {
  if (!set) return 0;
  let cents = 0;
  set.forEach((value) => {
    cents += value;
  });
  return cents / 100;
}

async function resolveSalesRankInTeam(params: {
  managerHrId: string | null;
  currentHrId: string;
  comparisonPeriod?: string | null;
  directory?: EmployeeDirectoryData | null;
  comparisonMode?: "team-members" | "line-managers" | "line-members";
  comparisonLineId?: number | null;
  comparisonRole?: string | null;
}) {
  const viewerHrId = normalizeHrId(params.currentHrId);
  if (!viewerHrId) return null;

  const directory = params.directory ?? await getEmployeeDirectory().catch(() => null);
  if (!directory) return null;

  const resolveTeamHrId = (value: string | null | undefined) => {
    const normalized = normalizeHrId(value);
    const canonical = normalized ? normalizeHrIdForAccess(normalized) : null;
    return canonical || normalized;
  };
  const managerHrId = normalizeHrId(params.managerHrId);
  const viewer = directory.employees.find((employee) => normalizeHrId(employee.hrId) === viewerHrId) ?? null;
  const comparisonMode = params.comparisonMode ?? "team-members";
  const isLineManagersMode = comparisonMode === "line-managers";
  const isLineMembersMode = comparisonMode === "line-members";
  const canonicalLineId = Number.isFinite(Number(params.comparisonLineId)) ? Number(params.comparisonLineId) : null;
  const canonicalManagerHrId = resolveTeamHrId(managerHrId);
  const canonicalComparisonRole = params.comparisonRole ? resolveJobFunctionRole(params.comparisonRole) : null;
  const viewerLineId = viewer?.lineId ?? null;
  const lineIdForComparison = isLineManagersMode || isLineMembersMode
    ? (canonicalLineId ?? (viewerLineId != null ? Number(viewerLineId) : null))
    : null;

  // Team scope: same manager_hr_id as viewer, plus viewer itself.
  const teamHrIds = new Set<string>();
  const teamHrCanonicalIds = new Set<string>();
  const originalHrIds = new Set<string>();

  if ((isLineManagersMode || isLineMembersMode) && lineIdForComparison !== null) {
    directory.employees.forEach((employee) => {
      const employeeHrId = normalizeHrId(employee.hrId);
      if (!employeeHrId) return;
      const employeeLineId = Number(employee.lineId);
      const employeeRole = resolveJobFunctionRole(employee.jobTitle || employee.positionTitle);
      const isSameLine = Number.isFinite(employeeLineId) && employeeLineId === lineIdForComparison;
      const isSameRole = canonicalComparisonRole ? employeeRole === canonicalComparisonRole : true;

      if (isSameLine && isSameRole) {
        teamHrIds.add(employeeHrId);
        const canonical = resolveTeamHrId(employee.hrId);
        if (canonical) teamHrCanonicalIds.add(canonical);
        if (employee.hrId) originalHrIds.add(employee.hrId);
      }
    });
  } else if (managerHrId) {
    directory.employees.forEach((employee) => {
      const employeeHrId = normalizeHrId(employee.hrId);
      const employeeManagerHrId = resolveTeamHrId(employee.managerHrId);
      if (!employeeHrId) return;
      if (employeeManagerHrId === canonicalManagerHrId || employeeHrId === viewerHrId) {
        teamHrIds.add(employeeHrId);
        const canonical = resolveTeamHrId(employee.hrId);
        if (canonical) teamHrCanonicalIds.add(canonical);
        if (employee.hrId) originalHrIds.add(employee.hrId);
      }
    });
  } else if (viewer) {
    // If no manager is assigned, fallback to self-only team.
    teamHrIds.add(viewerHrId);
    const canonical = resolveTeamHrId(viewer.hrId);
    if (canonical) teamHrCanonicalIds.add(canonical);
    if (viewer.hrId) originalHrIds.add(viewer.hrId);
  }

  if (teamHrIds.size === 0) return null;

  const queryHrIds = new Set<string>(Array.from(originalHrIds).map((id) => normalizeHrId(id)).filter(Boolean) as string[]);
  teamHrCanonicalIds.forEach((id) => queryHrIds.add(id));
  const buildHrSearchCandidates = (value: string | null | undefined) => {
    const normalized = normalizeHrId(value);
    if (!normalized) return [];
    const canonical = normalizeHrIdForAccess(normalized);
    return canonical && canonical !== normalized ? [normalized, canonical] : [normalized];
  };
  const queryCandidates = Array.from(
    new Set(
      Array.from(queryHrIds)
        .flatMap((id) => buildHrSearchCandidates(id))
        .filter((value) => value),
    ),
  );

  const periodFilter = parsePeriodToMonthYear(params.comparisonPeriod ?? "");

  // Rule #1: the rank a rep sees beside their name has to be computed from the same sales
  // the rest of the system reports for them, so this reads SoS Monthly Closing too.
  //
  // `employee_name` is intentionally absent from the projected rows — the legacy view carried
  // a denormalized name that could disagree with the directory, and resolveMemberIdFromRow
  // already prefers the directory. The name-matching fallback simply never fires now.
  const candidateSet = new Set(queryCandidates.map((id) => id.toLowerCase()));
  const projectRankRows = (rows: PortalSalesNormalized[]) =>
    rows.map((row) => ({
      employee_hr_id: row.hrId,
      hr_id: row.hrId,
      manager_hr_id: row.managerHrId,
      month: row.month,
      product: row.product,
      sales_value: row.salesValue,
      target_value: row.targetValue,
      territory: row.territory,
      year: row.year,
    }));

  let data: unknown[] = [];
  let error: unknown = null;
  try {
    const canonicalRows = await loadCanonicalPortalSalesRows(
      periodFilter ? { month: periodFilter.month, year: String(periodFilter.year) } : {},
    );
    // DSM comparison rolls a manager's whole team up to them; med-rep comparison ranks
    // individuals, so pulling in rows via manager_hr_id would credit a rep with their
    // teammates' sales.
    const scoped = isLineManagersMode
      ? selectCanonicalRowsForHrIds(canonicalRows, queryCandidates)
      : canonicalRows.filter((row) => candidateSet.has(row.hrId.toLowerCase()));

    data = projectRankRows(scoped);

    if (data.length === 0 && queryHrIds.size > 0) {
      // Fallback: attribute every row in application logic instead, exactly as before.
      data = projectRankRows(canonicalRows);
    }
  } catch (err) {
    error = err;
  }

  if (error) {
    return { rank: null, comparison: [] as Array<{ position: number; name: string; achievementPercent: number; sales: number; target: number }> };
  }

  const nameByHrId = new Map(
    directory.employees
      .map((employee) => [resolveTeamHrId(employee.hrId), employee.displayName] as const)
      .filter(([hrId]) => Boolean(hrId)) as Array<[string, string]>,
  );
  const teamNameToHrId = new Map<string, string>();
  directory.employees.forEach((employee) => {
    const canonicalHrId = resolveTeamHrId(employee.hrId);
    if (!canonicalHrId || !teamHrCanonicalIds.has(canonicalHrId)) return;
    const fullName = employee.fullName?.trim();
    const normalizedFullName = fullName?.toLowerCase().replace(/\s+/g, " ");
    if (normalizedFullName) teamNameToHrId.set(normalizedFullName, canonicalHrId);
  });

  const resolveMemberIdFromRow = (row: Record<string, unknown>) => {
    const preferredMemberId = isLineManagersMode ? row.manager_hr_id : row.employee_hr_id;
    const hrCandidates = [
      preferredMemberId,
      row.employee_hr_id,
      row.hr_id,
      (row as Record<string, unknown>).employeeId,
      (row as Record<string, unknown>).employee_id,
    ];
    for (const candidate of hrCandidates) {
      const id = resolveTeamHrId(candidate as string | null | undefined);
      if (!id) continue;
      if (teamHrCanonicalIds.has(id)) return id;
    }

    const fallbackName = String(row.employee_name ?? "").trim();
    if (fallbackName) {
      const normalizedName = fallbackName.toLowerCase().replace(/\s+/g, " ");
      const matched = teamNameToHrId.get(normalizedName);
      if (matched) return matched;
    }
    return null;
  };

  const memberNames = new Map<string, string>();
  const totals = new Map<string, { name: string; sales: number; target: number }>();

  // Target aggregation strategy depends on comparison mode:
  //
  // team-members mode (Med Reps): memberId IS the individual employee.
  //   A cell's target can repeat across the sales rows for one territory+product+period
  //   (echo) or differ (additive). Key by territory; sum DISTINCT targets per key, then
  //   sum across territories → the member's real total.
  //
  // line-managers mode (DSMs): memberId is the DSM; rows come from all their team members.
  //   Same rule per individual+territory, then sum across all individuals under the DSM.
  //   individualEmployeeId = employee_hr_id (or fallback to hr_id for vacant rows).

  // key format:
  //   team-members → "TM::{memberId}::{territory}::{period}::{product}"
  //   line-managers → "LM::{individualId}::{territory}::{period}::{product}"  (maps back to memberId separately)
  const targetSetKeys = new Map<string, Set<number>>();
  // For line-managers only: track which memberId each individualId belongs to
  const individualToMember = new Map<string, string>();

  toSafeArray(data).forEach((row) => {
    const r = row as Record<string, unknown>;
    const memberId = resolveMemberIdFromRow(r);
    if (!memberId) return;

    const rowName = String(r.employee_name ?? "").trim();
    const name = nameByHrId.get(memberId) || rowName || "Team Member";
    memberNames.set(memberId, name);

    const rowMonth = Number(r.month ?? 0);
    const rowYear = Number(r.year ?? 0);
    const product = String(r.product ?? "").trim() || "Unknown";
    const territory = String(r.territory ?? "").trim() || "Unassigned";
    const periodKey = rowYear && rowMonth
      ? `${rowYear}-${String(rowMonth).padStart(2, "0")}`
      : "unassigned";
    const targetValue = Number(r.target_value ?? 0);

    let targetKey: string;
    if (isLineManagersMode) {
      // Dedup within each individual employee+territory; track which DSM they belong to
      const individualId = String(r.employee_hr_id ?? r.hr_id ?? "").trim().toLowerCase() || `${memberId}::vacant`;
      targetKey = `LM::${individualId}::${territory}::${periodKey}::${product}`;
      individualToMember.set(individualId, memberId);
    } else {
      // Include territory: each territory has its own target; sum across territories is the real total
      targetKey = `TM::${memberId}::${territory}::${periodKey}::${product}`;
    }

    addDistinctTargetValue(targetSetKeys, targetKey, targetValue);
  });

  // Pass 2 — sum sales (all rows, simple sum)
  toSafeArray(data).forEach((row) => {
    const r = row as Record<string, unknown>;
    const memberId = resolveMemberIdFromRow(r);
    if (!memberId) return;
    const name = memberNames.get(memberId) ?? "Team Member";
    const salesValue = Number(r.sales_value ?? 0);
    const current = totals.get(memberId) ?? { name, sales: 0, target: 0 };
    totals.set(memberId, {
      ...current,
      name,
      sales: current.sales + (Number.isFinite(salesValue) ? salesValue : 0),
    });
  });

  // Pass 3 — add targets (sum of distinct values per key)
  targetSetKeys.forEach((set, key) => {
    let memberId: string | undefined;
    if (isLineManagersMode) {
      // key = "LM::{individualId}::{territory}::{period}::{product}"
      const individualId = key.slice("LM::".length).split("::")[0];
      memberId = individualToMember.get(individualId);
    } else {
      // key = "TM::{memberId}::{territory}::{period}::{product}"
      memberId = key.slice("TM::".length).split("::")[0];
    }
    if (!memberId) return;
    const current = totals.get(memberId);
    if (!current) return;
    totals.set(memberId, { ...current, target: current.target + sumDistinctTargetValues(set) });
  });

  teamHrCanonicalIds.forEach((hrId) => {
    if (!totals.has(hrId)) {
      totals.set(hrId, {
        name: memberNames.get(hrId) ?? nameByHrId.get(hrId) ?? "Team Member",
        sales: 0,
        target: 0,
      });
    }
  });

  const ranked = [...totals.entries()]
    .map(([hrId, stats]) => {
      const achievementPercent = stats.target > 0 ? (stats.sales / stats.target) * 100 : 0;
      return {
        achievementPercent: Number.isFinite(achievementPercent) ? achievementPercent : 0,
        hrId,
        name: stats.name,
        sales: stats.sales,
        target: stats.target,
      };
    })
    .sort((a, b) => {
      if (b.achievementPercent !== a.achievementPercent) return b.achievementPercent - a.achievementPercent;
      return b.sales - a.sales;
    })
    .map((entry, index) => ({
      ...entry,
      position: index + 1,
    }));

  if (ranked.length === 0) {
    return { comparison: [], rank: null as { position: number; total: number } | null };
  }

  const viewerRank = ranked.find((entry) => entry.hrId === resolveTeamHrId(params.currentHrId)) ?? null;
  const comparison = ranked.map((entry) => ({
    achievementPercent: entry.achievementPercent,
    name: entry.name,
    position: entry.position,
    sales: entry.sales,
    target: entry.target,
  }));

  return {
    comparison,
    rank: viewerRank ? { position: viewerRank.position, total: ranked.length } : null,
  };
}

type TeamComparisonOptions = {
  includeLiveOutstationExpenses?: boolean;
  includePortalOverview?: boolean;
  includeTeamRank?: boolean;
  includeWorkforceSummary?: boolean;
  teamComparisonPeriod?: string | null;
};

export async function getMedicalRepPortalData(
  access: AccessContext,
  options: TeamComparisonOptions = {},
): Promise<MedicalRepPortalData> {
  try {
    const currentUser = await resolvePortalCurrentUser(access);
    const currentHrId = normalizeHrId(currentUser.hrId);

    const salesScope = getSalesScope({
      role: currentUser.role as PhoenixRole,
      salesScopeOverride: currentUser.salesScopeOverride as BusinessScope,
    });
    const includeLiveOutstationExpenses = options.includeLiveOutstationExpenses ?? true;
    const includePortalOverview = options.includePortalOverview ?? true;
    const includeTeamRank = options.includeTeamRank ?? true;
    const includeWorkforceSummary = options.includeWorkforceSummary ?? true;

    const directory = await getEmployeeDirectory();
    const currentEmployee = currentHrId ? findDirectoryEmployeeByHrId(directory, currentHrId) : null;
    const salesLineFilter = resolvePortalSalesLineFilter(currentUser, currentEmployee);
    // HIERARCHY viewers (Regional Manager) must see their WHOLE subtree here, not just direct reports.
    // canSeeEmployee is a one-level isDirectReport check, so an RM resolved to self + their 3 DSMs —
    // and DSMs carry no sales rows of their own. targetSalesHrIds below therefore contained nobody who
    // actually sells, which zeroed the incentive achievement and the team sales roll-up (reading
    // "0.0%" and EGP 0 while the region was at ~105%). TEAM (DSM) and SELF keep canSeeEmployee, and
    // LINE/COMPANY never reach targetSalesHrIds at all — getScopedEmployeePortalSalesDashboard
    // special-cases LINE via the line filter — so this only changes the hierarchy case.
    const hierarchyViewerKey =
      salesScope === "HIERARCHY" || access.scope === "hierarchy" ? normalizeHrIdForAccess(currentHrId) : null;
    const subtreeByCanonicalHrId = hierarchyViewerKey
      ? new Map(
          directory.employees
            .map((row) => [normalizeHrIdForAccess(row.hrId), row] as const)
            .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
        )
      : null;
    const visibleTeamMembers = directory.employees.filter((row) => {
      const rowHrId = normalizeHrId(row.hrId);
      if (rowHrId === currentHrId) return false;
      if (hierarchyViewerKey && subtreeByCanonicalHrId) {
        return isWithinManagerHierarchy({
          employee: row,
          byCanonicalHrId: subtreeByCanonicalHrId,
          viewerCanonicalHrId: hierarchyViewerKey,
          canonicalize: normalizeHrIdForAccess,
        });
      }
      return canSeeEmployee(access, row);
    });

    const targetSalesHrIds: string[] = currentHrId ? [currentHrId] : [];
    if (salesScope !== "SELF") {
      const teamHrIds = visibleTeamMembers.map((m) => normalizeHrId(m.hrId)).filter(Boolean) as string[];
      targetSalesHrIds.push(...teamHrIds);
    }

    // Prefetch dashboards to avoid double fetching inside getEmployeePortalData
    const [scopedSales, payrollDashboard, historicalExpenses, liveOutstationExpenses, expenseReports] = await devSafePromiseAll([
      () => getScopedEmployeePortalSalesDashboard({
        line: salesLineFilter,
        salesScope,
        targetSalesHrIds,
      }),
      () => currentHrId ? getEmployeePortalPayrollDashboard(currentHrId) : Promise.resolve(null),
      async () =>
        withLivePortalExpenseNames(
          await listPayrollExpenses(undefined, undefined, undefined, { ...access, hrId: currentHrId }),
        ),
      // Live outstation (system-entered) expenses must follow the SAME access scope as
      // the historical rows above — otherwise managers only see their own trips and the
      // team's system-entered expenses vanish (they used to be masked by Excel uploads).
      async () =>
        includeLiveOutstationExpenses
          ? withLivePortalExpenseNames(
              await listOutstationRequestExpenses({ ...access, hrId: currentHrId }),
            )
          : [],
      () => listPayrollExpenseReports({ ...access, hrId: currentHrId }),
    ]);
    // The dashboard and the rows it was folded from. The rows are what the Pedia split incentive
    // reads per product; every other consumer wants the dashboard, as before.
    const salesDashboard = scopedSales.dashboard;
    const portalSalesRecords = scopedSales.records;
    const expenses = [
      ...dedupeHistoricalExpensesByTrip(historicalExpenses, liveOutstationExpenses),
      ...liveOutstationExpenses,
    ];

    const base = await getEmployeePortalData(access, {
      payroll: payrollDashboard,
      sales: salesDashboard,
      directory: directory,
      expenses,
      expenseReports: expenseReports,
    });

  const employee = base.employee;
  if (!employee) {
    throw new Error("Employee profile not found for the current user.");
  }
  const profileLinked =
    currentHrId !== null && toCanonicalPortalHrId(employee.hrId) === toCanonicalPortalHrId(currentHrId);
  const workforceRows = resolvePortalWorkforceRows({
    currentUser,
    directory,
    employee,
  });
  const shouldBuildScopeSummaries = includePortalOverview || includeWorkforceSummary;
  const vacancySummary = shouldBuildScopeSummaries
    ? await fetchOpenVacancySummaryForScope({
        currentUser,
        directory,
        employee,
      })
    : emptyPortalVacancySummary();
  // "Expense actions pending" counts only what still waits for a DECISION. `!hrApproved` also swept
  // in every REJECTED trip, and imported history (trips before July 2026) is values only — owner
  // ruling 2026-09-12, see imported-history.ts — so neither may raise the action.
  const pendingApprovalCount = expenses.filter(
    (expense) =>
      expenseApprovalState({ hrApproved: expense.hrApproved, status: expense.status }) === "pending" &&
      !isImportedHistoryTrip(expense.date),
  ).length;
  const overview = includePortalOverview
    ? await buildEmployeePortalOverviewData({
        access,
        currentHrId,
        pendingExpenseCount: pendingApprovalCount,
      })
    : {
        employeesOnLeaveToday: [],
        myActions: [],
        vacancyDetails: null,
      };
  const workforceScopeLabel = resolvePortalWorkforceScopeLabel({ currentUser, employee });
  const workforce = includeWorkforceSummary
    ? buildPortalWorkforceSummary({
        pendingApprovals: pendingApprovalCount,
        rows: workforceRows,
        scopeLabel: workforceScopeLabel,
        vacancySummary,
      })
    : {
        activeHeadcount: 0,
        contractRenewalsDue: 0,
        dataCoveragePercent: 0,
        missingEmployeeData: 0,
        newHires: 0,
        openVacancies: 0,
        pendingApprovals: 0,
        probationDue: 0,
        scopeLabel: workforceScopeLabel,
      };

  const allTimeTrend = (salesDashboard && Array.isArray(salesDashboard.trend))
    ? salesDashboard.trend
        .map((item) => {
          const row = item as Record<string, unknown>;
          const sales = Number(row.sales ?? 0);
          return {
            period: String(row.period ?? ""),
            sales,
            // Sales on a key that has a target — the only part an achievement may divide. A trend
            // from an engine that does not separate it reports nothing here, and falling back to
            // `sales` keeps the previous meaning; falling back to 0 would zero a payout figure.
            coveredSales: row.coveredSales == null ? sales : Number(row.coveredSales),
            target: Number(row.target ?? 0),
          };
        })
        .filter((item) => item.period)
    : [];

  // The payout window is the DECLARED CALENDAR semester — today that is Semester 2 2026 (Jul–Dec)
  // — not "the last six rows that happen to exist" and not the rep's own latest month. `slice(-6)`
  // gave different-length semesters to different reps (June 2026 was half-loaded: 26 reps had five
  // periods and one had four while 56 colleagues had six) and would silently straddle the
  // Semester 1 / Semester 2 boundary the moment a July sheet landed, quietly changing everyone's
  // payout. See src/lib/incentives/semester.ts. The 2026 payout curve itself is untouched.
  const cairoNow = currentCairoDateParts();
  const todayPeriod = `${cairoNow.year}-${String(cairoNow.month).padStart(2, "0")}`;
  const incentiveWindow = resolveIncentiveWindow({
    periods: allTimeTrend.map((point) => point.period),
    todayPeriod,
  });
  // The semester window governs the INCENTIVE figures and nothing else. Every other sales surface
  // on this payload — the trend chart, the team-comparison period picker, the latest-month ring,
  // the "no sales data" empty state — describes what the rep actually HAS, and must keep seeing
  // every loaded month. Scoping those to the payout window would blank a rep's entire sales section
  // on 1 July, the moment H2 is declared and before anything has been uploaded into it.
  const semesterTrend = incentiveWindow
    ? allTimeTrend.filter((point) => incentiveWindow.present.includes(point.period))
    : [];

  const latestTrend = allTimeTrend[allTimeTrend.length - 1] ?? null;
  const previousTrend = allTimeTrend[allTimeTrend.length - 2] ?? null;

  // All-time totals kept for the "All-time" dashboard lens and reach-target widget.
  const overviewSales = salesDashboard?.summary?.totalApprovedSales ??
    allTimeTrend.reduce((sum, point) => sum + Number((point as Record<string, unknown>).sales ?? 0), 0);
  const overviewTarget = salesDashboard?.summary?.totalApprovedTarget ??
    allTimeTrend.reduce((sum, point) => sum + Number((point as Record<string, unknown>).target ?? 0), 0);

  // Semester achievement: computed over the declared semester window (semesterTrend), NOT all-time
  // totals, so the incentive tab reflects the semester a rep is actually paid on. When that window
  // is incomplete the figure is still shown, but `incentiveWindowNotice` forces it to be read as
  // provisional rather than settled — see describeIncompleteWindow.
  //
  // With no semester target this is 0 and the callers below must read `incentiveSemesterTarget`
  // before rendering it — a rep with nothing in H2 yet has NO achievement, and the old fallback
  // here (`base.sales.achievementRate`, an ALL-TIME rate carrying closed H1 months) would have put
  // an H1 number on screen labelled as this semester's, and fed it to the payout curve. Under the
  // calendar anchor that is no longer an edge case: it is every rep until their July lands.
  //
  // THE INCENTIVE BASIS, in the owner's own words (2026-09-05, asked directly): "the incentive is
  // total sales per semester over total target semester, twice yearly, the first time from Jan to
  // June and the second from July to Dec." So: TOTAL sales ÷ TOTAL target, over the calendar
  // semester. The window above already is that; this line is the numerator half of it.
  //
  // It divided COVERED sales until then — only the money sitting on a product that carried a
  // target — justified by a comment claiming "/sales-vs-target and Monthly Closing both measure
  // achievement as covered ÷ target". Neither was true by 2026-09-05: vs-target was moved onto the
  // closing's rule that morning, and the Monthly Closing NEVER used covered ÷ target —
  // `closingAchievement` (monthly-closing-matrix-cells.ts) has always divided all sales. So the
  // stated reason for the covered numerator was a mistaken belief about the closing, and the rule
  // it appealed to — a rep's month reads identically everywhere — is the reason to divide TOTAL.
  //
  // Measured before the change, across all 80 reps carrying an H2 target: it moved NOBODY's payout.
  // One rep differed at all (21.76% against 25.90%) and sat far below the 90% floor, while the
  // three reps above that floor had no untargeted sales whatsoever. That is why this was safe to
  // correct rather than something to grandfather — but it does not stay free: the 90% floor is
  // worth 50 points of payout, so a rep at 88% covered and 92% total is the case this prevents.
  //
  // ⚠ A SEMESTER MONTH CARRYING NO TARGET INFLATES THIS, and that is a live shape rather than a
  // hypothetical: Anti Infective has no 2026-09 target row while CNS and Pedia do. Sales in such a
  // month are divided by a target that excludes them. The owner's definition is total over total,
  // so it is honoured literally here rather than silently carved out — the fix belongs in loading
  // the missing target, not in quietly redefining his formula. Raised with him on 2026-09-05.
  const semesterSales = semesterTrend.reduce((sum, p) => sum + p.sales, 0);
  const semesterTarget = semesterTrend.reduce((sum, p) => sum + p.target, 0);
  const overviewAchievementPercent = semesterTarget > 0 ? (semesterSales / semesterTarget) * 100 : 0;
  const growthVsLastMonthPercent =
    latestTrend && previousTrend && previousTrend.sales > 0
      ? ((latestTrend.sales - previousTrend.sales) / previousTrend.sales) * 100
      : null;

  const currentMonthSales = latestTrend?.sales ?? 0;
  const currentMonthTarget = latestTrend?.target ?? 0;
  // Same rule as the semester figure above: with no target for the month there is no achievement.
  // The all-time fallback that used to sit here paired a 140% ring with "EGP 0 of EGP 0 target"
  // underneath it, because the ring's own value and target come from this same empty month.
  const achievementPercent = currentMonthTarget > 0 ? (currentMonthSales / currentMonthTarget) * 100 : 0;

  // Enhance product contribution to be based on the latest month if available, otherwise all-time
  const productContribution = (salesDashboard && Array.isArray(salesDashboard.productPerformance))
    ? salesDashboard.productPerformance
        .map((item) => {
          const product = String((item as Record<string, unknown>).product ?? "Unknown");
          return {
            name: product,
            sales: Number((item as Record<string, unknown>).sales ?? 0),
            units: Number((item as Record<string, unknown>).salesUnits ?? 0),
          };
        })
        .filter((item) => item.sales > 0 || item.units > 0)
        .sort((a, b) => b.sales - a.sales)
        .slice(0, 5)
    : [];

  const familyContribution = (salesDashboard && Array.isArray(salesDashboard.familyMatrix))
    ? salesDashboard.familyMatrix
        .map((item) => ({
          name: String((item as Record<string, unknown>).name ?? "Unknown"),
          sales: Number((item as Record<string, unknown>).sales ?? 0),
          units: Number((item as Record<string, unknown>).units ?? 0),
        }))
        .filter((item) => item.sales > 0 || item.units > 0)
        .sort((a, b) => b.sales - a.sales)
    : [];

  const totalProductSales = productContribution.reduce((sum, p) => sum + p.sales, 0);
  const totalProductUnits = productContribution.reduce((sum, p) => sum + p.units, 0);
  const productContributionWithPercent = productContribution.map(p => ({
    ...p,
    salesPercentage: totalProductSales > 0 ? (p.sales / totalProductSales) * 100 : 0,
    unitsPercentage: totalProductUnits > 0 ? (p.units / totalProductUnits) * 100 : 0,
  }));

  const totalFamilySales = familyContribution.reduce((sum, f) => sum + f.sales, 0);
  const totalFamilyUnits = familyContribution.reduce((sum, f) => sum + f.units, 0);
  const familyContributionWithPercent = familyContribution.map(f => ({
    ...f,
    salesPercentage: totalFamilySales > 0 ? (f.sales / totalFamilySales) * 100 : 0,
    unitsPercentage: totalFamilyUnits > 0 ? (f.units / totalFamilyUnits) * 100 : 0,
  }));
  const territories = (salesDashboard && Array.isArray(salesDashboard.territories))
    ? salesDashboard.territories
        .map((item) => ({
          achievementPercent: Number((item as Record<string, unknown>).achievementRate ?? 0) * 100,
          name: String((item as Record<string, unknown>).name ?? "Unknown"),
          sales: Number((item as Record<string, unknown>).sales ?? 0),
          target: Number((item as Record<string, unknown>).target ?? 0),
        }))
        .filter((item) => item.sales > 0 || item.target > 0)
        .sort((left, right) => right.sales - left.sales)
    : [];
  const linePerformance = (salesDashboard && Array.isArray(salesDashboard.linePerformance))
    ? salesDashboard.linePerformance
        .map((item) => ({
          achievementPercent: Number((item as Record<string, unknown>).achievementRate ?? 0) * 100,
          name: String((item as Record<string, unknown>).line ?? "Unknown"),
          sales: Number((item as Record<string, unknown>).sales ?? 0),
          target: Number((item as Record<string, unknown>).target ?? 0),
        }))
        .filter((item) => item.sales > 0 || item.target > 0)
        .sort((left, right) => right.sales - left.sales)
    : [];

  const topProduct = productContribution[0]?.name ?? null;
  const topProductSalesValue = productContribution[0]?.sales ?? 0;
  const orgStructure = includeWorkforceSummary
    ? await resolvePortalStructureSummary({
        access,
        currentUser,
        directory,
        employee,
        vacancySummary,
      })
    : null;
  
  let teamRankResult: { 
    comparison: Array<{ position: number; name: string; achievementPercent: number; sales: number; target: number }>; 
    rank: { position: number; total: number } | null 
  } = { comparison: [], rank: null };
  let teamRankAllPeriodsResult: { 
    comparison: Array<{ position: number; name: string; achievementPercent: number; sales: number; target: number }>; 
    rank: { position: number; total: number } | null 
  } = { comparison: [], rank: null };
  let leadingMedicalRepResult: {
    comparison: Array<{ position: number; name: string; achievementPercent: number; sales: number; target: number }>;
    rank: { position: number; total: number } | null
  } | null = null;
  try {
    if (includeTeamRank && currentHrId) {
      const currentRole = normalizeRole(currentUser.role);
      const isDistrictManager = currentRole === "District Manager";
      const isNationalSalesManager = currentRole === "National Sales Manager";

      // DSM and NSM: compare against other DSMs in the same line (line-managers mode)
      // Med Rep: compare against teammates under the same manager (team-members mode)
      const comparisonMode: "team-members" | "line-managers" = (isDistrictManager || isNationalSalesManager)
        ? "line-managers"
        : "team-members";
      const comparisonRole: string | null = (isDistrictManager || isNationalSalesManager) ? "District Manager" : null;
      const comparisonLineId: number | null = (isDistrictManager || isNationalSalesManager) ? (employee.lineId ?? null) : null;
      const teamAnchorHrId = (isDistrictManager || isNationalSalesManager)
        ? null // line-managers mode uses lineId, not managerHrId
        : (salesScope === "SELF" ? employee.managerHrId : employee.hrId);

      const selectedPeriod = normalizeTeamComparisonPeriod(options.teamComparisonPeriod);

      // These three lookups only ever read the directory and the scope variables resolved
      // above — none depends on another's result — so they run concurrently instead of
      // paying for three sequential round trips on every portal load.
      const [allPeriodsResult, leadingMedicalRepLookup, selectedPeriodResult] = await Promise.all([
        resolveSalesRankInTeam({
          managerHrId: teamAnchorHrId,
          currentHrId,
          directory: directory,
          comparisonMode,
          comparisonRole,
          comparisonLineId,
        }),
        isNationalSalesManager
          ? resolveSalesRankInTeam({
              managerHrId: null,
              currentHrId,
              directory: directory,
              comparisonMode: "line-members",
              comparisonRole: "Medical Rep",
              comparisonLineId,
            })
          : Promise.resolve(null),
        selectedPeriod
          ? resolveSalesRankInTeam({
              managerHrId: teamAnchorHrId,
              currentHrId,
              comparisonMode,
              comparisonRole,
              comparisonLineId,
              comparisonPeriod: selectedPeriod,
              directory: directory,
            })
          : Promise.resolve(null),
      ]);

      if (allPeriodsResult) {
        teamRankAllPeriodsResult = allPeriodsResult;
      }

      if (isNationalSalesManager) {
        leadingMedicalRepResult = leadingMedicalRepLookup;
      }

      if (selectedPeriod) {
        if (selectedPeriodResult) {
          teamRankResult = selectedPeriodResult;
        }
      } else {
        teamRankResult = allPeriodsResult ?? teamRankResult;
      }
    }
  } catch {
    // team rank exception
  }
  
  const rankInTeam = teamRankAllPeriodsResult?.rank ?? null;
  const teamComparisonPeriod = normalizeTeamComparisonPeriod(options.teamComparisonPeriod);
  const teamComparison = teamRankResult?.comparison ?? [];
  const leadingMedicalRep = leadingMedicalRepResult?.comparison[0] ?? null;

  const latestRecord = (payrollDashboard && payrollDashboard.records[0]) || base.latestRecord;
  const previousRecord = (payrollDashboard && payrollDashboard.previousRecords?.[0]) || base.previousRecord;
  
  const statutoryDeductions = latestRecord
    ? latestRecord.governmentalDeductions || (latestRecord.socialInsurance || 0) + (latestRecord.employmentIncomeTax || 0)
    : 0;
  const totalDeductions = latestRecord?.totalDeductions ?? 0;
  const internalDeductions = totalDeductions;
  const latestBatch = (payrollDashboard && (payrollDashboard.batch ?? payrollDashboard.batches[0])) || null;

  const netVsLastMonth = latestRecord && previousRecord && previousRecord.netSalary > 0
    ? ((latestRecord.netSalary - previousRecord.netSalary) / previousRecord.netSalary) * 100
    : null;
  const grossVsLastMonth = latestRecord && previousRecord && previousRecord.grossSalary > 0
    ? ((latestRecord.grossSalary - previousRecord.grossSalary) / previousRecord.grossSalary) * 100
    : null;
  const deductionsVsLastMonth = latestRecord && previousRecord && previousRecord.totalDeductions > 0
    ? ((latestRecord.totalDeductions - previousRecord.totalDeductions) / previousRecord.totalDeductions) * 100
    : null;

  const payrollEligibility: "Eligible" | "Pending" = latestBatch?.status === "locked" || latestBatch?.status === "approved"
    ? "Eligible"
    : "Pending";

  const probationStatus: "Completed" | "Not Started" | "On Probation" =
    base.employmentJourney.probationEndDate === null
      ? "Not Started"
      : base.employmentJourney.probationActive
        ? "On Probation"
        : "Completed";

  const insightInput = {
    employmentJourney: base.employmentJourney,
    expenses: { approvedAmount: base.expenses.approvedAmount },
    latestRecord,
    previousRecord,
    salaryTrend: base.salaryTrend,
    // The SEMESTER pair, not the all-time one. computeInsights gates its achievement line on
    // `targetValue > 0` and then quotes the rate beside the gap still to close; pairing a semester
    // rate with all-time totals made those two sentences describe two different periods. It also
    // means a rep with no semester target gets no achievement line at all, rather than being told
    // their achievement is 0.0%.
    sales: {
      achievementRate: overviewAchievementPercent / 100,
      targetValue: semesterTarget,
      totalValue: semesterSales,
    },
  };
  const portalInsights = computeInsights(insightInput);
  const insights: string[] = portalInsights.map((i) => i.message);
  
  if (!allTimeTrend.length) insights.push("Sales data has not been uploaded yet.");
  
  const fallbackAllowances = resolveStandardSalaryAllowances({
    departmentName: employee.departmentName,
    employeeHrId: currentHrId,
    jobTitle: employee.jobTitle,
    lineName: employee.lineName,
    month: latestBatch?.month,
    positionTitle: employee.positionTitle,
    year: latestBatch?.year,
  });
  const salaryStructure = currentHrId ? await fetchEmployeeSalaryStructure(currentHrId) : null;
  const fixedSalary = resolveFixedSalaryReference({
    employee,
    fallbackAllowances,
    salaryStructure,
  });
  const payslipBaseSalary = fixedSalary.baseSalary;
  const payslipBasicSalary = fixedSalary.basicSalary;
  const latestPayslip = {
    baseSalary: payslipBaseSalary,
    basicSalary: payslipBasicSalary,
    calendarDays: latestRecord?.calendarDays ?? 0,
    firstPart: latestRecord?.firstPart ?? payslipBasicSalary,
    grossSalary: fixedSalary.grossSalary,
    netSalary: fixedSalary.netSalary,
    secondPart:
      latestRecord?.secondPart ??
      calculatePayrollParts({
        baseSalary: payslipBaseSalary,
        extraCostOfLiving: fixedSalary.extraCostOfLiving,
        fuelAllowance: fixedSalary.fuelAllowance,
      }).secondPart,
    totalAdditions: latestRecord?.totalAdditions ?? 0,
    totalDeductions: latestRecord?.totalDeductions ?? 0,
    workingDays: latestRecord?.workingDays ?? 0,
  };

  const fixedIncentiveSalary = {
    baseSalary: fixedSalary.baseSalary,
    basicSalary: fixedSalary.basicSalary,
    extraCostOfLiving: fixedSalary.extraCostOfLiving,
    fuelAllowance: fixedSalary.fuelAllowance,
    grossSalary: fixedSalary.grossSalary,
    netSalary: fixedSalary.netSalary,
    socialInsurance: fixedSalary.socialInsurance,
    taxes: fixedSalary.taxes,
  };
  // Semester achievement is the authoritative basis for all incentive calculations.
  // Current-month achievement is never used here — incentives are semester-level.
  const allPeriodsAchievementPercent = Number.isFinite(overviewAchievementPercent) ? overviewAchievementPercent : achievementPercent;
  // One calculation drives both the "incentive" and the "allPeriods" payload fields: the incentive
  // is a single semester figure, so the two used to be computed from identical arguments. Compute
  // it once and reuse it for both — the "allPeriods*" fields below are aliases of the same result.
  const incentiveCalc = calculateIncentive2026({
    ...fixedIncentiveSalary,
    achievementPercent: allPeriodsAchievementPercent,
  });

  // ── The Pedia split (owner, 2026-09-23) ────────────────────────────────────────────────────────
  // On the Pedia line, from Semester 2 2026, the semester incentive is paid as TWO halves: one
  // month of basic scored on SATO achievement (Guamusin + Ivyronc) and one month scored on TOTAL.
  // src/lib/incentives/pedia-split.ts has the rule and why it is a sum rather than a gate.
  //
  // Measured over the SAME window and from the SAME rows as `overviewAchievementPercent` above, so
  // the total half cannot disagree with the semester achievement already on this payload. It is
  // computed for every seat whose line and semester qualify — reps, DMs, RSMs and the NSM alike;
  // there is no role test, because scoring a manager on one figure while his reps are scored on
  // two would put two rules on one line.
  //
  // Everything below stays null for every other line and for a closed semester, and the payload
  // keeps `incentive` as the single figure in that case — this is additive, not a replacement.
  const pediaSplitEligible = pediaSplitApplies({
    line: employee.lineName,
    semester: incentiveWindow?.semester,
  });
  const pediaAchievement = pediaSplitEligible
    ? measurePediaAchievement({
        rows: portalSalesRecords,
        windowPeriods: incentiveWindow?.present ?? [],
      })
    : null;
  const pediaSplitCalc =
    pediaSplitEligible && pediaAchievement
      ? calculatePediaSplitIncentive({
          ...fixedIncentiveSalary,
          satoAchievementPercent: pediaAchievement.satoAchievementPercent,
          // The line total this rep is already shown, not a second reading of it.
          totalAchievementPercent: allPeriodsAchievementPercent,
        })
      : null;
  // What the rep is actually paid. The split replaces the single figure where it applies, and
  // reduces to exactly that figure whenever the two achievements agree.
  const effectiveIncentiveAmount = pediaSplitCalc?.payoutAmount ?? incentiveCalc.payoutAmount;
  const workloadExpenseSummary = summarizePayrollExpenses(expenses);
  const activeExpenseEmployeeCount = new Set(expenses.map((expense) => expense.hrId).filter(Boolean)).size;
  const activeExpenseDays = new Set(expenses.map((expense) => expense.date?.slice(0, 10)).filter(Boolean)).size;

  return {
    betaNavEnabled: isEmployeePortalBetaNavEnabled(),
    employee: {
      area: employee.areaName,
      department: employee.departmentName,
      fullName: employee.displayName,
      hrId: employee.hrId,
      line: employee.lineName,
      manager: (await resolveDirectManagerName(employee.hrId)) ?? employee.managerName,
      roleLabel: employee.jobTitle || employee.positionTitle || "Medical Representative",
      status: employee.employmentStatus ?? "active",
      territory: employee.regionName ?? employee.areaName,
    },
    orgStructure,
    workforce,
    empty: {
      payroll: (payrollDashboard ? payrollDashboard.records.length : 0) === 0,
      profile: !profileLinked,
      // "This rep has no sales data at all", not "none in the current payout semester" — this flag
      // replaces the whole Sales Performance section with an empty card.
      sales: allTimeTrend.length === 0,
    },
    hrContract: {
      contractRenewalDate: base.employmentJourney.contractRenewalDate,
      contractSignedDate: base.employmentJourney.contractSignedDate,
      daysUntilRenewal: base.employmentJourney.daysUntilRenewal,
      employmentStatus: employee.employmentStatus ?? "active",
      hireDate: employee.hireDate,
      payrollEligibility,
      probationStatus,
      serviceDurationText: serviceDurationText(base.employmentJourney.serviceDurationDays),
    },
    insights,
    overview,
    payroll: {
      batchId: latestBatch?.id ?? null,
      baseSalary: fixedSalary.baseSalary,
      firstPart: latestRecord?.firstPart ?? 0,
      grossSalary: latestPayslip.grossSalary,
      internalDeductions,
      latestPayslip,
      latestBatchLabel: latestBatch ? formatBatchLabel(latestBatch.month, latestBatch.year) : "No payroll period",
      latestBatchStatus: latestBatch?.status ?? null,
      netSalary: latestPayslip.netSalary,
      payslipRows: (payrollDashboard ? payrollDashboard.batches : []).map((batch) => ({
        createdAt: batch.createdAt,
        id: batch.id,
        label: formatBatchLabel(batch.month, batch.year),
        status: batch.status,
      })),
      secondPart: latestRecord?.secondPart ?? 0,
      statutoryDeductions,
      totalAdditions: latestRecord?.totalAdditions ?? 0,
      totalDeductions: latestRecord?.totalDeductions ?? 0,
      salaryTrend: base.salaryTrend,
      netVsLastMonth,
      grossVsLastMonth,
      deductionsVsLastMonth,
      bonus: latestRecord?.bonus ?? 0,
      incentive: effectiveIncentiveAmount,
      basicSalary: incentiveCalc.basicSalary,
      allPeriodsIncentive: effectiveIncentiveAmount,
      allPeriodsIncentiveTarget: incentiveCalc.semesterTargetIncentive,
      allPeriodsAchievementPercent: allPeriodsAchievementPercent,
      incentiveTarget: incentiveCalc.semesterTargetIncentive,
      loans: latestRecord?.loans ?? 0,
      otherDeductions: latestRecord?.otherDeductions ?? 0,
      socialInsurance: fixedSalary.socialInsurance,
      incomeTax: fixedSalary.taxes,
      fuelAllowance: fixedSalary.fuelAllowance,
      extraCostOfLiving: fixedSalary.extraCostOfLiving,
    },
    sales: {
      // Resolved at the top of this function from the viewer's own auth row, so an explicit
      // sales_scope_override is honoured here exactly as every other consumer honours it.
      viewerSalesScope: salesScope,
      achievementPercent: Number.isFinite(achievementPercent) ? achievementPercent : 0,
      currentMonthLabel: latestTrend ? toPeriodLabel(latestTrend.period) : "No period",
      currentMonthSales,
      currentMonthTarget,
      incentiveSemesterLabel: incentiveWindow?.semesterLabel ?? null,
      incentiveSemesterSales: semesterSales,
      incentiveSemesterTarget: semesterTarget,
      incentiveWindowNotice: describeIncompleteWindow(incentiveWindow),
      // The Pedia split, or null on every other line and in a closed semester. Null is what tells
      // the tab to render the single-figure presentation — it must never be read as "a split worth
      // zero", which is why the whole object is absent rather than its numbers being 0.
      pediaSplit: pediaSplitCalc && pediaAchievement
        ? {
            satoAchievementPercent: pediaAchievement.satoAchievementPercent,
            satoSales: pediaAchievement.satoSales,
            satoTarget: pediaAchievement.satoTarget,
            satoHalfAmount: pediaSplitCalc.satoHalfAmount,
            totalHalfAmount: pediaSplitCalc.totalHalfAmount,
            payoutAmount: pediaSplitCalc.payoutAmount,
            payoutPercentage: pediaSplitCalc.payoutPercentage,
            semesterTargetIncentive: pediaSplitCalc.semesterTargetIncentive,
          }
        : null,
      overviewAchievementPercent: Number.isFinite(overviewAchievementPercent) ? overviewAchievementPercent : 0,
      overviewSales,
      overviewTarget,
      growthVsLastMonthPercent,
      familyContribution: familyContributionWithPercent,
      productContribution: productContributionWithPercent,
      territories,
      linePerformance,
      teamComparisonPeriod,
      rankInTeam,
      teamComparison,
      leadingMedicalRep,
      topProduct,
      topProductSalesValue,
      // Every loaded month, not the payout window: this feeds the trend chart, the quarter lens and
      // the team-comparison period picker, and narrowing it to the semester would quietly delete
      // months from a control the rep uses to look back. `coveredSales` stays server-side — it is
      // an input to the achievement, not something any of those controls render.
      trend: allTimeTrend.map((point) => ({ period: point.period, sales: point.sales, target: point.target })),
      units: Number(salesDashboard?.summary?.unitsSold ?? 0),
    },
    workload: {
      totalTrips: workloadExpenseSummary.totalRows,
      totalDistance: workloadExpenseSummary.totalDistance,
      totalExpenses: workloadExpenseSummary.totalAmount,
      activeEmployees: activeExpenseEmployeeCount,
      avgCostPerTrip: workloadExpenseSummary.averageCostPerTrip,
      workloadOverview: [
        { label: "Avg Trips / Day", value: (workloadExpenseSummary.totalRows / 22).toFixed(1), delta: "0" },
        { label: "Avg Distance / Day", value: `${(workloadExpenseSummary.totalDistance / 22).toFixed(0)} km`, delta: "0 km" },
        { label: "Active Days", value: activeExpenseDays.toString(), delta: "0" },
        { label: "Avg Trips / Active Day", value: activeExpenseDays > 0 ? (workloadExpenseSummary.totalRows / activeExpenseDays).toFixed(1) : "0", delta: "0" },
      ],
      tripsVsDistanceTrend: Array.from(new Set(expenses.map((e) => expensePeriodKey(e)).filter(Boolean) as string[])).sort().map(period => {
        const periodExpenses = expenses.filter((e) => expensePeriodKey(e) === period);
        return {
          month: toPeriodLabel(period),
          trips: periodExpenses.length,
          distance: periodExpenses.reduce((sum, e) => sum + (e.km || 0), 0),
        };
      }),
      // Match against the canonical (normalized) trip types via case-insensitive
      // substring so the buckets stay non-zero: "Traveling"/"Overnight stay" → Travel,
      // "Return same day" → Return, "Meeting" → Meeting.
      workloadDistribution: [
        { name: "Travel", value: expenses.filter((e) => { const t = (e.tripType || "").toLowerCase(); return t.includes("travel") || t.includes("overnight"); }).length, color: "#f97316" },
        { name: "Return", value: expenses.filter((e) => (e.tripType || "").toLowerCase().includes("return")).length, color: "#f59e0b" },
        { name: "Meeting", value: expenses.filter((e) => (e.tripType || "").toLowerCase().includes("meeting")).length, color: "#94a3b8" },
      ],
      heatmapData: expenses.reduce((acc, e) => {
        if (!e.date) return acc;
        const day = new Date(e.date).getUTCDay(); // 0-6 (Sun-Sat)
        acc.trips[day] = (acc.trips[day] || 0) + 1;
        acc.distance[day] = (acc.distance[day] || 0) + (e.km || 0);
        acc.expenses[day] = (acc.expenses[day] || 0) + (e.total || 0);
        return acc;
      }, { trips: new Array(7).fill(0), distance: new Array(7).fill(0), expenses: new Array(7).fill(0) }),
      employeePerformance: Array.from(new Set(expenses.map((e) => e.hrId).filter(Boolean))).map((hrId) => {
        const empExpenses = expenses.filter((e) => e.hrId === hrId);
        const emp = findDirectoryEmployeeByHrId(directory, hrId);
        return {
          name: emp?.displayName ?? hrId!,
          role: emp?.jobTitle ?? "N/A",
          trips: empExpenses.length,
          distance: empExpenses.reduce((sum, e) => sum + (e.km || 0), 0),
          activeDays: new Set(empExpenses.map((e) => e.date?.slice(0, 10)).filter(Boolean)).size,
        };
      }).sort((a, b) => b.trips - a.trips),
      expenseAnalysis: [
        { label: "Total Expenses", value: egp(workloadExpenseSummary.totalAmount), delta: "0%" },
        { label: "Cost per Trip", value: egp(workloadExpenseSummary.averageCostPerTrip), delta: "0%" },
        { label: "Cost per KM", value: workloadExpenseSummary.totalDistance > 0 ? `EGP ${(workloadExpenseSummary.totalAmount / workloadExpenseSummary.totalDistance).toFixed(1)}` : "EGP 0", delta: "0%" },
        { label: "Highest Single Trip", value: egp(Math.max(0, ...expenses.map(t => t.total))), delta: "N/A" },
      ],
      expenseTrend: Array.from(new Set(expenses.map((e) => expensePeriodKey(e)).filter(Boolean) as string[])).sort().map(period => {
        const periodExpenses = expenses.filter((e) => expensePeriodKey(e) === period);
        return {
          month: toPeriodLabel(period),
          expenses: periodExpenses.reduce((sum, e) => sum + (e.total || 0), 0),
        };
      }),
      expenseRows: expenses.map((expense) => ({
        ...expense,
        location: expense.location || "",
      })),
      hasWorkloadFields: expenses.some(
        (expense) => Boolean(expense.amWorkload) || Boolean(expense.pmWorkload) || Boolean(expense.pharmacyWorkload),
      ),
      territoryAnalysis: Array.from(new Set(expenses.map((e) => e.location).filter(Boolean))).map((loc) => {
        const locExpenses = expenses.filter((e) => e.location === loc);
        return {
          territory: loc!,
          trips: locExpenses.length,
          distance: locExpenses.reduce((sum, e) => sum + (e.km || 0), 0),
          expenses: locExpenses.reduce((sum, e) => sum + (e.total || 0), 0),
        };
      }),
      recentTrips: expenses.slice(0, 10).map((e) => ({
        id: e.tripId || "N/A",
        date: e.date || "N/A",
        employee: e.specialist || "N/A",
        role: "N/A",
        from: e.from || "N/A",
        to: e.to || "N/A",
        type: e.tripType || "N/A",
        distance: e.km || 0,
        cost: e.total || 0,
      })),
      availableEmployees: visibleTeamMembers.map((m) => ({ id: m.hrId, name: m.displayName })),
      availableTerritories: Array.from(new Set(expenses.map((e) => e.location).filter(Boolean))) as string[],
    },
  };
} catch (error) {
  throw error;
}
}

export async function getEmployeePortalIncentiveData(access: AccessContext): Promise<MedicalRepPortalData> {
  return getMedicalRepPortalData(access, {
    includeLiveOutstationExpenses: false,
    includePortalOverview: false,
    includeTeamRank: false,
    includeWorkforceSummary: false,
  });
}

// ---------------------------------------------------------------------------
// DSM Team Members Performance
// ---------------------------------------------------------------------------

export type DsmTeamMemberProductData = {
  /**
   * ONLY MEANINGFUL WHEN `target` > 0. A zero target yields 0 here, and that 0 means "no
   * target was set", not "achieved nothing" — au.monthly_targets starts 2026-07, so real
   * sales with no target beside them is an ordinary case. Render "No target", never "0%".
   */
  achievementPercent: number;
  family: string;
  product: string;
  sales: number;
  target: number;
  units: number;
};

export type DsmTeamMemberData = {
  /** Only meaningful when `totalTarget` > 0 — see DsmTeamMemberProductData.achievementPercent. */
  achievementPercent: number;
  hrId: string;
  name: string;
  managerHrId: string | null;
  managerName: string | null;
  /**
   * Set only when `managerHrId` is null because the rep's District Manager seat was VACANT for the
   * period: that seat's id, so each vacant district groups as itself, while `managerName` reads
   * "Vacant — <district>" instead of "Unassigned District" (owner, 2026-10-20).
   */
  vacantManagerSeatId?: string | null;
  /**
   * True on a Regional roll-up row that is NOT a person: the seated districts of one region with no
   * occupied Regional Manager seat, totalled as "<region> — no regional manager". `hrId` is then a
   * synthetic key, never an employee, and the row is not a manager to count or probe.
   */
  isRegionWithoutManager?: boolean;
  position: number;
  products: DsmTeamMemberProductData[];
  totalSales: number;
  totalTarget: number;
};

export type DsmTeamPerformanceData = {
  members: DsmTeamMemberData[];
  periods: string[];
  teamAchievementPercent: number;
  teamMemberCount: number;
  teamTotalSales: number;
  teamTotalTarget: number;
  /**
   * Sales inside `teamTotalSales` that no member row carries — Direct Orders spread across
   * regions + vacant seats. `teamTotalSales = Σ(members.totalSales) + unattributedSales`,
   * so the UI can show a reconciliation line that makes the header foot to the leaderboard.
   */
  unattributedSales: number;
  unattributedTarget: number;
};

/**
 * Resolve the single, unambiguous vacant DSM seat under a given NSM for a line,
 * derived from the open vacancies the directory already loaded (no extra query).
 *
 * Used as the FALLBACK seat-continuity signal when an orphaned medical rep has
 * lost its `pending_manager_replacement_for_hr_id` marker but the org clearly has
 * exactly one open DSM seat under this NSM/line. If zero or more than one open
 * DSM seat exists, no seat is returned (we never guess across districts).
 */
export function resolveNsmVacantDsmSeat(
  directory: EmployeeDirectoryData,
  lineScope: ReturnType<typeof createPortalSalesLineScope>,
  nsmCanonicalHrId: string | null,
): { seat: ResolvedVacantSeat | null; ambiguous: boolean } {
  if (!nsmCanonicalHrId) return { seat: null, ambiguous: false };

  const candidates = directory.lookups.workforceVacancies
    .filter(
      (vac) =>
        isDistrictManagerVacancyTitle(vac.jobTitle, vac.positionTitle) &&
        employeeMatchesPortalSalesScope(
          { lineId: vac.lineId, lineName: vac.lineName },
          lineScope,
        ) &&
        toCanonicalPortalHrId(vac.managerHrId) === nsmCanonicalHrId,
    )
    .map((vac) => ({
      vacancyId: vac.vacancyId,
      vacancyCode: vac.vacancyCode,
      areaName: vac.areaName,
      lineName: vac.lineName,
    }));

  return selectVacantManagerSeat(candidates, "DSM seat");
}

export async function getDsmTeamPerformance(
  access: AccessContext,
  // `creditRepsByTenure`: a ranking credits each month to the rep who held the seat then (owner,
  // 26 Oct 2026). The expense forms' medical-trip rep list leaves it off and keeps today's holders.
  options: { period?: string | string[] | null; creditRepsByTenure?: boolean } = {},
): Promise<DsmTeamPerformanceData | null> {
  try {
    const currentUser = await resolvePortalCurrentUser(access);
    if (!currentUser?.hrId) return null;

    const currentRole = normalizeRole(currentUser.role);
    if (currentRole !== "District Manager" && currentRole !== "National Sales Manager") return null;

    // Sales AND targets now come from Source of Sales via the shared achievement engine
    // (see sos-team-performance.ts), not from sales_records. Scope is applied inside the
    // builder by resolveVsTargetBound — a line bound for an NSM, an area bound for a DSM —
    // so these numbers reconcile exactly with the /sales-vs-target page.
    return await buildDsmTeamPerformanceFromSos(access, options.period ?? null, {
      creditRepsByTenure: options.creditRepsByTenure === true,
    });
  } catch {
    return null;
  }
}

/**
 * The MRs Performance page's data: every medical rep in the viewer's reach, for the National Sales
 * Manager (his line) and — since 2026-10-20 (owner) — the Regional Manager (his own seat's areas;
 * the builder fails closed for an RM whose seat did not resolve). The same builder as
 * getDsmTeamPerformance, kept apart from it on purpose: that function also feeds the expense forms'
 * medical-trip rep list, and widening IT to the RM would have changed an expense form nobody asked
 * to change.
 */
export async function getMedRepsPerformance(
  access: AccessContext,
  options: { period?: string | string[] | null } = {},
): Promise<DsmTeamPerformanceData | null> {
  try {
    const currentUser = await resolvePortalCurrentUser(access);
    if (!currentUser?.hrId) return null;

    const currentRole = normalizeRole(currentUser.role);
    if (currentRole !== "National Sales Manager" && currentRole !== "Regional Manager") return null;

    // A ranking: each month goes to the rep who held the seat then (owner, 26 Oct 2026).
    return await buildDsmTeamPerformanceFromSos(access, options.period ?? null, { creditRepsByTenure: true });
  } catch {
    return null;
  }
}

export type CompanyMedRepPerformanceLine = {
  lineId: number | null;
  lineName: string;
  /** The line's NSM display name; null when the NSM seat is vacant. */
  nsmName: string | null;
  performance: DsmTeamPerformanceData;
};

export type CompanyMedRepPerformanceData = {
  /** Per-line blocks, computed by the same builder each NSM's own view uses, sorted by sales desc. */
  lines: CompanyMedRepPerformanceLine[];
  /** Union of sales periods across lines, newest first. */
  periods: string[];
  companyTotalSales: number;
  companyTotalTarget: number;
  companyAchievementPercent: number;
  /**
   * Sales inside `companyTotalSales` that no rep row carries — Direct Orders spread across
   * regions + vacant seats, company-wide. `companyTotalSales = Σ(all rep sales) +
   * companyUnattributedSales`. Each line block foots the same way via its own performance.
   */
  companyUnattributedSales: number;
  companyUnattributedTarget: number;
  repCount: number;
  lineCount: number;
};

/**
 * Directory-derived line label + NSM identity for every sales line that has field staff.
 * Keyed by the canonical target line code (cns / pedia / anti_infective). "Head Office"
 * and any line that does not resolve to a target line code drop out. Shared by the two
 * company SoS roll-ups so each line block carries the same name the NSM's own view uses.
 */
function buildSosCompanyLineMeta(directory: EmployeeDirectoryData): Map<string, SosCompanyLineMeta> {
  const meta = new Map<string, SosCompanyLineMeta>();
  for (const emp of directory.employees) {
    if (!isMedicalRepDirectoryEmployee(emp) && !isDistrictManagerEmployee(emp)) continue;
    const lineCode = resolveTargetLineCode(emp.lineName);
    if (!lineCode || meta.has(lineCode)) continue;
    const lineScope = createPortalSalesLineScope({
      fallbackLine: emp.lineName,
      lineId: emp.lineId ?? null,
      lineName: emp.lineName ?? null,
    });
    const nsmEmployee = directory.employees.find(
      (candidate) =>
        isNationalSalesManagerDirectoryEmployee(candidate) &&
        employeeMatchesPortalSalesScope(candidate, lineScope),
    );
    meta.set(lineCode, {
      lineId: emp.lineId ?? null,
      lineName: emp.lineName ?? SALES_LINES.find((line) => line.code === lineCode)?.label ?? lineCode,
      nsmName: nsmEmployee?.displayName ?? null,
      nsmHrId: nsmEmployee?.hrId ?? null,
    });
  }
  return meta;
}

/**
 * Company-wide medical-rep performance rollup for the executive admin surface (CEO /
 * Super Admin / SFE Manager). Sourced from Source of Sales + Targets via the shared
 * achievement engine (see sos-team-performance.ts), one block per line, so company
 * totals reconcile exactly with each NSM's own Med Reps Performance view and with
 * /sales-vs-target. Gated on company scope + executive role, NOT canSeeEmployee.
 */
export async function getCompanyMedRepPerformance(
  access: AccessContext,
  options: { period?: string | string[] | null } = {},
): Promise<CompanyMedRepPerformanceData | null> {
  try {
    // SFE Manager gets company-wide sales scope via getSalesScope, but scopeForRole
    // doesn't special-case it so AccessContext.scope stays "self" — carve out
    // explicitly here rather than widening scopeForRole (used well beyond sales).
    if (access.scope !== "company" && access.role !== "SFE Manager") return null;
    if (access.role !== "CEO" && access.role !== "Super Admin" && access.role !== "SFE Manager") return null;

    const directory = await getEmployeeDirectory().catch(() => null);
    if (!directory) return null;

    return await buildCompanyMedRepPerformanceFromSos(options.period ?? null, buildSosCompanyLineMeta(directory));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Company-wide top achievers per line (read-only landing widget)
// ---------------------------------------------------------------------------

export type LineTopAchiever = {
  achievementPercent: number;
  areaName: string | null;
  hrId: string;
  lineName: string;
  name: string;
};

export type LineTopAchieversGroup = {
  achievers: LineTopAchiever[];
  lineName: string;
  /** The published closing month the figures come from, "2026-09". */
  period: string;
  /** The same month for the screen, "Sep 2026". */
  periodLabel: string;
};

// Roles allowed to see the cross-line medical-rep achievement leaderboard. Kept
// deliberately narrow — sales leadership plus Training Manager (org-wide coaching
// oversight) and system/Super Admin. This is a curated, read-only snapshot; it
// does NOT widen the `sales` permission resource for these roles.
const LINE_TOP_ACHIEVER_ROLES = new Set<AccessContext["role"]>([
  "Super Admin",
  "CEO",
  "National Sales Manager",
  "Training Manager",
]);

/**
 * Top `perLine` medical reps by achievement for every line, in the latest month whose Monthly
 * Closing is PUBLISHED for that line (owner, 2026-10-24: match the rep's monthly closing and show
 * the period). Returns [] for roles outside the allowlist, and never throws (empty on any failure).
 * The ranking is `rankLineAchieversForPeriod`; a line with no published month shows no block.
 */
export async function getCompanyLineTopAchievers(
  access: AccessContext,
  options: { perLine?: number } = {},
): Promise<LineTopAchieversGroup[]> {
  const perLine = options.perLine ?? 3;
  try {
    if (access.scope !== "system" && !LINE_TOP_ACHIEVER_ROLES.has(access.role)) {
      return [];
    }

    const directory = await getEmployeeDirectory().catch(() => null);
    if (!directory) return [];

    const repsByLine = new Map<string, typeof directory.employees>();
    for (const emp of directory.employees) {
      if (!isMedicalRepDirectoryEmployee(emp)) continue;
      const line = emp.lineName?.trim();
      if (!line) continue;
      const arr = repsByLine.get(line) ?? [];
      arr.push(emp);
      repsByLine.set(line, arr);
    }
    if (repsByLine.size === 0) return [];

    const { current } = salesVsTargetPeriods();
    const publishedKeys = await loadPublishedPeriodKeys(SALES_VS_TARGET_FLOOR, current);

    const groups = await Promise.all(
      Array.from(repsByLine.entries()).map(async ([lineName, reps]): Promise<LineTopAchieversGroup | null> => {
        const lineCode = resolveTargetLineCode(lineName);
        const period = lineCode ? latestPublishedPeriodForLine(lineCode, publishedKeys) : null;
        if (!lineCode || !period) return null;
        // One month, cached per month by the loader, so the lines share it.
        const rows = applyAchievementAreaMerges(await loadAchievementRange(period, period)).filter(
          (row) => row.lineCode === lineCode,
        );
        const achievers = rankLineAchieversForPeriod(rows, period, reps, perLine).map((rep) => ({
          ...rep,
          lineName,
        }));
        return { achievers, lineName, period, periodLabel: periodLabel(period) };
      }),
    );

    return groups
      .filter((group): group is LineTopAchieversGroup => group !== null && group.achievers.length > 0)
      .sort((a, b) => a.lineName.localeCompare(b.lineName));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// NSM DSMs Performance
// ---------------------------------------------------------------------------

export type NsmDsmPerformanceData = {
  dsms: DsmTeamMemberData[];
  /**
   * Each Regional Manager on the line, as the SUM of the district-manager rows that report to him
   * through an RSM seat (owner, 2026-10-20) — never a figure of its own, and never inside `dsms`, so
   * no DSM count, distribution or reconciliation counts a district twice. Empty for a line with no
   * Regional Manager, and for the Regional Manager's own view (it would be himself).
   */
  regionalManagers: DsmTeamMemberData[];
  periods: string[];
  lineAchievementPercent: number;
  dsmCount: number;
  lineTotalSales: number;
  lineTotalTarget: number;
  /**
   * Sales inside `lineTotalSales` that no DSM row carries — Direct Orders spread across
   * regions + vacant seats. `lineTotalSales = Σ(dsms.totalSales) + unattributedSales`,
   * so the UI can show a reconciliation line that makes the header foot to the leaderboard.
   */
  unattributedSales: number;
  unattributedTarget: number;
};

export type NsmTeamExpensesDsmSummary = {
  activeDays: number;
  approvedAmount: number;
  approvedTrips: number;
  avgCostPerTrip: number;
  hrId: string;
  lastTripDate: string | null;
  lineName: string | null;
  name: string;
  pendingAmount: number;
  pendingTrips: number;
  totalDistance: number;
  totalExpenses: number;
  totalTrips: number;
};

export type NsmTeamExpensesData = {
  dsms: NsmTeamExpensesDsmSummary[];
  expenseRows: Array<
    PayrollExpenseApproval & {
      dsmName: string;
      lineName: string | null;
    }
  >;
  monthlyTrend: Array<{
    expenses: number;
    month: string;
    trips: number;
  }>;
  periods: string[];
  requestTypes: string[];
  reports: PayrollExpenseReport[];
  selectedReportId: string | null;
  selectedRequestType: string | null;
  scopeLabel: string;
  selectedDsmHrId: string | null;
  selectedPeriod: string | null;
  selectedPeriods: string[];
  summary: {
    activeDsms: number;
    approvedAmount: number;
    approvedTrips: number;
    avgCostPerTrip: number;
    pendingAmount: number;
    pendingTrips: number;
    totalDistance: number;
    totalExpenses: number;
    totalTrips: number;
  };
};

type PortalVacancyDbRow = {
  area_id: number | null;
  area_name?: string | null;
  areas?: { name: string | null } | null;
  created_at: string;
  department_id?: number | null;
  id: number;
  job_title: string | null;
  line_id: number | null;
  lines?: { name: string | null } | null;
  manager_hr_id: string | null;
  manager_name: string | null;
  note: string | null;
  position_id: number | null;
  positions?: { title: string | null } | null;
  region_name: string | null;
  status: string;
  vacancy_code: string;
};

export type EmployeePortalVacancyRow = {
  // The four lookup IDS. Carried so an open seat here can open Add Employee pre-filled,
  // exactly as the organogram popup and the admin vacancies report do — the form matches on
  // ids, not names, so a row with names alone produces an empty prefill.
  areaId: number | null;
  areaName: string | null;
  createdAt: string;
  departmentId: number | null;
  id: number;
  isDistrictManagerVacancy: boolean;
  jobTitle: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  note: string | null;
  /**
   * The offer already out against this open seat, when there is one — so the portal's hire action
   * opens Add Employee pre-filled from an ACCEPTED letter (candidate, agreed salary, generated id),
   * exactly as the organogram popup and the admin vacancies report do. Null when there is no live
   * offer. A LABEL, never a state: the seat stays vacant and open.
   */
  pendingOffer?: SeatOfferOut | null;
  positionId: number | null;
  positionTitle: string | null;
  regionName: string | null;
  status: string;
  vacancyCode: string;
};

export type EmployeePortalVacanciesData = {
  roleView: "dsm" | "nsm";
  scopeLabel: string;
  summary: {
    districtManagerVacancies: number;
    openVacancies: number;
    totalAreas: number;
    totalVacancies: number;
  };
  vacancies: EmployeePortalVacancyRow[];
};

function isDistrictManagerVacancyTitle(...values: Array<string | null | undefined>) {
  const normalized = values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");

  return (
    normalized.includes("district sales manager") ||
    normalized.includes("district manager") ||
    normalized.includes(" dsm") ||
    normalized.startsWith("dsm ")
  );
}

function isMedicalRepVacancyTitle(...values: Array<string | null | undefined>) {
  const normalized = values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");

  return normalized.includes("medical representative") || normalized.includes("medical rep");
}

function isNationalSalesManagerVacancyTitle(...values: Array<string | null | undefined>) {
  const normalized = values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");

  return normalized.includes("national sales manager") || normalized.includes("nsm");
}

function isGroupProductManagerVacancyTitle(...values: Array<string | null | undefined>) {
  const normalized = values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");

  return normalized.includes("group product manager") || normalized.includes("gpm");
}

function vacancySeatKey(
  row: {
    area_id?: number | null;
    job_title?: string | null;
    line_id?: number | null;
    manager_hr_id?: string | null;
    note?: string | null;
    position_id?: number | null;
    region_name?: string | null;
    vacancy_code?: string | null;
  },
) {
  const vacancyCode = String(row.vacancy_code ?? "").trim().toLowerCase();
  const resignationMatch = vacancyCode.match(/^resignation_([^_]+)_\d{8,}$/);

  if (resignationMatch) {
    const resignedHrId = normalizeHrIdForAccess(resignationMatch[1]) ?? resignationMatch[1].toUpperCase();
    return `resignation:${resignedHrId}`;
  }

  if (vacancyCode) return `code:${vacancyCode}`;

  return [
    "manual",
    row.line_id ?? "",
    normalizeHrIdForAccess(row.manager_hr_id) ?? "",
    row.position_id ?? "",
    String(row.job_title ?? "").trim().toLowerCase(),
    row.area_id ?? "",
    String(row.region_name ?? "").trim().toLowerCase(),
    String(row.note ?? "").trim().toLowerCase(),
  ].join("|");
}

function uniqueVacancyRows<T extends {
  area_id?: number | null;
  job_title?: string | null;
  line_id?: number | null;
  manager_hr_id?: string | null;
  note?: string | null;
  position_id?: number | null;
  region_name?: string | null;
  vacancy_code?: string | null;
}>(rows: T[]) {
  const seen = new Set<string>();

  return rows.filter((row) => {
    const key = vacancySeatKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isDistrictManagerEmployee(
  employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">,
) {
  return isDistrictManagerVacancyTitle(
    employee.jobTitle,
    employee.positionTitle,
  );
}

export async function getEmployeePortalVacancies(
  access: AccessContext,
): Promise<EmployeePortalVacanciesData | null> {
  try {
    const currentUser = await resolvePortalCurrentUser(access);
    if (!currentUser?.hrId) return null;

    const currentRole = normalizeRole(currentUser.role);
    const isDsm = currentRole === "District Manager";
    const isNsm = currentRole === "National Sales Manager";
    // Company-wide org-structure roles (Marketing Manager, Training Manager, CEO, Super Admin)
    // see ALL open vacancies — matching their company-wide organogram access
    // (canAccessCompanyOrganogram). A head-office department head sits on the Head Office line
    // while their reports sit on the business lines, so a single-line vacancy filter would show
    // ~0. Vacancies are just the open-seat layer of the same org structure the organogram shows.
    // canAccessCompanyVacancies already includes canAccessCompanyOrganogram's roles plus
    // Talent Acquisition (see src/lib/reports/organogram.ts) — a strict superset.
    const isCompanyScoped = canAccessCompanyVacancies(access);
    // Product / Group Product Managers + NSM see vacancies for their own single business line.
    const isLineScoped =
      !isCompanyScoped &&
      (isNsm ||
        currentRole === "Product Manager" ||
        currentRole === "Group Product Manager");
    // Regional Manager is REGION-scoped: their own line, narrowed to the regions inside their
    // own management subtree. Deliberately NOT folded into isLineScoped — that would show an RM
    // every open seat on the line, including other regions they do not manage. This mirrors the
    // RM branch fetchOpenVacancySummaryForScope already uses for the Command Center's open-seat
    // count, so the card total and this page agree instead of one showing seats the other hides.
    const isRegionScoped = !isCompanyScoped && !isLineScoped && currentRole === "Regional Manager";
    if (!isDsm && !isLineScoped && !isCompanyScoped && !isRegionScoped) return null;

    const [directory, viewerAllowedLines] = await Promise.all([
      getEmployeeDirectory().catch(() => null),
      isLineScoped ? resolveViewerAllowedLines(access) : Promise.resolve(null),
    ]);
    if (!directory) return null;

    const currentCanonicalHrId = normalizeHrIdForAccess(currentUser.hrId);
    const currentEmployee = directory.employees.find((employee) => {
      const employeeCanonical = normalizeHrIdForAccess(employee.hrId);
      return Boolean(employeeCanonical && currentCanonicalHrId && employeeCanonical === currentCanonicalHrId);
    });

    if (!currentEmployee) return null;

    // The RM's authoritative region bound. Their own region_name is a coarse parent label that does
    // not string-match the finer labels on their reports, so the set is derived from the subtree
    // (same resolver, same argument order as fetchOpenVacancySummaryForScope). Empty set = fail
    // closed below rather than silently widening to the whole line.
    const regionalManagerRegionKeys =
      isRegionScoped && currentCanonicalHrId
        ? regionsWithinManagerHierarchy(directory.employees, currentCanonicalHrId, normalizeHrIdForAccess)
        : null;

    // Multi-line override: when set, the viewer spans multiple lines (e.g. Ahmed Sharaf).
    const hasMultiLineOverride = isLineScoped && viewerAllowedLines && viewerAllowedLines.length > 1;
    const allowedLineNamesNormalized = hasMultiLineOverride
      ? viewerAllowedLines!.map((l) => normalizeLineName(l)).filter(Boolean)
      : null;

    const supabase = getSupabaseAdmin();
    const vacancyRows = await fetchAllRows<PortalVacancyDbRow>(() => {
      let query = supabase
        .from("position_vacancies")
        .select(
          // department_id joins the ids already selected here so an open seat can open Add Employee
          // pre-filled from this page too (src/lib/employees/vacancy-hire-link.ts) — the form needs
          // the IDS, and this row used to drop every one of them on the way out.
          "id,vacancy_code,job_title,status,created_at,note,manager_hr_id,manager_name,region_name,line_id,area_id,department_id,position_id,lines(name),areas(name),positions(title)",
        )
        .eq("status", "open")
        .order("created_at", { ascending: false });

      if (isDsm && currentUser.hrId) {
        query = query.eq("manager_hr_id", currentUser.hrId);
      } else if (isLineScoped && !hasMultiLineOverride && typeof currentEmployee.lineId === "number") {
        query = query.eq("line_id", currentEmployee.lineId);
      } else if (isRegionScoped && typeof currentEmployee.lineId === "number") {
        // Coarse line pre-filter only; the region bound is applied in scopedRows below.
        query = query.eq("line_id", currentEmployee.lineId);
      }
      // Multi-line: fetch unfiltered then scope in memory (avoids complex OR/IN on line_id)
      return query;
    }, "id");

    const scopedRows = vacancyRows.filter((row) => {
      if (isCompanyScoped) return true;
      if (isRegionScoped) {
        // Fail closed: an unresolvable region set shows nothing rather than the whole line.
        if (!regionalManagerRegionKeys || regionalManagerRegionKeys.size === 0) return false;
        if (typeof currentEmployee.lineId !== "number" || row.line_id !== currentEmployee.lineId) return false;
        const region = normalizeRegionLabel(row.region_name);
        return Boolean(region && regionalManagerRegionKeys.has(region));
      }
      if (isLineScoped) {
        if (allowedLineNamesNormalized && allowedLineNamesNormalized.length > 0) {
          const rowLine = normalizeLineName(row.lines?.name ?? null);
          return Boolean(rowLine && allowedLineNamesNormalized.includes(rowLine));
        }
        return sameWorkforceLine(
          { lineId: currentEmployee.lineId, lineName: currentEmployee.lineName },
          { lineId: row.line_id, lineName: row.lines?.name ?? null },
        );
      }

      const rowCanonicalManager = normalizeHrIdForAccess(row.manager_hr_id);
      return Boolean(
        rowCanonicalManager &&
          currentCanonicalHrId &&
          rowCanonicalManager === currentCanonicalHrId,
      );
    });

    const uniqueRows = uniqueVacancyRows(scopedRows);

    // Which of these open seats already have a letter out — so the hire action can open Add
    // Employee pre-filled from an accepted offer, the same one-press hire the organogram gives.
    // Keyed by the vacancy's own id (offerSeatKeyForVacancy), which is this row's `id`. Returns an
    // empty map on any failure, so an offers read that fails never stops the vacancies page.
    const offerOutBySeat = await loadOfferOutBySeat();

    const vacancies = uniqueRows.map((row) => ({
      areaId: row.area_id,
      areaName: row.areas?.name ?? row.area_name ?? null,
      createdAt: row.created_at,
      departmentId: row.department_id ?? null,
      id: row.id,
      isDistrictManagerVacancy: isDistrictManagerVacancyTitle(
        row.job_title,
        row.positions?.title,
      ),
      jobTitle: row.job_title,
      lineId: row.line_id,
      lineName: row.lines?.name ?? null,
      managerHrId: row.manager_hr_id,
      managerName: row.manager_name,
      note: row.note,
      // An accepted/sent letter on this open seat, looked up by the vacancy's own id. Only open
      // vacancies carry a key in the map, so a non-open row would read null here.
      pendingOffer: offerOutBySeat.get(offerSeatKeyForVacancy(row.id)) ?? null,
      positionId: row.position_id,
      positionTitle: row.positions?.title ?? null,
      regionName: row.region_name,
      status: row.status,
      vacancyCode: row.vacancy_code,
    }));

    return {
      // All line-scoped roles (NSM + Product/Group Product Manager) use the line view + line
      // label; only the District Manager uses the team/own-name view. Previously PM/GPM fell into
      // the "dsm" branch and were mislabeled "Team Vacancies / District view" with their own name.
      // The RM uses the roll-up ("nsm") view, not the DSM one: they span several districts, so the
      // team/own-name view would mislabel a multi-district list with a single manager's name.
      roleView: isLineScoped || isCompanyScoped || isRegionScoped ? "nsm" : "dsm",
      scopeLabel: isCompanyScoped
        ? "All lines"
        : isLineScoped
          ? hasMultiLineOverride
            ? viewerAllowedLines!.join(" + ")
            : currentEmployee.lineName ?? currentUser.line ?? "Your line"
          : isRegionScoped
            ? `${currentEmployee.lineName ?? currentUser.line ?? "Your line"} — your regions`
            : currentEmployee.displayName,
      summary: {
        districtManagerVacancies: vacancies.filter((row) => row.isDistrictManagerVacancy).length,
        openVacancies: vacancies.length,
        totalAreas: new Set(vacancies.map((row) => row.areaName).filter(Boolean)).size,
        totalVacancies: vacancies.length,
      },
      vacancies,
    };
  } catch {
    return null;
  }
}

export async function getNsmDsmPerformance(
  access: AccessContext,
  options: { period?: string | string[] | null } = {},
): Promise<NsmDsmPerformanceData | null> {
  try {
    const currentUser = await resolvePortalCurrentUser(access);
    if (!currentUser?.hrId) return null;

    const currentRole = normalizeRole(currentUser.role);
    // Regional Manager added 2026-10-20 (owner) — DSMs Performance is his page too now.
    if (currentRole !== "National Sales Manager" && currentRole !== "Regional Manager") return null;

    // The DSM roll-up is now sourced from Source of Sales + Targets via the shared
    // achievement engine (see sos-team-performance.ts), not from sales_records. The
    // builder scopes to the NSM's line, or the RM's own seat's areas, through
    // resolveVsTargetBound.
    return await buildNsmDsmPerformanceFromSos(access, options.period ?? null);
  } catch {
    return null;
  }
}

/** A Regional Manager's region roll-up: districts + reps inside their own line AND region subtree. */
export type RmRegionalPerformanceData = {
  dsms: DsmTeamMemberData[];
  topReps: DsmTeamMemberData[];
  periods: string[];
  regionAchievementPercent: number;
  dsmCount: number;
  regionTotalSales: number;
  regionTotalTarget: number;
  /**
   * Sales inside `regionTotalSales` that no district (DSM) row carries — reps whose DM seat
   * is vacant, plus any in-region Direct Orders. `regionTotalSales = Σ(dsms.totalSales) +
   * unattributedSales`, so the command center can show a reconciliation line that makes the
   * region header foot to the districts list. 0 while every district has a seated DM.
   */
  unattributedSales: number;
  unattributedTarget: number;
};

/**
 * Regional Manager region roll-up (district grain), for the RM portal command center.
 *
 * Deliberately built by REUSING the same two shared builders the NSM/DSM views use
 * (buildDsmPerformanceForLineScope at DSM grain + buildTeamPerformanceForScope in "nsm-line" mode
 * at med-rep grain) and then narrowing the result to the RM's regions. That ordering matters: the
 * builders own all the seat-continuity and achievement math, so an RM's district numbers reconcile
 * exactly with the same district as seen by its DSM and by the line's NSM — the same
 * one-code-path guarantee documented on those builders.
 *
 * Region membership follows the owner rule in regionalManagerScopeRows: the RM's own coarse
 * `region_name` (e.g. "Alexandria + Delta") is NOT used; the region set comes from the RM's own
 * management subtree via regionsWithinManagerHierarchy (seat-continuity aware).
 */
export async function getRmRegionalPerformance(
  access: AccessContext,
  options: { period?: string | string[] | null } = {},
): Promise<RmRegionalPerformanceData | null> {
  try {
    const currentUser = await resolvePortalCurrentUser(access);
    if (!currentUser?.hrId) return null;

    if (normalizeRole(currentUser.role) !== "Regional Manager") return null;

    const directory = await getEmployeeDirectory().catch(() => null);
    if (!directory) return null;

    const rmCanonical = normalizeHrIdForAccess(currentUser.hrId);
    if (!rmCanonical) return null;

    const currentEmployee = findDirectoryEmployeeByHrId(directory, currentUser.hrId);

    // The RM's region set, derived from their subtree (never their own coarse region label).
    // Empty means we cannot place the RM in any region: fail CLOSED rather than showing the
    // whole line as if it were "their region".
    const regionKeys = regionsWithinManagerHierarchy(directory.employees, rmCanonical, normalizeHrIdForAccess);
    if (regionKeys.size === 0) return null;

    // Region label per employee, keyed the same way the perf builders key their nodes, so DSM /
    // med-rep nodes (which carry no regionName of their own) can be narrowed to the region set.
    const regionByCanonicalHrId = new Map<string, string>();
    for (const employee of directory.employees) {
      const key = normalizeHrIdForAccess(employee.hrId);
      if (!key) continue;
      const region = normalizeRegionLabel(employee.regionName);
      if (region) regionByCanonicalHrId.set(key, region);
    }
    const isInRegion = (hrId: string | null | undefined) => {
      const key = normalizeHrIdForAccess(hrId);
      if (!key) return false;
      const region = regionByCanonicalHrId.get(key);
      return Boolean(region && regionKeys.has(region));
    };

    // The line's NSM anchors the vacant-DSM-seat fallback inside the shared builders (it must be
    // the NSM, not the RM — see buildDsmPerformanceForLineScope's nsmCanonical contract).
    const lineNsm = currentEmployee
      ? directory.employees.find(
          (employee) =>
            isNationalSalesManagerDirectoryEmployee(employee) &&
            lineScopeIncludesEmployee(currentEmployee, employee),
        )
      : undefined;

    // Sales + targets now come from Source of Sales via the shared achievement engine
    // (see sos-team-performance.ts). The RM's whole line is built at DSM and rep grain,
    // then narrowed to the RM's region set with the same directory-derived `isInRegion`
    // test — region membership never uses the RM's coarse region label. `lineNsm` labels
    // the DSM nodes' manager and is otherwise unused now that seat-continuity attribution
    // lives in the engine.
    const lineCode = resolveTargetLineCode(currentEmployee?.lineName);
    const lineCodes = lineCode ? new Set([lineCode]) : new Set<string>();

    return await buildRmRegionalPerformanceFromSos(options.period ?? null, lineCodes, isInRegion, {
      hrId: lineNsm?.hrId ?? null,
      name: lineNsm?.displayName ?? null,
    });
  } catch {
    return null;
  }
}

export type CompanyDsmPerformanceLine = {
  lineId: number | null;
  lineName: string;
  /** The line's NSM display name; null when the NSM seat is vacant. */
  nsmName: string | null;
  performance: NsmDsmPerformanceData;
};

export type CompanyDsmPerformanceData = {
  /** Per-line blocks, computed by the same builder each NSM's own view uses, sorted by sales desc. */
  lines: CompanyDsmPerformanceLine[];
  /** Union of sales periods across lines, newest first. */
  periods: string[];
  companyTotalSales: number;
  companyTotalTarget: number;
  companyAchievementPercent: number;
  /**
   * Sales inside `companyTotalSales` that no DSM row carries — Direct Orders spread across
   * regions + vacant seats, company-wide. `companyTotalSales = Σ(all DSM sales) +
   * companyUnattributedSales`. Each line block foots the same way via its own performance.
   */
  companyUnattributedSales: number;
  companyUnattributedTarget: number;
  dsmCount: number;
  lineCount: number;
};

/**
 * Company-wide DSM performance rollup for the executive admin surface (CEO / Super Admin).
 * Iterates every line that has District Managers and runs the SAME line builder the NSM
 * portal view uses, so `companyTotalSales` is exactly the sum of what each NSM sees —
 * seat-continuity (vacant DSM seats, orphaned reps) included. Deliberately gated on the
 * company scope + executive role, NOT canSeeEmployee (which stays manager-scoped).
 */
export async function getCompanyDsmPerformance(
  access: AccessContext,
  options: { period?: string | null } = {},
): Promise<CompanyDsmPerformanceData | null> {
  try {
    // SFE Manager gets company-wide sales scope via getSalesScope, but scopeForRole
    // doesn't special-case it so AccessContext.scope stays "self" — carve out
    // explicitly here rather than widening scopeForRole (used well beyond sales).
    if (access.scope !== "company" && access.role !== "SFE Manager") return null;
    if (access.role !== "CEO" && access.role !== "Super Admin" && access.role !== "SFE Manager") return null;

    const directory = await getEmployeeDirectory().catch(() => null);
    if (!directory) return null;

    return await buildCompanyDsmPerformanceFromSos(options.period ?? null, buildSosCompanyLineMeta(directory));
  } catch {
    return null;
  }
}

export async function getNsmTeamExpenses(
  access: AccessContext,
  options: {
    dsmHrId?: string | null;
    period?: string | string[] | null;
    reportId?: string | null;
    requestType?: string | null;
  } = {},
): Promise<NsmTeamExpensesData | null> {
  try {
    const currentUser = await resolvePortalCurrentUser(access);
    if (!currentUser?.hrId) return null;

    const currentRole = normalizeRole(currentUser.role);
    if (currentRole !== "National Sales Manager") return null;

    const directory = await getEmployeeDirectory().catch(() => null);
    if (!directory) return null;

    const viewerCanonicalHrId = normalizeHrIdForAccess(currentUser.hrId);
    const viewer = directory.employees.find(
      (employee) =>
        normalizeHrIdForAccess(employee.hrId) === viewerCanonicalHrId,
    );
    if (!viewer) return null;

    const directDsms = directory.employees.filter(
      (employee) =>
        isDistrictManagerEmployee(employee) &&
        viewerCanonicalHrId !== null &&
        // Seat-continuity aware: a DSM held under this NSM via the vacant-seat
        // marker still counts as a direct report, consistent with the organogram.
        reportsToManagerSeat({
          employee,
          viewerCanonicalHrId,
          canonicalize: normalizeHrIdForAccess,
        }),
    );

    const lineDsms = directory.employees.filter(
      (employee) =>
        // Department-safe LINE scope: same line AND same department only, so an
        // NSM never picks up DSMs from another department on a shared line.
        isDistrictManagerEmployee(employee) && lineScopeIncludesEmployee(viewer, employee),
    );

    const scopedDsms = directDsms.length > 0 ? directDsms : lineDsms;
    if (scopedDsms.length === 0) return null;

    const dsmByCanonicalHrId = new Map<
      string,
      Pick<EmployeeDirectoryRow, "displayName" | "hrId" | "lineName">
    >();

    scopedDsms.forEach((employee) => {
      const canonicalHrId = normalizeHrIdForAccess(employee.hrId);
      if (!canonicalHrId) return;
      dsmByCanonicalHrId.set(canonicalHrId, employee);
    });

    const selectedPeriods = normalizeTeamComparisonPeriods(options.period);
    const selectedPeriod = selectedPeriods[0] ?? null;
    const selectedDsmHrId = normalizeHrId(options.dsmHrId);
    const selectedDsmCanonicalHrId = normalizeHrIdForAccess(selectedDsmHrId);
    const selectedRequestType = normalizeExpenseRequestType(options.requestType);
    const reports = await listPayrollExpenseReports(access);
    const selectedReportId =
      options.reportId && reports.some((report) => report.id === options.reportId)
        ? options.reportId
        : null;

    const reportExpenses = await withLivePortalExpenseNames(
      await listPayrollExpenses(undefined, undefined, selectedReportId ?? undefined, access),
    );
    const liveOutstationExpenses = await listOutstationExpensesForPortal(
      scopedDsms.map((employee) => employee.hrId),
    );

    const combinedExpenses = [
      ...dedupeHistoricalExpensesByTrip(reportExpenses, liveOutstationExpenses),
      ...liveOutstationExpenses,
    ];

    const lineExpenses = combinedExpenses.filter((expense) => {
      const canonicalHrId = normalizeHrIdForAccess(expense.hrId);
      return Boolean(canonicalHrId && dsmByCanonicalHrId.has(canonicalHrId));
    });

    const dsmExpenses = lineExpenses.filter((expense) => {
      const canonicalHrId = normalizeHrIdForAccess(expense.hrId);
      if (!canonicalHrId || !dsmByCanonicalHrId.has(canonicalHrId)) {
        return false;
      }

      if (
        selectedDsmCanonicalHrId &&
        canonicalHrId !== selectedDsmCanonicalHrId
      ) {
        return false;
      }

      if (
        options.requestType &&
        normalizeExpenseRequestType(expense.requestType).toLowerCase() !==
          selectedRequestType.toLowerCase()
      ) {
        return false;
      }

      if (selectedPeriods.length === 0) {
        return true;
      }

      const period = expensePeriodKey(expense);
      return Boolean(period && selectedPeriods.includes(period));
    });

    const periods = Array.from(
      new Set(
        lineExpenses
          .map((expense) => expensePeriodKey(expense))
          .filter(Boolean) as string[],
      ),
    ).sort((left, right) => right.localeCompare(left));
    const requestTypes = Array.from(
      new Set(lineExpenses.map((expense) => normalizeExpenseRequestType(expense.requestType))),
    ).sort((left, right) => left.localeCompare(right));

    const dsms = buildPayrollExpenseDsmSummaries({
      dsms: scopedDsms.map((employee) => ({
        fullName: employee.displayName,
        hrId: employee.hrId,
        lineName: employee.lineName ?? null,
      })),
      expenses: dsmExpenses,
    });

    const monthlyTrend = Array.from(
      new Set(
        dsmExpenses
          .map((expense) => expensePeriodKey(expense))
          .filter(Boolean) as string[],
      ),
    )
      .sort((left, right) => left.localeCompare(right))
      .map((period) => {
        const periodRows = dsmExpenses.filter(
          (expense) => expensePeriodKey(expense) === period,
        );

        return {
          expenses: roundCurrency(periodRows.reduce((sum, expense) => sum + (expense.total || 0), 0)),
          month: toPeriodLabel(period),
          trips: periodRows.length,
        };
      });

    const expenseRows = dsmExpenses
      .map((expense) => {
        const employee =
          dsmByCanonicalHrId.get(normalizeHrIdForAccess(expense.hrId) ?? "") ??
          null;

        return {
          ...expense,
          dsmName: employee?.displayName ?? expense.specialist ?? expense.hrId ?? "Unknown DSM",
          lineName: employee?.lineName ?? null,
        };
      })
      .sort((left, right) => {
        const leftDate = left.date ? new Date(left.date).getTime() : 0;
        const rightDate = right.date ? new Date(right.date).getTime() : 0;
        return rightDate - leftDate;
      });

    const teamExpenseSummary = summarizePayrollExpenses(dsmExpenses);
    const summary = {
      activeDsms: dsms.length,
      approvedAmount: teamExpenseSummary.approvedAmount,
      approvedTrips: teamExpenseSummary.approvedRows,
      avgCostPerTrip: teamExpenseSummary.averageCostPerTrip,
      pendingAmount: teamExpenseSummary.pendingAmount,
      pendingTrips: teamExpenseSummary.pendingRows,
      totalDistance: teamExpenseSummary.totalDistance,
      totalExpenses: teamExpenseSummary.totalAmount,
      totalTrips: teamExpenseSummary.totalRows,
    };

    return {
      dsms,
      expenseRows,
      monthlyTrend,
      periods,
      reports,
      selectedReportId,
      requestTypes,
      selectedRequestType: options.requestType ? selectedRequestType : null,
      scopeLabel: viewer.lineName ?? currentUser.line ?? "Your line",
      selectedDsmHrId: selectedDsmHrId ?? null,
      selectedPeriod,
      selectedPeriods,
      summary,
    };
  } catch {
    return null;
  }
}
