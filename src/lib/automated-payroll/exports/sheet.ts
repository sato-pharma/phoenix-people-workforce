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
import { sortForExport } from "./export-order.ts";

const HELD_FILL = "FFFEE2E2";
const HELD_TEXT = "FF991B1B";
/** The First Part is the amount HR/finance actually executes (pays out) this Part-1 run. */
const EXECUTION_FILL = "FFDCFCE7";
const EXECUTION_HEADER_FILL = "FF166534";

/**
 * The Part-1 sheet's focused column subset (first installment). "First Part" is
 * the execution/payout column — highlighted distinctly by writePayrollWorksheet.
 */
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
  "Extra Cost of Living",
  "Fuel Allowance",
  "Finger Print",
  "Medical Insurance",
  "Total Deductions",
  "Month Salary",
  "First Part",
  "Payment Group",
  "Policy Comment",
];

/** Columns appended after `headers`, computed from the row (bank details) or left blank for manual fill-in (Finance Edit). */
export type ExtraColumn = {
  label: string;
  kind: "money" | "text";
  value?: (entry: AssembledRow) => string | number | null;
};

/** Bank details for wire execution — not part of the canonical SalaryValidationRow, computed per row. */
export function bankExtraColumns(): ExtraColumn[] {
  return [
    { label: "Bank Name", kind: "text", value: (entry) => entry.bankName ?? "" },
    { label: "Bank Account", kind: "text", value: (entry) => entry.bankAccount ?? "" },
  ];
}

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
  const { run, headers } = options;
  // Owner-fixed HR-ID execution order (2026-07-24) — every downloaded sheet.
  const rows = sortForExport(options.rows, (entry) => entry.row.hrId);
  const extraColumns = options.extraColumns ?? [];
  const labels = [...headers, ...extraColumns.map((column) => column.label)];
  const colCount = labels.length;
  const executionColumnIndex = headers.indexOf("First Part");

  const sheet = workbook.addWorksheet(options.sheetName);
  bandHeader(sheet, colCount, options.title, options.subtitle);

  const headerRowNumber = 5;
  const headerRow = sheet.getRow(headerRowNumber);
  labels.forEach((label, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    // The execution column (First Part — the amount actually paid this run) gets
    // its own header color so it stands out from every other column at a glance.
    cell.fill = {
      fgColor: { argb: index === executionColumnIndex ? EXECUTION_HEADER_FILL : BLACK },
      pattern: "solid",
      type: "pattern",
    };
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
      else if (ci === executionColumnIndex) {
        cell.fill = { fgColor: { argb: EXECUTION_FILL }, pattern: "solid", type: "pattern" };
        cell.font = { ...cell.font, bold: true };
      } else if (zebra) cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
      if (options.protect) cell.protection = { locked: true };
    });

    extraColumns.forEach((column, ei) => {
      const cell = excelRow.getCell(headers.length + ei + 1);
      cell.value = column.value ? (column.value(entry) ?? "") : "";
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

const INCREASE_FILL = "FFDCFCE7";
const INCREASE_TEXT = "FF166534";
const DECREASE_FILL = "FFFEE2E2";
const DECREASE_TEXT = "FF991B1B";

/**
 * Appends a "Salary Changes" tab listing only employees whose Net Salary this
 * run differs from their Net Salary on the previous month's published run —
 * green for an increase, red for a decrease. Employees with no prior baseline
 * (new hires) or no change are omitted. No-op if there is no previous data.
 */
function addSalaryChangesSheet(
  workbook: ExcelJS.Workbook,
  input: { run: MonthlySalaryRun; rows: AssembledRow[]; previousNetByHrIdCompact: Map<string, number> },
): void {
  if (input.previousNetByHrIdCompact.size === 0) return;

  type ChangeEntry = { hrId: string; fullName: string; previousNet: number; currentNet: number; delta: number };
  const changes: ChangeEntry[] = [];
  for (const entry of input.rows) {
    const compact = entry.compact;
    const previousNet = input.previousNetByHrIdCompact.get(compact);
    if (previousNet === undefined) continue;
    const currentNet = entry.row.netSalary;
    const delta = Math.round((currentNet - previousNet) * 100) / 100;
    if (Math.abs(delta) < 0.01) continue;
    changes.push({ currentNet, delta, fullName: entry.row.fullName, hrId: entry.row.hrId, previousNet });
  }
  if (changes.length === 0) return;
  const sorted = sortForExport(changes, (change) => change.hrId);

  const sheet = workbook.addWorksheet("Salary Changes");
  const title = "Salary Changes vs. Previous Month";
  const subtitle = `${monthLabel(input.run.month, input.run.year)} · green = increase, red = decrease`;
  bandHeader(sheet, 5, title, subtitle);

  const headerRowNumber = 5;
  const labels = ["HR_ID", "Full Name", "Previous Net Salary", "Current Net Salary", "Change"];
  const headerRow = sheet.getRow(headerRowNumber);
  labels.forEach((label, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.border = gridBorder();
  });
  headerRow.height = 26;

  sorted.forEach((change, index) => {
    const rowNumber = headerRowNumber + 1 + index;
    const excelRow = sheet.getRow(rowNumber);
    const increase = change.delta > 0;
    const fill = increase ? INCREASE_FILL : DECREASE_FILL;
    const text = increase ? INCREASE_TEXT : DECREASE_TEXT;
    const values = [change.hrId, change.fullName, change.previousNet, change.currentNet, change.delta];
    values.forEach((value, ci) => {
      const cell = excelRow.getCell(ci + 1);
      cell.value = value as ExcelJS.CellValue;
      if (ci >= 2) cell.numFmt = VALUE_FMT;
      cell.font = { color: { argb: text }, bold: ci === 4, name: "Calibri", size: 10 };
      cell.alignment = { horizontal: ci >= 2 ? "right" : "left", vertical: "middle" };
      cell.border = gridBorder();
      cell.fill = { fgColor: { argb: fill }, pattern: "solid", type: "pattern" };
    });
  });

  labels.forEach((label, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = Math.max(column.width ?? 9, Math.min(28, Math.max(14, label.length + 2)));
  });
  sheet.getColumn(2).width = 26;
  sheet.views = [{ state: "frozen", xSplit: 0, ySplit: headerRowNumber, showGridLines: false }];
}

/** The Part-1 focused sheet (first installment). */
export async function buildPart1SheetWorkbook(input: {
  run: MonthlySalaryRun;
  rows: AssembledRow[];
  /** Net Salary per employee (keyed by compact HR id) from the previous month's published run, if any. */
  previousNetByHrIdCompact?: Map<string, number>;
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
    extraColumns: bankExtraColumns(),
  });
  addSalaryChangesSheet(workbook, {
    run: input.run,
    rows: input.rows,
    previousNetByHrIdCompact: input.previousNetByHrIdCompact ?? new Map(),
  });
  return toBuffer(workbook);
}
