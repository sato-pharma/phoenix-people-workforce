import ExcelJS from "exceljs";

import { toDateOnlyString } from "../date-only.ts";
import {
  calculatePayrollParts,
  normalizePayrollPaymentMode,
  resolveFixedSalaryAmounts,
  type PayrollPaymentMode,
} from "./policy.ts";
import {
  salarySourceLookupKeys,
  type PayrollSalarySource,
} from "./salary-source-model.ts";

export type SalaryValidationIssue = {
  code: string;
  column?: string;
  hrId?: string;
  message: string;
  row: number;
};

export type SalaryValidationRow = {
  area: string;
  baseSalary: number;
  bonus: number;
  crm: number;
  hrId: string;
  employmentIncomeTax: number;
  expenses: number;
  extraCostOfLiving: number;
  fingerPrint: number;
  firstPart: number;
  fuelAllowance: number;
  governmentalDeductions: number;
  fullName: string;
  grossSalary: number;
  hireDate: string | null;
  incentive: number;
  jobTitle: string;
  line: string;
  loans: number;
  medicalInsurance: number;
  monthSalary: number;
  nameAr: string | null;
  netSalary: number;
  otherAdditions: number;
  otherDeductions: number;
  overtime: number;
  payrollComment: string | null;
  paymentMode: PayrollPaymentMode;
  row: number;
  secondPart: number;
  socialInsurance: number;
  totalAdditions: number;
  totalDeductions: number;
  unpaidVacations: number;
};

export type PayrollResignationCandidate = {
  area: string | null;
  fullName: string;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lastPayoutMonth: number;
  lastPayoutYear: number;
  line: string | null;
  nameAr: string | null;
  row: number;
};

export type SalaryValidationTotals = {
  baseSalary: number;
  bonus: number;
  crm: number;
  employmentIncomeTax: number;
  expenses: number;
  extraCostOfLiving: number;
  fingerPrint: number;
  firstPart: number;
  fuelAllowance: number;
  governmentalDeductions: number;
  grossSalary: number;
  incentive: number;
  loans: number;
  medicalInsurance: number;
  monthSalary: number;
  netSalary: number;
  otherAdditions: number;
  otherDeductions: number;
  overtime: number;
  secondPart: number;
  socialInsurance: number;
  totalAdditions: number;
  totalDeductions: number;
  unpaidVacations: number;
};

export type SalaryValidationResult = {
  detectedColumns: string[];
  duplicateHrIds: string[];
  failedRows: number;
  missingRequiredColumns: string[];
  payrollPeriod: {
    month: number;
    year: number;
  };
  payrollResignationCandidates: PayrollResignationCandidate[];
  rowsToImport: SalaryValidationRow[];
  totalRows: number;
  validRows: number;
  validationErrors: SalaryValidationIssue[];
  validationTotals: SalaryValidationTotals;
  validationWarnings: SalaryValidationIssue[];
  warningRows: number;
};

export type SalaryValidationOptions = {
  expectedPeriod?: {
    month: number;
    year: number;
  };
  salarySources?: Map<string, PayrollSalarySource>;
};

const columnAliases = {
  hrId: ["HR_ID", "HR ID", "Employee Code", "employee_code", "Code"],
  fullName: ["Full Name", "Employee Name", "full_name", "Name"],
  nameAr: ["Arabic Name", "Arabic Employee Name", "Name AR", "name_ar"],
  line: ["Line", "line"],
  area: ["Area", "area", "Region"],
  jobTitle: ["Job Title", "job_title", "Title"],
  baseSalary: ["Base Salary", "base_salary", "Fixed Base Salary"],
  grossSalary: ["Gross Salary", "gross_salary", "Total Gross Salary"],
  hireDate: ["Hire Date", "Hiring Date", "Start Date", "hire_date"],
  expenses: ["Expenses", "Expenses Prev Month", "Expenses (Prev Month)", "expenses"],
  incentive: ["Incentive", "incentive"],
  overtime: ["Overtime", "overtime"],
  bonus: ["Bonus", "bonus"],
  extraCostOfLiving: ["Extra Cost of Living", "Extra CoL", "extra_cost_of_living"],
  fuelAllowance: ["Fuel Allowance", "Fuel Allow.", "fuel_allowance"],
  otherAdditions: ["Other Additions", "Other Add.", "other_additions"],
  totalAdditions: ["Total Additions", "total_additions", "Additions"],
  socialInsurance: ["Social Insurance", "Social Ins.", "social_insurance"],
  employmentIncomeTax: [
    "Employment Income Tax",
    "employment_income_tax",
    "employment_income_taxes",
    "Income Tax",
  ],
  governmentalDeductions: [
    "Governmental Deductions",
    "Government Deductions",
    "Governmental Deduction",
    "governmental_deductions",
    "statutory_deductions",
  ],
  crm: [
    "CRM",
    "No CRM",
    "No. CRM",
    "No-CRM",
    "No CRM Deduction",
    "CRM Deduction",
    "no_crm_entery",
    "no_crm_entry",
    "crm",
  ],
  fingerPrint: ["Finger Print", "finger_print", "Fingerprint"],
  unpaidVacations: ["Unpaid Vacations", "Unpaid Vac.", "unpaid_vacations", "unpaid_vacation"],
  medicalInsurance: ["Medical Insurance", "Medical Ins.", "medical_insurance"],
  loans: ["Loans", "loans"],
  otherDeductions: ["Other Deductions", "Other Ded.", "other_deductions"],
  totalDeductions: ["Total Deductions", "total_deductions", "Deductions"],
  monthSalary: [
    "Month Salary",
    "Month Salary المرتب الشهري",
    "Monthly Salary",
    "المرتب الشهري",
  ],
  netSalary: [
    "Net Salary",
    "net_salary",
    "Net Pay",
    "Month Salary",
    "Month Salary المرتب الشهري",
    "Monthly Salary",
    "المرتب الشهري",
  ],
  firstPart: ["First Part", "1st Part", "1st Part Day 1 FIXED No Ded No Add", "first_part"],
  secondPart: ["Second Part", "2nd Part", "2nd Part Day 10 30 CoL Fuel All Adj", "second_part"],
  paymentMode: ["Payment Group", "Payment Mode", "payment_mode", "salary_payment_mode"],
  payrollComment: ["Comment", "Comments", "Notes", "Payroll Comment", "comment"],
  month: ["Month", "month"],
  year: ["Year", "year"],
} as const;

const requiredColumns = ["hrId", "fullName", "grossSalary", "netSalary"] as const;
const payrollFormulaTolerance = 1;

function cellText(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return toDateOnly(value) ?? "";
  if (value && typeof value === "object" && "result" in value) {
    return String((value as { result?: unknown }).result ?? "").trim();
  }
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  if (value && typeof value === "object" && "richText" in value) {
    const richText = (value as { richText?: Array<{ text?: unknown }> }).richText ?? [];
    return richText.map((part) => String(part.text ?? "")).join("").trim();
  }
  return String(value).trim();
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function headerScore(headers: string[]) {
  const normalizedHeaders = new Set(headers.map(normalizeHeader));

  return requiredColumns.filter((key) =>
    columnAliases[key].some((alias) => normalizedHeaders.has(normalizeHeader(alias))),
  ).length;
}

function findHeaderRow(sheet: ExcelJS.Worksheet) {
  let bestRowNumber = 1;
  let bestHeaders: string[] = [];
  let bestScore = -1;
  const rowsToScan = Math.min(sheet.rowCount, 12);

  for (let rowNumber = 1; rowNumber <= rowsToScan; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const headers = Array.from({ length: row.cellCount }, (_, index) =>
      cellText(row.getCell(index + 1)),
    ).filter(Boolean);
    const score = headerScore(headers);

    if (score > bestScore) {
      bestRowNumber = rowNumber;
      bestHeaders = headers;
      bestScore = score;
    }
  }

  return { headers: bestHeaders, rowNumber: bestRowNumber };
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasCellValue(value: unknown) {
  return String(value ?? "").trim() !== "";
}

function toDateOnly(value: unknown) {
  if (value === null || value === undefined || value === "") return null;

  return toDateOnlyString(value instanceof Date ? value : String(value));
}

function toPayrollDateOnly(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return toDateOnlyString(value);

  const text = String(value).trim();
  if (!text) return null;

  const parsed = toDateOnlyString(text);
  return parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed) ? parsed : null;
}

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function emptyValidationTotals(): SalaryValidationTotals {
  return {
    baseSalary: 0,
    bonus: 0,
    crm: 0,
    employmentIncomeTax: 0,
    expenses: 0,
    extraCostOfLiving: 0,
    fingerPrint: 0,
    firstPart: 0,
    fuelAllowance: 0,
    governmentalDeductions: 0,
    grossSalary: 0,
    incentive: 0,
    loans: 0,
    medicalInsurance: 0,
    monthSalary: 0,
    netSalary: 0,
    otherAdditions: 0,
    otherDeductions: 0,
    overtime: 0,
    secondPart: 0,
    socialInsurance: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    unpaidVacations: 0,
  };
}

function summarizeSalaryRows(rows: SalaryValidationRow[]): SalaryValidationTotals {
  const totals = emptyValidationTotals();

  rows.forEach((row) => {
    totals.baseSalary += row.baseSalary;
    totals.bonus += row.bonus;
    totals.crm += row.crm;
    totals.employmentIncomeTax += row.employmentIncomeTax;
    totals.expenses += row.expenses;
    totals.extraCostOfLiving += row.extraCostOfLiving;
    totals.fingerPrint += row.fingerPrint;
    totals.firstPart += row.firstPart;
    totals.fuelAllowance += row.fuelAllowance;
    totals.governmentalDeductions += row.governmentalDeductions;
    totals.grossSalary += row.grossSalary;
    totals.incentive += row.incentive;
    totals.loans += row.loans;
    totals.medicalInsurance += row.medicalInsurance;
    totals.monthSalary += row.monthSalary;
    totals.netSalary += row.netSalary;
    totals.otherAdditions += row.otherAdditions;
    totals.otherDeductions += row.otherDeductions;
    totals.overtime += row.overtime;
    totals.secondPart += row.secondPart;
    totals.socialInsurance += row.socialInsurance;
    totals.totalAdditions += row.totalAdditions;
    totals.totalDeductions += row.totalDeductions;
    totals.unpaidVacations += row.unpaidVacations;
  });

  return Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, money(value)]),
  ) as SalaryValidationTotals;
}

function differs(left: number, right: number, tolerance = payrollFormulaTolerance) {
  return Math.abs(money(left) - money(right)) > tolerance;
}

function moneyText(value: number) {
  return money(value).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });
}

function paymentModeLabel(value: PayrollPaymentMode) {
  return value === "one_part" ? "One Part" : "Two Parts";
}

function sourceAmount(
  source: PayrollSalarySource | undefined,
  key: keyof Pick<
    PayrollSalarySource,
    | "baseSalary"
    | "employmentIncomeTax"
    | "extraCostOfLiving"
    | "fuelAllowance"
    | "grossSalary"
    | "netSalary"
    | "socialInsurance"
  >,
  fallback: number,
) {
  const value = source?.[key];
  if (value === null || value === undefined) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function lookupSalarySource(
  sources: Map<string, PayrollSalarySource> | undefined,
  hrId: string,
) {
  if (!sources || !hrId) return undefined;

  for (const key of salarySourceLookupKeys(hrId)) {
    const source = sources.get(key);
    if (source) return source;
  }

  return undefined;
}

function addSourceMismatchWarning(input: {
  column: string;
  code: string;
  fieldLabel: string;
  hrId: string;
  expected: number;
  row: number;
  uploaded: number;
  warnings: SalaryValidationIssue[];
}) {
  if (input.uploaded <= 0 || input.expected <= 0 || !differs(input.uploaded, input.expected)) {
    return;
  }

  input.warnings.push({
    code: input.code,
    column: input.column,
    hrId: input.hrId,
    message: `${input.fieldLabel} differs from employee compensation (${moneyText(input.expected)}); the uploaded payroll value was preserved for payslip accuracy.`,
    row: input.row,
  });
}

function rowValue(row: Record<string, unknown>, aliases: readonly string[]) {
  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]),
  );
  for (const alias of aliases) {
    const value = normalized.get(normalizeHeader(alias));
    if (value !== undefined) return value;
  }
  return "";
}

function rowHasValue(row: Record<string, unknown>, aliases: readonly string[]) {
  return hasCellValue(rowValue(row, aliases));
}

function isPayrollSummaryRow(row: Record<string, unknown>) {
  const hasTotalsLabel = Object.entries(row).some(
    ([key, value]) =>
      key !== "__rowNumber" &&
      /^totals?$/i.test(String(value ?? "").trim()),
  );

  if (hasTotalsLabel) return true;

  const hasIdentityValue = [
    rowValue(row, ["#"]),
    rowValue(row, columnAliases.month),
    rowValue(row, columnAliases.year),
    rowValue(row, columnAliases.hrId),
    rowValue(row, columnAliases.fullName),
    rowValue(row, columnAliases.nameAr),
  ].some(hasCellValue);

  if (hasIdentityValue) return false;

  const populatedPayrollAmountColumns = [
    columnAliases.baseSalary,
    columnAliases.grossSalary,
    columnAliases.netSalary,
    columnAliases.totalAdditions,
    columnAliases.socialInsurance,
    columnAliases.employmentIncomeTax,
    columnAliases.governmentalDeductions,
    columnAliases.totalDeductions,
    columnAliases.firstPart,
    columnAliases.secondPart,
  ].filter((aliases) => rowHasValue(row, aliases)).length;

  return populatedPayrollAmountColumns >= 3;
}

function isRepeatedPayrollHeaderRow(row: Record<string, unknown>) {
  const matchingHeaderCells = Object.entries(row).filter(
    ([key, value]) =>
      key !== "__rowNumber" &&
      normalizeHeader(key) === normalizeHeader(String(value ?? "")),
  ).length;

  return matchingHeaderCells >= 3;
}

function isReadyPayrollBlockHeaderRow(row: Record<string, unknown>) {
  const firstCell = String(rowValue(row, ["#"])).trim();
  return /^block\s+\d+\s+-/i.test(firstCell);
}

function parseMonthCell(value: unknown) {
  if (!hasCellValue(value)) return null;
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.findIndex((month) =>
    String(value ?? "").toLowerCase().startsWith(month),
  );
  return index >= 0 ? index + 1 : null;
}

function parseMonth(value: unknown) {
  return parseMonthCell(value) ?? new Date().getMonth() + 1;
}

export async function validateSalaryWorkbook(
  file: File,
  options: SalaryValidationOptions = {},
): Promise<SalaryValidationResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];

  if (!sheet) {
    throw new Error("Payroll workbook has no readable sheets.");
  }

  const { headers, rowNumber: headerRowNumber } = findHeaderRow(sheet);
  const normalizedHeaders = new Set(headers.map(normalizeHeader));
  const missingRequiredColumns = requiredColumns.filter((key) =>
    columnAliases[key].every((alias) => !normalizedHeaders.has(normalizeHeader(alias))),
  );
  const hasColumnFor = (aliases: readonly string[]) =>
    aliases.some((alias) => normalizedHeaders.has(normalizeHeader(alias)));
  const hasExplicitTotalAdditionsColumn = hasColumnFor(columnAliases.totalAdditions);
  const hasExplicitTotalDeductionsColumn = hasColumnFor(columnAliases.totalDeductions);
  const hasBaseSalaryColumn = hasColumnFor(columnAliases.baseSalary);
  const hasGovernmentalDeductionsColumn = hasColumnFor(columnAliases.governmentalDeductions);
  const hasFirstPartColumn = hasColumnFor(columnAliases.firstPart);
  const hasSecondPartColumn = hasColumnFor(columnAliases.secondPart);
  const hasMonthColumn = hasColumnFor(columnAliases.month);
  const hasYearColumn = hasColumnFor(columnAliases.year);

  const rows: Record<string, unknown>[] = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const excelRow = sheet.getRow(rowNumber);
    const row = Object.fromEntries(
      headers.map((header, index) => [header, cellText(excelRow.getCell(index + 1))]),
    );
    if (
      Object.values(row).some((value) => String(value ?? "").trim() !== "") &&
      !isRepeatedPayrollHeaderRow(row) &&
      !isReadyPayrollBlockHeaderRow(row) &&
      !isPayrollSummaryRow(row)
    ) {
      rows.push({ ...row, __rowNumber: rowNumber });
    }
  }

  const validationErrors: SalaryValidationIssue[] = [];
  const validationWarnings: SalaryValidationIssue[] = [];
  const payrollResignationCandidates: PayrollResignationCandidate[] = [];
  const seenEmployees = new Map<string, number>();
  const rowsToImport = rows.map<SalaryValidationRow>((raw) => {
    const rowNumber = Number(raw.__rowNumber);
    const hrId = String(rowValue(raw, columnAliases.hrId)).trim();
    const fullName = String(rowValue(raw, columnAliases.fullName)).trim();
    const uploadedBaseSalary = toNumber(rowValue(raw, columnAliases.baseSalary));
    const uploadedGrossSalary = toNumber(rowValue(raw, columnAliases.grossSalary));
    const uploadedTotalAdditions = toNumber(rowValue(raw, columnAliases.totalAdditions));
    const uploadedTotalDeductions = toNumber(rowValue(raw, columnAliases.totalDeductions));
    const uploadedNetSalary = toNumber(rowValue(raw, columnAliases.netSalary));
    const expenses = toNumber(rowValue(raw, columnAliases.expenses));
    const incentive = toNumber(rowValue(raw, columnAliases.incentive));
    const overtime = toNumber(rowValue(raw, columnAliases.overtime));
    const bonus = toNumber(rowValue(raw, columnAliases.bonus));
    const extraCostOfLiving = toNumber(rowValue(raw, columnAliases.extraCostOfLiving));
    const fuelAllowance = toNumber(rowValue(raw, columnAliases.fuelAllowance));
    const otherAdditions = toNumber(rowValue(raw, columnAliases.otherAdditions));
    const socialInsurance = toNumber(rowValue(raw, columnAliases.socialInsurance));
    const employmentIncomeTax = toNumber(rowValue(raw, columnAliases.employmentIncomeTax));
    const uploadedGovernmentalDeductions = toNumber(rowValue(raw, columnAliases.governmentalDeductions));
    const crm = toNumber(rowValue(raw, columnAliases.crm));
    const fingerPrint = toNumber(rowValue(raw, columnAliases.fingerPrint));
    const unpaidVacations = toNumber(rowValue(raw, columnAliases.unpaidVacations));
    const medicalInsurance = toNumber(rowValue(raw, columnAliases.medicalInsurance));
    const loans = toNumber(rowValue(raw, columnAliases.loans));
    const otherDeductions = toNumber(rowValue(raw, columnAliases.otherDeductions));
    const uploadedFirstPart = toNumber(rowValue(raw, columnAliases.firstPart));
    const uploadedSecondPart = toNumber(rowValue(raw, columnAliases.secondPart));
    const uploadedMonthSalary = toNumber(rowValue(raw, columnAliases.monthSalary));
    const uploadedMonth = parseMonthCell(rowValue(raw, columnAliases.month));
    const uploadedYearValue = rowValue(raw, columnAliases.year);
    const uploadedYear = hasCellValue(uploadedYearValue) ? Number(uploadedYearValue) : null;
    const paymentModeText = String(rowValue(raw, columnAliases.paymentMode)).trim();
    const salarySource = lookupSalarySource(options.salarySources, hrId);
    const hireDate = toPayrollDateOnly(rowValue(raw, columnAliases.hireDate));
    const payoutMonth = options.expectedPeriod?.month ?? uploadedMonth ?? 0;
    const payoutYear = options.expectedPeriod?.year ?? (Number.isInteger(uploadedYear) ? Number(uploadedYear) : 0);
    const hasUploadedBaseSalary = hasBaseSalaryColumn && uploadedBaseSalary > 0;
    const hasUploadedGrossSalary = rowHasValue(raw, columnAliases.grossSalary);
    const hasUploadedNetSalary = rowHasValue(raw, columnAliases.netSalary);
    const fixedSalary = resolveFixedSalaryAmounts({
      baseSalary: hasUploadedBaseSalary ? uploadedBaseSalary : null,
      employmentIncomeTax,
      extraCostOfLiving,
      fuelAllowance,
      grossSalary: hasUploadedGrossSalary ? uploadedGrossSalary : null,
      netSalary: hasUploadedNetSalary ? uploadedNetSalary : null,
      socialInsurance,
    });
    const baseSalary = fixedSalary.baseSalary;
    const netSalary = hasUploadedNetSalary ? uploadedNetSalary : fixedSalary.netSalary;
    const grossSalary = hasUploadedGrossSalary ? uploadedGrossSalary : fixedSalary.grossSalary;
    const paymentMode = paymentModeText
      ? normalizePayrollPaymentMode(paymentModeText)
      : salarySource?.paymentMode ?? "two_parts";
    const variableAdditions = expenses + incentive + overtime + bonus + otherAdditions;
    const variableDeductions =
      crm + fingerPrint + unpaidVacations + medicalInsurance + loans + otherDeductions;
    const calculatedGovernmentalDeductions = money(socialInsurance + employmentIncomeTax);
    const governmentalDeductions = hasGovernmentalDeductionsColumn && uploadedGovernmentalDeductions > 0
      ? uploadedGovernmentalDeductions
      : calculatedGovernmentalDeductions;
    const calculatedTotalAdditions = money(
      expenses +
        incentive +
        overtime +
        bonus +
        extraCostOfLiving +
        fuelAllowance +
        otherAdditions,
    );
    const calculatedInternalDeductions = money(
      crm +
        fingerPrint +
        unpaidVacations +
        medicalInsurance +
        loans +
        otherDeductions,
    );
    const calculatedTotalDeductions = hasGovernmentalDeductionsColumn
      ? calculatedInternalDeductions
      : money(calculatedGovernmentalDeductions + calculatedInternalDeductions);
    const totalAdditions = hasExplicitTotalAdditionsColumn
      ? uploadedTotalAdditions
      : calculatedTotalAdditions;
    const totalDeductions = hasExplicitTotalDeductionsColumn
      ? uploadedTotalDeductions
      : calculatedTotalDeductions;
    const parts = calculatePayrollParts({
      additions: variableAdditions,
      baseSalary,
      deductions: variableDeductions,
      extraCostOfLiving,
      fuelAllowance,
      netSalary,
      paymentMode,
      previousExpenses: 0,
      secondPartAdditions: expenses + incentive,
    });
    const firstPart = hasFirstPartColumn ? uploadedFirstPart : parts.firstPart;
    const secondPart = hasSecondPartColumn ? uploadedSecondPart : parts.secondPart;
    const monthSalary = rowHasValue(raw, columnAliases.monthSalary)
      ? uploadedMonthSalary
      : money(firstPart + secondPart);

    if (!hrId) {
      validationErrors.push({
        code: "missing_employee_code",
        column: "HR_ID",
        message: "HR ID is required.",
        row: rowNumber,
      });
    } else {
      if (options.salarySources && !salarySource) {
        validationWarnings.push({
          code: "employee_not_found",
          column: "HR_ID",
          hrId,
          message: "HR ID was not found in the employee directory. This row will stay in payroll totals and be sent to the resignation report.",
          row: rowNumber,
        });

        if (payoutMonth >= 1 && payoutMonth <= 12 && payoutYear >= 2000 && payoutYear <= 2100) {
          payrollResignationCandidates.push({
            area: String(rowValue(raw, columnAliases.area)).trim() || null,
            fullName,
            hireDate,
            hrId,
            jobTitle: String(rowValue(raw, columnAliases.jobTitle)).trim() || null,
            lastPayoutMonth: payoutMonth,
            lastPayoutYear: payoutYear,
            line: String(rowValue(raw, columnAliases.line)).trim() || null,
            nameAr: String(rowValue(raw, columnAliases.nameAr)).trim() || null,
            row: rowNumber,
          });
        }
      }

      if (seenEmployees.has(hrId)) {
        validationWarnings.push({
          code: "duplicate_employee_code",
          column: "HR_ID",
          hrId,
          message: `Duplicate HR ID also appears on row ${seenEmployees.get(hrId)}.`,
          row: rowNumber,
        });
      } else {
        seenEmployees.set(hrId, rowNumber);
      }
    }

    if (!fullName) {
      validationErrors.push({
        code: "missing_full_name",
        column: "Full Name",
        hrId,
        message: "Employee name is required.",
        row: rowNumber,
      });
    }

    addSourceMismatchWarning({
      code: "net_salary_source_of_truth_mismatch",
      column: "Net Salary",
      fieldLabel: "Net salary",
      expected: sourceAmount(salarySource, "netSalary", 0),
      hrId,
      row: rowNumber,
      uploaded: netSalary,
      warnings: validationWarnings,
    });
    addSourceMismatchWarning({
      code: "base_salary_source_of_truth_mismatch",
      column: "Base Salary",
      fieldLabel: "Base salary",
      expected: sourceAmount(salarySource, "baseSalary", 0),
      hrId,
      row: rowNumber,
      uploaded: baseSalary,
      warnings: validationWarnings,
    });
    addSourceMismatchWarning({
      code: "extra_cost_of_living_source_of_truth_mismatch",
      column: "Extra Cost of Living",
      fieldLabel: "Extra cost of living",
      expected: sourceAmount(salarySource, "extraCostOfLiving", 0),
      hrId,
      row: rowNumber,
      uploaded: extraCostOfLiving,
      warnings: validationWarnings,
    });
    addSourceMismatchWarning({
      code: "fuel_allowance_source_of_truth_mismatch",
      column: "Fuel Allowance",
      fieldLabel: "Fuel allowance",
      expected: sourceAmount(salarySource, "fuelAllowance", 0),
      hrId,
      row: rowNumber,
      uploaded: fuelAllowance,
      warnings: validationWarnings,
    });
    addSourceMismatchWarning({
      code: "social_insurance_source_of_truth_mismatch",
      column: "Social Insurance",
      fieldLabel: "Social insurance",
      expected: sourceAmount(salarySource, "socialInsurance", 0),
      hrId,
      row: rowNumber,
      uploaded: socialInsurance,
      warnings: validationWarnings,
    });
    addSourceMismatchWarning({
      code: "employment_income_tax_source_of_truth_mismatch",
      column: "Employment Income Tax",
      fieldLabel: "Employment income tax",
      expected: sourceAmount(salarySource, "employmentIncomeTax", 0),
      hrId,
      row: rowNumber,
      uploaded: employmentIncomeTax,
      warnings: validationWarnings,
    });

    addSourceMismatchWarning({
      code: "gross_salary_source_of_truth_mismatch",
      column: "Gross Salary",
      expected: sourceAmount(salarySource, "grossSalary", 0),
      fieldLabel: "Gross salary",
      hrId,
      row: rowNumber,
      uploaded: grossSalary,
      warnings: validationWarnings,
    });

    if (paymentModeText && salarySource?.paymentMode && paymentMode !== salarySource.paymentMode) {
      validationWarnings.push({
        code: "payment_mode_source_of_truth_mismatch",
        column: "Payment Group",
        hrId,
        message: `Payment group differs from employee compensation (${paymentModeLabel(salarySource.paymentMode)}); the uploaded payroll value was preserved for payslip accuracy.`,
        row: rowNumber,
      });
    }

    if (grossSalary <= 0) {
      validationErrors.push({
        code: "missing_gross_salary",
        column: "Gross Salary",
        hrId,
        message: "Gross salary must be uploaded from the monthly payroll sheet.",
        row: rowNumber,
      });
    }

    if (
      hasUploadedGrossSalary &&
      fixedSalary.baseSalary > 0 &&
      differs(uploadedGrossSalary, fixedSalary.grossSalary)
    ) {
      validationErrors.push({
        code: "gross_salary_formula_mismatch",
        column: "Gross Salary",
        hrId,
        message: `Gross salary must equal Base Salary + Social Insurance + Employment Income Tax (${moneyText(fixedSalary.grossSalary)}).`,
        row: rowNumber,
      });
    }

    if (options.expectedPeriod && hasMonthColumn && uploadedMonth !== options.expectedPeriod.month) {
      validationErrors.push({
        code: "payroll_month_mismatch",
        column: "Month",
        hrId,
        message: `Payroll sheet month must match selected period (${options.expectedPeriod.month}/${options.expectedPeriod.year}).`,
        row: rowNumber,
      });
    }

    if (
      options.expectedPeriod &&
      hasYearColumn &&
      (typeof uploadedYear !== "number" ||
        !Number.isInteger(uploadedYear) ||
        uploadedYear !== options.expectedPeriod.year)
    ) {
      validationErrors.push({
        code: "payroll_year_mismatch",
        column: "Year",
        hrId,
        message: `Payroll sheet year must match selected period (${options.expectedPeriod.month}/${options.expectedPeriod.year}).`,
        row: rowNumber,
      });
    }

    if (netSalary <= 0) {
      validationErrors.push({
        code: netSalary < 0 ? "negative_net" : "missing_net_salary",
        column: "Net Salary",
        hrId,
        message: "Net salary must be uploaded from the monthly payroll sheet.",
        row: rowNumber,
      });
    }

    if (
      hasUploadedNetSalary &&
      fixedSalary.baseSalary > 0 &&
      differs(uploadedNetSalary, fixedSalary.netSalary)
    ) {
      validationErrors.push({
        code: "net_salary_formula_mismatch",
        column: "Net Salary",
        hrId,
        message: `Net salary must equal Base Salary + Extra Cost of Living + Fuel Allowance (${moneyText(fixedSalary.netSalary)}).`,
        row: rowNumber,
      });
    }

    if (hasExplicitTotalAdditionsColumn && !rowHasValue(raw, columnAliases.totalAdditions)) {
      validationErrors.push({
        code: "missing_total_additions",
        column: "Total Additions",
        hrId,
        message: "Total additions is required when the uploaded sheet includes a Total Additions column.",
        row: rowNumber,
      });
    }

    if (hasExplicitTotalDeductionsColumn && !rowHasValue(raw, columnAliases.totalDeductions)) {
      validationErrors.push({
        code: "missing_total_deductions",
        column: "Total Deductions",
        hrId,
        message: "Total deductions is required when the uploaded sheet includes a Total Deductions column.",
        row: rowNumber,
      });
    }

    if (hasGovernmentalDeductionsColumn && !rowHasValue(raw, columnAliases.governmentalDeductions)) {
      validationErrors.push({
        code: "missing_governmental_deductions",
        column: "Governmental Deductions",
        hrId,
        message: "Governmental deductions is required when the uploaded sheet includes a Governmental Deductions column.",
        row: rowNumber,
      });
    }

    if (
      hasGovernmentalDeductionsColumn &&
      rowHasValue(raw, columnAliases.governmentalDeductions) &&
      differs(uploadedGovernmentalDeductions, calculatedGovernmentalDeductions)
    ) {
      validationErrors.push({
        code: "governmental_deductions_formula_mismatch",
        column: "Governmental Deductions",
        hrId,
        message: `Governmental deductions must equal Social Insurance + Employment Income Tax (${moneyText(calculatedGovernmentalDeductions)}).`,
        row: rowNumber,
      });
    }

    if (hasFirstPartColumn && !rowHasValue(raw, columnAliases.firstPart)) {
      validationErrors.push({
        code: "missing_first_part",
        column: "First Part",
        hrId,
        message: "First part is required when the uploaded sheet includes a First Part column.",
        row: rowNumber,
      });
    }

    if (hasSecondPartColumn && !rowHasValue(raw, columnAliases.secondPart)) {
      validationErrors.push({
        code: "missing_second_part",
        column: "Second Part",
        hrId,
        message: "Second part is required when the uploaded sheet includes a Second Part column.",
        row: rowNumber,
      });
    }

    if (
      hasSecondPartColumn &&
      rowHasValue(raw, columnAliases.secondPart) &&
      uploadedSecondPart < 0
    ) {
      validationErrors.push({
        code: "negative_second_part",
        column: "Second Part",
        hrId,
        message: "Second part cannot be negative.",
        row: rowNumber,
      });
    }

    const requiredSecondPartAdditions = money(
      Math.min(Math.max(0, monthSalary), Math.max(0, expenses + incentive)),
    );
    if (
      hasSecondPartColumn &&
      rowHasValue(raw, columnAliases.secondPart) &&
      uploadedSecondPart >= 0 &&
      uploadedSecondPart + 0.01 < requiredSecondPartAdditions
    ) {
      validationErrors.push({
        code: "second_part_variable_additions_underpaid",
        column: "Second Part",
        hrId,
        message: `Second part must include Expenses + Incentive (${moneyText(requiredSecondPartAdditions)}).`,
        row: rowNumber,
      });
    }

    if (
      hasExplicitTotalAdditionsColumn &&
      rowHasValue(raw, columnAliases.totalAdditions) &&
      differs(uploadedTotalAdditions, calculatedTotalAdditions)
    ) {
      validationErrors.push({
        code: "total_additions_formula_mismatch",
        column: "Total Additions",
        hrId,
        message: `Total additions must equal Expenses + Incentive + Overtime + Bonus + Extra Cost of Living + Fuel Allowance + Other Additions (${moneyText(calculatedTotalAdditions)}).`,
        row: rowNumber,
      });
    }

    if (
      hasExplicitTotalDeductionsColumn &&
      rowHasValue(raw, columnAliases.totalDeductions) &&
      differs(uploadedTotalDeductions, calculatedTotalDeductions)
    ) {
      validationErrors.push({
        code: "total_deductions_formula_mismatch",
        column: "Total Deductions",
        hrId,
        message: hasGovernmentalDeductionsColumn
          ? `Total deductions must equal CRM + Finger Print + Unpaid Vacations + Medical Insurance + Loans + Other Deductions (${moneyText(calculatedTotalDeductions)}). Governmental Deductions is validated separately.`
          : `Total deductions must equal Social Insurance + Employment Income Tax + CRM + Finger Print + Unpaid Vacations + Medical Insurance + Loans + Other Deductions (${moneyText(calculatedTotalDeductions)}).`,
        row: rowNumber,
      });
    }

    return {
      area: String(rowValue(raw, columnAliases.area)).trim() || "Unassigned",
      baseSalary,
      bonus,
      crm,
      hrId,
      employmentIncomeTax,
      expenses,
      extraCostOfLiving,
      fingerPrint,
      firstPart,
      fuelAllowance,
      governmentalDeductions,
      fullName,
      grossSalary,
      hireDate,
      incentive,
      jobTitle: String(rowValue(raw, columnAliases.jobTitle)).trim() || "Unassigned",
      line: String(rowValue(raw, columnAliases.line)).trim() || "Unassigned",
      loans,
      medicalInsurance,
      monthSalary,
      nameAr: String(rowValue(raw, columnAliases.nameAr)).trim() || null,
      netSalary,
      otherAdditions,
      otherDeductions,
      overtime,
      payrollComment: String(rowValue(raw, columnAliases.payrollComment)).trim() || null,
      paymentMode,
      row: rowNumber,
      secondPart,
      socialInsurance,
      totalAdditions,
      totalDeductions,
      unpaidVacations,
    };
  });

  const firstRow = rows[0] ?? {};
  const month = options.expectedPeriod?.month ?? parseMonth(rowValue(firstRow, columnAliases.month));
  const year = options.expectedPeriod?.year ?? (Number(rowValue(firstRow, columnAliases.year)) || new Date().getFullYear());
  const errorRows = new Set(validationErrors.map((issue) => issue.row));
  const warningRows = new Set(
    validationWarnings
      .filter((issue) => issue.code !== "employee_not_found")
      .map((issue) => issue.row),
  );
  const importableRows = rowsToImport.filter((row) => !errorRows.has(row.row));

  return {
    detectedColumns: headers,
    duplicateHrIds: Array.from(seenEmployees.keys()).filter((hrId) =>
      validationWarnings.some(
        (warning) => warning.code === "duplicate_employee_code" && warning.hrId === hrId,
      ),
    ),
    failedRows: errorRows.size,
    missingRequiredColumns,
    payrollPeriod: { month, year },
    payrollResignationCandidates,
    rowsToImport: importableRows,
    totalRows: rows.length,
    validRows: rows.length - errorRows.size,
    validationErrors,
    validationTotals: summarizeSalaryRows(importableRows),
    validationWarnings,
    warningRows: warningRows.size,
  };
}

/**
 * Shared, pure per-row payroll validation.
 *
 * Encodes the salary-sheet relationships (gross/net via the locked policy,
 * additions/deductions totals), negative-value guards, and a new negative-pay
 * guard (deductions must never exceed net), independent of Excel parsing.
 *
 * The Payroll Copilot assembles SalaryValidationRow[] and runs this before
 * materializing a batch, so a Copilot-built sheet satisfies the same money
 * relationships an uploaded sheet must. The Excel upload path keeps its own
 * inline checks; this function is ADDITIVE and does not change that behavior.
 */
export function validateSalaryRows(
  rows: SalaryValidationRow[],
  sources?: Map<string, PayrollSalarySource>,
): SalaryValidationIssue[] {
  const issues: SalaryValidationIssue[] = [];
  const seen = new Map<string, number>();

  for (const row of rows) {
    const hrId = (row.hrId ?? "").trim();

    if (!hrId) {
      issues.push({ code: "missing_hr_id", column: "HR_ID", message: "HR ID is required.", row: row.row });
    } else {
      const key = hrId.toLowerCase();
      const priorRow = seen.get(key);
      if (priorRow !== undefined) {
        issues.push({
          code: "duplicate_hr_id",
          column: "HR_ID",
          hrId,
          message: `Duplicate HR ID also appears on row ${priorRow}.`,
          row: row.row,
        });
      } else {
        seen.set(key, row.row);
      }
    }

    if (!(row.fullName ?? "").trim()) {
      issues.push({ code: "missing_full_name", column: "Full Name", hrId, message: "Employee name is required.", row: row.row });
    }

    if (row.grossSalary <= 0) {
      issues.push({ code: "missing_gross_salary", column: "Gross Salary", hrId, message: "Gross salary is required.", row: row.row });
    }

    // Gross/net must match the locked-policy derivation from the same inputs.
    const fixed = resolveFixedSalaryAmounts({
      baseSalary: row.baseSalary > 0 ? row.baseSalary : null,
      employmentIncomeTax: row.employmentIncomeTax,
      extraCostOfLiving: row.extraCostOfLiving,
      fuelAllowance: row.fuelAllowance,
      grossSalary: row.grossSalary,
      netSalary: row.netSalary,
      socialInsurance: row.socialInsurance,
    });
    if (row.baseSalary > 0 && row.grossSalary > 0 && differs(row.grossSalary, fixed.grossSalary)) {
      issues.push({
        code: "gross_salary_formula_mismatch",
        column: "Gross Salary",
        hrId,
        message: `Gross salary ${money(row.grossSalary)} does not match the derived value ${money(fixed.grossSalary)}.`,
        row: row.row,
      });
    }
    if (row.baseSalary > 0 && row.netSalary > 0 && differs(row.netSalary, fixed.netSalary)) {
      issues.push({
        code: "net_salary_formula_mismatch",
        column: "Net Salary",
        hrId,
        message: `Net salary ${money(row.netSalary)} does not match the derived value ${money(fixed.netSalary)}.`,
        row: row.row,
      });
    }

    // Optional master-compensation cross-check when sources are supplied.
    const source = lookupSalarySource(sources, hrId);
    if (source?.baseSalary != null && row.baseSalary > 0 && source.baseSalary > 0 && differs(row.baseSalary, source.baseSalary)) {
      issues.push({
        code: "base_salary_source_of_truth_mismatch",
        column: "Base Salary",
        hrId,
        message: `Base salary ${money(row.baseSalary)} differs from master compensation ${money(source.baseSalary)}.`,
        row: row.row,
      });
    }

    // Additions / deductions totals must reconcile with their components.
    const expectedAdditions =
      row.expenses + row.incentive + row.overtime + row.bonus + row.extraCostOfLiving + row.fuelAllowance + row.otherAdditions;
    if (row.totalAdditions > 0 && differs(row.totalAdditions, expectedAdditions)) {
      issues.push({
        code: "total_additions_mismatch",
        column: "Total Additions",
        hrId,
        message: `Total additions ${money(row.totalAdditions)} does not match its components ${money(expectedAdditions)}.`,
        row: row.row,
      });
    }
    const expectedDeductions =
      row.crm + row.fingerPrint + row.unpaidVacations + row.medicalInsurance + row.loans + row.otherDeductions;
    if (row.totalDeductions > 0 && differs(row.totalDeductions, expectedDeductions)) {
      issues.push({
        code: "total_deductions_mismatch",
        column: "Total Deductions",
        hrId,
        message: `Total deductions ${money(row.totalDeductions)} does not match its components ${money(expectedDeductions)}.`,
        row: row.row,
      });
    }

    // Negative-value guards.
    const negativeChecks: ReadonlyArray<readonly [string, number, string]> = [
      ["Base salary", row.baseSalary, "Base Salary"],
      ["Net salary", row.netSalary, "Net Salary"],
      ["Gross salary", row.grossSalary, "Gross Salary"],
      ["Total deductions", row.totalDeductions, "Total Deductions"],
    ];
    for (const [label, value, column] of negativeChecks) {
      if (value < 0) {
        issues.push({
          code: "negative_value",
          column,
          hrId,
          message: `${label} cannot be negative (${money(value)}).`,
          row: row.row,
        });
      }
    }

    // New guard: deductions must never exceed net — take-home pay cannot go negative.
    const netForGuard = row.netSalary > 0 ? row.netSalary : fixed.netSalary;
    if (netForGuard > 0 && row.totalDeductions > netForGuard + payrollFormulaTolerance) {
      issues.push({
        code: "deductions_exceed_net",
        column: "Total Deductions",
        hrId,
        message: `Total deductions ${money(row.totalDeductions)} exceed net salary ${money(netForGuard)}; take-home pay would be negative.`,
        row: row.row,
      });
    }
  }

  return issues;
}
