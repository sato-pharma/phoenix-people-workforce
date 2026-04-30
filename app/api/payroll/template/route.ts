import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { calculatePayrollParts, payrollPaymentModeLabel } from "@/lib/payroll/policy";
import { getLatestSalaryRecordsBefore } from "@/lib/payroll/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const templateFileName = "Phoneix system template.xlsx";
const dataStartRow = 6;
const templateDataEndRow = 126;
const totalsLabel = "TOTALS";
const headers = [
  "HR_ID",
  "Full Name",
  "Line",
  "Area",
  "Job Title",
  "Gross Salary",
  "Expenses",
  "Incentive",
  "Overtime",
  "Bonus",
  "Extra Cost of Living",
  "Fuel Allowance",
  "Other Additions",
  "Total Additions",
  "Social Insurance",
  "Employment Income Tax",
  "CRM",
  "Finger Print",
  "Unpaid Vacations",
  "Medical Insurance",
  "Loans",
  "Other Deductions",
  "Total Deductions",
  "Net Salary",
  "First Part",
  "Second Part",
  "Month",
  "Year",
];

type PayrollTemplateRow = {
  arabicName: string | null;
  area: string | null;
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
  hireDate: string | null;
  incentive: number;
  jobTitle: string | null;
  line: string | null;
  loans: number;
  medicalInsurance: number;
  monthSalary: number;
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
    cells: Array.from({ length: 30 }, (_, index) => {
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

async function createFallbackWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Payroll Upload");

  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    fgColor: { argb: "FFFF6B00" },
    pattern: "solid",
    type: "pattern",
  };
  sheet.getRow(1).height = 24;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { column: 1, row: 1 },
    to: { column: headers.length, row: 1 },
  };
  sheet.columns = headers.map((header) => ({
    header,
    key: header,
    width: Math.max(header.length + 4, 14),
  }));

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
  const templatePath = payrollTemplatePath();

  if (existsSync(templatePath)) {
    const buffer = await readFile(templatePath);

    return new Response(buffer, {
      headers: {
        "Content-Disposition": 'attachment; filename="phoenix-payroll-template.xlsx"',
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  }

  const workbook = await createFallbackWorkbook();
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

  for (let column = 1; column <= 30; column += 1) {
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
    row.employeeCode,
    row.fullName,
    row.arabicName ?? "",
    row.jobTitle ?? "",
    row.line ?? "",
    row.area ?? "",
    row.hireDate ? new Date(row.hireDate) : "",
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
    row.comment,
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
  row.getCell(9).value = total((item) => item.netSalary);
  row.getCell(10).value = total((item) => item.expenses);
  row.getCell(11).value = total((item) => item.incentive);
  row.getCell(12).value = total((item) => item.overtime);
  row.getCell(13).value = total((item) => item.bonus);
  row.getCell(14).value = total((item) => item.extraCostOfLiving);
  row.getCell(15).value = total((item) => item.fuelAllowance);
  row.getCell(16).value = total((item) => item.otherAdditions);
  row.getCell(17).value = total((item) => item.totalAdditions);
  row.getCell(18).value = total((item) => item.socialInsurance);
  row.getCell(19).value = total((item) => item.employmentIncomeTax);
  row.getCell(20).value = total((item) => item.crm);
  row.getCell(21).value = total((item) => item.fingerPrint);
  row.getCell(22).value = total((item) => item.unpaidVacations);
  row.getCell(23).value = total((item) => item.medicalInsurance);
  row.getCell(24).value = total((item) => item.loans);
  row.getCell(25).value = total((item) => item.otherDeductions);
  row.getCell(26).value = total((item) => item.totalDeductions);
  row.getCell(27).value = total((item) => item.monthSalary);
  row.getCell(28).value = total((item) => item.firstPart);
  row.getCell(29).value = total((item) => item.secondPart);
  applyRowStyle(sheet, totalsRow, totalsStyle);
  row.commit();
}

async function buildReadyRows(month: number, year: number): Promise<PayrollTemplateRow[]> {
  const [directory, previousRecords] = await Promise.all([
    getEmployeeDirectory(),
    getLatestSalaryRecordsBefore(month, year),
  ]);
  const previousExpensesByEmployee = new Map(
    previousRecords.map((record) => [record.employeeCode, record.expenses]),
  );

  return directory.employees
    .filter((employee) => (employee.employmentStatus ?? "active") === "active")
    .map((employee) => {
      const expenses = money(previousExpensesByEmployee.get(employee.hrId));
      const parts = calculatePayrollParts({
        extraCostOfLiving: employee.extraCostOfLiving,
        fuelAllowance: employee.fuelAllowance,
        netSalary: employee.netSalary,
        paymentMode: employee.salaryPaymentMode,
        previousExpenses: expenses,
      });
      const socialInsurance = money(employee.socialInsurance);
      const employmentIncomeTax = money(employee.taxes);
      const medicalInsurance = money(employee.medicalInsurance);
      const extraCostOfLiving = money(employee.extraCostOfLiving);
      const fuelAllowance = money(employee.fuelAllowance);
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
        socialInsurance +
          employmentIncomeTax +
          crm +
          fingerPrint +
          unpaidVacations +
          medicalInsurance +
          loans +
          otherDeductions,
      );
      const paymentMode = payrollPaymentModeLabel(parts.paymentMode);

      return {
        arabicName: employee.nameAr,
        area: employee.areaName,
        bonus,
        comment: `${paymentMode}. Generated from employee master data.`,
        crm,
        employeeCode: employee.hrId,
        employmentIncomeTax,
        expenses,
        extraCostOfLiving,
        fingerPrint,
        firstPart: parts.firstPart,
        fuelAllowance,
        fullName: employee.fullName,
        hireDate: employee.hireDate,
        incentive,
        jobTitle: employee.positionTitle ?? employee.jobTitle,
        line: employee.lineName,
        loans,
        medicalInsurance,
        monthSalary: parts.totalPayable,
        netSalary: money(employee.netSalary),
        otherAdditions,
        otherDeductions,
        overtime,
        paymentMode,
        secondPart: parts.secondPart,
        socialInsurance,
        totalAdditions,
        totalDeductions,
        unpaidVacations,
      };
    });
}

async function buildStyledTemplate(month: number, year: number, ready: boolean) {
  const workbook = await loadPayrollTemplateWorkbook();
  const sheet = workbook.worksheets[0] ?? workbook.addWorksheet("Payroll Upload");
  const bodyStyles = captureBodyStyles(sheet);
  const totalsStyle = captureRowStyle(sheet, templateDataEndRow + 1);
  const rows = ready ? await buildReadyRows(month, year) : [];
  const displayRows = ready ? rows : [];
  const rowsToKeep = ready ? displayRows.length : 25;
  const totalsRow = prepareTemplateRows(sheet, rowsToKeep);

  writeTitle(sheet, month, year);
  writePayrollRows(sheet, displayRows, bodyStyles);
  writeTotals(sheet, totalsRow, displayRows, totalsStyle);
  sheet.name = "Payroll Upload";
  sheet.views = [{ state: "frozen", ySplit: 5 }];
  sheet.autoFilter = {
    from: { column: 1, row: 5 },
    to: { column: 30, row: Math.max(totalsRow - 1, dataStartRow) },
  };

  return workbook;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const now = new Date();
  const ready = url.searchParams.get("ready") === "1";

  if (!ready) {
    return exactTemplateResponse();
  }

  const month = numberParam(url.searchParams.get("month"), now.getMonth() + 1);
  const year = numberParam(url.searchParams.get("year"), now.getFullYear());
  const workbook = await buildStyledTemplate(month, year, ready);
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
