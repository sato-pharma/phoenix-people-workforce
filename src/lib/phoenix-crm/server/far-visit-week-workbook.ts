/**
 * The Far-visit week as one workbook in the house identity (owner, 28 Nov 2026: "the details, I can export them to
 * Excel"): a "Week" sheet per week chosen is the screen's grid — a rep per row, a day per column, the day's words in
 * each cell, never a coloured fill (the ink rule: the zebra is the only fill) — and sheet "Details" is every refused or
 * held visit of those weeks, one line each, with where it was pressed as a Google Maps link. One week keeps the plain
 * sheet name "Week"; several (owner, 28 Nov 2026: "multi select multi weeks") name each sheet by its Saturday, newest
 * first. It is built from the same `FarVisitWeeksReport` the screen draws, so the file can never hold a rep, or a
 * line, the screen would not show this reader. Server-only: it imports ExcelJS.
 */
import ExcelJS from "exceljs";

import { HOUSE_XLSX_COLORS, houseBodyStyle, houseCairoDateTime, houseGeneratedAt, houseHeaderStyle, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import { FAR_VISIT_WEEK_KIND_LABELS, farVisitWeekCellText, farVisitWeekDayLabel, farVisitWeekRangeLabel } from "@/lib/phoenix-crm/far-visit-week-rules";
import type { FarVisitWeekReport, FarVisitWeeksReport } from "@/lib/phoenix-crm/server/far-visit-week-report";

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

/** The sheet a week is written to: "Week" when it is the only one, "Week Sat 21 Nov" beside others. */
export function farVisitWeekSheetName(week: Pick<FarVisitWeekReport["week"], "start">, many: boolean): string {
  return many ? `${FAR_VISIT_WEEK_SHEETS.week} ${farVisitWeekDayLabel(week.start)}` : FAR_VISIT_WEEK_SHEETS.week;
}

function writeWeekSheet(
  workbook: ExcelJS.Workbook,
  report: FarVisitWeekReport,
  sheetName: string,
  filterLabel: string | null,
  viewerName: string,
  generatedAtIso: string,
) {
  const { week } = report;
  // The filters the reader picked ride on the period, so a filtered file never reads as the whole team.
  const period = `${farVisitWeekRangeLabel(week)}${filterLabel ? ` · ${filterLabel}` : ""}`;
  const grid = workbook.addWorksheet(sheetName, { properties: { defaultRowHeight: 18, tabColor: { argb: HOUSE_XLSX_COLORS.blue } } });
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
}

export async function buildFarVisitWeekWorkbook(report: FarVisitWeeksReport, viewerName: string, generatedAtIso: string): Promise<Buffer> {
  const weeks = report.weeks;
  const newest = weeks[0].week;
  const oldest = weeks[weeks.length - 1].week;
  const many = weeks.length > 1;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date(generatedAtIso);
  workbook.title = "Far-visit week";
  workbook.subject = `${oldest.start} to ${newest.end}`;

  // ── Week, one sheet per week chosen, newest first ──
  for (const week of weeks) writeWeekSheet(workbook, week, farVisitWeekSheetName(week.week, many), report.filterLabel, viewerName, generatedAtIso);

  // ── Details, every week's lines together ──
  const items = weeks
    .flatMap((week) => week.items)
    .sort((a, b) => a.repName.localeCompare(b.repName) || a.date.localeCompare(b.date) || String(a.at).localeCompare(String(b.at)));
  const span = many ? `${weeks.length} weeks, ${farVisitWeekRangeLabel({ start: oldest.start, end: newest.end })}` : farVisitWeekRangeLabel(newest);
  const period = `${span}${report.filterLabel ? ` · ${report.filterLabel}` : ""}`;
  const details = workbook.addWorksheet(FAR_VISIT_WEEK_SHEETS.details, { properties: { defaultRowHeight: 18, tabColor: { argb: HOUSE_XLSX_COLORS.blue } } });
  const detailLabels = ["Rep", "Territory", "Day", "Time", "Customer", "What happened", "Distance (m)", "Far line (m)", "Times saved", "Accepted later the same day", "Where save was pressed"];
  [26, 26, 13, 20, 30, 22, 12, 12, 11, 14, 28].forEach((width, index) => {
    details.getColumn(index + 1).width = width;
  });
  writeHouseMasthead(workbook, details, {
    columns: detailLabels.length,
    provenance: [houseGeneratedAt(generatedAtIso), `Prepared for ${viewerName}`, `${items.length} lines`],
    subtitle: `${period} · every visit refused or held for being away from the customer's place`,
    title: "Far-visit week — details",
  });
  header(details, detailLabels);
  items.forEach((item, rowIndex) => {
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
  if (items.length > 0) {
    details.autoFilter = { from: { column: 1, row: HEADER_ROW }, to: { column: detailLabels.length, row: HEADER_ROW + items.length } };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
