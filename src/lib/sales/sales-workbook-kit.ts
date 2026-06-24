import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";

// Shared Phoenix-branded workbook primitives: brand palette, formula helpers, a generic
// black-header / light-orange-grid table writer, and a hidden "Data" sheet planner. Report
// numbers are written as live Excel formulas (SUMIFS / COUNTIFS / division) that reference the
// Data sheet, each with a cached result so the file opens correct and recalculates when edited.
// No charts. Used by the Executive Report export (the Monthly Closing export keeps its own copy).

export const BLACK = "FF000000";
export const ORANGE = "FFF97316";
export const AMBER = "FFFDE7C7";
export const ORANGE_LINE = "FFF8B56B";
export const WHITE = "FFFFFFFF";
export const SLATE = "FF334155";
export const MUTED = "FF94A3B8";
export const ZEBRA = "FFF8FAFC";

export const UNITS_FMT = "#,##0";
export const VALUE_FMT = "#,##0.00";
export const PCT_FMT = "0.0%";

export function gridBorder(): ExcelJS.Borders {
  const side = { style: "thin" as const, color: { argb: ORANGE_LINE } };
  return { top: side, left: side, bottom: side, right: side } as ExcelJS.Borders;
}

export function sanitizeSheetName(name: string) {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || "Sheet").slice(0, 31);
}

// ── Formula helpers ──────────────────────────────────────────────────────────

export type Formula = { formula: string; result: number };
export const isFormula = (value: unknown): value is Formula =>
  typeof value === "object" && value !== null && "formula" in (value as Record<string, unknown>);
export const F = (formula: string, result: number): Formula => ({ formula, result });

const quote = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
export const sumifs = (sumRange: string, criteria: [string, string | number][]) =>
  `SUMIFS(${sumRange}${criteria.map(([range, value]) => `,${range},${quote(value)}`).join("")})`;
export const countifs = (criteria: [string, string | number][]) =>
  `COUNTIFS(${criteria.map(([range, value]) => `${range},${quote(value)}`).join(",")})`;
export const sumAll = (range: string) => `SUM(${range})`;
export const div0 = (numerator: string, denominator: string) => `IFERROR(${numerator}/${denominator},0)`;

// ── Hidden Data sheet planner ────────────────────────────────────────────────

export type DataBlockDef = { headers: string[]; rows: (string | number)[][] };
export type DataBlock = DataBlockDef & { firstData: number; headerRow: number };

// Plans the hidden Data sheet layout (and the formula ranges) WITHOUT writing it, so the report
// sheets can be written first and the Data sheet added last — keeping a visible report sheet as
// the active tab (Excel refuses to hide the active sheet, which would otherwise show Data).
export function planBlocks(defs: DataBlockDef[]): {
  blocks: DataBlock[];
  rangeOf: (blockIndex: number, column: string) => string;
} {
  let cursor = 3; // after the intro row (1) + a blank row (2)
  const blocks: DataBlock[] = defs.map((def) => {
    const headerRow = cursor;
    const firstData = headerRow + 1;
    const span = Math.max(1, def.rows.length); // keep a valid range even when empty
    cursor = firstData + span - 1 + 1 + 2; // last data row + gap
    return { ...def, firstData, headerRow };
  });
  const lastOf = (block: DataBlock) => block.firstData + Math.max(1, block.rows.length) - 1;
  const rangeOf = (blockIndex: number, column: string) => {
    const block = blocks[blockIndex];
    return `Data!$${column}$${block.firstData}:$${column}$${lastOf(block)}`;
  };
  return { blocks, rangeOf };
}

export function writeDataSheet(workbook: ExcelJS.Workbook, blocks: DataBlock[]) {
  const sheet = workbook.addWorksheet("Data");
  sheet.state = "hidden";
  const intro = sheet.getCell(1, 1);
  intro.value = "Source data — the report sheets reference these cells with live formulas. Editing these recalculates the report.";
  intro.font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 10 };
  let maxCols = 1;
  blocks.forEach((block) => {
    maxCols = Math.max(maxCols, block.headers.length);
    block.headers.forEach((header, index) => {
      const cell = sheet.getCell(block.headerRow, index + 1);
      cell.value = header;
      cell.font = { bold: true, name: "Calibri", size: 10 };
    });
    block.rows.forEach((cells, rowOffset) => {
      cells.forEach((value, index) => { sheet.getCell(block.firstData + rowOffset, index + 1).value = value; });
    });
  });
  for (let col = 1; col <= maxCols; col += 1) sheet.getColumn(col).width = 16;
}

// ── Generic table writer ─────────────────────────────────────────────────────

export type TableColumn = { dataBar?: boolean; label: string; numFmt?: string; right?: boolean; width?: number };
export type CellValue = string | number | null | Formula;

function setColumnWidth(sheet: ExcelJS.Worksheet, index: number, width: number) {
  const column = sheet.getColumn(index);
  column.width = Math.max(column.width ?? 9, width);
}

export function applyDataBar(sheet: ExcelJS.Worksheet, ref: string) {
  try {
    const rule = { cfvo: [{ type: "min" as const }, { type: "max" as const }], color: { argb: ORANGE }, gradient: false, priority: 1, showValue: true, type: "dataBar" as const };
    sheet.addConditionalFormatting({ ref, rules: [rule] });
  } catch {
    // data-bars are optional cosmetics — never fail the export over them.
  }
}

export function setCell(cell: ExcelJS.Cell, raw: CellValue, numFmt?: string) {
  if (raw === null || raw === undefined || raw === "") {
    cell.value = "";
  } else if (isFormula(raw)) {
    cell.value = { formula: raw.formula, result: raw.result };
    if (numFmt) cell.numFmt = numFmt;
  } else {
    cell.value = raw;
    if (typeof raw === "number" && numFmt) cell.numFmt = numFmt;
  }
}

export function writeTable(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  options: { columns: TableColumn[]; note?: string; rows: CellValue[][]; title: string; totals?: CellValue[] },
): number {
  const { columns, rows, title, totals, note } = options;
  const colCount = Math.max(1, columns.length);
  let row = startRow;

  sheet.mergeCells(row, 1, row, colCount);
  const titleCell = sheet.getCell(row, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, color: { argb: ORANGE }, name: "Calibri", size: 12 };
  titleCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  titleCell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  titleCell.border = { top: { style: "medium" as const, color: { argb: ORANGE } } };
  sheet.getRow(row).height = 22;
  row += 1;

  const headerRow = sheet.getRow(row);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: column.right ? "right" : "left", vertical: "middle", wrapText: true };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.border = gridBorder();
    setColumnWidth(sheet, index + 1, column.width ?? Math.max(12, column.label.length + 2));
  });
  headerRow.height = 18;
  row += 1;

  const firstDataRow = row;
  rows.forEach((cells, rowIndex) => {
    const excelRow = sheet.getRow(row);
    columns.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1);
      setCell(cell, cells[index], column.numFmt);
      cell.font = { color: { argb: SLATE }, name: "Calibri", size: 10.5 };
      cell.alignment = { horizontal: column.right ? "right" : "left", indent: column.right ? 0 : 1, vertical: "middle" };
      cell.border = gridBorder();
      if (rowIndex % 2 === 1) cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
    });
    row += 1;
  });
  const lastDataRow = row - 1;

  if (totals && rows.length > 0) {
    const totalRow = sheet.getRow(row);
    columns.forEach((column, index) => {
      const cell = totalRow.getCell(index + 1);
      setCell(cell, totals[index], column.numFmt);
      cell.font = { bold: true, color: { argb: BLACK }, name: "Calibri", size: 10.5 };
      cell.alignment = { horizontal: column.right ? "right" : "left", indent: column.right ? 0 : 1, vertical: "middle" };
      cell.fill = { fgColor: { argb: AMBER }, pattern: "solid", type: "pattern" };
      cell.border = gridBorder();
    });
    row += 1;
  }

  if (lastDataRow >= firstDataRow) {
    columns.forEach((column, index) => {
      if (column.dataBar) {
        const letter = sheet.getColumn(index + 1).letter;
        applyDataBar(sheet, `${letter}${firstDataRow}:${letter}${lastDataRow}`);
      }
    });
  }

  if (note) {
    sheet.getCell(row, 1).value = note;
    sheet.getCell(row, 1).font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 9.5 };
    row += 1;
  }

  return row + 1;
}

// Brand band at the top of a report sheet.
// Row 1: black fill, bold title.
// Row 2: black fill, muted italic subtitle.
// Row 3: premium accent divider with a bold amber lead.
export function bandHeader(sheet: ExcelJS.Worksheet, cols: number, title: string, subtitle: string) {
  const existingViews = sheet.views as ExcelJS.WorksheetView[];
  sheet.views = existingViews.length > 0
    ? existingViews.map((v) => ({ ...v, showGridLines: false }))
    : [{ showGridLines: false }];

  sheet.mergeCells(1, 1, 1, cols);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = `${systemIdentity.appName} — ${title}`;
  titleCell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 16 };
  titleCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  titleCell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  titleCell.border = { bottom: { style: "medium", color: { argb: ORANGE } } };
  sheet.getRow(1).height = 36;

  sheet.mergeCells(2, 1, 2, cols);
  const sub = sheet.getCell(2, 1);
  sub.value = subtitle;
  sub.font = { color: { argb: WHITE }, italic: true, name: "Calibri", size: 10 };
  sub.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  sub.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  sheet.getRow(2).height = 18;

  const leadSpan = Math.max(1, Math.min(cols, Math.ceil(cols * 0.45)));
  if (leadSpan < cols) {
    sheet.mergeCells(3, 1, 3, leadSpan);
    const accentLead = sheet.getCell(3, 1);
    accentLead.value = "";
    accentLead.font = { color: { argb: WHITE }, name: "Calibri", size: 8 };
    accentLead.fill = { fgColor: { argb: AMBER }, pattern: "solid", type: "pattern" };
    accentLead.alignment = { horizontal: "left", vertical: "middle" };

    sheet.mergeCells(3, leadSpan + 1, 3, cols);
    const accentTail = sheet.getCell(3, leadSpan + 1);
    accentTail.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  } else {
    sheet.mergeCells(3, 1, 3, cols);
    const accentLead = sheet.getCell(3, 1);
    accentLead.value = "";
    accentLead.font = { color: { argb: WHITE }, name: "Calibri", size: 8 };
    accentLead.fill = { fgColor: { argb: AMBER }, pattern: "solid", type: "pattern" };
    accentLead.alignment = { horizontal: "left", vertical: "middle" };
  }
  sheet.getRow(3).height = 6;
}

export function leaderText(leader: { distributorName: string; share: number } | null) {
  return leader ? `${leader.distributorName} (${(leader.share * 100).toFixed(0)}%)` : "—";
}
