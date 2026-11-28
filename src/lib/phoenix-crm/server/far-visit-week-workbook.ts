/**
 * The Far-visit week as one workbook in the house identity (owner, 28 Nov 2026: "the details, I can export them to
 * Excel"): sheet "Week" is the screen's grid — a rep per row, a day per column, the day's words in each cell, never a coloured fill (the ink rule: the zebra is the only fill) — and
 * sheet "Details" is every refused or held visit of the week, one line each, with where it was pressed as a Google
 * Maps link. It is built from the same `FarVisitWeekReport` the screen draws, so the file can never hold a rep, or a
 * line, the screen would not show this reader. Server-only: it imports ExcelJS.
 */
import ExcelJS from "exceljs";

import { HOUSE_XLSX_COLORS, houseBodyStyle, houseCairoDateTime, houseGeneratedAt, houseHeaderStyle, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import { FAR_VISIT_WEEK_KIND_LABELS, farVisitWeekCellText, farVisitWeekDayLabel } from "@/lib/phoenix-crm/far-visit-week-rules";
import type { FarVisitWeekReport } from "@/lib/phoenix-crm/server/far-visit-week-report";

export const FAR_VISIT_WEEK_SHEETS = { week: "Week", details: "Details" } as const;

const HEADER_ROW = 5;

function header(sheet: ExcelJS.Worksheet, labels: string[]) {
  const row = sheet.getRow(HEADER_ROW);
  row.height = 32;
  labels.forEach((label, index) => {
    const cell = row.getCell(index + 1);
    cell.value = label;
    houseHeaderStyle(cell, { size: 9.5 });
  });
}

export async function buildFarVisitWeekWorkbook(report: FarVisitWeekReport, viewerName: string, generatedAtIso: string): Promise<Buffer> {
  const { week } = report;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date(generatedAtIso);
  workbook.title = "Far-visit week";
  workbook.subject = `${week.start} to ${week.end}`;
  // The filters the reader picked ride on the period, so a filtered file never reads as the whole team.
  const period = `${farVisitWeekDayLabel(week.start)} to ${farVisitWeekDayLabel(week.end)} ${week.end.slice(0, 4)}${report.filterLabel ? ` · ${report.filterLabel}` : ""}`;

  // ── Week ──
  const grid = workbook.addWorksheet(FAR_VISIT_WEEK_SHEETS.week, { properties: { defaultRowHeight: 18, tabColor: { argb: HOUSE_XLSX_COLORS.blue } } });
  const gridLabels = ["Rep", "Territory", ...week.days.map(farVisitWeekDayLabel), "Visits", "Rejected", "Waiting", "Clean days"];
  [26, 26, ...week.days.map(() => 15), 9, 10, 9, 10].forEach((width, index) => {
    grid.getColumn(index + 1).width = width;
  });
  writeHouseMasthead(workbook, grid, {
    columns: gridLabels.length,
    provenance: [houseGeneratedAt(generatedAtIso), `Prepared for ${viewerName}`, `${report.totals.reps} reps`],
    subtitle: `${period} · ${report.totals.doorRejected + report.totals.sfeRejected} rejected, ${report.totals.waiting} waiting, ${report.totals.visits} visits logged`,
    title: "Far-visit week",
  });
  header(grid, gridLabels);
  report.rows.forEach((entry, rowIndex) => {
    const row = grid.getRow(HEADER_ROW + 1 + rowIndex);
    const values: Array<string | number> = [
      entry.repName,
      entry.territory,
      ...entry.cells.map((cell) => {
        const text = farVisitWeekCellText(cell);
        return text.foot ? `${text.head} · ${text.foot}` : text.head;
      }),
      entry.totals.visits,
      entry.totals.doorRejected + entry.totals.sfeRejected,
      entry.totals.waiting,
      entry.cleanDays,
    ];
    values.forEach((value, index) => {
      const cell = row.getCell(index + 1);
      cell.value = value;
      houseBodyStyle(cell, { size: 9.5, zebra: rowIndex % 2 === 1 });
      cell.alignment = { horizontal: typeof value === "number" ? "right" : "left", indent: typeof value === "number" ? 0 : 1, vertical: "middle", wrapText: true };
    });
  });
  grid.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: HEADER_ROW }];

  // ── Details ──
  const details = workbook.addWorksheet(FAR_VISIT_WEEK_SHEETS.details, { properties: { defaultRowHeight: 18, tabColor: { argb: HOUSE_XLSX_COLORS.blue } } });
  const detailLabels = ["Rep", "Territory", "Day", "Time", "Customer", "What happened", "Distance (m)", "Far line (m)", "Times saved", "Accepted later the same day", "Where save was pressed"];
  [26, 26, 13, 20, 30, 22, 12, 12, 11, 14, 28].forEach((width, index) => {
    details.getColumn(index + 1).width = width;
  });
  writeHouseMasthead(workbook, details, {
    columns: detailLabels.length,
    provenance: [houseGeneratedAt(generatedAtIso), `Prepared for ${viewerName}`, `${report.items.length} lines`],
    subtitle: `${period} · every visit refused or held for being away from the customer's place`,
    title: "Far-visit week — details",
  });
  header(details, detailLabels);
  report.items.forEach((item, rowIndex) => {
    const row = details.getRow(HEADER_ROW + 1 + rowIndex);
    const link = item.spot ? `https://www.google.com/maps/search/?api=1&query=${item.spot.lat.toFixed(6)},${item.spot.lon.toFixed(6)}` : null;
    const values: Array<string | number | null | ExcelJS.CellHyperlinkValue> = [
      item.repName,
      item.territory,
      farVisitWeekDayLabel(item.date),
      item.at ? houseCairoDateTime(item.at) : "",
      item.customerName,
      FAR_VISIT_WEEK_KIND_LABELS[item.kind],
      item.distanceMeters,
      item.farMeters,
      item.tries,
      item.kind === "door" ? (item.loggedLater ? "Yes" : "No") : "",
      link ? { hyperlink: link, text: "Open in Google Maps" } : "",
    ];
    values.forEach((value, index) => {
      const cell = row.getCell(index + 1);
      cell.value = value ?? "";
      houseBodyStyle(cell, { size: 9.5, zebra: rowIndex % 2 === 1 });
      const numeric = typeof value === "number";
      if (numeric) cell.numFmt = "#,##0";
      cell.alignment = { horizontal: numeric ? "right" : "left", indent: numeric ? 0 : 1, vertical: "middle", wrapText: !numeric };
    });
  });
  details.views = [{ showGridLines: false, state: "frozen", ySplit: HEADER_ROW }];
  if (report.items.length > 0) {
    details.autoFilter = { from: { column: 1, row: HEADER_ROW }, to: { column: detailLabels.length, row: HEADER_ROW + report.items.length } };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
