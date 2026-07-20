import ExcelJS from "exceljs";

import { buildCoverSheet } from "@/lib/export/phoenix-xlsx-style";
import {
  payrollMoneyHeaders,
  payrollSheetHeaders,
  payrollSheetValue,
  type PayrollSheetHeader,
} from "@/lib/payroll/salary-sheet-fields";
import type { SalaryRecord } from "@/lib/payroll/types";
import {
  AMBER,
  BLACK,
  bandHeader,
  gridBorder,
  SLATE,
  VALUE_FMT,
  WHITE,
  ZEBRA,
} from "@/lib/sales/sales-workbook-kit";

import type { AssembledRow } from "../assemble.ts";
import { monthLabel } from "../notify.ts";
import type { MonthlySalaryRun } from "../types.ts";

const HELD_FILL = "FFFEE2E2";
const HELD_TEXT = "FF991B1B";

/** The Part-1 sheet's focused column subset (first installment). */
export const PART1_HEADERS: PayrollSheetHeader[] = [
  "#",
  "Month",
  "Year",
  "HR_ID",
  "Full Name",
  "Arabic Name",
  "Job Title",
  "Line",
  "Area",
  "Hire Date",
  "Base Salary",
  "Gross Salary",
  "Net Salary",
  "Finger Print",
  "First Part",
  "Payment Group",
  "Policy Comment",
];

export type ExtraColumn = { label: string; kind: "money" | "text" };

/** SalaryValidationRow → the SalaryRecord shape payrollSheetValue reads (batchId/id unused here). */
function toSheetRecord(entry: AssembledRow): SalaryRecord {
  return { ...entry.row, batchId: "", employeeCode: entry.row.hrId, id: "" } as unknown as SalaryRecord;
}

/**
 * Writes one branded payroll worksheet: brand band, bold header, zebra body,
 * money formatting, held rows in red, and a totals row. When `protect` is set,
 * every cell is locked except the appended `extraColumns` (the finance-edit
 * columns) — the finance-download variant.
 */
export async function writePayrollWorksheet(
  workbook: ExcelJS.Workbook,
  options: {
    sheetName: string;
    title: string;
    subtitle: string;
    run: MonthlySalaryRun;
    rows: AssembledRow[];
    headers: PayrollSheetHeader[];
    extraColumns?: ExtraColumn[];
    protect?: boolean;
  },
): Promise<void> {
  const { run, rows, headers } = options;
  const extraColumns = options.extraColumns ?? [];
  const labels = [...headers, ...extraColumns.map((column) => column.label)];
  const colCount = labels.length;

  const sheet = workbook.addWorksheet(options.sheetName);
  bandHeader(sheet, colCount, options.title, options.subtitle);

  const headerRowNumber = 5;
  const headerRow = sheet.getRow(headerRowNumber);
  labels.forEach((label, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.border = gridBorder();
    if (options.protect) cell.protection = { locked: true };
  });
  headerRow.height = 26;

  let rowNumber = headerRowNumber + 1;
  rows.forEach((entry, index) => {
    const record = toSheetRecord(entry);
    const excelRow = sheet.getRow(rowNumber);
    const zebra = index % 2 === 1;

    headers.forEach((header, ci) => {
      const cell = excelRow.getCell(ci + 1);
      const value = payrollSheetValue(record, run.month, run.year, index + 1, header);
      cell.value = value as ExcelJS.CellValue;
      if (payrollMoneyHeaders.has(header) && typeof value === "number") cell.numFmt = VALUE_FMT;
      cell.font = {
        color: { argb: entry.onHold ? HELD_TEXT : SLATE },
        bold: entry.onHold,
        name: "Calibri",
        size: 10,
      };
      cell.alignment = { horizontal: payrollMoneyHeaders.has(header) ? "right" : "left", vertical: "middle" };
      cell.border = gridBorder();
      if (entry.onHold) cell.fill = { fgColor: { argb: HELD_FILL }, pattern: "solid", type: "pattern" };
      else if (zebra) cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
      if (options.protect) cell.protection = { locked: true };
    });

    extraColumns.forEach((column, ei) => {
      const cell = excelRow.getCell(headers.length + ei + 1);
      cell.value = "";
      if (column.kind === "money") cell.numFmt = VALUE_FMT;
      cell.border = gridBorder();
      cell.alignment = { horizontal: column.kind === "money" ? "right" : "left", vertical: "middle" };
      if (entry.onHold) cell.fill = { fgColor: { argb: HELD_FILL }, pattern: "solid", type: "pattern" };
      else if (zebra) cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
      // Finance-edit columns stay editable even on a protected sheet.
      if (options.protect) cell.protection = { locked: false };
    });

    rowNumber += 1;
  });

  // Totals over money columns.
  const totalsRow = sheet.getRow(rowNumber);
  headers.forEach((header, ci) => {
    const cell = totalsRow.getCell(ci + 1);
    if (ci === 0) cell.value = "TOTALS";
    else if (payrollMoneyHeaders.has(header)) {
      const sum = rows.reduce((acc, entry) => {
        const value = payrollSheetValue(toSheetRecord(entry), run.month, run.year, 0, header);
        return acc + (typeof value === "number" ? value : 0);
      }, 0);
      cell.value = Math.round(sum * 100) / 100;
      cell.numFmt = VALUE_FMT;
    }
    cell.font = { bold: true, color: { argb: BLACK }, name: "Calibri", size: 10.5 };
    cell.fill = { fgColor: { argb: AMBER }, pattern: "solid", type: "pattern" };
    cell.border = gridBorder();
    cell.alignment = { horizontal: payrollMoneyHeaders.has(header) ? "right" : "left", vertical: "middle" };
    if (options.protect) cell.protection = { locked: true };
  });

  // Column widths.
  labels.forEach((label, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = Math.max(column.width ?? 9, Math.min(28, Math.max(12, label.length + 2)));
  });
  sheet.getColumn(5).width = 26; // Full Name
  sheet.views = [{ state: "frozen", xSplit: 0, ySplit: headerRowNumber, showGridLines: false }];

  if (options.protect) {
    await sheet.protect("", {
      selectLockedCells: true,
      selectUnlockedCells: true,
      formatCells: true,
      formatColumns: true,
      formatRows: true,
      autoFilter: true,
      sort: true,
    });
  }
}

function coverRows(run: MonthlySalaryRun, rows: AssembledRow[], scopeLabel: string): Array<[string, string]> {
  const held = rows.filter((entry) => entry.onHold).length;
  const joiners = rows.filter((entry) => entry.lifecycle === "joiner").length;
  const leavers = rows.filter((entry) => entry.lifecycle === "leaver").length;
  return [
    ["Period", monthLabel(run.month, run.year)],
    ["Scope", scopeLabel],
    ["Employees", String(rows.length)],
    ["New hires", String(joiners)],
    ["Resignations", String(leavers)],
    ["On hold", String(held)],
    ["Part 1 confirmed", run.part1ConfirmedAt ? "Yes" : "No"],
    ["Part 2 confirmed", run.part2ConfirmedAt ? "Yes" : "No"],
    ["Published", run.publishedAt ? "Yes" : "No"],
  ];
}

const CONFIDENTIAL_NOTE =
  "CONFIDENTIAL — Payroll compensation data. For authorized finance and executive review only.";

async function toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

/** The full 36-column branded monthly sheet. */
export async function buildFullSheetWorkbook(input: {
  run: MonthlySalaryRun;
  rows: AssembledRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  buildCoverSheet(workbook, {
    title: "Automated Payroll — Full Monthly Sheet",
    subtitle: `${monthLabel(input.run.month, input.run.year)} · HR-confirmed`,
    rows: coverRows(input.run, input.rows, "Full monthly sheet"),
    confidentialNote: CONFIDENTIAL_NOTE,
  });
  await writePayrollWorksheet(workbook, {
    sheetName: "Payroll",
    title: "Full Monthly Sheet",
    subtitle: `${monthLabel(input.run.month, input.run.year)} · all employees`,
    run: input.run,
    rows: input.rows,
    headers: [...payrollSheetHeaders],
  });
  return toBuffer(workbook);
}

/** The Part-1 focused sheet (first installment). */
export async function buildPart1SheetWorkbook(input: {
  run: MonthlySalaryRun;
  rows: AssembledRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  buildCoverSheet(workbook, {
    title: "Automated Payroll — Part 1 Sheet",
    subtitle: `${monthLabel(input.run.month, input.run.year)} · first installment`,
    rows: coverRows(input.run, input.rows, "Part 1 (first installment)"),
    confidentialNote: CONFIDENTIAL_NOTE,
  });
  await writePayrollWorksheet(workbook, {
    sheetName: "Part 1",
    title: "Part 1 — First Installment",
    subtitle: `${monthLabel(input.run.month, input.run.year)}`,
    run: input.run,
    rows: input.rows,
    headers: PART1_HEADERS,
  });
  return toBuffer(workbook);
}
