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
import type { MonthlySalaryRun, NonEmployeePayrollRow } from "../types.ts";
import { sortForExport, unlistedExportHrIds } from "./export-order.ts";

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

/**
 * A previous month's overpayment being recovered this run (owner rule
 * 2026-07-25). Shown as its own column so a past-month correction is legible
 * to finance instead of silently inflating "other deductions".
 */
export function carryForwardExtraColumn(): ExtraColumn {
  return {
    label: "Recovered (prev. overpay)",
    kind: "money",
    value: (entry) => entry.carriedForwardApplied || "",
  };
}

/** SalaryValidationRow → the SalaryRecord shape payrollSheetValue reads (batchId/id unused here). */
function toSheetRecord(entry: AssembledRow): SalaryRecord {
  return { ...entry.row, batchId: "", employeeCode: entry.row.hrId, id: "" } as unknown as SalaryRecord;
}

/** Non-employees' contribution to whichever money column they're folded into, rounded once (matches the TOTALS row's own rounding). */
function sumNonEmployeeTotal(nonEmployees: NonEmployeePayrollRow[]): number {
  return Math.round(nonEmployees.reduce((sum, entry) => sum + entry.totalSalary, 0) * 100) / 100;
}

/**
 * Which money columns one non-employee's amount is written under on this sheet
 * variant.
 *
 * Always the variant's designated value column (`valueHeader` — "First Part" on
 * the Part 1 sheet, "Month Salary" on the full sheet), AND — when the sheet
 * actually carries the installment columns — the column for the installment
 * that person is really paid with.
 *
 * That second part matters (owner-reported 2026-08-08: "the non-employee
 * payroll Part 2 is not showing in the downloaded xlsx"). The full sheet used
 * to write every non-employee into "Month Salary" only, leaving First Part and
 * Second Part blank for them. Two consequences, both wrong:
 *   - a Part 2 non-employee was indistinguishable from a Part 1 one, so the
 *     same person appearing in both installments read as a duplicate row; and
 *   - the TOTALS row stopped footing — measured on the live July run, Month
 *     Salary exceeded First + Second by exactly 381,535.00, the whole
 *     non-employee payroll, with no column showing which installment pays it.
 *
 * The Part 1 sheet is unaffected: it only ever receives `part: "first"` entries
 * and has no "Second Part" column, so this resolves to "First Part" either way.
 */
function nonEmployeeMoneyColumns(
  entry: NonEmployeePayrollRow,
  headers: PayrollSheetHeader[],
  valueHeader: "First Part" | "Month Salary" | undefined,
): Set<string> {
  const columns = new Set<string>();
  if (valueHeader) columns.add(valueHeader);
  const installment: PayrollSheetHeader = entry.part === "second" ? "Second Part" : "First Part";
  if (headers.includes(installment)) columns.add(installment);
  return columns;
}

/**
 * Writes one branded payroll worksheet: brand band, bold header, zebra body,
 * money formatting, held rows in red, and a totals row. When `protect` is set,
 * every cell is locked except the appended `extraColumns` (the finance-edit
 * columns) — the finance-download variant.
 *
 * Non-Employees Payroll (owner rule 2026-07-26): people paid a monthly salary
 * with no employee/HR_ID record are rendered as ADDITIONAL ROWS in this SAME
 * table — under the same "Full Name"/"Arabic Name" headers, and their amount
 * under whichever money column this sheet variant pays out (`nonEmployeeValueHeader`
 * — "First Part" or "Month Salary") — not a separate section below. Every
 * other column (HR_ID, Job Title, Base Salary, etc.) is blank for these rows
 * since those concepts don't apply. Their amount is folded into the TOTALS
 * row's sum for that one column. They still never touch AssembledRow/
 * publishToPayslips — this is display-only, same as before.
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
    nonEmployees?: NonEmployeePayrollRow[];
    nonEmployeeValueHeader?: "First Part" | "Month Salary";
  },
): Promise<{
  sheet: ExcelJS.Worksheet;
  nextRow: number;
  firstPartTotal: number;
  monthSalaryTotal: number;
}> {
  const { run, headers } = options;
  // Owner-fixed HR-ID execution order (2026-07-24) — every downloaded sheet.
  // Anyone the fixed list doesn't cover is grouped by line then hire date
  // rather than dumped in arbitrary order (see sortForExport's doc comment).
  const rows = sortForExport(options.rows, (entry) => entry.row.hrId, {
    fallbackKey: (entry) => `${entry.row.line ?? ""}|${entry.row.hireDate ?? ""}|${entry.row.hrId}`,
  });
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

  // Non-Employees Payroll: additional rows in this SAME table, not a separate
  // section (owner rule 2026-07-26). Only Full Name / Arabic Name / Bank
  // details / the designated value column are populated; everything else
  // (HR_ID, Job Title, Base Salary, etc.) is blank since it doesn't apply.
  const nonEmployees = options.nonEmployees ?? [];
  nonEmployees.forEach((entry, neIndex) => {
    const excelRow = sheet.getRow(rowNumber);
    const zebra = (rows.length + neIndex) % 2 === 1;
    // Both the variant's value column AND this person's own installment column —
    // see nonEmployeeMoneyColumns for why the installment one is load-bearing.
    const moneyColumns = nonEmployeeMoneyColumns(entry, headers, options.nonEmployeeValueHeader);

    headers.forEach((header, ci) => {
      const cell = excelRow.getCell(ci + 1);
      let value: string | number = "";
      if (header === "#") value = rows.length + neIndex + 1;
      else if (header === "Month") value = run.month;
      else if (header === "Year") value = run.year;
      else if (header === "Full Name") value = entry.fullNameEn;
      else if (header === "Arabic Name") value = entry.fullNameAr;
      else if (header === "Payment Group") value = entry.part === "second" ? "Non-Employee · Part 2" : "Non-Employee · Part 1";
      else if (moneyColumns.has(header)) value = entry.totalSalary;
      cell.value = value as ExcelJS.CellValue;
      if (payrollMoneyHeaders.has(header) && typeof value === "number") cell.numFmt = VALUE_FMT;
      cell.font = { color: { argb: SLATE }, name: "Calibri", size: 10 };
      cell.alignment = { horizontal: payrollMoneyHeaders.has(header) ? "right" : "left", vertical: "middle" };
      cell.border = gridBorder();
      if (ci === executionColumnIndex) {
        cell.fill = { fgColor: { argb: EXECUTION_FILL }, pattern: "solid", type: "pattern" };
        cell.font = { ...cell.font, bold: true };
      } else if (zebra) cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
      if (options.protect) cell.protection = { locked: true };
    });

    extraColumns.forEach((column, ei) => {
      const cell = excelRow.getCell(headers.length + ei + 1);
      if (column.label === "Bank Name") cell.value = entry.bankName ?? "";
      else if (column.label === "Bank Account") cell.value = entry.bankAccount ?? "";
      else cell.value = "";
      if (column.kind === "money") cell.numFmt = VALUE_FMT;
      cell.border = gridBorder();
      cell.alignment = { horizontal: column.kind === "money" ? "right" : "left", vertical: "middle" };
      if (zebra) cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
      if (options.protect) cell.protection = { locked: false };
    });

    rowNumber += 1;
  });

  // Totals over money columns — each column picks up exactly the non-employees
  // whose amount was written under it, so First Part + Second Part still foots
  // to Month Salary (it did not before: the whole non-employee payroll landed in
  // Month Salary alone — see nonEmployeeMoneyColumns).
  const totalsRow = sheet.getRow(rowNumber);
  let firstPartTotal = 0;
  let monthSalaryTotal = 0;
  headers.forEach((header, ci) => {
    const cell = totalsRow.getCell(ci + 1);
    if (ci === 0) cell.value = "TOTALS";
    else if (payrollMoneyHeaders.has(header)) {
      const sum = rows.reduce((acc, entry) => {
        const value = payrollSheetValue(toSheetRecord(entry), run.month, run.year, 0, header);
        return acc + (typeof value === "number" ? value : 0);
      }, 0);
      const nonEmployeeContribution = sumNonEmployeeTotal(
        nonEmployees.filter((entry) =>
          nonEmployeeMoneyColumns(entry, headers, options.nonEmployeeValueHeader).has(header),
        ),
      );
      const rounded = Math.round((sum + nonEmployeeContribution) * 100) / 100;
      cell.value = rounded;
      cell.numFmt = VALUE_FMT;
      if (header === "First Part") firstPartTotal = rounded;
      if (header === "Month Salary") monthSalaryTotal = rounded;
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

  return { sheet, nextRow: rowNumber + 1, firstPartTotal, monthSalaryTotal };
}

function coverRows(run: MonthlySalaryRun, rows: AssembledRow[], scopeLabel: string): Array<[string, string]> {
  const held = rows.filter((entry) => entry.onHold).length;
  const joiners = rows.filter((entry) => entry.lifecycle === "joiner").length;
  const leavers = rows.filter((entry) => entry.lifecycle === "leaver").length;
  const recovered = rows.reduce((sum, entry) => sum + entry.carriedForwardApplied, 0);
  const unlisted = unlistedExportHrIds(rows, (entry) => entry.row.hrId);
  const cover: Array<[string, string]> = [
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
  if (recovered > 0) {
    cover.push(["Recovered (prev. overpayments)", String(Math.round(recovered * 100) / 100)]);
  }
  // Make the hand-maintained execution list's drift visible on the sheet
  // itself, so it can't keep degrading unnoticed month after month.
  if (unlisted.length > 0) {
    cover.push([
      "Not in fixed export order",
      `${unlisted.length} employee(s) appended at the end — update FIXED_EXPORT_HR_ID_ORDER`,
    ]);
  }
  return cover;
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
  /** Headcount + total Month Salary from the previous month's published run, if any. */
  previousSummary?: PeriodSummary | null;
  /**
   * People paid a monthly salary with no employee/HR_ID record. Whichever
   * installment each is paid with, their money still leaves the company this
   * month, so the FULL sheet (finance's complete monthly picture) carries BOTH
   * parts — owner decision 2026-07-25, extended 2026-08-03 when Part 2 entries
   * became possible. They still never reach salary_records.
   */
  nonEmployees?: NonEmployeePayrollRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  buildCoverSheet(workbook, {
    title: "Automated Payroll — Full Monthly Sheet",
    subtitle: `${monthLabel(input.run.month, input.run.year)} · HR-confirmed`,
    rows: coverRows(input.run, input.rows, "Full monthly sheet"),
    confidentialNote: CONFIDENTIAL_NOTE,
  });
  addExecutiveSummarySheet(workbook, {
    run: input.run,
    scopeLabel: "Full monthly sheet",
    valueLabel: "Total Month Salary",
    current: {
      headcount: input.rows.length,
      totalValue:
        Math.round(input.rows.reduce((sum, entry) => sum + entry.row.monthSalary, 0) * 100) / 100 +
        sumNonEmployeeTotal(input.nonEmployees ?? []),
    },
    previous: input.previousSummary ?? null,
  });
  await writePayrollWorksheet(workbook, {
    sheetName: "Payroll",
    title: "Full Monthly Sheet",
    subtitle: `${monthLabel(input.run.month, input.run.year)} · all employees`,
    run: input.run,
    rows: input.rows,
    headers: [...payrollSheetHeaders],
    // Owner request 2026-08-08: the Full sheet is finance's complete monthly
    // picture, and until now it was the one sheet in the module that DIDN'T
    // carry bank details — the Part 1 sheet already has them (see
    // buildPart1SheetWorkbook below).
    extraColumns: bankExtraColumns(),
    nonEmployees: input.nonEmployees ?? [],
    nonEmployeeValueHeader: "Month Salary",
  });
  return toBuffer(workbook);
}

const INCREASE_FILL = "FFDCFCE7";
const INCREASE_TEXT = "FF166534";
const DECREASE_FILL = "FFFEE2E2";
const DECREASE_TEXT = "FF991B1B";

/** Headcount + total payout for one period — current (computed from AssembledRow[]) or previous (from salary_records). */
export type PeriodSummary = { headcount: number; totalValue: number };

function periodDelta(current: number, previous: number): { delta: number; percent: number | null } {
  const delta = Math.round((current - previous) * 100) / 100;
  const percent = previous === 0 ? null : Math.round((delta / previous) * 1000) / 10;
  return { delta, percent };
}

/**
 * Appends an "Executive Summary" dashboard tab: headcount and total payout this
 * month vs. the previous month's published run (owner request 2026-07-25) — a
 * professional-looking KPI comparison, not a raw data dump. `valueLabel` names
 * whichever money figure this sheet variant pays out (First Part for Part 1,
 * Month Salary for the full sheet). No-op if there is no previous month to
 * compare against (first-ever run, or the prior month was never published).
 */
function addExecutiveSummarySheet(
  workbook: ExcelJS.Workbook,
  input: {
    run: MonthlySalaryRun;
    scopeLabel: string;
    valueLabel: string;
    current: PeriodSummary;
    previous: PeriodSummary | null;
  },
): void {
  const sheet = workbook.addWorksheet("Executive Summary");
  const title = "Executive Summary Dashboard";
  const subtitle = input.previous
    ? `${monthLabel(input.run.month, input.run.year)} · ${input.scopeLabel} · vs. previous month`
    : `${monthLabel(input.run.month, input.run.year)} · ${input.scopeLabel} · no previous month to compare`;
  bandHeader(sheet, 5, title, subtitle);

  const headerRowNumber = 5;
  const labels = ["Metric", "This Month", "Last Month", "Change", "% Change"];
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

  const metrics: { label: string; current: number; previous: number | null; money: boolean }[] = [
    { label: "Employees", current: input.current.headcount, previous: input.previous?.headcount ?? null, money: false },
    { label: input.valueLabel, current: input.current.totalValue, previous: input.previous?.totalValue ?? null, money: true },
  ];

  metrics.forEach((metric, index) => {
    const rowNumber = headerRowNumber + 1 + index;
    const excelRow = sheet.getRow(rowNumber);
    const hasPrevious = metric.previous != null;
    const { delta, percent } = hasPrevious ? periodDelta(metric.current, metric.previous!) : { delta: 0, percent: null };
    const increase = delta > 0;
    const decrease = delta < 0;

    const cells: (string | number)[] = [
      metric.label,
      metric.current,
      hasPrevious ? metric.previous! : "—",
      hasPrevious ? delta : "—",
      hasPrevious ? (percent == null ? "—" : `${percent > 0 ? "+" : ""}${percent}%`) : "—",
    ];
    cells.forEach((value, ci) => {
      const cell = excelRow.getCell(ci + 1);
      cell.value = value as ExcelJS.CellValue;
      if (metric.money && (ci === 1 || ci === 2 || ci === 3) && typeof value === "number") cell.numFmt = VALUE_FMT;
      cell.font = {
        bold: ci === 0 || ci === 3,
        color: { argb: ci === 3 && hasPrevious ? (increase ? INCREASE_TEXT : decrease ? DECREASE_TEXT : SLATE) : SLATE },
        name: "Calibri",
        size: ci === 0 ? 11 : 10,
      };
      cell.alignment = { horizontal: ci === 0 ? "left" : "right", vertical: "middle" };
      cell.border = gridBorder();
      if (ci === 3 && hasPrevious && (increase || decrease)) {
        cell.fill = { fgColor: { argb: increase ? INCREASE_FILL : DECREASE_FILL }, pattern: "solid", type: "pattern" };
      } else if (index % 2 === 1) {
        cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
      }
    });
  });

  labels.forEach((label, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = Math.max(column.width ?? 9, Math.min(30, Math.max(14, label.length + 4)));
  });
  sheet.getColumn(1).width = 28;
  sheet.views = [{ state: "frozen", xSplit: 0, ySplit: headerRowNumber, showGridLines: false }];
}

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
  /** People paid a monthly salary with no employee/HR_ID record (owner rule 2026-07-25). */
  nonEmployees?: NonEmployeePayrollRow[];
  /** Headcount + total First Part from the previous month's published run, if any. */
  previousSummary?: PeriodSummary | null;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  buildCoverSheet(workbook, {
    title: "Automated Payroll — Part 1 Sheet",
    subtitle: `${monthLabel(input.run.month, input.run.year)} · first installment`,
    rows: coverRows(input.run, input.rows, "Part 1 (first installment)"),
    confidentialNote: CONFIDENTIAL_NOTE,
  });
  addExecutiveSummarySheet(workbook, {
    run: input.run,
    scopeLabel: "Part 1 (first installment)",
    valueLabel: "Total First Part",
    current: {
      headcount: input.rows.length,
      totalValue:
        Math.round(input.rows.reduce((sum, entry) => sum + entry.row.firstPart, 0) * 100) / 100 +
        sumNonEmployeeTotal(input.nonEmployees ?? []),
    },
    previous: input.previousSummary ?? null,
  });
  await writePayrollWorksheet(workbook, {
    sheetName: "Part 1",
    title: "Part 1 — First Installment",
    subtitle: `${monthLabel(input.run.month, input.run.year)}`,
    run: input.run,
    rows: input.rows,
    headers: PART1_HEADERS,
    extraColumns: [...bankExtraColumns(), carryForwardExtraColumn()],
    nonEmployees: input.nonEmployees ?? [],
    nonEmployeeValueHeader: "First Part",
  });
  addSalaryChangesSheet(workbook, {
    run: input.run,
    rows: input.rows,
    previousNetByHrIdCompact: input.previousNetByHrIdCompact ?? new Map(),
  });
  return toBuffer(workbook);
}
