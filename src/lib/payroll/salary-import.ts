import ExcelJS from "exceljs";

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
  payrollComment: ["Comment", "Comments", "Notes", "Payroll Comment", "comment"],
  month: ["Month", "month"],
  year: ["Year", "year"],
} as const;

const requiredColumns = ["hrId", "fullName", "grossSalary", "netSalary"] as const;

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

  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value).trim() || null;

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
    const grossSalary = toNumber(rowValue(raw, columnAliases.grossSalary));
    const totalAdditions = toNumber(rowValue(raw, columnAliases.totalAdditions));
    const totalDeductions = toNumber(rowValue(raw, columnAliases.totalDeductions));
    const netSalary = toNumber(rowValue(raw, columnAliases.netSalary));

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

    if (grossSalary <= 0) {
      validationWarnings.push({
        code: "non_positive_gross",
        column: "Gross Salary",
        hrId,
        message: "Gross salary is zero or missing.",
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

    return {
      area: String(rowValue(raw, columnAliases.area)).trim() || "Unassigned",
      bonus: toNumber(rowValue(raw, columnAliases.bonus)),
      crm: toNumber(rowValue(raw, columnAliases.crm)),
      hrId,
      employmentIncomeTax: toNumber(rowValue(raw, columnAliases.employmentIncomeTax)),
      expenses: toNumber(rowValue(raw, columnAliases.expenses)),
      extraCostOfLiving: toNumber(rowValue(raw, columnAliases.extraCostOfLiving)),
      fingerPrint: toNumber(rowValue(raw, columnAliases.fingerPrint)),
      firstPart: toNumber(rowValue(raw, columnAliases.firstPart)),
      fuelAllowance: toNumber(rowValue(raw, columnAliases.fuelAllowance)),
      fullName,
      grossSalary,
      hireDate: toDateOnly(rowValue(raw, columnAliases.hireDate)),
      incentive: toNumber(rowValue(raw, columnAliases.incentive)),
      jobTitle: String(rowValue(raw, columnAliases.jobTitle)).trim() || "Unassigned",
      line: String(rowValue(raw, columnAliases.line)).trim() || "Unassigned",
      loans: toNumber(rowValue(raw, columnAliases.loans)),
      medicalInsurance: toNumber(rowValue(raw, columnAliases.medicalInsurance)),
      nameAr: String(rowValue(raw, columnAliases.nameAr)).trim() || null,
      netSalary,
      otherAdditions: toNumber(rowValue(raw, columnAliases.otherAdditions)),
      otherDeductions: toNumber(rowValue(raw, columnAliases.otherDeductions)),
      overtime: toNumber(rowValue(raw, columnAliases.overtime)),
      payrollComment: String(rowValue(raw, columnAliases.payrollComment)).trim() || null,
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
