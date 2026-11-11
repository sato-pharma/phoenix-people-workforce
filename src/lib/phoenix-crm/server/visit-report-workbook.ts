/**
 * Phoenix CRM — the Visit report generator's workbook: ONE tab, "Visits", holding exactly the fields
 * the owner chose for exactly the visits the filter returned (owner, 2026-10-15: "one master sheet with
 * one tab only", "only the chosen and filtered data").
 *
 * 🔴 EXCEPT THE FIRST THREE COLUMNS, WHICH ARE ALWAYS THE DATE, WHO VISITED AND THE CUSTOMER (owner,
 * 2026-10-16: "Always lead with them"), ticked or not, so every line of the file says whose visit it was.
 * A ticked one is not printed twice. The result filters narrow the visits through the same matcher as
 * the screen (`narrowVisitReportView`), and the subtitle says what the file was narrowed to.
 *
 * It lives under server/ for the same reason `reports-workbook.ts` does: it imports ExcelJS and the
 * loader's view type, and the phone bundle may touch neither.
 *
 * ## House identity, always
 *
 * It wears `SATO-DIS-2026-01` (owner, 2026-10-15: "Sato house identity always") — the masthead with the
 * on-light mark, a Brand Blue rule, headers as the house header, one 6% zebra, hairline grid. Do not bring
 * it into the Phoenix black-and-orange the screen uses.
 *
 * ## Real dates, real numbers
 *
 * A date is a date and a count is a number, so the file sorts and filters the way the owner will use it.
 * An instant is written as the Cairo WALL CLOCK (the column heading says "Cairo time"): a workbook has no
 * zone, so the offset is applied here, once, where the value is written.
 *
 * ## The reading notes sit UNDER the table
 *
 * There is no second sheet to carry them, so a field with a hint — the three that come from save times —
 * is explained in a block beneath the data, in the same words the screen prints beside its button. The
 * save-time fields are never coloured and never flagged here either.
 */

import ExcelJS from "exceljs";

import {
  HOUSE_XLSX_COLORS,
  houseBodyStyle,
  houseGeneratedAt,
  houseHeaderStyle,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import { HOUSE_DOCUMENT_STANDARD, HOUSE_XLSX_FONT } from "@/lib/export/house-xlsx-palette";
import {
  VISIT_REPORT_LEAD_KEYS,
  visitReportCategoryOf,
  visitReportField,
  type VisitReportField,
  type VisitReportFormat,
  type VisitReportRow,
  type VisitReportValue,
  type VisitReportView,
} from "@/lib/phoenix-crm/visit-report-fields";

const CAIRO_PARTS = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

/** An instant as a Date whose UTC fields are the Cairo wall clock — what a zoneless workbook shows. */
function cairoWallClock(iso: string): Date | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = Object.fromEntries(CAIRO_PARTS.formatToParts(at).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) % 24;
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second)));
}

function dateOnly(day: string): Date | null {
  const at = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

const NUMBER_FORMATS: Partial<Record<VisitReportFormat, string>> = {
  coordinate: "0.000000",
  date: "dd mmm yyyy",
  datetime: "dd mmm yyyy, h:mm AM/PM",
  decimal: "0.0",
  integer: "#,##0",
  km: "0.0",
  meters: "#,##0",
  minutes: "#,##0",
  seconds: "#,##0",
};

/**
 * The narrowest a column of this format may be. A date-time written as "15 Oct 2026, 12:00 PM" needs 21
 * characters, and a column set narrower shows `###` in place of the value — which reads as "no data".
 */
const MIN_WIDTH: Partial<Record<VisitReportFormat, number>> = { coordinate: 12, date: 13, datetime: 22 };

const NUMERIC = new Set<VisitReportFormat>(["coordinate", "decimal", "integer", "km", "meters", "minutes", "seconds"]);

/** One cell's value: a Date, a number, or text — blank when the fact is absent. */
export function visitReportCellValue(format: VisitReportFormat, value: VisitReportValue | undefined): Date | number | string | null {
  if (value === null || value === undefined || value === "") return null;
  if (format === "yesno") return value === true ? "Yes" : value === false ? "No" : String(value);
  if (format === "date") return typeof value === "string" ? dateOnly(value) ?? value : String(value);
  if (format === "datetime") return typeof value === "string" ? cairoWallClock(value) ?? value : String(value);
  if (NUMERIC.has(format)) return typeof value === "number" ? value : Number.isFinite(Number(value)) ? Number(value) : String(value);
  return typeof value === "string" ? value : String(value);
}

export type VisitReportWorkbookInput = {
  view: VisitReportView;
  /** The chosen fields in the catalogue's order — the columns after the three lead ones. */
  fields: ReadonlyArray<VisitReportField>;
  /** The reader's NAME, never an HR id. */
  viewerName: string;
  /** What the result filters narrowed the visits to, in words; absent when nothing was narrowed. */
  narrowedTo?: string | null;
};

/** The band over the three lead columns. */
const LEAD_BAND = "The visit";

/** The workbook's columns, left to right: the date, who visited and the customer, then the chosen rest. */
export function visitReportWorkbookColumns(fields: ReadonlyArray<VisitReportField>): VisitReportField[] {
  const lead = VISIT_REPORT_LEAD_KEYS.flatMap((key) => {
    const field = visitReportField(key);
    return field ? [field] : [];
  });
  const leadKeys = new Set(VISIT_REPORT_LEAD_KEYS);
  return [...lead, ...fields.filter((field) => !leadKeys.has(field.key))];
}

/** A lead column's value: the chosen field's when it was ticked, else the row's own head, which every row carries. */
function leadValue(row: VisitReportRow, key: string): VisitReportValue {
  const chosen = row.values[key];
  // A rep who had left by the visit day reads "Omaima Wael (Resigned on 31 Oct 2026)" (owner, 11 Nov 2026).
  if (key === "repName" && row.repLeft) {
    const name = chosen !== null && chosen !== undefined && chosen !== "" ? String(chosen) : row.repName;
    return `${name} (${row.repLeft})`;
  }
  if (chosen !== null && chosen !== undefined && chosen !== "") return chosen;
  if (key === "visitDate") return row.visitDate || null;
  if (key === "repName") return row.repName || null;
  if (key === "customerName") return row.customerName || null;
  return null;
}

/** The sheet's tab name — also what the test reads back. */
export const VISIT_REPORT_SHEET = "Visits";

const HEADER_ROW = 5;

export async function buildVisitReportWorkbook(input: VisitReportWorkbookInput): Promise<Buffer> {
  const { view, fields, viewerName, narrowedTo } = input;
  const columns = visitReportWorkbookColumns(fields);
  const leadCount = VISIT_REPORT_LEAD_KEYS.length;
  const lead = new Set(VISIT_REPORT_LEAD_KEYS);
  const bandOf = (index: number): string => (index < leadCount ? LEAD_BAND : visitReportCategoryOf(columns[index].category).label);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date(view.generatedAtIso);
  workbook.title = `Visit report — ${view.target.name}`;
  workbook.subject = `${view.period.from} to ${view.period.to}`;

  const sheet = workbook.addWorksheet(VISIT_REPORT_SHEET, {
    properties: { defaultRowHeight: 18, tabColor: { argb: HOUSE_XLSX_COLORS.blue } },
  });
  columns.forEach((field, index) => {
    sheet.getColumn(index + 1).width = Math.max(field.width, MIN_WIDTH[field.format] ?? 0);
  });

  writeHouseMasthead(workbook, sheet, {
    columns: Math.max(1, columns.length),
    provenance: [houseGeneratedAt(view.generatedAtIso), `Prepared for ${viewerName}`, `${view.total.toLocaleString("en-US")} visits`],
    subtitle:
      `${view.target.name} · ${view.period.from} to ${view.period.to} · ${fields.length} field${fields.length === 1 ? "" : "s"} chosen`
      + (narrowedTo ? ` · Only ${narrowedTo}` : ""),
    title: "Visit report",
  });

  // Row 4 — the category band: the lead three under "The visit", then each run of one category's columns,
  // named, under a Brand Blue rule.
  const bandRow = sheet.getRow(4);
  bandRow.height = 30;
  let start = 0;
  while (start < columns.length) {
    let end = start;
    while (end + 1 < columns.length && bandOf(end + 1) === bandOf(start)) end += 1;
    if (end > start) sheet.mergeCells(4, start + 1, 4, end + 1);
    const cell = sheet.getCell(4, start + 1);
    cell.value = bandOf(start);
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 10 };
    cell.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
    for (let column = start + 1; column <= end + 1; column += 1) {
      sheet.getCell(4, column).border = { bottom: { style: "medium", color: { argb: HOUSE_XLSX_COLORS.blue } } };
    }
    start = end + 1;
  }

  // Row 5 — the field headings, the house header.
  const headerRow = sheet.getRow(HEADER_ROW);
  headerRow.height = 44;
  columns.forEach((field, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = field.label;
    houseHeaderStyle(cell, { size: 9.5 });
  });

  // The data — one row per visit: the lead three, then only the chosen fields.
  view.rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(HEADER_ROW + 1 + rowIndex);
    columns.forEach((field, index) => {
      const cell = excelRow.getCell(index + 1);
      const value = visitReportCellValue(field.format, lead.has(field.key) ? leadValue(row, field.key) : row.values[field.key]);
      cell.value = value === null ? "" : value;
      const numFormat = NUMBER_FORMATS[field.format];
      if (numFormat && value !== null && typeof value !== "string") cell.numFmt = numFormat;
      houseBodyStyle(cell, { size: 9.5, zebra: rowIndex % 2 === 1 });
      cell.alignment = {
        horizontal: NUMERIC.has(field.format) ? "right" : "left",
        indent: NUMERIC.has(field.format) ? 0 : 1,
        vertical: "middle",
        wrapText: !NUMERIC.has(field.format),
      };
    });
  });

  const lastDataRow = HEADER_ROW + view.rows.length;
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: HEADER_ROW }];
  if (view.rows.length > 0 && columns.length > 0) {
    sheet.autoFilter = { from: { column: 1, row: HEADER_ROW }, to: { column: columns.length, row: lastDataRow } };
  }

  // On paper: landscape A3, the category band and headings repeated on every page, and a few columns wide
  // per page rather than a hundred squeezed into one unreadable strip.
  sheet.pageSetup = {
    fitToHeight: 0,
    fitToPage: true,
    fitToWidth: Math.max(1, Math.ceil(columns.length / 14)),
    horizontalCentered: true,
    margins: { bottom: 0.7, footer: 0.3, header: 0.3, left: 0.4, right: 0.4, top: 0.5 },
    orientation: "landscape",
    // A3 is Excel's paper 8; ExcelJS's enum lists A4 and a few others but not it.
    paperSize: 8 as ExcelJS.PaperSize,
    printTitlesRow: `${HEADER_ROW - 1}:${HEADER_ROW}`,
  };
  sheet.headerFooter = {
    oddFooter: `&L&8${HOUSE_DOCUMENT_STANDARD}&C&8Page &P of &N&R&8Visit report · ${view.period.from} to ${view.period.to}`,
  };

  // Reading notes, beneath the data: what is blank and why, and how the save-time fields are read.
  const notes: string[] = [];
  if (view.rows.length === 0) notes.push(narrowedTo ? "No visits match what the report was narrowed to." : "No visits were saved in this period.");
  for (const field of columns) {
    if (field.hint) notes.push(`${field.label} — ${field.hint}`);
    if (field.sparse) notes.push(`${field.label} — recorded on ${view.filled[field.key] ?? 0} of ${view.total} visits; a blank means the rep recorded nothing.`);
  }
  let noteRow = lastDataRow + 2;
  if (notes.length > 0) {
    const heading = sheet.getCell(noteRow, 1);
    heading.value = "Reading notes";
    heading.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 10 };
    noteRow += 1;
    for (const note of notes) {
      const cell = sheet.getCell(noteRow, 1);
      cell.value = note;
      cell.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, name: HOUSE_XLSX_FONT, size: 9 };
      noteRow += 1;
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
