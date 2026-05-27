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
import { daysBetweenDateOnly } from "@/lib/date-only";
import {
  createPortalSalesLineScope,
  employeeMatchesPortalSalesScope,
  salesRecordMatchesPortalSalesScope,
} from "@/lib/employee-portal/sales-scope";
import { getEmployeeDirectory, type EmployeeDirectoryData, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  isDateWithinLifecycleRiskWindow,
  lifecycleRiskWindows,
  probationEndDateFromHire,
  resolveEmployeeLifecycleJourney,
} from "@/lib/lifecycle-risk/metrics";
import { classifyEmployeeNode } from "@/lib/workforce-classification";
import { salesRecordMatchesSeatContinuity } from "@/lib/workforce/seat-lifecycle";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import {
  buildPayrollExpenseDsmSummaries,
  summarizePayrollExpenses,
} from "@/lib/payroll/expense-metrics";
import { listPayrollExpenseReports, listPayrollExpenses } from "@/lib/payroll/expenses";
import {
  calculatePayrollParts,
  normalizePayrollPaymentMode,
  resolveFixedSalaryAmounts,
} from "@/lib/payroll/policy";
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
import { getVacationReportData } from "@/lib/vacation/service";

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

type PortalSalesSourceRow = Record<string, unknown>;
type PortalSalesNormalized = {
  hrId: string;
  managerHrId: string | null;
  family: string;
  line: string | null;
  month: number | null;
  period: string;
  product: string;
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

function logPortalDebug(message: string, payload?: unknown) {
  void message;
  void payload;
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
    .ilike("employee_hr_id", hrId)
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

function normalizeTeamComparisonPeriods(value: string | string[] | null | undefined) {
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

function hasMissingColumnError(error: unknown, columnName: string) {
  if (!error) return false;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "42703") return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("column") &&
    (message.includes(`\"${columnName}\"`) ||
      message.includes(columnName) ||
      message.includes(`column ${columnName}`))
  );
}

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

function mapSalesRow(row: PortalSalesSourceRow): PortalSalesNormalized {
  const period = pickText(row as unknown as PortalPayrollSourceRow, ["period"]);
  const year = parseIntValue(row, ["year", "payroll_year"]);
  const month = parseIntValue(row, ["month", "payroll_month"]);
  const normalizedPeriod = period || (year && month ? `${year}-${String(month).padStart(2, "0")}` : "");
  return {
    hrId: pickText(row as unknown as PortalPayrollSourceRow, ["hr_id", "employee_hr_id"]),
    managerHrId: pickOptionalText(row as Record<string, unknown>, ["manager_hr_id", "manager_id"]),
    family: pickText(row as unknown as PortalPayrollSourceRow, ["family"]),
    line: pickOptionalText(row as unknown as PortalPayrollSourceRow, ["line", "employee_line"]),
    month,
    period: normalizedPeriod,
    product: pickText(row as unknown as PortalPayrollSourceRow, ["product"]),
    salesType: pickText(row as unknown as PortalPayrollSourceRow, ["sales_type", "salesType"]),
    salesUnits: toNumber((row as unknown as PortalPayrollSourceRow).sales_units ?? (row as unknown as PortalPayrollSourceRow).salesUnits),
    salesValue: toNumber((row as unknown as PortalPayrollSourceRow).sales_value ?? (row as unknown as PortalPayrollSourceRow).salesValue),
    targetValue: toNumber((row as unknown as PortalPayrollSourceRow).target_value ?? (row as unknown as PortalPayrollSourceRow).targetValue),
    territory: pickText(row as unknown as PortalPayrollSourceRow, ["territory"]),
    year,
  };
}

function normalizeFilter(value: unknown) {
  return isPortalFilterText(value) ? value.trim() : null;
}

function toCanonicalPortalHrId(hrId: string | null | undefined) {
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

type SalesFilterQuery = {
  or: (filter: string) => SalesFilterQuery;
  eq: (column: string, value: number | string) => SalesFilterQuery;
  ilike: (column: string, pattern: string) => SalesFilterQuery;
  in: (column: string, values: string[]) => SalesFilterQuery;
};

function applySalesFiltersToQuery(query: SalesFilterQuery, filters: PortalSalesFilters) {
  let nextQuery = query;
  if (filters.year) nextQuery = nextQuery.eq("year", Number(filters.year));
  if (filters.month) nextQuery = nextQuery.eq("month", Number(filters.month));
  if (filters.product) nextQuery = nextQuery.eq("product", filters.product);
  if (filters.family) nextQuery = nextQuery.eq("family", filters.family);
  if (filters.salesType) nextQuery = nextQuery.eq("sales_type", filters.salesType);
  if (filters.sales_type) nextQuery = nextQuery.eq("sales_type", filters.sales_type);
  if (filters.territory) nextQuery = nextQuery.eq("territory", filters.territory);
  if (filters.line) {
    const lineFilters = Array.from(
      new Set(Array.isArray(filters.line) ? filters.line : [filters.line]),
    ).filter(Boolean);
    if (lineFilters.length === 1) {
      nextQuery = nextQuery.ilike("line", lineFilters[0] as string);
    } else if (lineFilters.length > 1) {
      nextQuery = nextQuery.or(lineFilters.map((line) => `line.ilike.${line}`).join(","));
    }
  }
  if (filters.products && filters.products.length > 0) nextQuery = nextQuery.in("product", filters.products);
  if (filters.period) {
    const [yearText, monthText] = String(filters.period).split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    if (Number.isFinite(year) && Number.isFinite(month)) {
      nextQuery = nextQuery.eq("year", year).eq("month", month);
    }
  }
  return nextQuery;
}

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
    () => supabase.from("employee_documents").select("*").ilike("employee_hr_id", hrId).order("created_at", { ascending: false }),
    () => supabase.from("employee_documents").select("*").ilike("hr_id", hrId).order("created_at", { ascending: false }),
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
      logPortalDebug("salary history query error", { error, hrId: normalizedHrId });
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
    logPortalDebug("salary history query error", { error, hrId: normalizedHrId });
    return [];
  }
}

async function fetchPortalNotifications(hrId: string): Promise<PortalNotification[]> {
  const supabase = getSupabaseAdmin();
  try {
    const { data } = await supabase
      .from("notification_events")
      .select("id,category,subject,scheduled_for,sent_at,status,metadata,recipients")
      .or(`employee_hr_id.eq.${hrId},recipients.cs.["${hrId.toUpperCase()}"]`)
      .order("scheduled_for", { ascending: false })
      .limit(5);

    return (data ?? []).filter((row) => {
      const r = row as Record<string, unknown>;
      if (String(r.category ?? "").toLowerCase() !== "probation") return true;
      const recipients = Array.isArray(r.recipients) ? r.recipients : [];
      return recipients.some((recipient) => String(recipient ?? "").trim().toUpperCase() === hrId.toUpperCase());
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

async function resolvePortalCurrentUser(access: AccessContext): Promise<PortalCurrentUser> {
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
      currentUser.name = currentUser.name ?? employee.fullName;
    }
  } catch {
    // Keep the auth-derived identity if the directory is temporarily unavailable.
  }

  return currentUser;
}

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

  const runPayslipQuery = async (column: "hr_id" | "employee_hr_id" | "employee_code", value: string, exact = true) => {
    const query = exact ? buildPayslipQuery().ilike(column, value) : buildPayslipQuery().ilike(column, `%${value}%`);
    return query;
  };

  try {
    const { data: hrIdData, error: hrIdError } = await runPayslipQuery("hr_id", normalizedHrId);
    let dataByColumn: unknown[] | null = hrIdData;
    let employeeHrIdData: unknown[] | null = null;
    let employeeCodeData: unknown[] | null = null;
    let employeeHrIdError: unknown = null;
    let employeeCodeError: unknown = null;

    const hasHrIdRows = (hrIdData?.length ?? 0) > 0;
    const canQueryEmployeeHrId = !hasHrIdRows && !hasMissingColumnError(hrIdError, "hr_id");
    if (canQueryEmployeeHrId) {
      const byEmployeeHrId = await runPayslipQuery("employee_hr_id", normalizedHrId);
      employeeHrIdData = byEmployeeHrId.data;
      employeeHrIdError = byEmployeeHrId.error;
    }

    const canQueryEmployeeCode = (
      !hasHrIdRows &&
      !hasMissingColumnError(employeeHrIdError, "employee_hr_id")
      && !hasMissingColumnError(hrIdError, "employee_code")
    );
    if (canQueryEmployeeCode) {
      const byEmployeeCode = await runPayslipQuery("employee_code", normalizedHrId);
      employeeCodeData = byEmployeeCode.data;
      employeeCodeError = byEmployeeCode.error;
    }

    if (!hasHrIdRows && !employeeHrIdData?.length && canonicalHrId && canonicalHrId !== normalizedHrId) {
      if (!isMissingColumnError(hrIdError, "hr_id")) {
        const byHrIdContains = await runPayslipQuery("hr_id", canonicalHrId, false);
        dataByColumn = [...toSafeArray(dataByColumn), ...toSafeArray(byHrIdContains.data)];
      }
      if (!hasMissingColumnError(employeeHrIdError, "employee_hr_id")) {
        const byEmployeeHrIdContains = await runPayslipQuery("employee_hr_id", canonicalHrId, false);
        employeeHrIdData = [...toSafeArray(employeeHrIdData), ...toSafeArray(byEmployeeHrIdContains.data)];
      }
      if (!hasMissingColumnError(employeeCodeError, "employee_code")) {
        const byEmployeeCodeContains = await runPayslipQuery("employee_code", canonicalHrId, false);
        employeeCodeData = [...toSafeArray(employeeCodeData), ...toSafeArray(byEmployeeCodeContains.data)];
      }
    }

    const data = [
      ...toSafeArray(dataByColumn),
      ...toSafeArray(employeeHrIdData),
      ...toSafeArray(employeeCodeData),
    ];
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
    logPortalDebug("payroll query exception", { error, hr_id: normalizedHrId });
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

// Supabase PostgREST max_rows caps every query at 1000 rows by default.
// This helper pages through all results 1000 at a time so callers get everything.
async function fetchAllRows<T = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  pageSize = 1000,
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = toSafeArray(data) as T[];
    results.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return results;
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
  const supabase = getSupabaseAdmin();

  try {
    const buildSalesQuery = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase.from("v_employee_portal_sales").select("*");
      
      if (queryHrIds.length > 0) {
        if (queryHrIds.length === 1) {
          const singleHrId = queryHrIds[0];
          // For managers, we want to see records where they are the employee OR the manager
          q = q.or(`hr_id.ilike.${singleHrId},manager_hr_id.ilike.${singleHrId}`);
        } else {
          // Use ilike OR for each ID — .in() is case-sensitive but HR IDs may be stored uppercase
          // We check both hr_id (employee) and manager_hr_id to ensure managers see their team's data
          const orConditions = queryHrIds.flatMap((id: string) => [
            `hr_id.ilike.${id}`,
            `manager_hr_id.ilike.${id}`
          ]);
          q = q.or(orConditions.join(","));
        }
      }

      q = applySalesFiltersToQuery(q, normalizedFilters);
      return q.order("year", { ascending: false }).order("month", { ascending: false });
    };

    const data = await fetchAllRows(buildSalesQuery);
    const directRecords = data.map((row) => mapSalesRow(row as PortalSalesSourceRow));
    const continuityRecords = await fetchPortalSalesSeatContinuityRecords({
      currentHrIds: queryHrIds,
      filters,
      normalizedFilters,
      supabase,
    });
    return mergePortalSalesRecords([...directRecords, ...continuityRecords]);
  } catch (error) {
    logPortalDebug("sales query exception", { error, hr_ids: queryHrIds });
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
    logPortalDebug("sales continuity vacancy lookup failed", { currentHrId, error });
    return [];
  }
}

async function fetchPortalSalesSeatContinuityRecords({
  currentHrIds,
  filters,
  normalizedFilters,
  supabase,
}: {
  currentHrIds: string[];
  filters: PortalSalesFilters;
  normalizedFilters: ReturnType<typeof resolveSalesFilterValues>;
  supabase: ReturnType<typeof getSupabaseAdmin>;
}) {
  if (currentHrIds.length === 0 || filters.line) return [];

  const directory = await getEmployeeDirectory();
  const seats = (
    await Promise.all(
      currentHrIds.map(async (currentHrId) => {
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

  const continuityLines = Array.from(
    new Set(seats.map((seat) => seat.employee.lineName).filter((line): line is string => Boolean(line))),
  );
  const continuityFilters = {
    ...normalizedFilters,
    line: normalizedFilters.line ?? (continuityLines.length > 0 ? continuityLines : undefined),
  };

  const buildContinuityQuery = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from("v_employee_portal_sales").select("*");
    q = applySalesFiltersToQuery(q, continuityFilters);
    return q.order("year", { ascending: false }).order("month", { ascending: false });
  };

  try {
    const data = await fetchAllRows(buildContinuityQuery);
    return data
      .map((row) => mapSalesRow(row as PortalSalesSourceRow))
      .filter((record) =>
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
    logPortalDebug("sales continuity query failed", { currentHrIds, error });
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

async function getEmployeePortalSalesDashboard(
  hrId: string | string[] | null,
  filters: PortalSalesFilters = {},
): Promise<SalesDashboardData> {
  const salesRecords = await fetchPortalSalesRecords(hrId, filters);
  const dashboard = buildPortalSalesDashboardMetrics(salesRecords);

  const products = Array.from(new Set(salesRecords.map((record) => record.product).filter(Boolean))).sort();
  const families = Array.from(new Set(salesRecords.map((record) => record.family).filter(Boolean))).sort();
  const periods = Array.from(new Set(salesRecords.map((record) => record.period).filter(Boolean))).sort();
  const salesTypes = Array.from(new Set(salesRecords.map((record) => record.salesType).filter(Boolean))).sort();
  const territories = Array.from(new Set(salesRecords.map((record) => record.territory).filter(Boolean))).sort();

  return {
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
  };
}

export function buildEmployeeSalesDashboard(records: PortalSalesNormalized[]): SalesDashboardData {
  const trendByPeriod = new Map<string, { sales: number; target: number; linkedEmployees: number }>();
  const productPerformanceMap = new Map<string, { sales: number; target: number; family: string; salesUnits: number }>();
  const familyMatrixMap = new Map<string, { sales: number; target: number; units: number; salesRows: PortalSalesNormalized[] }>();
  const territoryMap = new Map<string, { sales: number; target: number }>();
  const linePerformance = new Map<string, { sales: number; target: number; linkedEmployees: number }>();

  // Heuristic: If multiple rows exist for the same period and product, only take the highest target value found
  // because targets are usually per-employee-per-period-per-product and repeated on each row.
  const maxTargetsByPeriodProduct = new Map<string, number>();
  const maxTargetsByLineProduct = new Map<string, number>();
  const maxTargetsByPeriodFamily = new Map<string, number>();
  const seenTrendTargets = new Set<string>();
  const seenProductTargets = new Set<string>();
  const seenFamilyTargets = new Set<string>();
  const seenLineTargets = new Set<string>();

  // Pass 1 — collect max target per (employee, territory, period, product).
  // Key insight: each territory has 2 row types — Retail (has target) and Stores (target=0).
  // Taking MAX per territory deduplicates those two rows and gives the territory's real target.
  // Summing across territories then gives the correct total target.
  records.forEach((record) => {
    const period = record.period || (record.year && record.month ? `${record.year}-${String(record.month).padStart(2, "0")}` : "");
    const product = record.product || "Unknown";
    const line = record.line || "Unassigned";
    const family = record.family || "Unknown";
    const territory = record.territory || "Unassigned";
    const employeeHrId = normalizeHrId(record.hrId) || "unassigned";
    const targetVal = Number(record.targetValue ?? 0);

    if (period) {
      // Include territory so targets from different territories are summed, not collapsed to max
      const targetKey = `trend::${employeeHrId}::${territory}::${period}::${product}`;
      if (targetVal > (maxTargetsByPeriodProduct.get(targetKey) ?? 0)) {
        maxTargetsByPeriodProduct.set(targetKey, targetVal);
      }

      const lineTargetKey = `line::${employeeHrId}::${territory}::${line}::${period}::${product}`;
      if (targetVal > (maxTargetsByLineProduct.get(lineTargetKey) ?? 0)) {
        maxTargetsByLineProduct.set(lineTargetKey, targetVal);
      }

      const familyTargetKey = `fam::${employeeHrId}::${territory}::${period}::${product}::${family}`;
      if (targetVal > (maxTargetsByPeriodFamily.get(familyTargetKey) ?? 0)) {
        maxTargetsByPeriodFamily.set(familyTargetKey, targetVal);
      }
    }
  });

  // Pass 2 — accumulate sales (all rows) and deduplicated territory-level targets.
  records.forEach((record) => {
    const period = record.period || (record.year && record.month ? `${record.year}-${String(record.month).padStart(2, "0")}` : "");
    const product = record.product || "Unknown";
    const line = record.line || "Unassigned";
    const family = record.family || "Unknown";
    const territory = record.territory || "Unassigned";
    const employeeHrId = normalizeHrId(record.hrId) || "unassigned";

    if (period) {
      const current = trendByPeriod.get(period) ?? { sales: 0, target: 0, linkedEmployees: 0 };
      const targetKey = `trend::${employeeHrId}::${territory}::${period}::${product}`;
      const targetValue = seenTrendTargets.has(targetKey) ? 0 : (maxTargetsByPeriodProduct.get(targetKey) ?? 0);
      seenTrendTargets.add(targetKey);

      trendByPeriod.set(period, {
        linkedEmployees: current.linkedEmployees + 1,
        sales: current.sales + Number(record.salesValue ?? 0),
        target: current.target + targetValue,
      });
    }

    const prevProduct = productPerformanceMap.get(product) ?? { sales: 0, target: 0, family: record.family || "Unknown", salesUnits: 0 };
    const productTargetKey = `prod::${employeeHrId}::${territory}::${period}::${product}`;
    const productTargetValue = period && !seenProductTargets.has(productTargetKey)
      ? (maxTargetsByPeriodProduct.get(`trend::${employeeHrId}::${territory}::${period}::${product}`) ?? 0)
      : 0;
    if (period) seenProductTargets.add(productTargetKey);

    productPerformanceMap.set(product, {
      ...prevProduct,
      sales: prevProduct.sales + Number(record.salesValue ?? 0),
      target: prevProduct.target + productTargetValue,
      salesUnits: prevProduct.salesUnits + Number(record.salesUnits ?? 0),
    });

    const prevFamily = familyMatrixMap.get(family) ?? { sales: 0, target: 0, salesRows: [], units: 0 };
    const familyProductTargetKey = `fam::${employeeHrId}::${territory}::${period}::${product}::${family}`;
    const familyTargetValue = period && !seenFamilyTargets.has(familyProductTargetKey)
      ? (maxTargetsByPeriodFamily.get(familyProductTargetKey) ?? 0)
      : 0;
    if (period) seenFamilyTargets.add(familyProductTargetKey);

    familyMatrixMap.set(family, {
      sales: prevFamily.sales + Number(record.salesValue ?? 0),
      salesRows: [...prevFamily.salesRows, record],
      target: prevFamily.target + familyTargetValue,
      units: prevFamily.units + Number(record.salesUnits ?? 0),
    });

    const prevTerritory = territoryMap.get(territory) ?? { sales: 0, target: 0 };
    territoryMap.set(territory, {
      sales: prevTerritory.sales + Number(record.salesValue ?? 0),
      target: prevTerritory.target + Number(record.targetValue ?? 0),
    });

    const prevLine = linePerformance.get(line) ?? { sales: 0, target: 0, linkedEmployees: 0 };
    const lineTargetKey = `line::${employeeHrId}::${territory}::${line}::${period}::${product}`;
    const lineTargetValue = seenLineTargets.has(lineTargetKey) ? 0 : (maxTargetsByLineProduct.get(lineTargetKey) ?? 0);
    seenLineTargets.add(lineTargetKey);

    linePerformance.set(line, {
      linkedEmployees: prevLine.linkedEmployees + 1,
      sales: prevLine.sales + Number(record.salesValue ?? 0),
      target: prevLine.target + lineTargetValue,
    });
  });

  const sortedTrend = [...trendByPeriod.entries()]
    .map(([period, value]) => {
      const achievementRate = value.target > 0 ? value.sales / value.target : 0;
      return {
        ...value,
        achievementRate,
        period,
      };
    })
    .sort((left, right) => left.period.localeCompare(right.period));

  const productPerformance = [...productPerformanceMap.entries()].map(([product, value]) => ({
    family: value.family,
    achievementRate: value.target > 0 ? value.sales / value.target : 0,
    product,
    sales: value.sales,
    target: value.target,
    salesUnits: value.salesUnits,
  }));

  const familyMatrix = [...familyMatrixMap.entries()]
    .map(([name, value]) => ({
      achievementRate: value.target > 0 ? value.sales / value.target : 0,
      name,
      sales: value.sales,
      salesRows: value.salesRows,
      target: value.target,
      units: value.units,
    }));

  const totalSales = records.reduce((total, item) => total + Number(item.salesValue ?? 0), 0);
  
  // Total target should be sum of targets across unique periods and products for this employee
  // We use the pre-calculated maxTargetsByPeriodProduct to avoid double counting or missing targets
  let totalTarget = 0;
  maxTargetsByPeriodProduct.forEach((val) => {
    totalTarget += val;
  });

  const activeProducts = new Set(records.map((item) => item.product).filter(Boolean)).size;
  const totalUnits = records.reduce((total, item) => total + Number(item.salesUnits ?? 0), 0);
  const totalLinked = records.length;
  const filters = {
    families: [...new Set(records.map((item) => item.family).filter((value): value is string => Boolean(value)))].sort(),
    lines: [...new Set(records.map((item) => item.line).filter((value): value is string => Boolean(value)))].sort(),
    managers: [...new Set(records.map((item) => item.managerHrId).filter((value): value is string => Boolean(value)))].sort(),
    periods: sortedTrend.map((item) => item.period),
    products: [...new Set(records.map((item) => item.product).filter((value): value is string => Boolean(value)))].sort(),
    salesTypes: [...new Set(records.map((item) => item.salesType).filter((value): value is string => Boolean(value)))].sort(),
    territories: [...new Set(records.map((item) => item.territory).filter((value): value is string => Boolean(value)))].sort(),
  };

  return {
    anomalies: [],
    familyMatrix,
    filters,
    managerPerformance: [],
    productPerformance: productPerformance.sort((left, right) => right.sales - left.sales),
    recentBatches: [],
    summary: {
      activeProducts,
      anomalyCount: 0,
      averageFactoryPrice: 0,
      dataQualityRate: 1,
      dsmLinkedRecords: 0,
      dsmTotalRecords: 0,
      linkedEmployees: 0,
      linkedRecords: totalLinked,
      openReviewBatches: 0,
      totalApprovedSales: totalSales,
      totalApprovedTarget: totalTarget,
      activeTargetRecords: 0,
      achievementRate: totalTarget > 0 ? totalSales / totalTarget : 0,
      approvedRecords: records.length,
      unitsSold: totalUnits,
      topManager: "-",
    },
    territories: [...territoryMap.entries()].map(([name, value]) => ({
      achievementRate: value.target > 0 ? value.sales / value.target : 0,
      name,
      sales: value.sales,
      target: value.target,
    })),
    linePerformance: [...linePerformance.entries()].map(([line, value]) => ({
      achievementRate: value.target > 0 ? value.sales / value.target : 0,
      line,
      linkedEmployees: value.linkedEmployees,
      sales: value.sales,
      target: value.target,
    })),
    trend: sortedTrend,
    transactions: [],
    topManager: "-",
  } as SalesDashboardData;
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
}): Promise<SalesDashboardData> {
  if (salesScope === "LINE") {
    const byLine = line.length > 0
      ? await getEmployeePortalSalesDashboard(null, { line })
      : null;
    if (byLine && salesDashboardHasData(byLine)) return byLine;

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
    gender: null,
    fuelAllowance: null,
    grossSalary: null,
    hasBankAccount: null,
    hireDate: null,
    hrId,
    jobTitle: access.role,
    lastWorkingDate: null,
    lineId: null,
    lineName: null,
    managerHrId: null,
    managerName: null,
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

  const [payroll, sales, expenses, expenseReports, documents, notifications] = await Promise.all([
    prefetched?.payroll ?? getEmployeePortalPayrollDashboard(currentHrId),
    prefetched?.sales ?? getScopedEmployeePortalSalesDashboard({
      line: salesLineFilter,
      salesScope,
      targetSalesHrIds,
    }),
    prefetched?.expenses ?? listPayrollExpenses(undefined, undefined, undefined, { ...access, hrId: currentHrId }),
    prefetched?.expenseReports ?? listPayrollExpenseReports({ ...access, hrId: currentHrId }),
    listEmployeeDocuments(currentHrId),
    fetchPortalNotifications(currentHrId),
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
  employee: {
    area: string | null;
    department: string | null;
    fullName: string;
    hrId: string;
    line: string | null;
    manager: string | null;
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
        firstPart: number;
        grossSalary: number;
        netSalary: number;
        secondPart: number;
        totalAdditions: number;
        totalDeductions: number;
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
    achievementPercent: number;
    currentMonthLabel: string;
    currentMonthSales: number;
    currentMonthTarget: number;
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

export async function getEmployeePortalShellData(access: AccessContext): Promise<EmployeePortalShellData> {
  const currentUser = await resolvePortalCurrentUser(access);
  const currentHrId = normalizeHrId(currentUser.hrId);
  const directory = await getEmployeeDirectory();
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

  return {
    employee: {
      area: employee.areaName,
      department: employee.departmentName,
      fullName: employee.fullName,
      hrId: employee.hrId,
      line: employee.lineName,
      manager: employee.managerName,
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
}

async function buildEmployeePortalOverviewData(input: {
  access: AccessContext;
  currentHrId: string | null;
  pendingExpenseCount: number;
}): Promise<MedicalRepPortalData["overview"]> {
  const today = new Date().toISOString().slice(0, 10);

  const [vacationReport, marketingWorkspace, vacancyDetails] = await Promise.all([
    getVacationReportData(input.access).catch(() => null),
    getMarketingRequestDraftWorkspace(input.access).catch(() => null),
    getEmployeePortalVacancies(input.access).catch(() => null),
  ]);

  const vacationRows = vacationReport?.rows ?? [];
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
  const directory = await getEmployeeDirectory();
  const employee = currentHrId
    ? findDirectoryEmployeeByHrId(directory, currentHrId) ?? fallbackEmployee(access)
    : fallbackEmployee(access);
  const profileLinked =
    currentHrId !== null && toCanonicalPortalHrId(employee.hrId) === toCanonicalPortalHrId(currentHrId);
  const payrollDashboard = currentHrId ? await getEmployeePortalPayrollDashboard(currentHrId) : null;
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
  const salaryStructure = currentHrId ? await fetchEmployeeSalaryStructure(currentHrId) : null;
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
    firstPart: latestRecord?.firstPart ?? fixedSalary.basicSalary,
    grossSalary: fixedSalary.grossSalary,
    netSalary: fixedSalary.netSalary,
    secondPart: latestRecord?.secondPart ?? payrollParts.secondPart,
    totalAdditions: latestRecord?.totalAdditions ?? 0,
    totalDeductions: latestRecord?.totalDeductions ?? 0,
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
      fullName: employee.fullName,
      hrId: employee.hrId,
      line: employee.lineName,
      manager: employee.managerName,
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
      scopeLabel: employee.fullName,
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
      achievementPercent: 0,
      currentMonthLabel: "No period",
      currentMonthSales: 0,
      currentMonthTarget: 0,
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

function expenseTypeLabel(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "traveling") return "Traveling";
  if (normalized === "meeting") return "Meeting";
  if (normalized === "other") return "Other";
  return "Other";
}

function statusLabelFromOutstation(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized.includes("approve") || normalized.includes("confirm")) return "Confirmed by HR";
  if (normalized.includes("reject") || normalized.includes("decline")) return "Declined";
  return "Pending";
}

function mapOutstationExpenseToPayrollApproval(row: Record<string, unknown>): PayrollExpenseApproval {
  const status = statusLabelFromOutstation(row.status);
  const requestType = expenseTypeLabel(row.expense_type);
  const transportationType = String(row.transportation_type ?? "car").trim() || "car";
  const expectedTotal = toNumber(row.expected_total_amount);
  const claimedTotal = toNumber(row.claimed_total_amount);
  const total = claimedTotal > 0 ? claimedTotal : expectedTotal;
  const ticketAmount = toNumber(row.ticket_amount);
  const fuelAmount = toNumber(row.fuel_amount);
  const tripId = `OUTSTATION-${String(row.id ?? "").trim() || "request"}`;
  const createdAt = String(row.created_at ?? "").trim();
  const tripStartDate = String(row.trip_start_date ?? createdAt).trim();
  const tripEndDate = String(row.trip_end_date ?? tripStartDate).trim();
  const employeeHrId = String(row.employee_hr_id ?? "").trim();
  const employeeName = String(row.employee_name ?? "").trim();
  const destination =
    String(row.to_label ?? "").trim() ||
    [row.to_area, row.to_city].map((value) => String(value ?? "").trim()).filter(Boolean).join(", ");
  const origin =
    String(row.residence_address ?? "").trim() ||
    [row.residence_area, row.residence_city].map((value) => String(value ?? "").trim()).filter(Boolean).join(", ");

  return {
    allowance: toNumber(row.allowance_amount),
    amWorkload: 0,
    approvedAt: null,
    approvedBy: null,
    date: tripStartDate,
    description: String(row.notes ?? "").trim() || "Live outstation expense request",
    from: origin,
    hr: employeeName,
    hrApproved: status === "Confirmed by HR",
    hrComment: String(row.approval_reason ?? "").trim(),
    hrId: employeeHrId,
    hrNotes: String(row.eligibility_reason ?? "").trim(),
    km: toNumber(row.distance_km ?? row.distance_from_residence_km),
    location: destination,
    meetingAmount: requestType === "Meeting" ? total : 0,
    open: "",
    payoutMonth: (() => {
      const date = new Date(tripStartDate || createdAt);
      return Number.isNaN(date.getTime()) ? 0 : date.getUTCMonth() + 1;
    })(),
    payoutYear: (() => {
      const date = new Date(tripStartDate || createdAt);
      return Number.isNaN(date.getTime()) ? 0 : date.getUTCFullYear();
    })(),
    pmWorkload: 0,
    reportId: null,
    requestType,
    returnTicketAmount: 0,
    row: Number(row.id ?? 0),
    sourceFileName: "Outstation Requests",
    specialist: employeeName,
    status,
    to: destination,
    toDate: tripEndDate,
    total,
    transportationType,
    travelCost: ticketAmount + fuelAmount,
    tripId,
    tripType: requestType === "Traveling" ? "Travel" : requestType,
  } as PayrollExpenseApproval;
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

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map(mapOutstationExpenseToPayrollApproval)
    .filter((expense) => {
      if (normalizedFilter.size === 0) return true;
      const canonicalHrId = normalizeHrIdForAccess(expense.hrId);
      return Boolean(canonicalHrId && normalizedFilter.has(canonicalHrId));
    });
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

function isMedicalRepDirectoryEmployee(
  employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">,
) {
  const normalizedTitle = `${employee.jobTitle ?? ""} ${employee.positionTitle ?? ""}`.toLowerCase();
  return (
    normalizeRole(employee.jobTitle) === "Medical Rep" ||
    normalizeRole(employee.positionTitle) === "Medical Rep" ||
    normalizedTitle.includes("medical representative") ||
    normalizedTitle.includes("medical rep")
  );
}

function isNationalSalesManagerDirectoryEmployee(
  employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">,
) {
  return normalizeRole(employee.jobTitle) === "National Sales Manager" || normalizeRole(employee.positionTitle) === "National Sales Manager";
}

function isGroupProductManagerDirectoryEmployee(
  employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">,
) {
  return normalizeRole(employee.jobTitle) === "Group Product Manager" || normalizeRole(employee.positionTitle) === "Group Product Manager";
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
  return role === "Super Admin" || role === "CEO" || role === "HR Specialist" || role === "Finance Manager";
}

function isLineWorkforceRole(role: PhoenixRole) {
  return (
    role === "National Sales Manager" ||
    role === "Regional Manager" ||
    role === "Product Manager" ||
    role === "Group Product Manager" ||
    role === "SFE Manager" ||
    role === "Training Manager" ||
    role === "Marketing Manager"
  );
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
  if (isLineWorkforceRole(role)) return employee.lineName ?? currentUser.line ?? "Your line";
  if (isTeamWorkforceRole(role)) return "Your team";
  return employee.fullName;
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
  employee,
}: {
  currentUser: PortalCurrentUser;
  employee: EmployeeDirectoryRow;
}): Promise<PortalVacancySummary> {
  const role = normalizeRole(currentUser.role);
  const currentLine = normalizeLineName(currentUser.line ?? employee.lineName);
  const currentCanonicalHrId = normalizeHrIdForAccess(currentUser.hrId);
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
        query = query.ilike("manager_hr_id", currentUser.hrId);
      } else if (isLineWorkforceRole(role) && typeof employee.lineId === "number") {
        query = query.eq("line_id", employee.lineId);
      }

      return query;
    });

    const scopedRows = rows.filter((row) => {
      if (isCompanyWorkforceRole(role)) return true;
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
    logPortalDebug("open vacancy summary query failed", error);
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
      : employee.fullName,
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
  const canonicalComparisonRole = params.comparisonRole ? normalizeRole(params.comparisonRole) : null;
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
      const employeeRole = normalizeRole(employee.jobTitle || employee.positionTitle);
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

  const supabase = getSupabaseAdmin();
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

  const buildRankQuery = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("v_employee_portal_sales")
      .select("employee_name,employee_hr_id,hr_id,manager_hr_id,sales_value,target_value,month,year,product,territory");

    if (queryCandidates.length === 1) {
      const singleHrId = queryCandidates[0];
      if (isLineManagersMode) {
        // DSM comparison: fetch all rows where the candidate is a manager (team sales)
        // or is an employee (DSM's own rows) — both rolled up to the DSM
        q = q.or(`manager_hr_id.ilike.${singleHrId},hr_id.ilike.${singleHrId}`);
      } else {
        // Med Rep comparison: only fetch rows owned by this employee (hr_id = COALESCE result)
        // Do NOT include manager_hr_id to avoid pulling in sub-reports that don't exist
        q = q.or(`hr_id.ilike.${singleHrId},employee_hr_id.ilike.${singleHrId}`);
      }
    } else {
      const candidateFilters = queryCandidates.flatMap((id) => {
        if (isLineManagersMode) {
          return [`manager_hr_id.ilike.${id}`, `hr_id.ilike.${id}`];
        }
        return [`hr_id.ilike.${id}`, `employee_hr_id.ilike.${id}`];
      });
      q = q.or(candidateFilters.join(","));
    }

    if (periodFilter) {
      q = q.eq("year", periodFilter.year).eq("month", periodFilter.month);
    }
    return q;
  };

  let data: unknown[] = [];
  let error: unknown = null;
  try {
    data = await fetchAllRows(buildRankQuery);
  } catch (err) {
    error = err;
  }

  if (!error && data.length === 0 && queryHrIds.size > 0) {
    // Fallback: retry without HR filtering; attribute rows in application logic.
    const buildFallbackQuery = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from("v_employee_portal_sales")
        .select("employee_name,employee_hr_id,hr_id,manager_hr_id,sales_value,target_value,month,year,product,territory");
      if (periodFilter) {
        q = q.eq("year", periodFilter.year).eq("month", periodFilter.month);
      }
      return q;
    };
    try {
      data = await fetchAllRows(buildFallbackQuery);
    } catch (fallbackErr) {
      error = fallbackErr;
    }
  }

  if (error) {
    return { rank: null, comparison: [] as Array<{ position: number; name: string; achievementPercent: number; sales: number; target: number }> };
  }

  const nameByHrId = new Map(
    directory.employees
      .map((employee) => [resolveTeamHrId(employee.hrId), employee.fullName] as const)
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

  // Target deduplication strategy depends on comparison mode:
  //
  // team-members mode (Med Reps): memberId IS the individual employee.
  //   Target repeats across territory rows for the same product+period.
  //   Dedup key: memberId::period::product → take max per employee.
  //
  // line-managers mode (DSMs): memberId is the DSM; rows come from all their team members.
  //   Each team member has their own target that repeats across their territories.
  //   Dedup key: individualEmployeeId::period::product → take max per individual,
  //   then sum across all individuals under the DSM.
  //   individualEmployeeId = employee_hr_id (or fallback to hr_id for vacant rows).

  // key format:
  //   team-members → "TM::{memberId}::{period}::{product}"
  //   line-managers → "LM::{individualId}::{period}::{product}"  (maps back to memberId separately)
  const maxTargetKeys = new Map<string, number>();
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

    if (Number.isFinite(targetValue) && targetValue > (maxTargetKeys.get(targetKey) ?? 0)) {
      maxTargetKeys.set(targetKey, targetValue);
    }
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

  // Pass 3 — add deduplicated targets
  maxTargetKeys.forEach((value, key) => {
    let memberId: string | undefined;
    if (isLineManagersMode) {
      // key = "LM::{individualId}::{period}::{product}"
      const individualId = key.slice("LM::".length).split("::")[0];
      memberId = individualToMember.get(individualId);
    } else {
      // key = "TM::{memberId}::{period}::{product}"
      memberId = key.slice("TM::".length).split("::")[0];
    }
    if (!memberId) return;
    const current = totals.get(memberId);
    if (!current) return;
    totals.set(memberId, { ...current, target: current.target + value });
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
    const visibleTeamMembers = directory.employees.filter((row) => {
      const rowHrId = normalizeHrId(row.hrId);
      return rowHrId !== currentHrId && canSeeEmployee(access, row);
    });

    const targetSalesHrIds: string[] = currentHrId ? [currentHrId] : [];
    if (salesScope !== "SELF") {
      const teamHrIds = visibleTeamMembers.map((m) => normalizeHrId(m.hrId)).filter(Boolean) as string[];
      targetSalesHrIds.push(...teamHrIds);
    }

    // Prefetch dashboards to avoid double fetching inside getEmployeePortalData
    const [salesDashboard, payrollDashboard, historicalExpenses, liveOutstationExpenses, expenseReports] = await Promise.all([
      getScopedEmployeePortalSalesDashboard({
        line: salesLineFilter,
        salesScope,
        targetSalesHrIds,
      }),
      currentHrId ? getEmployeePortalPayrollDashboard(currentHrId) : Promise.resolve(null),
      listPayrollExpenses(undefined, undefined, undefined, { ...access, hrId: currentHrId }),
      includeLiveOutstationExpenses ? listOutstationExpensesForPortal(currentHrId ? [currentHrId] : []) : Promise.resolve([]),
      listPayrollExpenseReports({ ...access, hrId: currentHrId }),
    ]);
    const liveOutstationTripIds = new Set(liveOutstationExpenses.map((expense) => expense.tripId));
    const expenses = [
      ...historicalExpenses.filter((expense) => !liveOutstationTripIds.has(expense.tripId)),
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
        employee,
      })
    : emptyPortalVacancySummary();
  const pendingApprovalCount = expenses.filter((expense) => !expense.hrApproved).length;
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
        .map((item) => ({
          period: String((item as Record<string, unknown>).period ?? ""),
          sales: Number((item as Record<string, unknown>).sales ?? 0),
          target: Number((item as Record<string, unknown>).target ?? 0),
        }))
        .filter((item) => item.period)
    : [];

  const salesTrend = allTimeTrend.slice(-6);

  const latestTrend = salesTrend[salesTrend.length - 1] ?? null;
  const previousTrend = salesTrend[salesTrend.length - 2] ?? null;

  // Use summary totals if available, otherwise fall back to trend aggregation
  const overviewSales = salesDashboard?.summary?.totalApprovedSales ?? 
    allTimeTrend.reduce((sum, point) => sum + Number((point as Record<string, unknown>).sales ?? 0), 0);
  const overviewTarget = salesDashboard?.summary?.totalApprovedTarget ?? 
    allTimeTrend.reduce((sum, point) => sum + Number((point as Record<string, unknown>).target ?? 0), 0);

  const overviewAchievementPercent =
    overviewTarget > 0
      ? (overviewSales / overviewTarget) * 100
      : Number(base.sales.achievementRate ?? 0) * 100;
  const growthVsLastMonthPercent =
    latestTrend && previousTrend && previousTrend.sales > 0
      ? ((latestTrend.sales - previousTrend.sales) / previousTrend.sales) * 100
      : null;

  const currentMonthSales = latestTrend?.sales ?? 0;
  const currentMonthTarget = latestTrend?.target ?? 0;
  const achievementPercent = currentMonthTarget > 0
    ? (currentMonthSales / currentMonthTarget) * 100
    : Number(base.sales.achievementRate ?? 0) * 100;

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

      const allPeriodsResult = await resolveSalesRankInTeam({
        managerHrId: teamAnchorHrId,
        currentHrId,
        directory: directory,
        comparisonMode,
        comparisonRole,
        comparisonLineId,
      });
      if (allPeriodsResult) {
        teamRankAllPeriodsResult = allPeriodsResult;
      }

      if (isNationalSalesManager) {
        leadingMedicalRepResult = await resolveSalesRankInTeam({
          managerHrId: null,
          currentHrId,
          directory: directory,
          comparisonMode: "line-members",
          comparisonRole: "Medical Rep",
          comparisonLineId,
        });
      }

      const selectedPeriod = normalizeTeamComparisonPeriod(options.teamComparisonPeriod);
      if (selectedPeriod) {
        const selectedPeriodResult = await resolveSalesRankInTeam({
          managerHrId: teamAnchorHrId,
          currentHrId,
          comparisonMode,
          comparisonRole,
          comparisonLineId,
          comparisonPeriod: selectedPeriod,
          directory: directory,
        });
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
    sales: {
      achievementRate: overviewAchievementPercent / 100,
      targetValue: overviewTarget,
      totalValue: overviewSales,
    },
  };
  const portalInsights = computeInsights(insightInput);
  const insights: string[] = portalInsights.map((i) => i.message);
  
  if (!salesTrend.length) insights.push("Sales data has not been uploaded yet.");
  
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
  const incentiveCalc = calculateIncentive2026({
    ...fixedIncentiveSalary,
    achievementPercent: achievementPercent,
  });
  const allPeriodsAchievementPercent = Number.isFinite(overviewAchievementPercent) ? overviewAchievementPercent : achievementPercent;
  const allPeriodsIncentiveCalc = calculateIncentive2026({
    ...fixedIncentiveSalary,
    achievementPercent: allPeriodsAchievementPercent,
  });
  const workloadExpenseSummary = summarizePayrollExpenses(expenses);
  const activeExpenseEmployeeCount = new Set(expenses.map((expense) => expense.hrId).filter(Boolean)).size;
  const activeExpenseDays = new Set(expenses.map((expense) => expense.date?.slice(0, 10)).filter(Boolean)).size;

  return {
    employee: {
      area: employee.areaName,
      department: employee.departmentName,
      fullName: employee.fullName,
      hrId: employee.hrId,
      line: employee.lineName,
      manager: employee.managerName,
      roleLabel: employee.jobTitle || employee.positionTitle || "Medical Representative",
      status: employee.employmentStatus ?? "active",
      territory: employee.regionName ?? employee.areaName,
    },
    orgStructure,
    workforce,
    empty: {
      payroll: (payrollDashboard ? payrollDashboard.records.length : 0) === 0,
      profile: !profileLinked,
      sales: salesTrend.length === 0,
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
      incentive: incentiveCalc.payoutAmount,
      basicSalary: incentiveCalc.basicSalary,
      allPeriodsIncentive: allPeriodsIncentiveCalc.payoutAmount,
      allPeriodsIncentiveTarget: allPeriodsIncentiveCalc.semesterTargetIncentive / 6,
      allPeriodsAchievementPercent: allPeriodsAchievementPercent,
      incentiveTarget: incentiveCalc.semesterTargetIncentive / 6,
      loans: latestRecord?.loans ?? 0,
      otherDeductions: latestRecord?.otherDeductions ?? 0,
      socialInsurance: fixedSalary.socialInsurance,
      incomeTax: fixedSalary.taxes,
      fuelAllowance: fixedSalary.fuelAllowance,
      extraCostOfLiving: fixedSalary.extraCostOfLiving,
    },
    sales: {
      achievementPercent: Number.isFinite(achievementPercent) ? achievementPercent : 0,
      currentMonthLabel: latestTrend ? toPeriodLabel(latestTrend.period) : "No period",
      currentMonthSales,
      currentMonthTarget,
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
      trend: salesTrend,
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
      workloadDistribution: [
        { name: "Travel", value: expenses.filter((e) => e.tripType === "Travel").length, color: "#f97316" },
        { name: "Return", value: expenses.filter((e) => e.tripType === "Return").length, color: "#f59e0b" },
        { name: "Meeting", value: expenses.filter((e) => e.tripType === "Meeting").length, color: "#94a3b8" },
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
          name: emp?.fullName ?? hrId!,
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
      hasWorkloadFields: expenses.some((expense) => Boolean(expense.amWorkload) || Boolean(expense.pmWorkload)),
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
      availableEmployees: visibleTeamMembers.map((m) => ({ id: m.hrId, name: m.fullName })),
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
  achievementPercent: number;
  family: string;
  product: string;
  sales: number;
  target: number;
  units: number;
};

export type DsmTeamMemberData = {
  achievementPercent: number;
  hrId: string;
  name: string;
  managerHrId: string | null;
  managerName: string | null;
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
};

export async function getDsmTeamPerformance(
  access: AccessContext,
  options: { period?: string | null } = {},
): Promise<DsmTeamPerformanceData | null> {
  try {
    const currentUser = await resolvePortalCurrentUser(access);
    if (!currentUser?.hrId) return null;

    const currentRole = normalizeRole(currentUser.role);
    const isDsm = currentRole === "District Manager";
    const isNsm = currentRole === "National Sales Manager";
    
    if (!isDsm && !isNsm) return null;

    const currentHrId = normalizeHrId(currentUser.hrId);
    if (!currentHrId) return null;

    const directory = await getEmployeeDirectory().catch(() => null);
    if (!directory) return null;

    const dsmCanonical = toCanonicalPortalHrId(currentHrId);
    const currentEmployee = findDirectoryEmployeeByHrId(directory, currentHrId);
    const lineScope = createPortalSalesLineScope({
      fallbackLine: currentUser.line,
      lineId: currentEmployee?.lineId ?? null,
      lineName: currentEmployee?.lineName ?? null,
    });

    const scopedDsmRows = isNsm
      ? directory.employees.filter(
          (emp) =>
            isDistrictManagerEmployee(emp) &&
            employeeMatchesPortalSalesScope(emp, lineScope),
        )
      : [];
    const scopedDsmCanonicalIds = new Set(
      scopedDsmRows
        .map((emp) => toCanonicalPortalHrId(emp.hrId))
        .filter((hrId): hrId is string => Boolean(hrId)),
    );

    // Find target employees based on role
    // NSM sees all Med Reps in their line
    // DSM sees only their direct reports
    const medRepRows = directory.employees.filter((emp) => {
      if (!isMedicalRepDirectoryEmployee(emp)) return false;

      if (isNsm) {
        return employeeMatchesPortalSalesScope(emp, lineScope);
      }
      
      const managerCanonical = toCanonicalPortalHrId(emp.managerHrId);
      return managerCanonical && dsmCanonical && managerCanonical === dsmCanonical;
    });

    // Build hrId variant → canonical lookup for attributing sales rows
    const hrIdToCanonical = new Map<string, string>();
    const canonicalToName = new Map<string, string>();
    medRepRows.forEach((emp) => {
      const canonical = toCanonicalPortalHrId(emp.hrId);
      const normalized = normalizeHrId(emp.hrId);
      if (canonical) {
        if (normalized) hrIdToCanonical.set(normalized, canonical);
        hrIdToCanonical.set(canonical, canonical);
        canonicalToName.set(canonical, emp.fullName);
      }
    });

    const medRepHrIds = medRepRows.map((emp) => emp.hrId).filter(Boolean) as string[];

    const empty: DsmTeamPerformanceData = {
      members: [],
      periods: [],
      teamAchievementPercent: 0,
      teamMemberCount: 0,
      teamTotalSales: 0,
      teamTotalTarget: 0,
    };
    if (medRepHrIds.length === 0 && (!isNsm || scopedDsmRows.length === 0)) return empty;

    // Fetch all sales records without period filter (used for period list + all-periods view)
    // For NSMs, fetch scoped people by HR ID so stale auth line values cannot pull another line.
    const nsmSalesHrIds = Array.from(
      new Set([...medRepHrIds, ...scopedDsmRows.map((emp) => emp.hrId).filter(Boolean)]),
    ) as string[];
    const fetchedRecords = isNsm
      ? await fetchPortalSalesRecords(nsmSalesHrIds, {})
      : await fetchPortalSalesRecords(medRepHrIds, {});
    const scopedMedRepCanonicalIds = new Set(
      medRepRows
        .map((emp) => toCanonicalPortalHrId(emp.hrId))
        .filter((hrId): hrId is string => Boolean(hrId)),
    );
    const allRecords = isNsm
      ? fetchedRecords.filter((record) => {
          const recordCanonical = toCanonicalPortalHrId(record.hrId);
          const managerCanonical = toCanonicalPortalHrId(record.managerHrId);
          const belongsToScopedRep =
            Boolean(recordCanonical && scopedMedRepCanonicalIds.has(recordCanonical));
          const belongsToScopedDsm = Boolean(
            (recordCanonical && scopedDsmCanonicalIds.has(recordCanonical)) ||
              (managerCanonical && scopedDsmCanonicalIds.has(managerCanonical)),
          );

          return (
            (belongsToScopedRep || belongsToScopedDsm) &&
            salesRecordMatchesPortalSalesScope(record, lineScope)
          );
        })
      : fetchedRecords;

    // Available periods (newest first)
    const periods = Array.from(new Set(allRecords.map((r) => r.period).filter(Boolean)))
      .sort((a, b) => b.localeCompare(a));

    // Filter records by period in memory if requested
    const selectedPeriod = normalizeTeamComparisonPeriod(options.period);
    const records = selectedPeriod
      ? allRecords.filter((r) => r.period === selectedPeriod)
      : allRecords;

    // Pass 1 — accumulate sales and build deduplicated target keys
    // Target dedup key: (canonical rep ID OR territory for vacant)::period::product → take max
    const salesByRepProduct = new Map<string, { sales: number; units: number; family: string }>();
    const maxTargetByKey = new Map<string, number>();
    const targetKeyToRepProduct = new Map<string, { repId: string; product: string }>();
    
    // Global line totals (will include vacant areas if NSM)
    let teamTotalSales = 0;
    const globalMaxTargetByKey = new Map<string, number>();

    records.forEach((record) => {
      const salesVal = record.salesValue;
      const targetVal = record.targetValue;
      const period = record.period || "unknown";
      const product = record.product || "Unknown";
      const territory = record.territory || "Unassigned";

      // Always add to line totals
      teamTotalSales += salesVal;
      // Target key for the entire line: territory::period::product
      // We use territory because vacant areas are usually identified by territory
      const lineTargetKey = `${territory}::${period}::${product}`;
      if (targetVal > (globalMaxTargetByKey.get(lineTargetKey) ?? 0)) {
        globalMaxTargetByKey.set(lineTargetKey, targetVal);
      }

      // Attribute to member if linked
      const normalized = normalizeHrId(record.hrId);
      if (!normalized) return;
      const canonical = hrIdToCanonical.get(normalized);
      if (!canonical) return;

      const family = record.family || "";
      const rpKey = `${canonical}::${product}`;
      const existing = salesByRepProduct.get(rpKey) ?? { sales: 0, units: 0, family };
      salesByRepProduct.set(rpKey, {
        sales: existing.sales + salesVal,
        units: existing.units + record.salesUnits,
        family: family || existing.family,
      });

      const targetKey = `${canonical}::${territory}::${period}::${product}`;
      const currentMax = maxTargetByKey.get(targetKey) ?? 0;
      if (targetVal > currentMax) {
        maxTargetByKey.set(targetKey, targetVal);
        targetKeyToRepProduct.set(targetKey, { repId: canonical, product });
      }
    });

    // Calculate team total target from global maxes
    let teamTotalTarget = 0;
    globalMaxTargetByKey.forEach((val) => {
      teamTotalTarget += val;
    });

    // Pass 2 — aggregate deduplicated targets by (repId::product)
    const targetByRepProduct = new Map<string, number>();
    maxTargetByKey.forEach((value, key) => {
      const rp = targetKeyToRepProduct.get(key);
      if (!rp) return;
      const k = `${rp.repId}::${rp.product}`;
      targetByRepProduct.set(k, (targetByRepProduct.get(k) ?? 0) + value);
    });

    // Pass 3 — build per-member data (include all med reps, even those with no sales)
    const membersMap = new Map<string, DsmTeamMemberData>();
    medRepRows.forEach((emp) => {
      const canonical = toCanonicalPortalHrId(emp.hrId);
      if (!canonical) return;
      membersMap.set(canonical, {
        achievementPercent: 0,
        hrId: canonical,
        name: emp.fullName,
        managerHrId: emp.managerHrId ?? null,
        managerName: emp.managerName ?? null,
        position: 0,
        products: [],
        totalSales: 0,
        totalTarget: 0,
      });
    });

    const allRepIds = new Set(
      Array.from(salesByRepProduct.keys()).map((k) => k.split("::")[0]),
    );
    allRepIds.forEach((repId) => {
      const entry = membersMap.get(repId);
      if (!entry) return;

      const productKeys = Array.from(salesByRepProduct.keys()).filter((k) =>
        k.startsWith(`${repId}::`),
      );
      const products: DsmTeamMemberProductData[] = productKeys
        .map((k) => {
          const product = k.slice(`${repId}::`.length);
          const salesData = salesByRepProduct.get(k) ?? { sales: 0, units: 0, family: "" };
          const target = targetByRepProduct.get(k) ?? 0;
          const achievement = target > 0 ? (salesData.sales / target) * 100 : 0;
          return {
            achievementPercent: achievement,
            family: salesData.family,
            product,
            sales: salesData.sales,
            target,
            units: salesData.units,
          };
        })
        .sort((a, b) => b.sales - a.sales);

      const totalSales = products.reduce((sum, p) => sum + p.sales, 0);
      const totalTarget = products.reduce((sum, p) => sum + p.target, 0);
      const achievementPercent = totalTarget > 0 ? (totalSales / totalTarget) * 100 : 0;

      membersMap.set(repId, { ...entry, products, totalSales, totalTarget, achievementPercent });
    });

    // Sort by achievement (then by sales as tiebreaker) and assign positions
    const members: DsmTeamMemberData[] = Array.from(membersMap.values())
      .sort(
        (a, b) =>
          b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales,
      )
      .map((m, i) => ({ ...m, position: i + 1 }));

    const teamAchievementPercent =
      teamTotalTarget > 0 ? (teamTotalSales / teamTotalTarget) * 100 : 0;

    return {
      members,
      periods,
      teamAchievementPercent,
      teamMemberCount: members.length,
      teamTotalSales,
      teamTotalTarget,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// NSM DSMs Performance
// ---------------------------------------------------------------------------

export type NsmDsmPerformanceData = {
  dsms: DsmTeamMemberData[];
  periods: string[];
  lineAchievementPercent: number;
  dsmCount: number;
  lineTotalSales: number;
  lineTotalTarget: number;
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
  areaName: string | null;
  createdAt: string;
  id: number;
  isDistrictManagerVacancy: boolean;
  jobTitle: string | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  note: string | null;
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

function isDistrictManagerEmployee(
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
    if (!isDsm && !isNsm) return null;

    const directory = await getEmployeeDirectory().catch(() => null);
    if (!directory) return null;

    const currentCanonicalHrId = normalizeHrIdForAccess(currentUser.hrId);
    const currentLineNormalized = normalizeLineName(currentUser.line);
    const currentEmployee = directory.employees.find((employee) => {
      const employeeCanonical = normalizeHrIdForAccess(employee.hrId);
      return Boolean(employeeCanonical && currentCanonicalHrId && employeeCanonical === currentCanonicalHrId);
    });

    if (!currentEmployee) return null;

    const supabase = getSupabaseAdmin();
    const vacancyRows = await fetchAllRows<PortalVacancyDbRow>(() => {
      let query = supabase
        .from("position_vacancies")
        .select(
          "id,vacancy_code,job_title,status,created_at,note,manager_hr_id,manager_name,region_name,line_id,area_id,position_id,lines(name),areas(name),positions(title)",
        )
        .eq("status", "open")
        .order("created_at", { ascending: false });

      if (isDsm && currentUser.hrId) {
        query = query.ilike("manager_hr_id", currentUser.hrId);
      } else if (typeof currentEmployee.lineId === "number") {
        query = query.eq("line_id", currentEmployee.lineId);
      }

      return query;
    });

    const scopedRows = vacancyRows.filter((row) => {
      if (isNsm) {
        if (typeof currentEmployee.lineId === "number") {
          return row.line_id === currentEmployee.lineId;
        }
        return normalizeLineName(row.lines?.name ?? null) === currentLineNormalized;
      }

      const rowCanonicalManager = normalizeHrIdForAccess(row.manager_hr_id);
      return Boolean(
        rowCanonicalManager &&
          currentCanonicalHrId &&
          rowCanonicalManager === currentCanonicalHrId,
      );
    });

    const uniqueRows = uniqueVacancyRows(scopedRows);

    const vacancies = uniqueRows.map((row) => ({
      areaName: row.areas?.name ?? row.area_name ?? null,
      createdAt: row.created_at,
      id: row.id,
      isDistrictManagerVacancy: isDistrictManagerVacancyTitle(
        row.job_title,
        row.positions?.title,
      ),
      jobTitle: row.job_title,
      lineName: row.lines?.name ?? null,
      managerHrId: row.manager_hr_id,
      managerName: row.manager_name,
      note: row.note,
      positionTitle: row.positions?.title ?? null,
      regionName: row.region_name,
      status: row.status,
      vacancyCode: row.vacancy_code,
    }));

    return {
      roleView: isNsm ? "nsm" : "dsm",
      scopeLabel: isNsm
        ? currentEmployee.lineName ?? currentUser.line ?? "Your line"
        : currentEmployee.fullName,
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
  options: { period?: string | null } = {},
): Promise<NsmDsmPerformanceData | null> {
  try {
    const currentUser = await resolvePortalCurrentUser(access);
    if (!currentUser?.hrId) return null;

    const currentRole = normalizeRole(currentUser.role);
    if (currentRole !== "National Sales Manager") return null;

    const directory = await getEmployeeDirectory().catch(() => null);
    if (!directory) return null;

    const currentEmployee = findDirectoryEmployeeByHrId(directory, currentUser.hrId);
    const lineScope = createPortalSalesLineScope({
      fallbackLine: currentUser.line,
      lineId: currentEmployee?.lineId ?? null,
      lineName: currentEmployee?.lineName ?? null,
    });

    const dsmRows = directory.employees.filter((emp) => {
      return (
        isDistrictManagerEmployee(emp) &&
        employeeMatchesPortalSalesScope(emp, lineScope)
      );
    });

    // Map to identify which DSM a sales record belongs to
    // For NSM viewing DSMs, we look at the manager_hr_id of the records
    const dsmHrIdToCanonical = new Map<string, string>();
    const canonicalToName = new Map<string, string>();
    dsmRows.forEach((emp) => {
      const canonical = toCanonicalPortalHrId(emp.hrId);
      const normalized = normalizeHrId(emp.hrId);
      if (canonical) {
        if (normalized) dsmHrIdToCanonical.set(normalized, canonical);
        dsmHrIdToCanonical.set(canonical, canonical);
        canonicalToName.set(canonical, emp.fullName);
      }
    });
    const dsmCanonicalIds = new Set(dsmHrIdToCanonical.values());

    const medRepToDsmCanonical = new Map<string, string>();
    directory.employees.forEach((emp) => {
      if (!isMedicalRepDirectoryEmployee(emp)) return;
      if (!employeeMatchesPortalSalesScope(emp, lineScope)) return;

      const repCanonical = toCanonicalPortalHrId(emp.hrId);
      const managerCanonical = toCanonicalPortalHrId(emp.managerHrId);
      if (!repCanonical || !managerCanonical || !dsmCanonicalIds.has(managerCanonical)) return;
      medRepToDsmCanonical.set(repCanonical, managerCanonical);
    });

    const resolveDsmForSalesRecord = (record: PortalSalesNormalized) => {
      const managerCanonical = toCanonicalPortalHrId(record.managerHrId);
      if (managerCanonical && dsmCanonicalIds.has(managerCanonical)) {
        return managerCanonical;
      }

      const recordCanonical = toCanonicalPortalHrId(record.hrId);
      if (recordCanonical && dsmCanonicalIds.has(recordCanonical)) {
        return recordCanonical;
      }

      return recordCanonical ? medRepToDsmCanonical.get(recordCanonical) ?? null : null;
    };

    // Fetch by scoped HR IDs so stale app_auth_users.line values do not leak other lines.
    const salesQueryHrIds = Array.from(
      new Set([
        ...dsmRows.map((emp) => emp.hrId),
        ...Array.from(medRepToDsmCanonical.keys()),
      ]),
    );
    const fetchedRecords =
      salesQueryHrIds.length > 0
        ? await fetchPortalSalesRecords(salesQueryHrIds, {})
        : [];
    const allRecords = fetchedRecords
      .map((record) => ({ dsmCanonical: resolveDsmForSalesRecord(record), record }))
      .filter(
        (entry): entry is { dsmCanonical: string; record: PortalSalesNormalized } =>
          Boolean(entry.dsmCanonical) &&
          salesRecordMatchesPortalSalesScope(entry.record, lineScope),
      );

    // Available periods
    const periods = Array.from(new Set(allRecords.map(({ record }) => record.period).filter(Boolean)))
      .sort((a, b) => b.localeCompare(a));

    const selectedPeriod = normalizeTeamComparisonPeriod(options.period);
    const records = selectedPeriod
      ? allRecords.filter(({ record }) => record.period === selectedPeriod)
      : allRecords;

    const salesByDsmProduct = new Map<string, { sales: number; units: number; family: string }>();
    const maxTargetByDsmPeriodProduct = new Map<string, number>();
    
    let lineTotalSales = 0;
    const globalMaxTargetByKey = new Map<string, number>();

    records.forEach(({ dsmCanonical, record }) => {
      const salesVal = record.salesValue;
      const targetVal = record.targetValue;
      const period = record.period || "unknown";
      const product = record.product || "Unknown";
      const territory = record.territory || "Unassigned";

      lineTotalSales += salesVal;
      const lineTargetKey = `${territory}::${period}::${product}`;
      if (targetVal > (globalMaxTargetByKey.get(lineTargetKey) ?? 0)) {
        globalMaxTargetByKey.set(lineTargetKey, targetVal);
      }

      const family = record.family || "";
      const dpKey = `${dsmCanonical}::${product}`;
      const existing = salesByDsmProduct.get(dpKey) ?? { sales: 0, units: 0, family };
      salesByDsmProduct.set(dpKey, {
        sales: existing.sales + salesVal,
        units: existing.units + record.salesUnits,
        family: family || existing.family,
      });

      // DSM target dedup: manager::territory::period::product
      const dsmTargetKey = `${dsmCanonical}::${territory}::${period}::${product}`;
      if (targetVal > (maxTargetByDsmPeriodProduct.get(dsmTargetKey) ?? 0)) {
        maxTargetByDsmPeriodProduct.set(dsmTargetKey, targetVal);
      }
    });

    let lineTotalTarget = 0;
    globalMaxTargetByKey.forEach((val) => {
      lineTotalTarget += val;
    });

    // Aggregate DSM product targets
    const dsmProductTargets = new Map<string, number>();
    maxTargetByDsmPeriodProduct.forEach((val, key) => {
      const parts = key.split("::");
      const dsmId = parts[0];
      const product = parts[3];
      const k = `${dsmId}::${product}`;
      dsmProductTargets.set(k, (dsmProductTargets.get(k) ?? 0) + val);
    });

    // Build DSM data objects
    const dsmsMap = new Map<string, DsmTeamMemberData>();
    dsmRows.forEach((emp) => {
      const canonical = toCanonicalPortalHrId(emp.hrId);
      if (!canonical) return;
      dsmsMap.set(canonical, {
        achievementPercent: 0,
        hrId: canonical,
        name: emp.fullName,
        managerHrId: null, // NSM is the manager
        managerName: currentUser.name,
        position: 0,
        products: [],
        totalSales: 0,
        totalTarget: 0,
      });
    });

    const activeDsmIds = new Set(Array.from(salesByDsmProduct.keys()).map(k => k.split("::")[0]));
    activeDsmIds.forEach(dsmId => {
      const entry = dsmsMap.get(dsmId);
      if (!entry) return;

      const productKeys = Array.from(salesByDsmProduct.keys()).filter(k => k.startsWith(`${dsmId}::`));
      const products: DsmTeamMemberProductData[] = productKeys.map(k => {
        const product = k.slice(`${dsmId}::`.length);
        const s = salesByDsmProduct.get(k)!;
        const t = dsmProductTargets.get(k) ?? 0;
        return {
          achievementPercent: t > 0 ? (s.sales / t) * 100 : 0,
          family: s.family,
          product,
          sales: s.sales,
          target: t,
          units: s.units
        };
      }).sort((a, b) => b.sales - a.sales);

      const totalSales = products.reduce((sum, p) => sum + p.sales, 0);
      const totalTarget = products.reduce((sum, p) => sum + p.target, 0);
      dsmsMap.set(dsmId, {
        ...entry,
        products,
        totalSales,
        totalTarget,
        achievementPercent: totalTarget > 0 ? (totalSales / totalTarget) * 100 : 0
      });
    });

    const dsms = Array.from(dsmsMap.values())
      .sort((a, b) => b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales)
      .map((d, i) => ({ ...d, position: i + 1 }));

    return {
      dsms,
      periods,
      lineAchievementPercent: lineTotalTarget > 0 ? (lineTotalSales / lineTotalTarget) * 100 : 0,
      dsmCount: dsms.length,
      lineTotalSales,
      lineTotalTarget
    };
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

    const directDsms = directory.employees.filter((employee) => {
      const managerCanonical = normalizeHrIdForAccess(employee.managerHrId);
      return (
        isDistrictManagerEmployee(employee) &&
        Boolean(viewerCanonicalHrId) &&
        managerCanonical === viewerCanonicalHrId
      );
    });

    const lineDsms = directory.employees.filter((employee) => {
      if (!isDistrictManagerEmployee(employee)) {
        return false;
      }

      if (typeof viewer.lineId === "number" && typeof employee.lineId === "number") {
        return employee.lineId === viewer.lineId;
      }

      return normalizeLineName(employee.lineName) === normalizeLineName(viewer.lineName);
    });

    const scopedDsms = directDsms.length > 0 ? directDsms : lineDsms;
    if (scopedDsms.length === 0) return null;

    const dsmByCanonicalHrId = new Map<
      string,
      Pick<EmployeeDirectoryRow, "fullName" | "hrId" | "lineName">
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

    const reportExpenses = await listPayrollExpenses(
      undefined,
      undefined,
      selectedReportId ?? undefined,
      access,
    );
    const liveOutstationExpenses = await listOutstationExpensesForPortal(
      scopedDsms.map((employee) => employee.hrId),
    );

    const liveOutstationTripIds = new Set(liveOutstationExpenses.map((expense) => expense.tripId));
    const combinedExpenses = [
      ...reportExpenses.filter((expense) => !liveOutstationTripIds.has(expense.tripId)),
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
        fullName: employee.fullName,
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
          expenses: periodRows.reduce((sum, expense) => sum + (expense.total || 0), 0),
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
          dsmName: employee?.fullName ?? expense.specialist ?? expense.hrId ?? "Unknown DSM",
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

