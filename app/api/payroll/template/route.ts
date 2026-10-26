import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import path from "node:path";

import { assertPermission, getPayrollScope, type AccessContext } from "@/lib/auth/permissions";
import { parseDateOnly } from "@/lib/date-only";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  getEmployeeDirectory,
  getEmployeeDirectoryRows,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { getApprovedExpenseTotalsForPayroll } from "@/lib/outstation/expenses";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import {
  BASIC_SALARY_RATE,
  calculatePayrollParts,
  payrollPaymentModeLabel,
  resolveFixedSalaryAmounts,
} from "@/lib/payroll/policy";
import {
  payrollDaysInMonth,
  payrollMonthMatches,
  prorationStartDay,
  readyLifecycleComment,
  resolveReadyLifecycleSettlement,
} from "@/lib/payroll/ready-proration";
import {
  payrollCountHeaders,
  payrollMoneyHeaders,
  payrollSheetHeaders,
} from "@/lib/payroll/salary-sheet-fields";
import { getLatestSalaryExpenseTotalsBefore, getSalaryBatchExport } from "@/lib/payroll/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

import { HOUSE_XLSX_COLORS, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import { payrollHeaderCell, payrollTotalsCell } from "@/lib/payroll/payroll-sheet-style";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The First Part cap as a percentage, for prose shown inside the workbook. Derived from the
 * locked BASIC_SALARY_RATE so the sheet can never claim a different rate from the one that
 * actually computed the split.
 */
const basicSalaryRatePercentLabel = `${Math.round(BASIC_SALARY_RATE * 100)}%`;

const templateFileName = "Phoneix system template.xlsx";
const dataStartRow = 6;
const templateDataEndRow = 126;
const totalsLabel = "TOTALS";
type PayrollTemplateHeader = (typeof payrollSheetHeaders)[number] | "Bank" | "Bank Account";

const headers: PayrollTemplateHeader[] = [...payrollSheetHeaders, "Bank", "Bank Account"];
const bankDetailsSectionStart = payrollSheetHeaders.length + 1;

const columnNumberByHeader = new Map<PayrollTemplateHeader, number>(
  headers.map((header, index) => [header, index + 1] as const),
);

/**
 * 1-based Excel column number for a header, BY NAME.
 *
 * Every column index in this file used to be a literal, and there are around
 * forty of them: three formula blocks, the money/editable/section bands and the
 * whole TOTALS row. Inserting "Working Days" at column 11 on 2026-09-04 shifted
 * all of them at once — a class of bug that shows no error and no failing
 * build, and surfaces only when somebody reads a payslip and finds the income
 * tax sitting in the loans column. Asking for the column by the name it carries
 * in `payrollSheetHeaders` makes the writer and the header row incapable of
 * disagreeing, so the next insert is a one-line change.
 */
function col(header: PayrollTemplateHeader): number {
  const columnNumber = columnNumberByHeader.get(header);
  if (!columnNumber) throw new Error(`Unknown payroll template column: ${header}`);
  return columnNumber;
}

const moneyColumnNumbers = new Set<number>(
  payrollSheetHeaders.filter((header) => payrollMoneyHeaders.has(header)).map(col),
);
/** Plain counts — right-aligned like money, but whole numbers and never summed. */
const countColumnNumbers = new Set<number>(
  payrollSheetHeaders.filter((header) => payrollCountHeaders.has(header)).map(col),
);
const readyPayrollEditableColumnNumbers = new Set<number>(
  (
    [
      "Expenses",
      "Incentive",
      "Overtime",
      "Bonus",
      "Other Additions",
      "CRM",
      "Finger Print",
      "Unpaid Vacations",
      "Medical Insurance",
      "Loans",
      "Other Deductions",
    ] as const
  ).map(col),
);

/**
 * Colour bands over the sheet. Named rather than numbered for the reason given
 * on `col` — and "Working Days" joins Employee Data, matching the band it was
 * given in `payrollSheetSections`, so the two renderings of the same sheet
 * agree about where it belongs.
 */
const uploadTemplateSections = [
  { end: col("Working Days"), label: "Employee Data", start: 1 },
  { end: col("Net Salary"), label: "Fixed Salary", start: col("Base Salary") },
  { end: col("Other Additions"), label: "Additions", start: col("Expenses") },
  { end: col("Total Additions"), label: "Total Additions", start: col("Total Additions") },
  { end: col("Governmental Deductions"), label: "Governmental Deductions", start: col("Social Insurance") },
  { end: col("Other Deductions"), label: "Internal Deductions", start: col("CRM") },
  { end: col("Total Deductions"), label: "Total Deductions", start: col("Total Deductions") },
  { end: col("Policy Comment"), label: "Payment Split", start: col("Month Salary") },
  { end: col("Bank Account"), label: "Bank Details", start: col("Bank") },
] as const;

type PayrollTemplateRow = {
  arabicName: string | null;
  area: string | null;
  bankAccount: string | null;
  bankName: string | null;
  bonus: number;
  comment: string;
  crm: number;
  employeeCode: string;
  employmentIncomeTax: number;
  expenses: number;
  extraCostOfLiving: number;
  fingerPrint: number;
  firstPart: number;
  fuelAllowance: number;
  fullName: string;
  governmentalDeductions: number;
  grossSalary: number;
  /** Last paid day charged for, after Rule 1's >25th waiver (resignations only). */
  effectiveEndDay: number;
  /**
   * Days of the month the employee was actually on payroll — the "Working Days"
   * column. The date-derived span, never the span the money used: a resignation
   * after the 25th reads its real 28 days while being paid a full month.
   */
  workingDays: number;
  hireDate: string | null;
  incentive: number;
  jobTitle: string | null;
  lastWorkingDate: string | null;
  line: string | null;
  loans: number;
  medicalInsurance: number;
  monthSalary: number;
  baseSalary: number;
  month: number;
  netSalary: number;
  otherAdditions: number;
  otherDeductions: number;
  overtime: number;
  paymentMode: string;
  secondPart: number;
  socialInsurance: number;
  totalAdditions: number;
  totalDeductions: number;
  unpaidVacations: number;
  year: number;
};

type PayrollTemplateEmployee = {
  employee: EmployeeDirectoryRow;
  /** True only for a genuine resignation — drives Rule 1's >25th full-pay waiver. */
  isResignation: boolean;
  isTerminalPayroll: boolean;
  lastWorkingDate: string | null;
};

const terminalPayrollStatuses = new Set(["resigned", "terminated", "inactive"]);
// Of the terminal statuses, only a resignation earns Rule 1's >25th generosity.
// terminated (dismissed) and inactive (deactivated) are prorated with no allowances.
const resignationPayrollStatus = "resigned";

type CellStyleSnapshot = {
  alignment: Partial<ExcelJS.Alignment>;
  border: Partial<ExcelJS.Borders>;
  fill: ExcelJS.Fill;
  font: Partial<ExcelJS.Font>;
  numFmt: string;
  protection: Partial<ExcelJS.Protection>;
  style: Partial<ExcelJS.Style>;
};

type RowStyleSnapshot = {
  cells: CellStyleSnapshot[];
  height: number | undefined;
};

function numberParam(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function money(value: number | null | undefined) {
  return Math.round((Number(value ?? 0) + Number.EPSILON) * 100) / 100;
}

/**
 * The two-part split for this sheet.
 *
 * Deliberately NOT a call to calculatePayrollParts: this cap carries a second limb
 * (`base - otherDeductions`) that the canonical function does not have, so delegating
 * outright would move money. What it must not do is re-derive the RATE — `basicSalary`
 * is passed in already computed by calculatePayrollParts from the locked
 * BASIC_SALARY_RATE, instead of this file multiplying by its own 0.7. That local copy
 * was a second source of truth for a rate the owner keeps under lock, and it also
 * compared against an unrounded product where the workbook rounds to 2dp.
 */
function resolvePayrollSplit(input: {
  baseSalary: number;
  basicSalary: number;
  monthSalary: number;
  otherDeductions: number;
  paymentMode: "one_part" | "two_parts";
  secondPartAdditions: number;
}) {
  const payable = money(Math.max(0, input.monthSalary));
  const forcedSecondPart = money(
    Math.min(payable, Math.max(0, input.secondPartAdditions)),
  );
  const firstPartPayable = money(Math.max(0, payable - forcedSecondPart));

  if (input.paymentMode === "one_part") {
    return { firstPart: firstPartPayable, secondPart: forcedSecondPart };
  }

  const firstPartCap = money(
    Math.min(
      input.basicSalary,
      Math.max(0, input.baseSalary - input.otherDeductions),
    ),
  );
  const firstPart = money(Math.min(firstPartPayable, firstPartCap));

  return {
    firstPart,
    secondPart: money(Math.max(0, payable - firstPart)),
  };
}

function normalizePayrollHrId(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text.toUpperCase() : null;
}

function normalizePayrollStatus(value: string | null | undefined) {
  return String(value ?? "active").trim().toLowerCase();
}

function terminalPayrollDate(employee: EmployeeDirectoryRow) {
  return employee.lastWorkingDate ?? employee.resignationDate ?? null;
}

function isTerminalPayrollEmployeeForPeriod(
  employee: EmployeeDirectoryRow,
  month: number,
  year: number,
) {
  return (
    terminalPayrollStatuses.has(normalizePayrollStatus(employee.employmentStatus)) &&
    payrollMonthMatches(terminalPayrollDate(employee), month, year)
  );
}

async function getPayrollTemplateEmployees(
  month: number,
  year: number,
): Promise<PayrollTemplateEmployee[]> {
  const [directory, allEmployees] = await Promise.all([
    getEmployeeDirectory(),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);
  const activeEmployees = directory.employees
    .filter((employee) => (employee.employmentStatus ?? "active") === "active" && employee.payrollEligible !== false)
    .map((employee) => ({
      employee,
      isResignation: false,
      isTerminalPayroll: false,
      lastWorkingDate: null,
    }));
  const activeHrIds = new Set(
    activeEmployees
      .map(({ employee }) => normalizePayrollHrId(employee.hrId))
      .filter(Boolean),
  );
  const terminalEmployees = allEmployees
    .filter((employee) => {
      const hrId = normalizePayrollHrId(employee.hrId);
      return (
        Boolean(hrId) &&
        !activeHrIds.has(hrId) &&
        isTerminalPayrollEmployeeForPeriod(employee, month, year)
      );
    })
    .map((employee) => ({
      employee,
      isResignation: normalizePayrollStatus(employee.employmentStatus) === resignationPayrollStatus,
      isTerminalPayroll: true,
      lastWorkingDate: terminalPayrollDate(employee),
    }));

  return [...activeEmployees, ...terminalEmployees];
}

function payrollExcelDateOnly(value: string | null) {
  const date = parseDateOnly(value);
  if (!date) return "";

  return new Date(Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    12,
  ));
}

function otherDeductionsFormula(
  row: PayrollTemplateRow,
  rowNumber: number,
  month: number,
  year: number,
) {
  const baseSalary = cellRef(rowNumber, col("Base Salary"));
  const hireDate = cellRef(rowNumber, col("Hire Date"));
  // Net = Base + Extra Cost of Living + Fuel, read from the row's own cells
  // (Base Salary, Extra Cost of Living, Fuel Allowance) rather than the Net
  // Salary column, so the formula
  // states the three components it actually prorates. BOTH branches divide this
  // since 2026-08-29 — the owner gave the same instruction for joiners in the
  // morning and for resignations later the same day.
  //
  // Reading the cells rather than hardcoding a divisor is also what keeps the
  // NON-resignation leaver correct without a third branch: that row's ECOL and
  // Fuel are withheld, so its cells are 0 and this expression collapses to the
  // base — exactly calculateBaseLifecycleProrationDeduction. And because the
  // cells are live, an HR edit to an allowance re-prorates coherently instead of
  // leaving the deduction stating a shortfall on a figure no longer in the row.
  const netSalary = `(${baseSalary}+${cellRef(rowNumber, col("Extra Cost of Living"))}+${cellRef(rowNumber, col("Fuel Allowance"))})`;
  // Must match payrollDaysInMonth exactly: the workbook recalculates these
  // formulas client-side, so a server-only fix would leave the downloaded sheet
  // disagreeing with the figure Ready Payroll stored.
  const daysInMonth = payrollDaysInMonth(month, year);

  if (payrollMonthMatches(row.lastWorkingDate, month, year)) {
    // Resignation Rule 1: a RESIGNATION after the 25th is paid in full, so its end day is
    // waived to month end; a termination/deactivation is charged to its actual last day.
    // row.effectiveEndDay is the number the stored proration already used (resolved with the
    // resignation flag) — the sheet recalculates client-side, so reusing that same number
    // keeps the formula and the stored value from ever disagreeing. Mirrors the leaver
    // branch of resolveReadyLifecycleSettlement, which divides the same net.
    const endDay = row.effectiveEndDay;
    return `ROUND(MAX(0,${netSalary}-((${netSalary}/${daysInMonth})*MAX(0,${endDay}-IF(AND(ISNUMBER(${hireDate}),YEAR(${hireDate})=${year},MONTH(${hireDate})=${month}),DAY(${hireDate}),1)+1))),2)`;
  }

  // Joiner branch — prorates NET, so the deducted shortfall covers the base and
  // both allowances together and Month Salary lands on Net x days worked / days
  // in month. The allowance columns keep their full contractual figures.
  return `IF(AND(ISNUMBER(${hireDate}),YEAR(${hireDate})=${year},MONTH(${hireDate})=${month}),ROUND(MAX(0,${netSalary}-((${netSalary}/${daysInMonth})*MAX(0,${daysInMonth}-DAY(${hireDate})+1))),2),0)`;
}

function monthName(month: number) {
  return new Intl.DateTimeFormat("en", { month: "long" }).format(
    new Date(Date.UTC(2026, month - 1, 1)),
  );
}

function cloneStyle<T>(value: T): T {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function captureRowStyle(sheet: ExcelJS.Worksheet, rowNumber: number): RowStyleSnapshot {
  const row = sheet.getRow(rowNumber);

  return {
    cells: Array.from({ length: headers.length }, (_, index) => {
      const cell = row.getCell(index + 1);

      return {
        alignment: cloneStyle(cell.alignment),
        border: cloneStyle(cell.border),
        fill: cloneStyle(cell.fill),
        font: cloneStyle(cell.font),
        numFmt: cell.numFmt,
        protection: cloneStyle(cell.protection),
        style: cloneStyle(cell.style),
      };
    }),
    height: row.height,
  };
}

function captureBodyStyles(sheet: ExcelJS.Worksheet) {
  return Array.from(
    { length: templateDataEndRow - dataStartRow + 1 },
    (_, index) => captureRowStyle(sheet, dataStartRow + index),
  );
}

function applyRowStyle(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  style: RowStyleSnapshot,
) {
  const row = sheet.getRow(rowNumber);

  if (style.height !== undefined) {
    row.height = style.height;
  }
  style.cells.forEach((cellStyle, index) => {
    const cell = row.getCell(index + 1);

    cell.style = cloneStyle(cellStyle.style);
    cell.numFmt = cellStyle.numFmt;
    cell.alignment = cloneStyle(cellStyle.alignment);
    cell.border = cloneStyle(cellStyle.border);
    cell.fill = cloneStyle(cellStyle.fill);
    cell.font = cloneStyle(cellStyle.font);
    cell.protection = cloneStyle(cellStyle.protection);
  });
}

function writeHeaderRow(sheet: ExcelJS.Worksheet, rowNumber: number) {
  const row = sheet.getRow(rowNumber);
  row.values = headers;
  row.commit();
}

function writeReadyPayrollBlockHeaderRow(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  label: string,
) {
  sheet.mergeCells(rowNumber, 1, rowNumber, headers.length);
  const row = sheet.getRow(rowNumber);
  const cell = row.getCell(1);
  cell.value = label;
  // A block divider: deep type over a Brand Blue rule, the same shape every heading in the house
  // format takes. It was a full-width navy bar.
  cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 11 };
  cell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  cell.border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" } };
  row.height = 24;
  row.commit();
}

function uploadSectionForColumn(columnNumber: number) {
  return uploadTemplateSections.find((section) => columnNumber >= section.start && columnNumber <= section.end) ?? uploadTemplateSections[0];
}

/**
 * The grid, in the house format: a hairline between cells and a Brand Blue rule where one section
 * ends and the next begins. The boundary rule is what separates the sections now that they no
 * longer each have a colour of their own — nine hues, none of them in the company mark.
 */
function borderForColumn(columnNumber: number, color = HOUSE_XLSX_COLORS.hair): Partial<ExcelJS.Borders> {
  const section = uploadSectionForColumn(columnNumber);
  const isSectionEnd = columnNumber === section.end;

  return {
    bottom: { color: { argb: color }, style: "hair" },
    right: isSectionEnd
      ? { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "thin" }
      : { color: { argb: color }, style: "hair" },
  };
}

function writeUploadSectionHeader(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  section: (typeof uploadTemplateSections)[number],
) {
  const row = sheet.getRow(rowNumber);
  const leadCell = row.getCell(section.start);

  if (section.start < section.end && !leadCell.isMerged) {
    sheet.mergeCells(rowNumber, section.start, rowNumber, section.end);
  }

  leadCell.value = section.label.toUpperCase();
  leadCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.light }, name: "Aptos", size: 7.5 };
  leadCell.alignment = { horizontal: "left", indent: 1, vertical: "bottom" };

  for (let column = section.start; column <= section.end; column += 1) {
    const cell = row.getCell(column);
    cell.border =
      column === section.start
        ? { left: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "thin" } }
        : {};
  }
}

function writeUploadSectionRow(sheet: ExcelJS.Worksheet, rowNumber: number) {
  for (const section of uploadTemplateSections) {
    writeUploadSectionHeader(sheet, rowNumber, section);
  }

  sheet.getRow(rowNumber).height = 24;
  sheet.getRow(rowNumber).commit();
}

function writeBankDetailsSectionRow(sheet: ExcelJS.Worksheet, rowNumber: number) {
  writeUploadSectionHeader(
    sheet,
    rowNumber,
    uploadTemplateSections[uploadTemplateSections.length - 1],
  );
  sheet.getRow(rowNumber).height = 24;
  sheet.getRow(rowNumber).commit();
}

function stylePayrollHeaderRow(row: ExcelJS.Row) {
  row.height = 32;
  row.eachCell((cell) => {
    const column = Number(cell.col);
    payrollHeaderCell(cell, { numeric: moneyColumnNumbers.has(column) || countColumnNumbers.has(column) });
  });
}

function stylePayrollDataCell(cell: ExcelJS.Cell) {
  const column = Number(cell.col);
  const isTotalColumn =
    column === col("Total Additions") ||
    column === col("Governmental Deductions") ||
    column === col("Total Deductions");

  if (moneyColumnNumbers.has(column)) {
    cell.numFmt = "#,##0.00";
  } else if (countColumnNumbers.has(column)) {
    // A day count, not money: whole numbers, no currency decimals.
    cell.numFmt = "0";
  }

  cell.alignment = {
    horizontal: moneyColumnNumbers.has(column) || countColumnNumbers.has(column) ? "right" : "left",
    vertical: "middle",
    wrapText: true,
  };
  cell.border = borderForColumn(column);
  // Nine section body fills become one zebra. The sections are still legible — their captions and
  // the Brand Blue rule at each boundary do that work — and a data-entry sheet where every column
  // is tinted has no way left to highlight anything that matters.
  if (Number(cell.row) % 2 === 0) {
    cell.fill = {
      fgColor: { argb: HOUSE_XLSX_COLORS.tint },
      pattern: "solid",
      type: "pattern",
    };
  }
  cell.font = {
    bold: isTotalColumn,
    color: { argb: isTotalColumn ? HOUSE_XLSX_COLORS.deep : HOUSE_XLSX_COLORS.body },
    name: "Aptos",
    size: 9.5,
  };
}

function styleBankDetailsCells(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  endRow: number,
) {
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);

    for (let column = bankDetailsSectionStart; column <= headers.length; column += 1) {
      stylePayrollDataCell(row.getCell(column));
    }
  }
}

function applyPayrollTemplateColumnWidths(sheet: ExcelJS.Worksheet) {
  headers.forEach((header, index) => {
    const column = sheet.getColumn(index + 1);
    const defaultWidth = Math.max(header.length + 4, 14);

    if (!column.width || index + 1 >= bankDetailsSectionStart) {
      column.width = defaultWidth;
    }
  });
}

function stylePayrollTotalsRow(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    const column = Number(cell.col);
    payrollTotalsCell(cell, { numeric: column !== 1 });
    if (moneyColumnNumbers.has(column)) {
      cell.numFmt = "#,##0.00";
    }
  });
  row.height = 28;
}

async function buildUploadRows(month: number, year: number): Promise<PayrollTemplateRow[]> {
  const payrollEmployees = await getPayrollTemplateEmployees(month, year);

  return payrollEmployees
    .map((payrollEmployee) => {
      const { employee } = payrollEmployee;
      const standardAllowances = resolveStandardSalaryAllowances({
        departmentName: employee.departmentName,
        employeeHrId: employee.hrId,
        jobTitle: employee.jobTitle,
        lineName: employee.lineName,
        month,
        positionTitle: employee.positionTitle,
        year,
      });
      const standardExtraCostOfLiving = money(standardAllowances.extraCostOfLiving);
      const standardFuelAllowance = money(standardAllowances.fuelAllowance);
      const socialInsurance = money(employee.socialInsurance);
      const employmentIncomeTax = money(employee.taxes);
      // The CONTRACT structure, always resolved from the STANDARD allowances. calculateBaseSalary
      // falls back to `net - ECOL - fuel` when neither base nor basic is stored, so feeding it the
      // lifecycle-reduced allowances would let this month's resignation rule silently redefine the
      // employee's base salary — and then prorate against that redefined number.
      const fixedSalary = resolveFixedSalaryAmounts({
        baseSalary: employee.baseSalary,
        basicSalary: employee.basicSalary,
        employmentIncomeTax,
        extraCostOfLiving: standardExtraCostOfLiving,
        fuelAllowance: standardFuelAllowance,
        grossSalary: employee.grossSalary,
        netSalary: employee.netSalary,
        socialInsurance,
      });
      const baseSalary = money(fixedSalary.baseSalary);
      const grossSalary = money(fixedSalary.grossSalary);
      const governmentalDeductions = money(socialInsurance + employmentIncomeTax);
      // Resignation Rule 1 decides Base, ECOL and Fuel together — a RESIGNATION after the 25th
      // keeps both allowances in full and is not prorated; on or before the 25th prorates all
      // three together on the net (owner, 2026-08-29); a termination/deactivation keeps neither
      // allowance and has its base prorated to the last working day.
      // Zeroing on isTerminalPayroll alone contradicted the rule for every late-month leaver.
      const settlement = resolveReadyLifecycleSettlement({
        baseSalary,
        extraCostOfLiving: standardExtraCostOfLiving,
        fuelAllowance: standardFuelAllowance,
        hireDate: employee.hireDate,
        isResignation: payrollEmployee.isResignation,
        lastWorkingDate: payrollEmployee.lastWorkingDate,
        month,
        year,
      });
      const extraCostOfLiving = settlement.extraCostOfLiving;
      const fuelAllowance = settlement.fuelAllowance;
      const otherDeductions = settlement.prorationDeduction;
      // Net Salary = base + the row's OWN allowance cells, matching the col-13 formula
      // base+ECOL+Fuel exactly. Those cells hold the contractual figures on every row except a
      // non-resignation leaver, whose allowances are withheld outright and read 0 — so this
      // states a full month's net wherever a full month's net is what the row means, and a
      // prorated row shows its shortfall in Other Deductions rather than in this column.
      // fixedSalary.netSalary is not used: it would carry the standard allowances onto that
      // withheld row too, and the row's own ECOL/Fuel=0 cells would then contradict it.
      const netSalary = money(baseSalary + extraCostOfLiving + fuelAllowance);
      const parts = calculatePayrollParts({
        baseSalary,
        deductions: otherDeductions,
        extraCostOfLiving,
        fuelAllowance,
        paymentMode: employee.salaryPaymentMode,
      });
      const paymentMode = payrollPaymentModeLabel(parts.paymentMode);
      const monthSalary = parts.totalPayable;
      const { firstPart, secondPart } = resolvePayrollSplit({
        baseSalary,
        basicSalary: parts.basicSalary,
        monthSalary,
        otherDeductions,
        paymentMode: parts.paymentMode,
        secondPartAdditions: 0,
      });

      return {
        arabicName: employee.nameAr,
        area: employee.areaName,
        bankAccount: employee.bankAccount,
        bankName: employee.bankName,
        baseSalary,
        bonus: 0,
        comment:
          readyLifecycleComment(settlement) ??
          "Fixed starter row. Add monthly expenses, additions, and deductions before upload.",
        crm: 0,
        effectiveEndDay: settlement.effectiveEndDay,
        workingDays: settlement.workingDays,
        employeeCode: employee.hrId,
        employmentIncomeTax,
        expenses: 0,
        extraCostOfLiving,
        fingerPrint: 0,
        firstPart,
        fuelAllowance,
        fullName: employee.fullName,
        governmentalDeductions,
        grossSalary,
        hireDate: employee.hireDate,
        incentive: 0,
        jobTitle: employee.positionTitle ?? employee.jobTitle,
        lastWorkingDate: payrollEmployee.lastWorkingDate,
        line: employee.lineName,
        loans: 0,
        medicalInsurance: 0,
        monthSalary,
        month,
        netSalary,
        otherAdditions: 0,
        otherDeductions,
        overtime: 0,
        paymentMode,
        secondPart,
        socialInsurance,
        totalAdditions: money(extraCostOfLiving + fuelAllowance),
        totalDeductions: otherDeductions,
        unpaidVacations: 0,
        year,
      };
    });
}

/**
 * Exported for `tests/payroll-upload-template.test.ts`, which round-trips the generated sheet back
 * through the real importer. The masthead and the section captions sit ABOVE the header row, and
 * the importer picks its header row by scoring rows 1-12 — so this is the one thing about the
 * restyle that could silently swallow an upload, and it is tested rather than reasoned about.
 */
export async function createFallbackWorkbook(
  rows: PayrollTemplateRow[] = [],
  month = new Date().getMonth() + 1,
  year = new Date().getFullYear(),
  options: { formulas?: boolean } = {},
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Payroll Upload");

  // Rows 1-3 are the house masthead, which is exactly the space the old navy title bar and its
  // orange subtitle occupied — so the section band stays on row 4, the header on row 5, and the
  // importer's header scan sees precisely what it saw before. Row 3 is the masthead's 3-point brand
  // RULE; the old layout set it to height 22, which here would render a blue slab, not a hairline.
  applyPayrollUploadMasthead(workbook, sheet, month, year);
  writeUploadSectionRow(sheet, dataStartRow - 2);
  writeHeaderRow(sheet, dataStartRow - 1);
  stylePayrollHeaderRow(sheet.getRow(dataStartRow - 1));
  sheet.views = [{ state: "frozen", ySplit: dataStartRow - 1 }];
  sheet.columns = headers.map((header) => ({
    key: header,
    width: Math.max(header.length + 4, 14),
  }));
  const blockHeaderRows = new Set<number>();
  let previousBlockRank: number | null = null;
  let rowNumber = dataStartRow;
  rows.forEach((row, index) => {
    const blockRank = readyPayrollBlockRank(row);
    if (options.formulas && blockRank !== previousBlockRank) {
      blockHeaderRows.add(rowNumber);
      writeReadyPayrollBlockHeaderRow(
        sheet,
        rowNumber,
        readyPayrollBlockLabel(blockRank, month, year),
      );
      rowNumber += 1;
      previousBlockRank = blockRank;
    }

    const sheetRow = sheet.getRow(rowNumber);
    sheetRow.values = rowValues(row, index + 1, rowNumber, options);
    sheetRow.height = 24;
    for (let column = 1; column <= headers.length; column += 1) {
      stylePayrollDataCell(sheetRow.getCell(column));
    }
    sheetRow.commit();
    rowNumber += 1;
  });
  const lastDataRow = rows.length > 0 ? rowNumber - 1 : dataStartRow;
  const totalsRow = rows.length > 0 ? rowNumber : null;
  if (rows.length > 0) {
    writeTotals(sheet, rowNumber, rows, captureRowStyle(sheet, dataStartRow - 1));
  }
  sheet.autoFilter = {
    from: { column: 1, row: dataStartRow - 1 },
    to: { column: headers.length, row: Math.max(dataStartRow, lastDataRow) },
  };
  if (options.formulas) {
    await protectReadyPayrollSheet(sheet, {
      blockHeaderRows,
      lastDataRow,
      totalsRow,
    });
  }
  upsertWorkingDaysCalcSheet(workbook, month, year);
  upsertSalaryPolicySheet(workbook);

  return workbook;
}

/**
 * Puts the house masthead on a Payroll Upload sheet, whether it was just built or loaded from the
 * stored `Phoneix system template.xlsx`.
 *
 * TWO OF THE THREE DOWNLOAD PATHS START FROM THAT STORED FILE — the plain template and the "ready"
 * one both load it and restyle in place, and only `?upload=1` builds a sheet from scratch. Styling
 * only the built one would have shipped the old navy title bar sitting on top of a house-styled
 * body: a masthead in one identity, a table in another, on the same sheet.
 *
 * The loaded workbook already has rows 1-3 merged its own way, and ExcelJS throws rather than
 * re-merging, so the old merges come out first. `unMergeCells` throws when there is nothing merged,
 * which is the normal case for a freshly built sheet — hence the guard rather than a check.
 */
function applyPayrollUploadMasthead(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  month: number,
  year: number,
) {
  for (const range of [
    [1, 1, 1, headers.length],
    [2, 1, 3, headers.length],
    [1, 3, 1, Math.max(3, headers.length - 3)],
  ] as Array<[number, number, number, number]>) {
    try {
      sheet.unMergeCells(range[0], range[1], range[2], range[3]);
    } catch {
      // Nothing merged there — the ordinary case on a sheet built from scratch.
    }
  }

  for (let rowNumber = 1; rowNumber <= 3; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    for (let column = 1; column <= headers.length; column += 1) {
      const cell = row.getCell(column);
      cell.value = null;
      cell.fill = { type: "pattern", pattern: "none" };
      cell.border = {};
    }
  }

  writeHouseMasthead(workbook, sheet, {
    columns: headers.length,
    provenance: [`${monthName(month)} ${year}`],
    subtitle:
      `Payroll period: ${monthName(month)} ${year}. Fixed fields are pre-populated from employee ` +
      "master data. Add monthly expenses, additions, and deductions before upload.",
    title: "Payroll Upload Template",
  });
  writeTitle(sheet, month, year);
}

async function loadPayrollTemplateWorkbook() {
  const templatePath = payrollTemplatePath();

  if (!existsSync(templatePath)) {
    return createFallbackWorkbook();
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

  return workbook;
}

function payrollTemplatePath() {
  return path.join(process.cwd(), templateFileName);
}

async function exactTemplateResponse() {
  const now = new Date();
  const workbook = await loadPayrollTemplateWorkbook();
  const sheet = workbook.worksheets[0] ?? workbook.addWorksheet("Payroll Upload");

  applyPayrollUploadMasthead(workbook, sheet, now.getMonth() + 1, now.getFullYear());
  writeBankDetailsSectionRow(sheet, dataStartRow - 2);
  writeHeaderRow(sheet, dataStartRow - 1);
  stylePayrollHeaderRow(sheet.getRow(dataStartRow - 1));
  applyPayrollTemplateColumnWidths(sheet);
  styleBankDetailsCells(sheet, dataStartRow, Math.max(sheet.rowCount, templateDataEndRow));
  sheet.autoFilter = {
    from: { column: 1, row: dataStartRow - 1 },
    to: { column: headers.length, row: Math.max(dataStartRow, sheet.rowCount) },
  };
  upsertWorkingDaysCalcSheet(workbook, now.getMonth() + 1, now.getFullYear());
  upsertSalaryPolicySheet(workbook);
  const buffer = await workbook.xlsx.writeBuffer();

  return new Response(buffer, {
    headers: {
      ...DOWNLOAD_NO_STORE_HEADERS,
      "Content-Disposition": 'attachment; filename="phoenix-payroll-template.xlsx"',
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
}

function copyRowStyle(sheet: ExcelJS.Worksheet, sourceRowNumber: number, targetRowNumber: number) {
  applyRowStyle(sheet, targetRowNumber, captureRowStyle(sheet, sourceRowNumber));
}

function clearRowValues(sheet: ExcelJS.Worksheet, rowNumber: number) {
  const row = sheet.getRow(rowNumber);

  for (let column = 1; column <= headers.length; column += 1) {
    row.getCell(column).value = null;
  }
}

function prepareTemplateRows(
  sheet: ExcelJS.Worksheet,
  requiredRows: number,
) {
  const rowCount = Math.max(requiredRows, 1);
  const templateCapacity = templateDataEndRow - dataStartRow + 1;

  if (rowCount > templateCapacity) {
    const extraRows = rowCount - templateCapacity;
    sheet.spliceRows(
      templateDataEndRow + 1,
      0,
      ...Array.from({ length: extraRows }, () => []),
    );

    for (let row = templateDataEndRow + 1; row <= templateDataEndRow + extraRows; row += 1) {
      copyRowStyle(sheet, templateDataEndRow, row);
    }
  } else if (rowCount < templateCapacity) {
    sheet.spliceRows(
      dataStartRow + rowCount,
      templateCapacity - rowCount,
    );
  }

  for (let row = dataStartRow; row < dataStartRow + rowCount; row += 1) {
    clearRowValues(sheet, row);
  }

  return dataStartRow + rowCount;
}

/**
 * The period line under the mark.
 *
 * A2 is the house masthead's subtitle row, so this writes the same cell the masthead does and must
 * agree with it rather than compete: whichever runs last wins, and two different sentences in one
 * cell is how a sheet ends up captioned for the wrong month.
 */
function writeTitle(sheet: ExcelJS.Worksheet, month: number, year: number) {
  sheet.getCell("A2").value =
    `Payroll period: ${monthName(month)} ${year}. Fixed fields are pre-populated from employee ` +
    "master data. Add monthly expenses, additions, and deductions before upload.";
}

function rowValues(
  row: PayrollTemplateRow,
  index: number,
  rowNumber = dataStartRow + index - 1,
  options: { formulas?: boolean } = {},
) {
  if (options.formulas) {
    const baseSalary = cellRef(rowNumber, col("Base Salary"));
    const netSalary = cellRef(rowNumber, col("Net Salary"));
    const expenses = cellRef(rowNumber, col("Expenses"));
    const incentive = cellRef(rowNumber, col("Incentive"));
    const overtime = cellRef(rowNumber, col("Overtime"));
    const bonus = cellRef(rowNumber, col("Bonus"));
    const extraCostOfLiving = cellRef(rowNumber, col("Extra Cost of Living"));
    const fuelAllowance = cellRef(rowNumber, col("Fuel Allowance"));
    const otherAdditions = cellRef(rowNumber, col("Other Additions"));
    const socialInsurance = cellRef(rowNumber, col("Social Insurance"));
    const employmentIncomeTax = cellRef(rowNumber, col("Employment Income Tax"));
    const crm = cellRef(rowNumber, col("CRM"));
    const fingerPrint = cellRef(rowNumber, col("Finger Print"));
    const unpaidVacations = cellRef(rowNumber, col("Unpaid Vacations"));
    const medicalInsurance = cellRef(rowNumber, col("Medical Insurance"));
    const loans = cellRef(rowNumber, col("Loans"));
    const otherDeductions = cellRef(rowNumber, col("Other Deductions"));
    const totalDeductions = cellRef(rowNumber, col("Total Deductions"));
    const monthSalary = cellRef(rowNumber, col("Month Salary"));
    const firstPart = cellRef(rowNumber, col("First Part"));
    const paymentMode = cellRef(rowNumber, col("Payment Group"));

    return [
      index,
      row.month,
      row.year,
      row.employeeCode,
      row.fullName,
      row.arabicName ?? "",
      row.jobTitle ?? "",
      row.line ?? "",
      row.area ?? "",
      payrollExcelDateOnly(row.hireDate),
      row.workingDays,
      row.baseSalary,
      formulaValue(`ROUND(${baseSalary}+${socialInsurance}+${employmentIncomeTax},2)`, row.grossSalary),
      formulaValue(`ROUND(${baseSalary}+${extraCostOfLiving}+${fuelAllowance},2)`, row.netSalary),
      row.expenses,
      row.incentive,
      row.overtime,
      row.bonus,
      row.extraCostOfLiving,
      row.fuelAllowance,
      row.otherAdditions,
      formulaValue(
        `ROUND(${expenses}+${incentive}+${overtime}+${bonus}+${extraCostOfLiving}+${fuelAllowance}+${otherAdditions},2)`,
        row.totalAdditions,
      ),
      row.socialInsurance,
      row.employmentIncomeTax,
      formulaValue(`ROUND(${socialInsurance}+${employmentIncomeTax},2)`, row.governmentalDeductions),
      row.crm,
      row.fingerPrint,
      row.unpaidVacations,
      row.medicalInsurance,
      row.loans,
      formulaValue(
        otherDeductionsFormula(row, rowNumber, row.month, row.year),
        row.otherDeductions,
      ),
      formulaValue(
        `ROUND(${crm}+${fingerPrint}+${unpaidVacations}+${medicalInsurance}+${loans}+${otherDeductions},2)`,
        row.totalDeductions,
      ),
      formulaValue(
        `ROUND(${netSalary}+${expenses}+${incentive}+${overtime}+${bonus}+${otherAdditions}-${totalDeductions},2)`,
        row.monthSalary,
      ),
      formulaValue(
        `IF(${paymentMode}="One Part",MAX(0,${monthSalary}-MIN(MAX(0,${monthSalary}),MAX(0,${expenses}+${incentive}))),MIN(MAX(0,${monthSalary}-MIN(MAX(0,${monthSalary}),MAX(0,${expenses}+${incentive}))),ROUND(${baseSalary}*${BASIC_SALARY_RATE},2),MAX(0,${baseSalary}-${otherDeductions})))`,
        row.firstPart,
      ),
      formulaValue(`IF(${paymentMode}="One Part",MIN(MAX(0,${monthSalary}),MAX(0,${expenses}+${incentive})),MAX(0,ROUND(${monthSalary}-${firstPart},2)))`, row.secondPart),
      row.paymentMode,
      row.comment,
      row.bankName ?? "",
      row.bankAccount ?? "",
    ];
  }

  return [
    index,
    row.month,
    row.year,
    row.employeeCode,
    row.fullName,
    row.arabicName ?? "",
    row.jobTitle ?? "",
    row.line ?? "",
    row.area ?? "",
    payrollExcelDateOnly(row.hireDate),
    row.workingDays,
    row.baseSalary,
    row.grossSalary,
    row.netSalary,
    row.expenses,
    row.incentive,
    row.overtime,
    row.bonus,
    row.extraCostOfLiving,
    row.fuelAllowance,
    row.otherAdditions,
    row.totalAdditions,
    row.socialInsurance,
    row.employmentIncomeTax,
    row.governmentalDeductions,
    row.crm,
    row.fingerPrint,
    row.unpaidVacations,
    row.medicalInsurance,
    row.loans,
    row.otherDeductions,
    row.totalDeductions,
    row.monthSalary,
    row.firstPart,
    row.secondPart,
    row.paymentMode,
    row.comment,
    row.bankName ?? "",
    row.bankAccount ?? "",
  ];
}

function writePayrollRows(
  sheet: ExcelJS.Worksheet,
  rows: PayrollTemplateRow[],
  bodyStyles: RowStyleSnapshot[],
) {
  rows.forEach((row, index) => {
    const rowNumber = dataStartRow + index;
    const sheetRow = sheet.getRow(rowNumber);

    sheetRow.values = rowValues(row, index + 1);
    applyRowStyle(sheet, rowNumber, bodyStyles[index % bodyStyles.length]);
    for (let column = bankDetailsSectionStart; column <= headers.length; column += 1) {
      stylePayrollDataCell(sheetRow.getCell(column));
    }
    sheetRow.commit();
  });
}

function writeTotals(
  sheet: ExcelJS.Worksheet,
  totalsRow: number,
  rows: PayrollTemplateRow[],
  totalsStyle: RowStyleSnapshot,
) {
  const row = sheet.getRow(totalsRow);
  const total = (selector: (item: PayrollTemplateRow) => number) =>
    money(rows.reduce((sum, item) => sum + selector(item), 0));
  const totalFormula = (columnNumber: number, result: number) =>
    rows.length > 0
      ? formulaValue(
          `SUM(${cellRef(dataStartRow, columnNumber)}:${cellRef(totalsRow - 1, columnNumber)})`,
          result,
        )
      : result;

  row.getCell(1).value = totalsLabel;

  // Money only, keyed by NAME. "Working Days" is deliberately absent from this
  // table and blanked below: a company-wide sum of day counts is meaningless,
  // and a number sitting under that heading would read as one.
  const totalsByHeader: Array<[PayrollTemplateHeader, (item: PayrollTemplateRow) => number]> = [
    ["Base Salary", (item) => item.baseSalary],
    ["Gross Salary", (item) => item.grossSalary],
    ["Net Salary", (item) => item.netSalary],
    ["Expenses", (item) => item.expenses],
    ["Incentive", (item) => item.incentive],
    ["Overtime", (item) => item.overtime],
    ["Bonus", (item) => item.bonus],
    ["Extra Cost of Living", (item) => item.extraCostOfLiving],
    ["Fuel Allowance", (item) => item.fuelAllowance],
    ["Other Additions", (item) => item.otherAdditions],
    ["Total Additions", (item) => item.totalAdditions],
    ["Social Insurance", (item) => item.socialInsurance],
    ["Employment Income Tax", (item) => item.employmentIncomeTax],
    ["Governmental Deductions", (item) => item.governmentalDeductions],
    ["CRM", (item) => item.crm],
    ["Finger Print", (item) => item.fingerPrint],
    ["Unpaid Vacations", (item) => item.unpaidVacations],
    ["Medical Insurance", (item) => item.medicalInsurance],
    ["Loans", (item) => item.loans],
    ["Other Deductions", (item) => item.otherDeductions],
    ["Total Deductions", (item) => item.totalDeductions],
    ["Month Salary", (item) => item.monthSalary],
    ["First Part", (item) => item.firstPart],
    ["Second Part", (item) => item.secondPart],
  ];

  for (const [header, selector] of totalsByHeader) {
    const columnNumber = col(header);
    row.getCell(columnNumber).value = totalFormula(columnNumber, total(selector));
  }

  for (const header of [
    "Working Days",
    "Payment Group",
    "Policy Comment",
    "Bank",
    "Bank Account",
  ] as const) {
    row.getCell(col(header)).value = "";
  }
  applyRowStyle(sheet, totalsRow, totalsStyle);
  stylePayrollTotalsRow(row);
  row.commit();
}

/**
 * "Type here".
 *
 * The one place this template still spends a fill on meaning rather than on rhythm, and it earns
 * it: on a sheet of pre-populated figures, which cells a person is expected to change is the most
 * useful thing the styling can say. It is the house tint with a Brand Blue rule around it, instead
 * of an orange box in a palette that appears nowhere in the company mark.
 */
function styleInputCell(cell: ExcelJS.Cell) {
  cell.fill = {
    fgColor: { argb: HOUSE_XLSX_COLORS.tint },
    pattern: "solid",
    type: "pattern",
  };
  cell.border = {
    bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "thin" },
    left: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "thin" },
    right: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "thin" },
    top: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "thin" },
  };
}

function applyWorkingDaysLegendStyle(cell: ExcelJS.Cell, color: string) {
  cell.fill = {
    fgColor: { argb: color },
    pattern: "solid",
    type: "pattern",
  };
  cell.border = {
    bottom: { color: { argb: "FFE5E7EB" }, style: "thin" },
    left: { color: { argb: "FFE5E7EB" }, style: "thin" },
    right: { color: { argb: "FFE5E7EB" }, style: "thin" },
    top: { color: { argb: "FFE5E7EB" }, style: "thin" },
  };
}

function columnLetter(columnNumber: number) {
  let dividend = columnNumber;
  let letter = "";

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    letter = String.fromCharCode(65 + modulo) + letter;
    dividend = Math.floor((dividend - modulo) / 26);
  }

  return letter;
}

function cellRef(rowNumber: number, columnNumber: number) {
  return `${columnLetter(columnNumber)}${rowNumber}`;
}

function formulaValue(formula: string, result: number): ExcelJS.CellValue {
  return { formula, result: money(result) } as ExcelJS.CellValue;
}

function writeMatrix(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  startColumn: number,
  values: unknown[][],
) {
  values.forEach((rowValues, rowIndex) => {
    const row = sheet.getRow(startRow + rowIndex);
    rowValues.forEach((value, columnIndex) => {
      row.getCell(startColumn + columnIndex).value = value as ExcelJS.CellValue;
    });
  });
}

function forCells(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
  callback: (cell: ExcelJS.Cell) => void,
) {
  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startColumn; column <= endColumn; column += 1) {
      callback(sheet.getCell(row, column));
    }
  }
}

function upsertWorkingDaysCalcSheet(workbook: ExcelJS.Workbook, month: number, year: number) {
  const existing = workbook.getWorksheet("Working Days Calc");
  if (existing) {
    workbook.removeWorksheet(existing.id);
  }

  const sheet = workbook.addWorksheet("Working Days Calc");
  const exampleAllowances = resolveStandardSalaryAllowances({
    jobTitle: "Medical Representative",
    month,
    year,
  });
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 13 }];
  sheet.properties.defaultRowHeight = 22;
  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 14;
  sheet.getColumn(3).width = 14;
  sheet.getColumn(4).width = 14;
  sheet.getColumn(5).width = 16;
  for (let column = 6; column <= 36; column += 1) {
    sheet.getColumn(column).width = 5;
  }

  sheet.mergeCells("A1:J1");
  sheet.getCell("A1").value = "Working Days Calc";
  sheet.getCell("A1").font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos Display", size: 14 };
  sheet.getCell("A1").alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  sheet.getCell("A1").border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" } };
  sheet.getRow(1).height = 30;

  writeMatrix(sheet, 3, 1, [
    ["Year", year],
    ["Month", month],
    ["Base Salary", 14000],
    ["Cost of Living", exampleAllowances.extraCostOfLiving],
    ["Fuel", exampleAllowances.fuelAllowance],
    ["Net Salary", { formula: "B5+B6+B7" }],
    ["Basic Salary", { formula: `B5*${basicSalaryRatePercentLabel}` }],
    ["Payroll Calendar Days", payrollDaysInMonth(month, year)],
    ["Base Daily Rate", { formula: "B5/B10" }],
    ["Example Hire-Day-20 Deduction", { formula: "B5-((B5/B10)*(B10-20+1))" }],
  ]);

  forCells(sheet, 3, 1, 12, 1, (cell) => {
    cell.font = { bold: true, color: { argb: "FF374151" } };
  });
  forCells(sheet, 3, 2, 7, 2, (cell) => styleInputCell(cell));
  forCells(sheet, 5, 2, 9, 2, (cell) => {
    cell.numFmt = "#,##0.00";
  });
  sheet.getCell("B11").numFmt = "#,##0.00";
  sheet.getCell("B12").numFmt = "#,##0.00";

  writeMatrix(sheet, 3, 4, [
    ["Legend", "", "", "", ""],
    ["Worked day", "", "Weekend Fri/Sat", "", "Not worked"],
    ["Entry/exit day", "", "Inputs", "", "Formula result"],
    ["", "", "", "", ""],
    ["Net Salary = Base Salary + CoL + Fuel from April 2026 onward", "", "", "", ""],
  ]);
  sheet.mergeCells("D3:H3");
  sheet.getCell("D3").font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 10 };
  sheet.getCell("D3").border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" } };
  applyWorkingDaysLegendStyle(sheet.getCell("D4"), "FFDCFCE7");
  applyWorkingDaysLegendStyle(sheet.getCell("F4"), "FFFFEDD5");
  applyWorkingDaysLegendStyle(sheet.getCell("H4"), "FFF3F4F6");
  // Entry/exit day. The legend swatch and the conditional format below are one pair: change one
  // without the other and the key describes a colour the calendar no longer uses.
  applyWorkingDaysLegendStyle(sheet.getCell("D5"), HOUSE_XLSX_COLORS.light);
  styleInputCell(sheet.getCell("F5"));
  applyWorkingDaysLegendStyle(sheet.getCell("H5"), "FFEFF6FF");

  writeMatrix(sheet, 13, 1, [
    ["Scenario", "First Day", "Last Day", "Working Days", "Total"],
    ["Full month", 1, { formula: "$B$10" }, { formula: "C14-B14+1" }, { formula: "$B$11*D14" }],
    ["New employee", 15, { formula: "$B$10" }, { formula: "C15-B15+1" }, { formula: "$B$11*D15" }],
    ["Resignation", 1, 20, { formula: "C16-B16+1" }, { formula: "$B$11*D16" }],
  ]);
  forCells(sheet, 13, 1, 13, 5, (cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      fgColor: { argb: "FFEA580C" },
      pattern: "solid",
      type: "pattern",
    };
  });
  forCells(sheet, 14, 2, 16, 3, (cell) => styleInputCell(cell));
  forCells(sheet, 14, 5, 16, 5, (cell) => {
    cell.numFmt = "#,##0.00";
  });
  forCells(sheet, 13, 1, 16, 5, (cell) => {
    cell.border = {
      bottom: { color: { argb: "FFE5E7EB" }, style: "thin" },
      left: { color: { argb: "FFE5E7EB" }, style: "thin" },
      right: { color: { argb: "FFE5E7EB" }, style: "thin" },
      top: { color: { argb: "FFE5E7EB" }, style: "thin" },
    };
  });

  for (let index = 0; index < 31; index += 1) {
    const column = 6 + index;
    const letter = columnLetter(column);
    sheet.getCell(`${letter}13`).value = index + 1;
    sheet.getCell(`${letter}14`).value = { formula: `IF(${letter}$13<=$B$10,TEXT(DATE($B$3,$B$4,${letter}$13),"ddd"),"")` };
    for (let row = 15; row <= 17; row += 1) {
      sheet.getCell(row, column).value = {
        formula: `IF(${letter}$13>$B$10,"",IF(OR(${letter}$13=$B${row - 1},${letter}$13=$C${row - 1}),"Boundary",IF(WEEKDAY(DATE($B$3,$B$4,${letter}$13),2)>5,"Weekend",IF(AND(${letter}$13>=$B${row - 1},${letter}$13<=$C${row - 1}),"Worked","Off"))))`,
      };
    }
  }

  forCells(sheet, 13, 6, 14, 36, (cell) => {
    cell.font = { bold: true, color: { argb: "FF374151" } };
  });
  forCells(sheet, 13, 6, 17, 36, (cell) => {
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  forCells(sheet, 15, 6, 17, 36, (cell) => {
    cell.font = { size: 9 };
    cell.border = {
      bottom: { color: { argb: "FFE5E7EB" }, style: "thin" },
      left: { color: { argb: "FFE5E7EB" }, style: "thin" },
      right: { color: { argb: "FFE5E7EB" }, style: "thin" },
      top: { color: { argb: "FFE5E7EB" }, style: "thin" },
    };
  });
  sheet.addConditionalFormatting({
    ref: "F15:AJ17",
    rules: [
      {
        formulae: ['F15="Worked"'],
        priority: 1,
        style: { fill: { fgColor: { argb: "FFDCFCE7" }, type: "pattern", pattern: "solid" } },
        type: "expression",
      },
      {
        formulae: ['F15="Weekend"'],
        priority: 2,
        style: { fill: { fgColor: { argb: "FFFFEDD5" }, type: "pattern", pattern: "solid" } },
        type: "expression",
      },
      {
        formulae: ['F15="Boundary"'],
        priority: 3,
        style: {
          fill: { fgColor: { argb: HOUSE_XLSX_COLORS.light }, type: "pattern", pattern: "solid" },
          font: { color: { argb: HOUSE_XLSX_COLORS.white } },
        },
        type: "expression",
      },
      {
        formulae: ['F15="Off"'],
        priority: 4,
        style: { fill: { fgColor: { argb: "FFF3F4F6" }, type: "pattern", pattern: "solid" } },
        type: "expression",
      },
    ],
  });

  writeMatrix(sheet, 19, 1, [
    ["Policy note", "", "", "", "", "", "", ""],
    ["Change Year/Month in B3:B4. Month days and weekday names recalculate automatically.", "", "", "", "", "", "", ""],
    ["Change First Day / Last Day in B14:C16. Working days and totals recalculate immediately.", "", "", "", "", "", "", ""],
    [`Ready payroll prorates on the actual calendar days in the month (${payrollDaysInMonth(month, year)} this month). Partial-month hire deduction is calculated on Net Salary (Base Salary plus Extra Cost of Living plus Fuel Allowance) and is written into Other Deductions.`, "", "", "", "", "", "", ""],
  ]);
  sheet.mergeCells("A19:H19");
  sheet.mergeCells("A20:H20");
  sheet.mergeCells("A21:H21");
  sheet.mergeCells("A22:H22");
  sheet.getCell("A19").font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 10 };
  sheet.getCell("A19").border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" } };
  forCells(sheet, 20, 1, 22, 8, (cell) => {
    cell.alignment = { wrapText: true };
  });
}

function upsertSalaryPolicySheet(workbook: ExcelJS.Workbook) {
  const existing = workbook.getWorksheet("Salary Policy");
  if (existing) {
    workbook.removeWorksheet(existing.id);
  }

  const sheet = workbook.addWorksheet("Salary Policy");
  sheet.properties.defaultRowHeight = 22;
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 92;

  sheet.mergeCells("A1:B1");
  sheet.getCell("A1").value = "Salary Upload Policy";
  sheet.getCell("A1").font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos Display", size: 14 };
  sheet.getCell("A1").alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  sheet.getCell("A1").border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" } };
  sheet.getRow(1).height = 30;

  writeMatrix(sheet, 3, 1, [
    ["Field", "Formula / Rule"],
    ["Base Salary", "Fixed employee compensation source. This number does not change month to month."],
    ["Effective Period", "Extra Cost of Living and Fuel Allowance start from April 2026 payroll onward. Before April 2026 both values are 0."],
    ["Extra Cost of Living", "From April 2026: NSM 5000; DSM 3000; MR 2000; Marketing Manager 3000; Product Manager 3000; Group Product Manager 3000; Training 3000; all other positions 1500."],
    ["Fuel Allowance", "From April 2026: 500 for every employee."],
    ["Net Salary", "Base Salary + Extra Cost of Living + Fuel Allowance."],
    ["Basic Salary", `Base Salary x ${basicSalaryRatePercentLabel}.`],
    ["Gross Salary", "Base Salary + Social Insurance + Employment Income Tax."],
    ["Ready Sheet Formulas", "Ready payroll rows use Excel formulas for Gross Salary, Net Salary, Total Additions, Governmental Deductions, Other Deductions proration, Total Deductions, Month Salary, First Part, and Second Part."],
    ["Partial Month Hires", "Payroll prorates on the actual calendar days in the payroll month (28, 29, 30 or 31). If Hire Date is inside the payroll month, Other Deductions auto-calculates Net Salary - ((Net Salary / days in month) x eligible days), where Net Salary is Base Salary plus Extra Cost of Living plus Fuel Allowance. Hire day is included. Extra Cost of Living and Fuel Allowance are prorated along with Base Salary, so a new hire is paid the same fraction of every component."],
    ["Resignations", "Last Working Date on or before the 25th: Base Salary is prorated to the days worked, and Extra Cost of Living and Fuel Allowance are both 0. Last Working Date after the 25th: Base Salary is paid in FULL and both Extra Cost of Living and Fuel Allowance are paid in full, with no proration."],
    ["First Part", `One Part: Month Salary minus Expenses and Incentive. Two Parts: MIN(Month Salary minus Expenses and Incentive, Base Salary x ${basicSalaryRatePercentLabel}, Base Salary - Other Deductions) so low final dues are paid fully in First Part.`],
    ["Second Part", "Expenses and Incentive always pay in Second Part. Two Parts also includes any remaining Month Salary after First Part. Never below 0."],
    ["Ready Sheet Sorting", "Ready payroll rows are ordered in four blocks: One Part, already hired Two Parts, current-month Two Parts new hires, then current-month resignations. Rows inside each block are sorted from oldest to newest by the relevant date."],
    ["Ready Sheet Editing", "Ready payroll locks fixed employee and salary fields. Monthly variable fields stay editable: Expenses, Incentive, Overtime, Bonus, Other Additions, CRM, Finger Print, Unpaid Vacations, Medical Insurance, Loans, and Other Deductions."],
    ["Upload Note", "The uploaded monthly sheet remains the payslip source of truth for month-specific additions, deductions, First Part, Second Part, and stored payroll totals."],
  ]);

  forCells(sheet, 3, 1, 3, 2, (cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      fgColor: { argb: "FFEA580C" },
      pattern: "solid",
      type: "pattern",
    };
  });
  forCells(sheet, 4, 1, 17, 1, (cell) => {
    cell.font = { bold: true, color: { argb: "FF374151" } };
  });
  forCells(sheet, 3, 1, 17, 2, (cell) => {
    cell.alignment = { vertical: "top", wrapText: true };
    cell.border = {
      bottom: { color: { argb: "FFE5E7EB" }, style: "thin" },
      left: { color: { argb: "FFE5E7EB" }, style: "thin" },
      right: { color: { argb: "FFE5E7EB" }, style: "thin" },
      top: { color: { argb: "FFE5E7EB" }, style: "thin" },
    };
  });
}

function sortReadyPayrollRows(rows: PayrollTemplateRow[]) {
  return rows.slice().sort((left, right) => {
    const blockDifference = readyPayrollBlockRank(left) - readyPayrollBlockRank(right);
    if (blockDifference !== 0) return blockDifference;

    const dateDifference =
      readyPayrollBlockDateSortValue(left) -
      readyPayrollBlockDateSortValue(right);
    if (dateDifference !== 0) return dateDifference;

    return (
      left.fullName.localeCompare(right.fullName) ||
      left.employeeCode.localeCompare(right.employeeCode)
    );
  });
}

function readyPayrollBlockRank(row: PayrollTemplateRow) {
  if (payrollMonthMatches(row.lastWorkingDate, row.month, row.year)) return 4;
  if (row.paymentMode === "One Part") return 1;
  if (payrollMonthMatches(row.hireDate, row.month, row.year)) return 3;
  return 2;
}

function readyPayrollBlockLabel(rank: number, month: number, year: number) {
  if (rank === 1) return "BLOCK 1 - One Part";
  if (rank === 2) return "BLOCK 2 - Two Parts Already Hired";
  if (rank === 3) return `BLOCK 3 - New Hires in ${monthName(month)} ${year}`;
  return `BLOCK 4 - Resignations in ${monthName(month)} ${year}`;
}

function readyPayrollBlockDateSortValue(row: PayrollTemplateRow) {
  if (readyPayrollBlockRank(row) === 4) {
    return readyPayrollHireDateSortValue(row.lastWorkingDate);
  }

  return readyPayrollHireDateSortValue(row.hireDate);
}

function readyPayrollHireDateSortValue(value: string | null) {
  return parseDateOnly(value)?.getTime() ?? Number.POSITIVE_INFINITY;
}

function lockReadyPayrollRow(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
) {
  const row = sheet.getRow(rowNumber);
  for (let column = 1; column <= headers.length; column += 1) {
    row.getCell(column).protection = { locked: true };
  }
}

function setReadyPayrollDataRowProtection(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
) {
  const row = sheet.getRow(rowNumber);
  for (let column = 1; column <= headers.length; column += 1) {
    row.getCell(column).protection = {
      locked: !readyPayrollEditableColumnNumbers.has(column),
    };
  }
}

async function protectReadyPayrollSheet(
  sheet: ExcelJS.Worksheet,
  input: {
    blockHeaderRows: ReadonlySet<number>;
    lastDataRow: number;
    totalsRow: number | null;
  },
) {
  for (let rowNumber = dataStartRow; rowNumber <= input.lastDataRow; rowNumber += 1) {
    if (input.blockHeaderRows.has(rowNumber)) {
      lockReadyPayrollRow(sheet, rowNumber);
    } else {
      setReadyPayrollDataRowProtection(sheet, rowNumber);
    }
  }

  if (input.totalsRow !== null) {
    lockReadyPayrollRow(sheet, input.totalsRow);
  }

  await sheet.protect("", {
    autoFilter: true,
    formatCells: true,
    formatColumns: true,
    formatRows: true,
    selectLockedCells: true,
    selectUnlockedCells: true,
    sort: true,
  });
}

async function buildReadyRows(
  month: number,
  year: number,
  accessContext: AccessContext,
  batchId?: string | null,
): Promise<PayrollTemplateRow[]> {
  if (batchId) {
    const exportData = await getSalaryBatchExport(batchId, accessContext);
    if (exportData) {
      return exportData.records.map((record) => {
        return {
          arabicName: record.nameAr,
          area: record.area,
          bankAccount: "", // Not stored in SalaryRecord, typically blank in batch
          bankName: "", // Not stored in SalaryRecord
          baseSalary: record.baseSalary ?? 0,
          bonus: record.bonus ?? 0,
          comment: record.payrollComment ?? "",
          crm: record.crm ?? 0,
          // Batch-export rows are already-computed history with no live last-working date, so the
          // proration formula's leaver branch never runs; month-end keeps the type satisfied.
          effectiveEndDay: payrollDaysInMonth(month, year),
          // Prefer the count actually stored with the row. Rows written before
          // 2026-09-04 have none, and rather than assert a full month over a
          // historical joiner, derive what the record itself can prove: its hire
          // date sets the start day, and month-end the finish. That is exact for
          // the ordinary row and for a joiner; it can only overstate a LEAVER,
          // whose last working date a SalaryRecord does not carry.
          workingDays:
            record.workingDays > 0
              ? record.workingDays
              : Math.max(
                  0,
                  payrollDaysInMonth(month, year)
                    - prorationStartDay(record.hireDate, month, year)
                    + 1,
                ),
          employeeCode: record.hrId,
          employmentIncomeTax: record.employmentIncomeTax ?? 0,
          expenses: record.expenses ?? 0,
          extraCostOfLiving: record.extraCostOfLiving ?? 0,
          fingerPrint: record.fingerPrint ?? 0,
          firstPart: record.firstPart ?? 0,
          fuelAllowance: record.fuelAllowance ?? 0,
          fullName: record.fullName,
          governmentalDeductions: record.governmentalDeductions ?? 0,
          grossSalary: record.grossSalary ?? 0,
          hireDate: record.hireDate,
          incentive: record.incentive ?? 0,
          jobTitle: record.jobTitle,
          lastWorkingDate: null,
          line: record.line,
          loans: record.loans ?? 0,
          medicalInsurance: record.medicalInsurance ?? 0,
          month,
          monthSalary: record.monthSalary ?? 0,
          netSalary: record.netSalary ?? 0,
          otherAdditions: record.otherAdditions ?? 0,
          otherDeductions: record.otherDeductions ?? 0,
          overtime: record.overtime ?? 0,
          paymentMode: payrollPaymentModeLabel((record.paymentMode as "one_part" | "two_parts") || "two_parts"),
          secondPart: record.secondPart ?? 0,
          socialInsurance: record.socialInsurance ?? 0,
          totalAdditions: record.totalAdditions ?? 0,
          totalDeductions: record.totalDeductions ?? 0,
          unpaidVacations: record.unpaidVacations ?? 0,
          year,
        };
      });
    }
  }

  const [payrollEmployees, previousExpensesByEmployee, approvedExpenseTotals] = await Promise.all([
    getPayrollTemplateEmployees(month, year),
    getLatestSalaryExpenseTotalsBefore(month, year, accessContext),
    getApprovedExpenseTotalsForPayroll(month, year, accessContext),
  ]);

  const rows = payrollEmployees
    .map((payrollEmployee) => {
      const { employee } = payrollEmployee;
      const expenses = money(
        approvedExpenseTotals.get(employee.hrId) ??
          previousExpensesByEmployee.get(employee.hrId),
      );
      const standardAllowances = resolveStandardSalaryAllowances({
        departmentName: employee.departmentName,
        employeeHrId: employee.hrId,
        jobTitle: employee.jobTitle,
        lineName: employee.lineName,
        month,
        positionTitle: employee.positionTitle,
        year,
      });
      const standardExtraCostOfLiving = money(standardAllowances.extraCostOfLiving);
      const standardFuelAllowance = money(standardAllowances.fuelAllowance);
      const socialInsurance = money(employee.socialInsurance);
      const employmentIncomeTax = money(employee.taxes);
      // Contract structure from the STANDARD allowances — see the matching note in
      // buildUploadRows. The lifecycle rule changes what is PAID, never the base it prorates.
      const fixedSalary = resolveFixedSalaryAmounts({
        baseSalary: employee.baseSalary,
        basicSalary: employee.basicSalary,
        employmentIncomeTax,
        extraCostOfLiving: standardExtraCostOfLiving,
        fuelAllowance: standardFuelAllowance,
        grossSalary: employee.grossSalary,
        netSalary: employee.netSalary,
        socialInsurance,
      });
      const baseSalary = money(fixedSalary.baseSalary);
      const settlement = resolveReadyLifecycleSettlement({
        baseSalary,
        extraCostOfLiving: standardExtraCostOfLiving,
        fuelAllowance: standardFuelAllowance,
        hireDate: employee.hireDate,
        isResignation: payrollEmployee.isResignation,
        lastWorkingDate: payrollEmployee.lastWorkingDate,
        month,
        year,
      });
      const extraCostOfLiving = settlement.extraCostOfLiving;
      const fuelAllowance = settlement.fuelAllowance;
      const parts = calculatePayrollParts({
        additions: 0,
        baseSalary,
        deductions: 0,
        extraCostOfLiving,
        fuelAllowance,
        paymentMode: employee.salaryPaymentMode,
        previousExpenses: expenses,
      });
      const grossSalary = money(fixedSalary.grossSalary);
      const governmentalDeductions = money(socialInsurance + employmentIncomeTax);
      const medicalInsurance = money(employee.medicalInsurance);
      const incentive = 0;
      const overtime = 0;
      const bonus = 0;
      const otherAdditions = 0;
      const crm = 0;
      const fingerPrint = 0;
      const unpaidVacations = 0;
      const loans = 0;
      const otherDeductions = settlement.prorationDeduction;
      const totalAdditions = money(
        expenses + incentive + overtime + bonus + extraCostOfLiving + fuelAllowance + otherAdditions,
      );
      const totalDeductions = money(
        crm +
          fingerPrint +
          unpaidVacations +
          medicalInsurance +
          loans +
          otherDeductions,
      );
      const paymentMode = payrollPaymentModeLabel(parts.paymentMode);
      // Net Salary = base + the SETTLEMENT allowances (0 for a leaver who keeps none), matching
      // the col-13 formula base+ECOL+Fuel. Using fixedSalary.netSalary (full standard allowances)
      // cached a Month Salary inflated by the very ECOL/Fuel this row zeroes — self-contradictory
      // and, on a raw re-upload, tripping the net-salary mismatch guard that then excludes the row.
      const netSalary = money(baseSalary + extraCostOfLiving + fuelAllowance);
      const monthSalary = money(
        netSalary +
          expenses +
          incentive +
          overtime +
          bonus +
          otherAdditions -
          totalDeductions,
      );
      const { firstPart, secondPart } = resolvePayrollSplit({
        baseSalary,
        basicSalary: parts.basicSalary,
        monthSalary,
        otherDeductions,
        paymentMode: parts.paymentMode,
        secondPartAdditions: expenses + incentive,
      });

      return {
        arabicName: employee.nameAr,
        area: employee.areaName,
        bankAccount: employee.bankAccount,
        bankName: employee.bankName,
        baseSalary,
        bonus,
        comment:
          readyLifecycleComment(settlement) ??
          (parts.paymentMode === "two_parts"
            ? `Day 1: ${basicSalaryRatePercentLabel} of base only. Day 10: remaining pay plus expenses and incentive.`
            : "Day 1: net salary. Day 10: expenses and incentive."),
        crm,
        effectiveEndDay: settlement.effectiveEndDay,
        workingDays: settlement.workingDays,
        employeeCode: employee.hrId,
        employmentIncomeTax,
        expenses,
        extraCostOfLiving,
        fingerPrint,
        firstPart,
        fuelAllowance,
        fullName: employee.fullName,
        governmentalDeductions,
        grossSalary,
        hireDate: employee.hireDate,
        incentive,
        jobTitle: employee.positionTitle ?? employee.jobTitle,
        lastWorkingDate: payrollEmployee.lastWorkingDate,
        line: employee.lineName,
        loans,
        medicalInsurance,
        monthSalary,
        month,
        netSalary,
        otherAdditions,
        otherDeductions,
        overtime,
        paymentMode,
        secondPart,
        socialInsurance,
        totalAdditions,
        totalDeductions,
        unpaidVacations,
        year,
      };
    });

  return sortReadyPayrollRows(rows);
}

async function buildStyledTemplate(
  month: number,
  year: number,
  ready: boolean,
  accessContext: AccessContext,
  batchId?: string | null,
) {
  const workbook = await loadPayrollTemplateWorkbook();
  const sheet = workbook.worksheets[0] ?? workbook.addWorksheet("Payroll Upload");
  const bodyStyles = captureBodyStyles(sheet);
  const totalsStyle = captureRowStyle(sheet, templateDataEndRow + 1);
  const rows = ready ? await buildReadyRows(month, year, accessContext, batchId) : [];
  const displayRows = ready ? rows : [];
  const rowsToKeep = ready ? displayRows.length : 25;
  const totalsRow = prepareTemplateRows(sheet, rowsToKeep);

  applyPayrollUploadMasthead(workbook, sheet, month, year);
  writeBankDetailsSectionRow(sheet, dataStartRow - 2);
  writeHeaderRow(sheet, dataStartRow - 1);
  stylePayrollHeaderRow(sheet.getRow(dataStartRow - 1));
  applyPayrollTemplateColumnWidths(sheet);
  writePayrollRows(sheet, displayRows, bodyStyles);
  styleBankDetailsCells(sheet, dataStartRow, Math.max(totalsRow - 1, dataStartRow));
  writeTotals(sheet, totalsRow, displayRows, totalsStyle);
  upsertWorkingDaysCalcSheet(workbook, month, year);
  upsertSalaryPolicySheet(workbook);
  sheet.name = "Payroll Upload";
  sheet.views = [{ state: "frozen", ySplit: 5 }];
  sheet.autoFilter = {
    from: { column: 1, row: 5 },
    to: { column: headers.length, row: Math.max(totalsRow - 1, dataStartRow) },
  };

  return workbook;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "payroll", "read");

    const url = new URL(request.url);
    const now = new Date();
    const ready = url.searchParams.get("ready") === "1";
    const upload = url.searchParams.get("upload") === "1";
    const month = numberParam(url.searchParams.get("month"), now.getMonth() + 1);
    const year = numberParam(url.searchParams.get("year"), now.getFullYear());
    const batchId = url.searchParams.get("batchId");

    if (upload) {
      if (getPayrollScope(access) !== "COMPANY") {
        return new Response("Forbidden", { status: 403 });
      }

      try {
        assertValidPayrollPeriod(month, year);
      } catch (error) {
        return NextResponse.json(
          {
            error: "invalid_payroll_period",
            message: clientSafeErrorMessage(error, "Payroll period is invalid."),
          },
          { status: 400 },
        );
      }

      const workbook = await createFallbackWorkbook(await buildUploadRows(month, year), month, year);
      const buffer = await workbook.xlsx.writeBuffer();

      return new Response(buffer, {
        headers: {
          ...DOWNLOAD_NO_STORE_HEADERS,
          "Content-Disposition": 'attachment; filename="phoenix-salary-upload-template.xlsx"',
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });
    }

    if (!ready) {
      return exactTemplateResponse();
    }

    try {
      assertValidPayrollPeriod(month, year);
    } catch (error) {
      return NextResponse.json(
        {
          error: "invalid_payroll_period",
          message: clientSafeErrorMessage(error, "Payroll period is invalid."),
        },
        { status: 400 },
      );
    }

    if (ready && getPayrollScope(access) !== "COMPANY") {
      return new Response("Forbidden", { status: 403 });
    }

    const workbook = ready
      ? await createFallbackWorkbook(await buildReadyRows(month, year, access, batchId), month, year, { formulas: true })
      : await buildStyledTemplate(month, year, ready, access, batchId);
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = ready
      ? `phoenix-ready-payroll-${year}-${String(month).padStart(2, "0")}.xlsx`
      : "phoenix-payroll-template.xlsx";

    return new Response(buffer, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Payroll template request failed.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }

    return NextResponse.json({ error: "payroll_template_failed", message }, { status: 500 });
  }
}
