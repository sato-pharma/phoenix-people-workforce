import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import path from "node:path";

import { assertPermission, getPayrollScope, type AccessContext } from "@/lib/auth/permissions";
import { parseDateOnly } from "@/lib/date-only";
import { resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getApprovedExpenseTotalsForPayroll } from "@/lib/payroll/expenses";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import { calculateGrossSalary, calculateNetSalary, calculatePayrollParts, payrollPaymentModeLabel } from "@/lib/payroll/policy";
import { payrollSheetHeaders } from "@/lib/payroll/salary-sheet-fields";
import { getLatestSalaryRecordsBefore } from "@/lib/payroll/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const templateFileName = "Phoneix system template.xlsx";
const dataStartRow = 6;
const templateDataEndRow = 126;
const totalsLabel = "TOTALS";
const headers = [...payrollSheetHeaders, "Bank", "Bank Account"];
const bankDetailsSectionStart = payrollSheetHeaders.length + 1;

const uploadTemplateSections = [
  { bodyFill: "FFEFF6FF", end: 10, headerFill: "FF1E3A8A", label: "Employee Data", start: 1 },
  { bodyFill: "FFF0FDFA", end: 13, headerFill: "FF0F766E", label: "Fixed Salary", start: 11 },
  { bodyFill: "FFF0FDF4", end: 20, headerFill: "FF16A34A", label: "Additions", start: 14 },
  { bodyFill: "FFDCFCE7", end: 21, headerFill: "FF166534", label: "Total Additions", start: 21 },
  { bodyFill: "FFF5F3FF", end: 24, headerFill: "FF7C3AED", label: "Governmental Deductions", start: 22 },
  { bodyFill: "FFFEF2F2", end: 30, headerFill: "FFDC2626", label: "Internal Deductions", start: 25 },
  { bodyFill: "FFFEE2E2", end: 31, headerFill: "FF991B1B", label: "Total Deductions", start: 31 },
  { bodyFill: "FFFFF7ED", end: 36, headerFill: "FFF97316", label: "Payment Split", start: 32 },
  { bodyFill: "FFF8FAFC", end: 38, headerFill: "FF475569", label: "Bank Details", start: 37 },
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
  hireDate: string | null;
  incentive: number;
  jobTitle: string | null;
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

function uploadSectionForColumn(columnNumber: number) {
  return uploadTemplateSections.find((section) => columnNumber >= section.start && columnNumber <= section.end) ?? uploadTemplateSections[0];
}

function solidFill(argb: string): ExcelJS.Fill {
  return {
    fgColor: { argb },
    pattern: "solid",
    type: "pattern",
  };
}

function borderForColumn(columnNumber: number, color = "FFE5E7EB"): Partial<ExcelJS.Borders> {
  const section = uploadSectionForColumn(columnNumber);
  const isSectionEnd = columnNumber === section.end;

  return {
    bottom: { color: { argb: color }, style: "thin" },
    left: { color: { argb: color }, style: "thin" },
    right: { color: { argb: isSectionEnd ? section.headerFill : color }, style: isSectionEnd ? "medium" : "thin" },
    top: { color: { argb: color }, style: "thin" },
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

  leadCell.value = section.label;
  leadCell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  leadCell.fill = solidFill(section.headerFill);
  leadCell.alignment = { horizontal: "center", vertical: "middle" };

  for (let column = section.start; column <= section.end; column += 1) {
    const cell = row.getCell(column);
    cell.fill = solidFill(section.headerFill);
    cell.border = borderForColumn(column, "FFFFFFFF");
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
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.height = 34;
  row.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  row.eachCell((cell) => {
    const section = uploadSectionForColumn(Number(cell.col));
    cell.fill = solidFill(section.headerFill);
    cell.border = borderForColumn(Number(cell.col), "FFFFEDD5");
  });
}

function stylePayrollDataCell(cell: ExcelJS.Cell) {
  const column = Number(cell.col);
  const section = uploadSectionForColumn(column);
  const isTotalColumn = column === 21 || column === 24 || column === 31;

  if (typeof cell.value === "number") {
    cell.numFmt = "#,##0.00";
  }

  cell.alignment = { vertical: "middle", wrapText: true };
  cell.border = borderForColumn(column);
  cell.fill = solidFill(section.bodyFill);
  cell.font = isTotalColumn
    ? { bold: true, color: { argb: "FF0F172A" } }
    : { color: { argb: "FF0F172A" } };
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
    const section = uploadSectionForColumn(Number(cell.col));
    cell.fill = solidFill(section.headerFill);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: Number(cell.col) === 1 ? "left" : "right", vertical: "middle", wrapText: true };
    cell.border = borderForColumn(Number(cell.col), "FFFFFFFF");
    if (typeof cell.value === "number") {
      cell.numFmt = "#,##0.00";
    }
  });
  row.height = 28;
}

async function buildUploadRows(month: number, year: number): Promise<PayrollTemplateRow[]> {
  const directory = await getEmployeeDirectory();

  return directory.employees
    .filter((employee) => (employee.employmentStatus ?? "active") === "active")
    .map((employee) => {
      const baseSalary = money(employee.netSalary);
      const standardAllowances = resolveStandardSalaryAllowances({
        departmentName: employee.departmentName,
        jobTitle: employee.jobTitle,
        lineName: employee.lineName,
        month,
        positionTitle: employee.positionTitle,
        year,
      });
      const extraCostOfLiving = money(standardAllowances.extraCostOfLiving);
      const fuelAllowance = money(standardAllowances.fuelAllowance);
      const socialInsurance = money(employee.socialInsurance);
      const employmentIncomeTax = money(employee.taxes);
      const netSalary = calculateNetSalary({
        baseSalary,
        extraCostOfLiving,
        fuelAllowance,
      });
      const grossSalary = calculateGrossSalary({
        baseSalary,
        socialInsurance,
        taxes: employmentIncomeTax,
      });
      const governmentalDeductions = money(socialInsurance + employmentIncomeTax);
      const parts = calculatePayrollParts({
        baseSalary,
        extraCostOfLiving,
        fuelAllowance,
        paymentMode: employee.salaryPaymentMode,
      });
      const paymentMode = payrollPaymentModeLabel(parts.paymentMode);

      return {
        arabicName: employee.nameAr,
        area: employee.areaName,
        bankAccount: employee.bankAccount,
        bankName: employee.bankName,
        baseSalary,
        bonus: 0,
        comment:
          parts.paymentMode === "two_parts"
            ? "Fixed starter row. Add monthly expenses, additions, and deductions before upload."
            : "Fixed starter row. Add monthly expenses, additions, and deductions before upload.",
        crm: 0,
        employeeCode: employee.hrId,
        employmentIncomeTax,
        expenses: 0,
        extraCostOfLiving,
        fingerPrint: 0,
        firstPart: parts.firstPart,
        fuelAllowance,
        fullName: employee.fullName,
        governmentalDeductions,
        grossSalary,
        hireDate: employee.hireDate,
        incentive: 0,
        jobTitle: employee.positionTitle ?? employee.jobTitle,
        line: employee.lineName,
        loans: 0,
        medicalInsurance: 0,
        monthSalary: parts.totalPayable,
        month,
        netSalary,
        otherAdditions: 0,
        otherDeductions: 0,
        overtime: 0,
        paymentMode,
        secondPart: parts.secondPart,
        socialInsurance,
        totalAdditions: money(extraCostOfLiving + fuelAllowance),
        totalDeductions: 0,
        unpaidVacations: 0,
        year,
      };
    });
}

async function createFallbackWorkbook(
  rows: PayrollTemplateRow[] = [],
  month = new Date().getMonth() + 1,
  year = new Date().getFullYear(),
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Payroll Upload");

  writeTitle(sheet, month, year);
  sheet.mergeCells(1, 1, 1, headers.length);
  sheet.getCell("A1").value = "Phoenix Payroll Upload Template";
  sheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 18 };
  sheet.getCell("A1").fill = {
    fgColor: { argb: "FF111827" },
    pattern: "solid",
    type: "pattern",
  };
  sheet.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 34;
  sheet.mergeCells(2, 1, 3, headers.length);
  sheet.getCell("A2").value =
    `Payroll period: ${monthName(month)} ${year}. Fixed fields are pre-populated from employee master data. Add monthly expenses, additions, and deductions before upload.`;
  sheet.getCell("A2").font = { color: { argb: "FF374151" }, italic: true };
  sheet.getCell("A2").fill = {
    fgColor: { argb: "FFFFF7ED" },
    pattern: "solid",
    type: "pattern",
  };
  sheet.getCell("A2").alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  sheet.getRow(2).height = 22;
  sheet.getRow(3).height = 22;
  writeUploadSectionRow(sheet, dataStartRow - 2);
  writeHeaderRow(sheet, dataStartRow - 1);
  stylePayrollHeaderRow(sheet.getRow(dataStartRow - 1));
  sheet.views = [{ state: "frozen", ySplit: dataStartRow - 1 }];
  sheet.columns = headers.map((header) => ({
    key: header,
    width: Math.max(header.length + 4, 14),
  }));
  rows.forEach((row, index) => {
    const sheetRow = sheet.getRow(dataStartRow + index);
    sheetRow.values = rowValues(row, index + 1);
    sheetRow.height = 24;
    for (let column = 1; column <= headers.length; column += 1) {
      stylePayrollDataCell(sheetRow.getCell(column));
    }
    sheetRow.commit();
  });
  if (rows.length > 0) {
    writeTotals(sheet, dataStartRow + rows.length, rows, captureRowStyle(sheet, dataStartRow - 1));
  }
  sheet.autoFilter = {
    from: { column: 1, row: dataStartRow - 1 },
    to: { column: headers.length, row: Math.max(dataStartRow, dataStartRow + rows.length - 1) },
  };
  upsertWorkingDaysCalcSheet(workbook, month, year);
  upsertSalaryPolicySheet(workbook);

  return workbook;
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

function writeTitle(sheet: ExcelJS.Worksheet, month: number, year: number) {
  sheet.getCell("A2").value = `⚡  PhoenixX — Payroll Sheet  |  ${monthName(month)} ${year}`;
}

function rowValues(row: PayrollTemplateRow, index: number) {
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
    parseDateOnly(row.hireDate) ?? "",
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

  row.getCell(1).value = totalsLabel;
  row.getCell(11).value = total((item) => item.baseSalary);
  row.getCell(12).value = total((item) => item.grossSalary);
  row.getCell(13).value = total((item) => item.netSalary);
  row.getCell(14).value = total((item) => item.expenses);
  row.getCell(15).value = total((item) => item.incentive);
  row.getCell(16).value = total((item) => item.overtime);
  row.getCell(17).value = total((item) => item.bonus);
  row.getCell(18).value = total((item) => item.extraCostOfLiving);
  row.getCell(19).value = total((item) => item.fuelAllowance);
  row.getCell(20).value = total((item) => item.otherAdditions);
  row.getCell(21).value = total((item) => item.totalAdditions);
  row.getCell(22).value = total((item) => item.socialInsurance);
  row.getCell(23).value = total((item) => item.employmentIncomeTax);
  row.getCell(24).value = total((item) => item.governmentalDeductions);
  row.getCell(25).value = total((item) => item.crm);
  row.getCell(26).value = total((item) => item.fingerPrint);
  row.getCell(27).value = total((item) => item.unpaidVacations);
  row.getCell(28).value = total((item) => item.medicalInsurance);
  row.getCell(29).value = total((item) => item.loans);
  row.getCell(30).value = total((item) => item.otherDeductions);
  row.getCell(31).value = total((item) => item.totalDeductions);
  row.getCell(32).value = total((item) => item.monthSalary);
  row.getCell(33).value = total((item) => item.firstPart);
  row.getCell(34).value = total((item) => item.secondPart);
  row.getCell(35).value = "";
  row.getCell(36).value = "";
  row.getCell(37).value = "";
  row.getCell(38).value = "";
  applyRowStyle(sheet, totalsRow, totalsStyle);
  stylePayrollTotalsRow(row);
  row.commit();
}

function styleInputCell(cell: ExcelJS.Cell) {
  cell.fill = {
    fgColor: { argb: "FFFFF7ED" },
    pattern: "solid",
    type: "pattern",
  };
  cell.border = {
    bottom: { color: { argb: "FFF97316" }, style: "thin" },
    left: { color: { argb: "FFF97316" }, style: "thin" },
    right: { color: { argb: "FFF97316" }, style: "thin" },
    top: { color: { argb: "FFF97316" }, style: "thin" },
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
  sheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
  sheet.getCell("A1").fill = {
    fgColor: { argb: "FF111827" },
    pattern: "solid",
    type: "pattern",
  };
  sheet.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 30;

  writeMatrix(sheet, 3, 1, [
    ["Year", year],
    ["Month", month],
    ["Base Salary", 14000],
    ["Cost of Living", exampleAllowances.extraCostOfLiving],
    ["Fuel", exampleAllowances.fuelAllowance],
    ["Net Salary", { formula: "B5+B6+B7" }],
    ["Basic Salary", { formula: "B5*70%" }],
    ["Days in Month", { formula: "DAY(EOMONTH(DATE(B3,B4,1),0))" }],
    ["Base Daily Rate", { formula: "B5/B10" }],
    ["Net Daily Rate", { formula: "B8/B10" }],
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
  sheet.getCell("D3").font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getCell("D3").fill = {
    fgColor: { argb: "FF334155" },
    pattern: "solid",
    type: "pattern",
  };
  applyWorkingDaysLegendStyle(sheet.getCell("D4"), "FFDCFCE7");
  applyWorkingDaysLegendStyle(sheet.getCell("F4"), "FFFFEDD5");
  applyWorkingDaysLegendStyle(sheet.getCell("H4"), "FFF3F4F6");
  applyWorkingDaysLegendStyle(sheet.getCell("D5"), "FFF97316");
  styleInputCell(sheet.getCell("F5"));
  applyWorkingDaysLegendStyle(sheet.getCell("H5"), "FFEFF6FF");

  writeMatrix(sheet, 13, 1, [
    ["Scenario", "First Day", "Last Day", "Working Days", "Total"],
    ["Full month", 1, { formula: "$B$10" }, { formula: "C14-B14+1" }, { formula: "$B$12*D14" }],
    ["New employee", 15, { formula: "$B$10" }, { formula: "C15-B15+1" }, { formula: "$B$12*D15" }],
    ["Resignation", 1, 20, { formula: "C16-B16+1" }, { formula: "$B$12*D16" }],
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
          fill: { fgColor: { argb: "FFF97316" }, type: "pattern", pattern: "solid" },
          font: { color: { argb: "FFFFFFFF" } },
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
    ["Full month total equals net salary. Partial month total prorates base salary, CoL, and fuel across month days.", "", "", "", "", "", "", ""],
  ]);
  sheet.mergeCells("A19:H19");
  sheet.mergeCells("A20:H20");
  sheet.mergeCells("A21:H21");
  sheet.mergeCells("A22:H22");
  sheet.getCell("A19").font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A19").fill = {
    fgColor: { argb: "FF0F766E" },
    pattern: "solid",
    type: "pattern",
  };
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
  sheet.getCell("A1").value = "Phoenix Salary Upload Policy";
  sheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
  sheet.getCell("A1").fill = {
    fgColor: { argb: "FF111827" },
    pattern: "solid",
    type: "pattern",
  };
  sheet.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 30;

  writeMatrix(sheet, 3, 1, [
    ["Field", "Formula / Rule"],
    ["Base Salary", "Fixed employee compensation source. This number does not change month to month."],
    ["Effective Period", "Extra Cost of Living and Fuel Allowance start from April 2026 payroll onward. Before April 2026 both values are 0."],
    ["Extra Cost of Living", "From April 2026: NSM 5000; DSM 3000; MR 2000; Marketing Manager 3000; Product Manager 3000; Group Product Manager 3000; Training 3000; all other positions 1500."],
    ["Fuel Allowance", "From April 2026: 500 for every employee."],
    ["Net Salary", "Base Salary + Extra Cost of Living + Fuel Allowance."],
    ["Basic Salary", "Base Salary x 70%."],
    ["Gross Salary", "Base Salary + Social Insurance + Employment Income Tax."],
    ["First Part", "Two Parts: Basic Salary. One Part: Net Salary."],
    ["Second Part", "Two Parts: Net Salary - First Part + Expenses + monthly additions - monthly deductions. One Part: Expenses + monthly additions - monthly deductions."],
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
  forCells(sheet, 4, 1, 13, 1, (cell) => {
    cell.font = { bold: true, color: { argb: "FF374151" } };
  });
  forCells(sheet, 3, 1, 13, 2, (cell) => {
    cell.alignment = { vertical: "top", wrapText: true };
    cell.border = {
      bottom: { color: { argb: "FFE5E7EB" }, style: "thin" },
      left: { color: { argb: "FFE5E7EB" }, style: "thin" },
      right: { color: { argb: "FFE5E7EB" }, style: "thin" },
      top: { color: { argb: "FFE5E7EB" }, style: "thin" },
    };
  });
}

async function buildReadyRows(
  month: number,
  year: number,
  accessContext: AccessContext,
): Promise<PayrollTemplateRow[]> {
  const [directory, previousRecords, approvedExpenseTotals] = await Promise.all([
    getEmployeeDirectory(),
    getLatestSalaryRecordsBefore(month, year),
    getApprovedExpenseTotalsForPayroll(month, year, accessContext),
  ]);
  const previousExpensesByEmployee = new Map(
    previousRecords.map((record) => [record.employeeCode, record.expenses]),
  );

  return directory.employees
    .filter((employee) => (employee.employmentStatus ?? "active") === "active")
    .map((employee) => {
      const expenses = money(
        approvedExpenseTotals.get(employee.hrId) ??
          previousExpensesByEmployee.get(employee.hrId),
      );
      const baseSalary = money(employee.netSalary);
      const standardAllowances = resolveStandardSalaryAllowances({
        departmentName: employee.departmentName,
        jobTitle: employee.jobTitle,
        lineName: employee.lineName,
        month,
        positionTitle: employee.positionTitle,
        year,
      });
      const extraCostOfLiving = money(standardAllowances.extraCostOfLiving);
      const fuelAllowance = money(standardAllowances.fuelAllowance);
      const parts = calculatePayrollParts({
        additions: 0,
        baseSalary,
        deductions: 0,
        extraCostOfLiving,
        fuelAllowance,
        paymentMode: employee.salaryPaymentMode,
        previousExpenses: expenses,
      });
      const socialInsurance = money(employee.socialInsurance);
      const employmentIncomeTax = money(employee.taxes);
      const grossSalary = calculateGrossSalary({
        baseSalary,
        socialInsurance,
        taxes: employmentIncomeTax,
      });
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
      const otherDeductions = 0;
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
      const netSalary = calculateNetSalary({
        baseSalary,
        extraCostOfLiving,
        fuelAllowance,
      });

      return {
        arabicName: employee.nameAr,
        area: employee.areaName,
        bankAccount: employee.bankAccount,
        bankName: employee.bankName,
        baseSalary,
        bonus,
        comment:
          parts.paymentMode === "two_parts"
            ? "Day 1: 70% of base only. Day 10: 30% base + cost of living + fuel + approved previous-month expenses."
            : "Day 1: net salary. Day 10: approved previous-month expenses.",
        crm,
        employeeCode: employee.hrId,
        employmentIncomeTax,
        expenses,
        extraCostOfLiving,
        fingerPrint,
        firstPart: parts.firstPart,
        fuelAllowance,
        fullName: employee.fullName,
        governmentalDeductions,
        grossSalary,
        hireDate: employee.hireDate,
        incentive,
        jobTitle: employee.positionTitle ?? employee.jobTitle,
        line: employee.lineName,
        loans,
        medicalInsurance,
        monthSalary: parts.totalPayable,
        month,
        netSalary,
        otherAdditions,
        otherDeductions,
        overtime,
        paymentMode,
        secondPart: parts.secondPart,
        socialInsurance,
        totalAdditions,
        totalDeductions,
        unpaidVacations,
        year,
      };
    });
}

async function buildStyledTemplate(
  month: number,
  year: number,
  ready: boolean,
  accessContext: AccessContext,
) {
  const workbook = await loadPayrollTemplateWorkbook();
  const sheet = workbook.worksheets[0] ?? workbook.addWorksheet("Payroll Upload");
  const bodyStyles = captureBodyStyles(sheet);
  const totalsStyle = captureRowStyle(sheet, templateDataEndRow + 1);
  const rows = ready ? await buildReadyRows(month, year, accessContext) : [];
  const displayRows = ready ? rows : [];
  const rowsToKeep = ready ? displayRows.length : 25;
  const totalsRow = prepareTemplateRows(sheet, rowsToKeep);

  writeTitle(sheet, month, year);
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
  const access = await resolveAccessContext(request);
  await assertPermission(access, "payroll", "read");

  const url = new URL(request.url);
  const now = new Date();
  const ready = url.searchParams.get("ready") === "1";
  const upload = url.searchParams.get("upload") === "1";
  const month = numberParam(url.searchParams.get("month"), now.getMonth() + 1);
  const year = numberParam(url.searchParams.get("year"), now.getFullYear());

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
          message: error instanceof Error ? error.message : "Payroll period is invalid.",
        },
        { status: 400 },
      );
    }

    const workbook = await createFallbackWorkbook(await buildUploadRows(month, year), month, year);
    const buffer = await workbook.xlsx.writeBuffer();

    return new Response(buffer, {
      headers: {
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
        message: error instanceof Error ? error.message : "Payroll period is invalid.",
      },
      { status: 400 },
    );
  }

  if (ready && getPayrollScope(access) !== "COMPANY") {
    return new Response("Forbidden", { status: 403 });
  }

  const workbook = await buildStyledTemplate(month, year, ready, access);
  const buffer = await workbook.xlsx.writeBuffer();
  const filename = ready
    ? `phoenix-ready-payroll-${year}-${String(month).padStart(2, "0")}.xlsx`
    : "phoenix-payroll-template.xlsx";

  return new Response(buffer, {
    headers: {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
}
