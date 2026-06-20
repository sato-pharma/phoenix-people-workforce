import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";

// Shared Phoenix-branded XLSX style for the Marketing ROI exports. Re-exports the proven
// generic primitives from the sales workbook kit (palette, grid, table writer) — leaving the
// kit untouched — and adds a NEUTRAL brand band (the kit's bandHeader hardcodes an SFE
// slogan) plus a Cover / Provenance sheet used by every ROI workbook.

export {
  BLACK,
  ORANGE,
  AMBER,
  ORANGE_LINE,
  WHITE,
  SLATE,
  MUTED,
  ZEBRA,
  UNITS_FMT,
  VALUE_FMT,
  PCT_FMT,
  gridBorder,
  sanitizeSheetName,
  setCell,
  writeTable,
} from "@/lib/sales/sales-workbook-kit";
export type { TableColumn, CellValue } from "@/lib/sales/sales-workbook-kit";

import { AMBER, BLACK, MUTED, ORANGE, SLATE, sanitizeSheetName } from "@/lib/sales/sales-workbook-kit";

export const ORANGE_SOFT = "FFFFF7ED";

/** Neutral two-row brand band (black title + muted subtitle), no department slogan. */
export function phoenixBandHeader(sheet: ExcelJS.Worksheet, cols: number, title: string, subtitle: string) {
  const existingViews = sheet.views as ExcelJS.WorksheetView[];
  sheet.views = existingViews.length > 0
    ? existingViews.map((v) => ({ ...v, showGridLines: false }))
    : [{ showGridLines: false }];

  sheet.mergeCells(1, 1, 1, cols);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = `${systemIdentity.appName} — ${title}`;
  titleCell.font = { bold: true, color: { argb: ORANGE }, name: "Calibri", size: 16 };
  titleCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  titleCell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  sheet.getRow(1).height = 34;

  sheet.mergeCells(2, 1, 2, cols);
  const sub = sheet.getCell(2, 1);
  sub.value = subtitle;
  sub.font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 10.5 };
  sub.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  sub.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  sheet.getRow(2).height = 18;
}

export type CoverProvenance = {
  title: string;
  subtitle: string;
  /** key/value rows: applied filters, KPI totals, role scope, generated-by, export id, etc. */
  rows: Array<[string, string]>;
  /** the confidentiality / disclosure callout text. */
  confidentialNote: string;
};

/** Build the first sheet: brand band + a confidentiality callout + a provenance key/value table. */
export function buildCoverSheet(workbook: ExcelJS.Workbook, cover: CoverProvenance) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Cover"), {
    properties: { defaultColWidth: 28 },
  });
  sheet.getColumn(1).width = 34;
  sheet.getColumn(2).width = 64;
  phoenixBandHeader(sheet, 2, cover.title, cover.subtitle);

  // Confidentiality callout (amber band).
  sheet.mergeCells(3, 1, 3, 2);
  const note = sheet.getCell(3, 1);
  note.value = cover.confidentialNote;
  note.font = { bold: true, color: { argb: "FFB45309" }, name: "Calibri", size: 10.5 };
  note.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  note.fill = { fgColor: { argb: AMBER }, pattern: "solid", type: "pattern" };
  sheet.getRow(3).height = 30;

  let row = 5;
  const heading = sheet.getCell(row, 1);
  heading.value = "Report provenance";
  heading.font = { bold: true, color: { argb: ORANGE }, name: "Calibri", size: 12 };
  row += 1;

  for (const [label, value] of cover.rows) {
    const labelCell = sheet.getCell(row, 1);
    labelCell.value = label;
    labelCell.font = { bold: true, color: { argb: SLATE }, name: "Calibri", size: 10.5 };
    labelCell.alignment = { horizontal: "left", vertical: "top", indent: 1 };
    const valueCell = sheet.getCell(row, 2);
    valueCell.value = value;
    valueCell.font = { color: { argb: SLATE }, name: "Calibri", size: 10.5 };
    valueCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    row += 1;
  }

  workbook.creator = systemIdentity.appName;
  workbook.company = systemIdentity.appName;
  return sheet;
}
