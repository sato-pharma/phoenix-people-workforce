// Targets upload template + parser for the 42-area seat model. One target per
// (period, line, area, product). Headers match what parseTargetsWorkbook reads, so
// a filled copy uploads straight through /api/sales/targets/upload. Mirrors the
// Sales Queue template style (ExcelJS, frozen header, Read Me sheet).
import ExcelJS from "exceljs";

import type { TargetInputRow } from "@/lib/sales/monthly-targets";

const HEADER_STYLE: Partial<ExcelJS.Style> = {
  font: { bold: true, color: { argb: "FFFFFFFF" }, size: 10 },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B0B0B" } },
  alignment: { vertical: "middle", wrapText: true },
  border: { bottom: { style: "thin", color: { argb: "FFF97316" } } },
};

const SAMPLE_STYLE: Partial<ExcelJS.Style> = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } },
  font: { color: { argb: "FF166534" }, size: 9 },
};

type ColDef = { header: string; note: string; width: number };

// Order is display-only; the parser maps by header name, not position.
const COLUMNS: ColDef[] = [
  { header: "Period", note: "Target month as YYYY-MM (e.g. 2026-07).", width: 12 },
  { header: "Line", note: "CNS, Pedia, or Anti-infective.", width: 16 },
  { header: "Area Code", note: "One of the 42 canonical area codes (see the Valid Areas sheet).", width: 12 },
  { header: "Product Code", note: "Product code (e.g. TE002). Confidential products are not targeted here.", width: 14 },
  { header: "Target Value", note: "EGP target for this product in this area this month.", width: 14 },
  { header: "Target Units", note: "Optional. Unit target (leave blank if you only set value).", width: 14 },
];

const SAMPLE_ROWS: (string | number | null)[][] = [
  ["2026-07", "CNS", "AB1", "TE002", 250000, 2000],
  ["2026-07", "Pedia", "D14", "LA002", 210000, null],
];

const HEADER_KEY: Record<string, keyof Omit<TargetInputRow, "rowNumber">> = {
  period: "period",
  line: "line",
  areacode: "area",
  area: "area",
  productcode: "product",
  product: "product",
  targetvalue: "targetValue",
  value: "targetValue",
  targetunits: "targetUnits",
  units: "targetUnits",
};

function headerKey(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Generate the targets upload template. When `areas` is supplied it is listed on a
 * "Valid Areas" reference sheet so the user knows the accepted area codes for the line.
 */
export async function generateTargetsTemplate(opts?: {
  lineLabel?: string;
  areas?: ReadonlyArray<{ areaCode: string; areaName: string; regionCode: string | null }>;
}): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Phoenix Workforce";

  const ws = wb.addWorksheet("Targets", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map((col, i) => ({ key: `col${i}`, width: col.width }));
  const headerRow = ws.getRow(1);
  COLUMNS.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    Object.assign(cell, { style: HEADER_STYLE });
  });
  headerRow.height = 20;
  SAMPLE_ROWS.forEach((values, rowIndex) => {
    const row = ws.getRow(2 + rowIndex);
    values.forEach((value, i) => {
      const cell = row.getCell(i + 1);
      cell.value = value;
      Object.assign(cell, { style: SAMPLE_STYLE });
    });
  });

  const ref = wb.addWorksheet("Read Me");
  ref.columns = [{ key: "a", width: 40 }, { key: "b", width: 90 }];
  const titleStyle: Partial<ExcelJS.Style> = { font: { bold: true, color: { argb: "FFFFFFFF" } }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B0B0B" } } };
  const colHeaderStyle: Partial<ExcelJS.Style> = { font: { bold: true, color: { argb: "FF0B0B0B" } }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } } };
  [
    "Targets upload template — one target per (Period, Line, Area, Product).",
    "",
    "Targets attach to the AREA (not the person): a vacant area still carries its target,",
    "and a new hire inherits it. \"Other\" areas carry no target and are rejected if included.",
    "",
    "Every row is validated on upload: an unknown Line / Area Code / Product Code, or an",
    "\"Other\" area, is REJECTED (never auto-created) and reported back with its row number.",
    "Fill Target Value (EGP) and optionally Target Units. Replace the two green sample rows.",
    "",
    "Column reference:",
  ].forEach((line, i) => {
    const row = ref.addRow([line, ""]);
    if (i === 0) { row.getCell(1).style = titleStyle; row.getCell(2).style = titleStyle; }
  });
  const colHeader = ref.addRow(["Column", "Meaning"]);
  colHeader.getCell(1).style = colHeaderStyle;
  colHeader.getCell(2).style = colHeaderStyle;
  COLUMNS.forEach((col) => ref.addRow([col.header, col.note]));
  ref.getColumn(2).alignment = { wrapText: true };

  if (opts?.areas && opts.areas.length > 0) {
    const areaSheet = wb.addWorksheet(`Valid Areas${opts.lineLabel ? ` (${opts.lineLabel})` : ""}`);
    areaSheet.columns = [
      { key: "code", width: 12 },
      { key: "name", width: 32 },
      { key: "region", width: 12 },
    ];
    const ah = areaSheet.getRow(1);
    ["Area Code", "Area Name", "Region"].forEach((h, i) => {
      const cell = ah.getCell(i + 1);
      cell.value = h;
      Object.assign(cell, { style: colHeaderStyle });
    });
    opts.areas.forEach((area) => areaSheet.addRow([area.areaCode, area.areaName, area.regionCode ?? ""]));
  }

  return wb.xlsx.writeBuffer();
}

/** Parse an uploaded targets workbook into raw input rows (validated later, map-or-reject). */
export async function parseTargetsWorkbook(buffer: ArrayBuffer): Promise<TargetInputRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const headerRow = ws.getRow(1);
  const colOf: Partial<Record<keyof Omit<TargetInputRow, "rowNumber">, number>> = {};
  headerRow.eachCell((cell, colNumber) => {
    const key = HEADER_KEY[headerKey(cell.value)];
    if (key && colOf[key] === undefined) colOf[key] = colNumber;
  });
  if (colOf.period === undefined || colOf.line === undefined || colOf.area === undefined || colOf.product === undefined) {
    return [];
  }

  const cellText = (row: ExcelJS.Row, col: number | undefined): string => {
    if (col === undefined) return "";
    const value = row.getCell(col).value;
    if (value == null) return "";
    if (typeof value === "object" && value !== null && "result" in value) {
      return String((value as { result?: unknown }).result ?? "").trim();
    }
    if (typeof value === "object" && value !== null && "text" in value) {
      return String((value as { text?: unknown }).text ?? "").trim();
    }
    return String(value).trim();
  };
  const cellNum = (row: ExcelJS.Row, col: number | undefined): number | null => {
    const text = cellText(row, col);
    if (text === "") return null;
    const parsed = Number(text.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const rows: TargetInputRow[] = [];
  const lastRow = ws.rowCount;
  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
    const row = ws.getRow(rowNumber);
    const period = cellText(row, colOf.period);
    const line = cellText(row, colOf.line);
    const area = cellText(row, colOf.area);
    const product = cellText(row, colOf.product);
    if (!period && !line && !area && !product) continue; // blank row
    rows.push({
      rowNumber,
      period,
      line,
      area,
      product,
      targetUnits: cellNum(row, colOf.targetUnits),
      targetValue: cellNum(row, colOf.targetValue),
    });
  }
  return rows;
}
