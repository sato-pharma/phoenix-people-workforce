import ExcelJS from "exceljs";

import { toDateOnlyString } from "../date-only.ts";
import {
  calculateGrossSalary,
  calculatePayrollParts,
  normalizePayrollPaymentMode,
  type PayrollPaymentMode,
} from "./policy.ts";

export type SalaryValidationIssue = {
  code: string;
  column?: string;
  hrId?: string;
  message: string;
  row: number;
};

export type SalaryValidationRow = {
  area: string;
  bonus: number;
  crm: number;
  hrId: string;
  employmentIncomeTax: number;
  expenses: number;
  extraCostOfLiving: number;
  fingerPrint: number;
  firstPart: number;
  fuelAllowance: number;
  fullName: string;
  grossSalary: number;
  hireDate: string | null;
  incentive: number;
  jobTitle: string;
  line: string;
  loans: number;
  medicalInsurance: number;
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

export type SalaryValidationResult = {
  detectedColumns: string[];
  duplicateHrIds: string[];
  failedRows: number;
  missingRequiredColumns: string[];
  payrollPeriod: {
    month: number;
    year: number;
  };
  rowsToImport: SalaryValidationRow[];
  totalRows: number;
  validRows: number;
  validationErrors: SalaryValidationIssue[];
  validationWarnings: SalaryValidationIssue[];
  warningRows: number;
};

const columnAliases = {
  hrId: ["HR_ID", "HR ID", "Employee Code", "employee_code", "Code"],
  fullName: ["Full Name", "Employee Name", "full_name", "Name"],
  nameAr: ["Arabic Name", "Arabic Employee Name", "Name AR", "name_ar"],
  line: ["Line", "line"],
  area: ["Area", "area", "Region"],
  jobTitle: ["Job Title", "job_title", "Title"],
  grossSalary: ["Gross Salary", "gross_salary", "Total Gross Salary", "Net Salary"],
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
  netSalary: [
    "Month Salary",
    "Month Salary المرتب الشهري",
    "Monthly Salary",
    "المرتب الشهري",
    "Net Pay",
    "Net Salary",
    "net_salary",
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

function toDateOnly(value: unknown) {
  if (value === null || value === undefined || value === "") return null;

  return toDateOnlyString(value instanceof Date ? value : String(value));
}

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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

function parseMonth(value: unknown) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.findIndex((month) =>
    String(value ?? "").toLowerCase().startsWith(month),
  );
  return index >= 0 ? index + 1 : new Date().getMonth() + 1;
}

export async function validateSalaryWorkbook(file: File): Promise<SalaryValidationResult> {
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
  const hasExplicitGrossColumn = ["Gross Salary", "gross_salary", "Total Gross Salary"].some(
    (alias) => normalizedHeaders.has(normalizeHeader(alias)),
  );
  const hasExplicitTotalAdditionsColumn = hasColumnFor(columnAliases.totalAdditions);
  const hasExplicitTotalDeductionsColumn = hasColumnFor(columnAliases.totalDeductions);
  const hasFirstPartColumn = hasColumnFor(columnAliases.firstPart);
  const hasSecondPartColumn = hasColumnFor(columnAliases.secondPart);

  const rows: Record<string, unknown>[] = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const excelRow = sheet.getRow(rowNumber);
    const row = Object.fromEntries(
      headers.map((header, index) => [header, cellText(excelRow.getCell(index + 1))]),
    );
    if (Object.values(row).some((value) => String(value ?? "").trim() !== "")) {
      rows.push({ ...row, __rowNumber: rowNumber });
    }
  }

  const validationErrors: SalaryValidationIssue[] = [];
  const validationWarnings: SalaryValidationIssue[] = [];
  const seenEmployees = new Map<string, number>();
  const rowsToImport = rows.map<SalaryValidationRow>((raw) => {
    const rowNumber = Number(raw.__rowNumber);
    const hrId = String(rowValue(raw, columnAliases.hrId)).trim();
    const fullName = String(rowValue(raw, columnAliases.fullName)).trim();
    const uploadedGrossSalary = toNumber(rowValue(raw, columnAliases.grossSalary));
    const uploadedTotalAdditions = toNumber(rowValue(raw, columnAliases.totalAdditions));
    const uploadedTotalDeductions = toNumber(rowValue(raw, columnAliases.totalDeductions));
    const netSalary = toNumber(rowValue(raw, columnAliases.netSalary));
    const expenses = toNumber(rowValue(raw, columnAliases.expenses));
    const incentive = toNumber(rowValue(raw, columnAliases.incentive));
    const overtime = toNumber(rowValue(raw, columnAliases.overtime));
    const bonus = toNumber(rowValue(raw, columnAliases.bonus));
    const extraCostOfLiving = toNumber(rowValue(raw, columnAliases.extraCostOfLiving));
    const fuelAllowance = toNumber(rowValue(raw, columnAliases.fuelAllowance));
    const otherAdditions = toNumber(rowValue(raw, columnAliases.otherAdditions));
    const socialInsurance = toNumber(rowValue(raw, columnAliases.socialInsurance));
    const employmentIncomeTax = toNumber(rowValue(raw, columnAliases.employmentIncomeTax));
    const crm = toNumber(rowValue(raw, columnAliases.crm));
    const fingerPrint = toNumber(rowValue(raw, columnAliases.fingerPrint));
    const unpaidVacations = toNumber(rowValue(raw, columnAliases.unpaidVacations));
    const medicalInsurance = toNumber(rowValue(raw, columnAliases.medicalInsurance));
    const loans = toNumber(rowValue(raw, columnAliases.loans));
    const otherDeductions = toNumber(rowValue(raw, columnAliases.otherDeductions));
    const uploadedFirstPart = toNumber(rowValue(raw, columnAliases.firstPart));
    const uploadedSecondPart = toNumber(rowValue(raw, columnAliases.secondPart));
    const paymentModeText = String(rowValue(raw, columnAliases.paymentMode)).trim();
    const paymentMode = paymentModeText
      ? normalizePayrollPaymentMode(paymentModeText)
      : uploadedFirstPart > 0 && uploadedSecondPart > 0
        ? "two_parts"
        : "one_part";
    const variableAdditions = expenses + incentive + overtime + bonus + otherAdditions;
    const variableDeductions =
      crm + fingerPrint + unpaidVacations + medicalInsurance + loans + otherDeductions;
    const totalAdditions = money(
      expenses + incentive + overtime + bonus + extraCostOfLiving + fuelAllowance + otherAdditions,
    );
    const totalDeductions = money(
      socialInsurance +
        employmentIncomeTax +
        crm +
        fingerPrint +
        unpaidVacations +
        medicalInsurance +
        loans +
        otherDeductions,
    );
    const grossSalary = calculateGrossSalary({
      employmentIncomeTax,
      extraCostOfLiving,
      fuelAllowance,
      grossSalary: uploadedGrossSalary,
      netSalary,
      socialInsurance,
    });
    const parts = calculatePayrollParts({
      additions: variableAdditions,
      deductions: variableDeductions,
      extraCostOfLiving,
      fuelAllowance,
      netSalary,
      paymentMode,
      previousExpenses: 0,
    });

    if (!hrId) {
      validationErrors.push({
        code: "missing_employee_code",
        column: "HR_ID",
        message: "HR ID is required.",
        row: rowNumber,
      });
    } else if (seenEmployees.has(hrId)) {
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

    if (!fullName) {
      validationErrors.push({
        code: "missing_full_name",
        column: "Full Name",
        hrId,
        message: "Employee name is required.",
        row: rowNumber,
      });
    }

    if (uploadedGrossSalary <= 0 && grossSalary <= 0) {
      validationWarnings.push({
        code: "non_positive_gross",
        column: "Gross Salary",
        hrId,
        message: "Gross salary is zero or missing.",
        row: rowNumber,
      });
    }

    if (
      hasExplicitGrossColumn &&
      uploadedGrossSalary > 0 &&
      grossSalary > 0 &&
      differs(uploadedGrossSalary, grossSalary)
    ) {
      validationWarnings.push({
        code: "gross_salary_formula_mismatch",
        column: "Gross Salary",
        hrId,
        message: `Gross salary was normalized to ${moneyText(grossSalary)} based on net salary minus cost of living/fuel plus social insurance and income tax.`,
        row: rowNumber,
      });
    }

    if (netSalary < 0) {
      validationWarnings.push({
        code: "negative_net",
        column: "Net Salary",
        hrId,
        message: "Net salary is negative.",
        row: rowNumber,
      });
    }

    if (
      hasExplicitTotalAdditionsColumn &&
      uploadedTotalAdditions > 0 &&
      differs(uploadedTotalAdditions, totalAdditions)
    ) {
      validationWarnings.push({
        code: "total_additions_formula_mismatch",
        column: "Total Additions",
        hrId,
        message: `Total additions were normalized to ${moneyText(totalAdditions)} from expenses, incentive, overtime, bonus, cost of living, fuel, and other additions.`,
        row: rowNumber,
      });
    }

    if (
      hasExplicitTotalDeductionsColumn &&
      uploadedTotalDeductions > 0 &&
      differs(uploadedTotalDeductions, totalDeductions)
    ) {
      validationWarnings.push({
        code: "total_deductions_formula_mismatch",
        column: "Total Deductions",
        hrId,
        message: `Total deductions were normalized to ${moneyText(totalDeductions)} from statutory and internal deductions.`,
        row: rowNumber,
      });
    }

    if (hasFirstPartColumn && uploadedFirstPart > 0 && differs(uploadedFirstPart, parts.firstPart)) {
      validationWarnings.push({
        code: "first_part_formula_mismatch",
        column: "First Part",
        hrId,
        message: `First part was normalized to ${moneyText(parts.firstPart)} because it must equal the fixed basic salary.`,
        row: rowNumber,
      });
    }

    if (hasSecondPartColumn && uploadedSecondPart > 0 && differs(uploadedSecondPart, parts.secondPart)) {
      validationWarnings.push({
        code: "second_part_formula_mismatch",
        column: "Second Part",
        hrId,
        message: `Second part was normalized to ${moneyText(parts.secondPart)} as the variable salary part.`,
        row: rowNumber,
      });
    }

    return {
      area: String(rowValue(raw, columnAliases.area)).trim() || "Unassigned",
      bonus,
      crm,
      hrId,
      employmentIncomeTax,
      expenses,
      extraCostOfLiving,
      fingerPrint,
      firstPart: parts.firstPart,
      fuelAllowance,
      fullName,
      grossSalary,
      hireDate: toDateOnly(rowValue(raw, columnAliases.hireDate)),
      incentive,
      jobTitle: String(rowValue(raw, columnAliases.jobTitle)).trim() || "Unassigned",
      line: String(rowValue(raw, columnAliases.line)).trim() || "Unassigned",
      loans,
      medicalInsurance,
      nameAr: String(rowValue(raw, columnAliases.nameAr)).trim() || null,
      netSalary,
      otherAdditions,
      otherDeductions,
      overtime,
      payrollComment: String(rowValue(raw, columnAliases.payrollComment)).trim() || null,
      paymentMode,
      row: rowNumber,
      secondPart: parts.secondPart,
      socialInsurance,
      totalAdditions,
      totalDeductions,
      unpaidVacations,
    };
  });

  const firstRow = rows[0] ?? {};
  const month = parseMonth(rowValue(firstRow, columnAliases.month));
  const year = Number(rowValue(firstRow, columnAliases.year)) || new Date().getFullYear();
  const errorRows = new Set(validationErrors.map((issue) => issue.row));
  const warningRows = new Set(validationWarnings.map((issue) => issue.row));

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
    rowsToImport: rowsToImport.filter((row) => !errorRows.has(row.row)),
    totalRows: rows.length,
    validRows: rows.length - errorRows.size,
    validationErrors,
    validationWarnings,
    warningRows: warningRows.size,
  };
}
