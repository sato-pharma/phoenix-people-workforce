import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import path from "node:path";

import { assertPermission, getPayrollScope, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getApprovedExpenseTotalsForPayroll } from "@/lib/payroll/expenses";
import { calculatePayrollParts, payrollPaymentModeLabel } from "@/lib/payroll/policy";
import { getLatestSalaryRecordsBefore } from "@/lib/payroll/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const templateFileName = "Phoneix system template.xlsx";
const dataStartRow = 6;
const templateDataEndRow = 126;
const totalsLabel = "TOTALS";
const headers = [
  "#",
  "HR_ID",
  "Full Name",
  "Arabic Name",
  "Job Title",
  "Line",
  "Area",
  "Hire Date",
  "Net Salary",
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
  "Month Salary",
  "First Part",
  "Second Part",
  "Payment Group",
  "Policy Comment",
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
    cells: Array.from({ length: 31 }, (_, index) => {
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
  upsertWorkingDaysCalcSheet(workbook, new Date().getMonth() + 1, new Date().getFullYear());

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
  upsertWorkingDaysCalcSheet(workbook, now.getMonth() + 1, now.getFullYear());
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

  for (let column = 1; column <= 31; column += 1) {
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
    row.paymentMode,
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
  row.getCell(30).value = "";
  row.getCell(31).value = "";
  applyRowStyle(sheet, totalsRow, totalsStyle);
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
    ["Net Salary", 17500],
    ["Cost of Living", 2000],
    ["Fuel", 500],
    ["Base Salary", { formula: "B5-B6-B7" }],
    ["Days in Month", { formula: "DAY(EOMONTH(DATE(B3,B4,1),0))" }],
    ["Base Daily Rate", { formula: "B8/B9" }],
    ["Net Daily Rate", { formula: "B5/B9" }],
  ]);

  forCells(sheet, 3, 1, 11, 1, (cell) => {
    cell.font = { bold: true, color: { argb: "FF374151" } };
  });
  forCells(sheet, 3, 2, 7, 2, (cell) => styleInputCell(cell));
  forCells(sheet, 5, 2, 8, 2, (cell) => {
    cell.numFmt = "#,##0.00";
  });
  sheet.getCell("B10").numFmt = "#,##0.00";
  sheet.getCell("B11").numFmt = "#,##0.00";

  writeMatrix(sheet, 3, 4, [
    ["Legend", "", "", "", ""],
    ["Worked day", "", "Weekend Fri/Sat", "", "Not worked"],
    ["Entry/exit day", "", "Inputs", "", "Formula result"],
    ["", "", "", "", ""],
    ["Base = Net Salary - CoL - Fuel", "", "", "", ""],
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
    ["Full month", 1, { formula: "$B$9" }, { formula: "C14-B14+1" }, { formula: "$B$11*D14" }],
    ["New employee", 15, { formula: "$B$9" }, { formula: "C15-B15+1" }, { formula: "$B$11*D15" }],
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
    sheet.getCell(`${letter}14`).value = { formula: `IF(${letter}$13<=$B$9,TEXT(DATE($B$3,$B$4,${letter}$13),"ddd"),"")` };
    for (let row = 15; row <= 17; row += 1) {
      sheet.getCell(row, column).value = {
        formula: `IF(${letter}$13>$B$9,"",IF(OR(${letter}$13=$B${row - 1},${letter}$13=$C${row - 1}),"Boundary",IF(WEEKDAY(DATE($B$3,$B$4,${letter}$13),2)>5,"Weekend",IF(AND(${letter}$13>=$B${row - 1},${letter}$13<=$C${row - 1}),"Worked","Off"))))`,
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
      const parts = calculatePayrollParts({
        additions: 0,
        deductions: 0,
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
  writePayrollRows(sheet, displayRows, bodyStyles);
  writeTotals(sheet, totalsRow, displayRows, totalsStyle);
  upsertWorkingDaysCalcSheet(workbook, month, year);
  sheet.name = "Payroll Upload";
  sheet.views = [{ state: "frozen", ySplit: 5 }];
  sheet.autoFilter = {
    from: { column: 1, row: 5 },
    to: { column: 31, row: Math.max(totalsRow - 1, dataStartRow) },
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

  if (upload) {
    const workbook = await createFallbackWorkbook();
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

  const month = numberParam(url.searchParams.get("month"), now.getMonth() + 1);
  const year = numberParam(url.searchParams.get("year"), now.getFullYear());
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
