import ExcelJS from "exceljs";

export type SalaryValidationIssue = {
  code: string;
  column?: string;
  employeeCode?: string;
  message: string;
  row: number;
};

export type SalaryValidationRow = {
  area: string;
  bonus: number;
  crm: number;
  employeeCode: string;
  employmentIncomeTax: number;
  expenses: number;
  extraCostOfLiving: number;
  fingerPrint: number;
  firstPart: number;
  fuelAllowance: number;
  fullName: string;
  grossSalary: number;
  incentive: number;
  jobTitle: string;
  line: string;
  loans: number;
  medicalInsurance: number;
  netSalary: number;
  otherAdditions: number;
  otherDeductions: number;
  overtime: number;
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
  employeeCode: ["HR_ID", "HR ID", "Employee Code", "employee_code", "Code"],
  fullName: ["Full Name", "Employee Name", "full_name", "Name"],
  line: ["Line", "line"],
  area: ["Area", "area", "Region"],
  jobTitle: ["Job Title", "job_title", "Title"],
  grossSalary: ["Gross Salary", "gross_salary", "Total Gross Salary"],
  expenses: ["Expenses", "Expenses Prev Month", "Expenses (Prev Month)", "expenses"],
  incentive: ["Incentive", "incentive"],
  overtime: ["Overtime", "overtime"],
  bonus: ["Bonus", "bonus"],
  extraCostOfLiving: ["Extra Cost of Living", "Extra CoL", "extra_cost_of_living"],
  fuelAllowance: ["Fuel Allowance", "Fuel Allow.", "fuel_allowance"],
  otherAdditions: ["Other Additions", "Other Add.", "other_additions"],
  totalAdditions: ["Total Additions", "total_additions", "Additions"],
  socialInsurance: ["Social Insurance", "Social Ins.", "social_insurance"],
  employmentIncomeTax: ["Employment Income Tax", "employment_income_tax", "Income Tax"],
  crm: ["CRM", "No CRM", "crm"],
  fingerPrint: ["Finger Print", "finger_print", "Fingerprint"],
  unpaidVacations: ["Unpaid Vacations", "Unpaid Vac.", "unpaid_vacations"],
  medicalInsurance: ["Medical Insurance", "Medical Ins.", "medical_insurance"],
  loans: ["Loans", "loans"],
  otherDeductions: ["Other Deductions", "Other Ded.", "other_deductions"],
  totalDeductions: ["Total Deductions", "total_deductions", "Deductions"],
  netSalary: ["Net Salary", "Month Salary", "Month Salary المرتب الشهري", "net_salary", "Net Pay"],
  firstPart: ["First Part", "1st Part", "1st Part Day 1 FIXED No Ded No Add", "first_part"],
  secondPart: ["Second Part", "2nd Part", "2nd Part Day 10 30 CoL Fuel All Adj", "second_part"],
  month: ["Month", "month"],
  year: ["Year", "year"],
} as const;

const requiredColumns = ["employeeCode", "fullName", "grossSalary", "netSalary"] as const;

function cellText(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value && typeof value === "object" && "result" in value) {
    return String((value as { result?: unknown }).result ?? cell.text ?? "").trim();
  }
  return String(value ?? cell.text ?? "").trim();
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
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

  const headerRow = sheet.getRow(1);
  const headers = Array.from({ length: headerRow.cellCount }, (_, index) =>
    cellText(headerRow.getCell(index + 1)),
  ).filter(Boolean);
  const normalizedHeaders = new Set(headers.map(normalizeHeader));
  const missingRequiredColumns = requiredColumns.filter((key) =>
    columnAliases[key].every((alias) => !normalizedHeaders.has(normalizeHeader(alias))),
  );

  const rows: Record<string, unknown>[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
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
    const employeeCode = String(rowValue(raw, columnAliases.employeeCode)).trim();
    const fullName = String(rowValue(raw, columnAliases.fullName)).trim();
    const grossSalary = toNumber(rowValue(raw, columnAliases.grossSalary));
    const totalAdditions = toNumber(rowValue(raw, columnAliases.totalAdditions));
    const totalDeductions = toNumber(rowValue(raw, columnAliases.totalDeductions));
    const netSalary = toNumber(rowValue(raw, columnAliases.netSalary));

    if (!employeeCode) {
      validationErrors.push({
        code: "missing_employee_code",
        column: "HR_ID",
        message: "Employee code is required.",
        row: rowNumber,
      });
    } else if (seenEmployees.has(employeeCode)) {
      validationWarnings.push({
        code: "duplicate_employee_code",
        column: "HR_ID",
        employeeCode,
        message: `Duplicate employee code also appears on row ${seenEmployees.get(employeeCode)}.`,
        row: rowNumber,
      });
    } else {
      seenEmployees.set(employeeCode, rowNumber);
    }

    if (!fullName) {
      validationErrors.push({
        code: "missing_full_name",
        column: "Full Name",
        employeeCode,
        message: "Employee name is required.",
        row: rowNumber,
      });
    }

    if (grossSalary <= 0) {
      validationWarnings.push({
        code: "non_positive_gross",
        column: "Gross Salary",
        employeeCode,
        message: "Gross salary is zero or missing.",
        row: rowNumber,
      });
    }

    if (netSalary < 0) {
      validationWarnings.push({
        code: "negative_net",
        column: "Net Salary",
        employeeCode,
        message: "Net salary is negative.",
        row: rowNumber,
      });
    }

    return {
      area: String(rowValue(raw, columnAliases.area)).trim() || "Unassigned",
      bonus: toNumber(rowValue(raw, columnAliases.bonus)),
      crm: toNumber(rowValue(raw, columnAliases.crm)),
      employeeCode,
      employmentIncomeTax: toNumber(rowValue(raw, columnAliases.employmentIncomeTax)),
      expenses: toNumber(rowValue(raw, columnAliases.expenses)),
      extraCostOfLiving: toNumber(rowValue(raw, columnAliases.extraCostOfLiving)),
      fingerPrint: toNumber(rowValue(raw, columnAliases.fingerPrint)),
      firstPart: toNumber(rowValue(raw, columnAliases.firstPart)),
      fuelAllowance: toNumber(rowValue(raw, columnAliases.fuelAllowance)),
      fullName,
      grossSalary,
      incentive: toNumber(rowValue(raw, columnAliases.incentive)),
      jobTitle: String(rowValue(raw, columnAliases.jobTitle)).trim() || "Unassigned",
      line: String(rowValue(raw, columnAliases.line)).trim() || "Unassigned",
      loans: toNumber(rowValue(raw, columnAliases.loans)),
      medicalInsurance: toNumber(rowValue(raw, columnAliases.medicalInsurance)),
      netSalary,
      otherAdditions: toNumber(rowValue(raw, columnAliases.otherAdditions)),
      otherDeductions: toNumber(rowValue(raw, columnAliases.otherDeductions)),
      overtime: toNumber(rowValue(raw, columnAliases.overtime)),
      row: rowNumber,
      secondPart: toNumber(rowValue(raw, columnAliases.secondPart)),
      socialInsurance: toNumber(rowValue(raw, columnAliases.socialInsurance)),
      totalAdditions,
      totalDeductions,
      unpaidVacations: toNumber(rowValue(raw, columnAliases.unpaidVacations)),
    };
  });

  const firstRow = rows[0] ?? {};
  const month = parseMonth(rowValue(firstRow, columnAliases.month));
  const year = Number(rowValue(firstRow, columnAliases.year)) || new Date().getFullYear();
  const errorRows = new Set(validationErrors.map((issue) => issue.row));
  const warningRows = new Set(validationWarnings.map((issue) => issue.row));

  return {
    detectedColumns: headers,
    duplicateHrIds: Array.from(seenEmployees.keys()).filter((employeeCode) =>
      validationWarnings.some(
        (warning) => warning.code === "duplicate_employee_code" && warning.employeeCode === employeeCode,
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
