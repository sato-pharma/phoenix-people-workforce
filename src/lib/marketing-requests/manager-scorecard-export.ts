// ─────────────────────────────────────────────────────────────────────────────
// Marketing Manager Scorecard — the Excel and PDF versions of the same sheet.
//
// Owner instruction, 2026-10-09: "make me able to extract reports from it either by excel or
// either by pdf". So both come from ONE already-built scorecard object, never from a second query:
// whatever the screen shows, the file repeats. If these re-read anything, the day will come when a
// manager forwards a PDF whose total does not match the page it was taken from.
//
// Two deliberate differences between the formats:
//
//  1. THE WORKBOOK IS FLAT AND COMPLETE — one column per figure, every manager, no merging. The
//     fits-the-screen rule governs a viewport and a sheet has none, so nothing is squeezed and
//     nothing is dropped; this is the copy somebody pivots.
//  2. THE PDF IS A PRINTABLE SNAPSHOT — six columns that fit a landscape page, money rounded to
//     whole EGP, and a row cap with an honest note when the scope is bigger than the page. It
//     carries no filled table headers or zebra: the house ink rule, and it also prints cheaply.
//
// Both state the sales frontier and the Cairo generation time on their own face. A report whose
// numbers are read a month later must say what they were true of.
// ─────────────────────────────────────────────────────────────────────────────

import ExcelJS from "exceljs";
import pdfMake from "pdfmake";
import type { Content, TableCell } from "pdfmake";

import { CAIRO_MONTHS, cairoDateTime, cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import type {
  MarketingManagerScorecard,
  MarketingManagerScorecardRow,
  MarketingManagerScorecardTotals,
} from "@/lib/marketing-requests/manager-scorecard";

pdfMake.setFonts({
  Helvetica: {
    bold: "Helvetica-Bold",
    bolditalics: "Helvetica-BoldOblique",
    italics: "Helvetica-Oblique",
    normal: "Helvetica",
  },
});

/** The PDF paginates poorly past this; the workbook has no such limit and says so in the note. */
const PDF_ROW_CAP = 60;

type PdfDocDefinition = Parameters<typeof pdfMake.createPdf>[0];

/** YYYY-MM → "Aug 2026", from the hand-written month names rather than from `Intl`. */
function monthLabel(period: string | null): string {
  if (!period) return "no validated sales data yet";
  const [year, month] = period.split("-").map((part) => Number(part));
  if (!year || !month || month < 1 || month > 12) return period;
  return `${CAIRO_MONTHS[month - 1]} ${year}`;
}

const wholeEgp = (value: number): string => `EGP ${Math.round(value).toLocaleString("en-US")}`;
const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/**
 * One row of the sheet, in the order both formats read it.
 *
 * Money stays NUMERIC for the workbook — a reader who sums a column of text gets zero — and is
 * formatted only where it is printed.
 */
function sheetRow(row: MarketingManagerScorecardRow) {
  return {
    actualValue: row.actualValue,
    approvedRequests: row.approvedRequests,
    approvedValue: row.approvedValue,
    awaitingRequests: row.awaitingRequests,
    expectedRoiValue: row.expectedRoiValue,
    lineName: row.lineName ?? "—",
    managerName: row.managerName,
    recoveryRatio: row.recoveryRatio,
    refusedRequests: row.refusedRequests,
    regionName: row.regionName ?? "—",
    requiredRoiValue: row.requiredRoiValue,
    roiCoverageRatio: row.roiCoverageRatio,
    totalRequestedValue: row.totalRequestedValue,
    totalRequests: row.totalRequests,
  };
}

function totalsRow(totals: MarketingManagerScorecardTotals) {
  return {
    actualValue: totals.actualValue,
    approvedRequests: totals.approvedRequests,
    approvedValue: totals.approvedValue,
    awaitingRequests: totals.awaitingRequests,
    expectedRoiValue: totals.expectedRoiValue,
    lineName: "",
    managerName: `TOTAL · ${totals.managerCount} ${totals.managerCount === 1 ? "manager" : "managers"}`,
    recoveryRatio: totals.recoveryRatio,
    refusedRequests: totals.refusedRequests,
    regionName: "",
    requiredRoiValue: totals.requiredRoiValue,
    roiCoverageRatio: totals.roiCoverageRatio,
    totalRequestedValue: totals.totalRequestedValue,
    totalRequests: totals.totalRequests,
  };
}

/**
 * The Excel version: a "Manager Scorecard" sheet with a totals row, and a "Report Info" sheet
 * recording what the figures were true of.
 */
export async function buildMarketingManagerScorecardWorkbook(
  scorecard: MarketingManagerScorecard,
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const info = workbook.addWorksheet("Report Info");
  info.columns = [
    { header: "Field", key: "field", width: 30 },
    { header: "Value", key: "value", width: 52 },
  ];
  info.addRows([
    { field: "Report", value: "Marketing Manager Scorecard" },
    { field: "Generated", value: `${cairoDateTime(scorecard.generatedAtIso)} Cairo` },
    { field: "Distributor sales fully loaded to", value: monthLabel(scorecard.salesDataAsOf) },
    {
      field: "Later months",
      value:
        "Counted as soon as a distributor files them, so a part-loaded month is already in these figures",
    },
    { field: "Managers in scope", value: scorecard.totals.managerCount },
    { field: "Scope", value: "Everyone whose marketing requests the reader of this report can see" },
    {
      field: "Shared sales",
      value: "Counted once: two campaigns on the same pharmacy and product both claim the sale, and the overlap is deducted",
    },
  ]);

  const sheet = workbook.addWorksheet("Manager Scorecard");
  sheet.columns = [
    { header: "Manager", key: "managerName", width: 30 },
    { header: "Line", key: "lineName", width: 16 },
    { header: "Region", key: "regionName", width: 18 },
    { header: "Requests Raised", key: "totalRequests", width: 16 },
    { header: "Approved", key: "approvedRequests", width: 12 },
    { header: "Awaiting Decision", key: "awaitingRequests", width: 18 },
    { header: "Refused Or Called Off", key: "refusedRequests", width: 20 },
    { header: "Requested Value (EGP)", key: "totalRequestedValue", width: 21 },
    { header: "Approved Value (EGP)", key: "approvedValue", width: 20 },
    { header: "Forecast ROI (EGP)", key: "expectedRoiValue", width: 19 },
    { header: "Required Return (EGP)", key: "requiredRoiValue", width: 21 },
    { header: "Actual Collected (EGP)", key: "actualValue", width: 21 },
    { header: "Collected Of Approved", key: "recoveryRatio", width: 20 },
    { header: "Collected Of Required", key: "roiCoverageRatio", width: 20 },
  ];
  sheet.addRows(scorecard.rows.map(sheetRow));
  sheet.addRow(totalsRow(scorecard.totals));

  // Formats, not values: the cell keeps the number so it still sums.
  for (const key of [
    "totalRequestedValue",
    "approvedValue",
    "expectedRoiValue",
    "requiredRoiValue",
    "actualValue",
  ]) {
    sheet.getColumn(key).numFmt = "#,##0.00";
  }
  for (const key of ["recoveryRatio", "roiCoverageRatio"]) {
    sheet.getColumn(key).numFmt = "0%";
  }
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(sheet.rowCount).font = { bold: true };

  return workbook;
}

/** The six columns a landscape page holds without shrinking the type. */
function pdfTable(scorecard: MarketingManagerScorecard): Content {
  const shown = scorecard.rows.slice(0, PDF_ROW_CAP);
  return {
    layout: "lightHorizontalLines",
    table: {
      body: ([
        [
          { bold: true, text: "Manager" },
          { bold: true, text: "Requests" },
          { alignment: "right", bold: true, text: "Requested" },
          { alignment: "right", bold: true, text: "Approved" },
          { alignment: "right", bold: true, text: "Forecast ROI" },
          { alignment: "right", bold: true, text: "Collected" },
        ],
        ...shown.map((row): TableCell[] => [
          `${row.managerName}${row.lineName ? `\n${row.lineName}${row.regionName ? ` · ${row.regionName}` : ""}` : ""}`,
          `${row.totalRequests} raised\n${row.approvedRequests} approved`,
          { alignment: "right", text: wholeEgp(row.totalRequestedValue) },
          { alignment: "right", text: wholeEgp(row.approvedValue) },
          { alignment: "right", text: wholeEgp(row.expectedRoiValue) },
          { alignment: "right", text: `${wholeEgp(row.actualValue)}\n${percent(row.recoveryRatio)} of approved` },
        ]),
        [
          { bold: true, text: `TOTAL · ${scorecard.totals.managerCount} managers` },
          {
            bold: true,
            text: `${scorecard.totals.totalRequests} raised\n${scorecard.totals.approvedRequests} approved`,
          },
          { alignment: "right", bold: true, text: wholeEgp(scorecard.totals.totalRequestedValue) },
          { alignment: "right", bold: true, text: wholeEgp(scorecard.totals.approvedValue) },
          { alignment: "right", bold: true, text: wholeEgp(scorecard.totals.expectedRoiValue) },
          {
            alignment: "right",
            bold: true,
            text: `${wholeEgp(scorecard.totals.actualValue)}\n${percent(scorecard.totals.recoveryRatio)} of approved`,
          },
        ],
      ] satisfies TableCell[][]),
      headerRows: 1,
      widths: ["*", 70, 75, 75, 80, 85],
    },
  };
}

/** Exported so a test can read the content without parsing a PDF. */
export function buildMarketingManagerScorecardPdfDocDefinition(
  scorecard: MarketingManagerScorecard,
): PdfDocDefinition {
  const truncated = scorecard.rows.length > PDF_ROW_CAP;
  return {
    content: [
      { style: "title", text: "Marketing Manager Scorecard" },
      {
        margin: [0, 0, 0, 12] as [number, number, number, number],
        style: "subtitle",
        text:
          `Distributor sales fully loaded to ${monthLabel(scorecard.salesDataAsOf)} — a later month counts ` +
          `as soon as its files arrive · read as of ${cairoDateTime(scorecard.generatedAtIso)} Cairo`,
      },
      pdfTable(scorecard),
      {
        margin: [0, 10, 0, 0] as [number, number, number, number],
        style: "note",
        text: truncated
          ? `Showing the ${PDF_ROW_CAP} biggest spenders of ${scorecard.rows.length} managers — the Excel export carries them all.`
          : "A sale claimed by two campaigns is counted once, here and in the total.",
      },
    ],
    defaultStyle: { font: "Helvetica", fontSize: 9 },
    pageMargins: [30, 40, 30, 40],
    pageOrientation: "landscape",
    styles: {
      note: { color: "#64748B", fontSize: 8, italics: true },
      subtitle: { color: "#64748B", fontSize: 9 },
      title: { bold: true, fontSize: 18 },
    },
  };
}

export async function buildMarketingManagerScorecardPdf(
  scorecard: MarketingManagerScorecard,
): Promise<Buffer> {
  return pdfMake.createPdf(buildMarketingManagerScorecardPdfDocDefinition(scorecard)).getBuffer();
}

/**
 * `marketing-manager-scorecard-2026-10-09.xlsx` — the date is the CAIRO day it was taken, from the
 * shared formatter rather than a local `toLocaleDateString`, so a file taken at 01:00 Cairo is not
 * filed under the previous day by a server running in UTC.
 */
export function marketingManagerScorecardFilename(generatedAtIso: string, extension: "pdf" | "xlsx"): string {
  const cairoDay = cairoDateTimeSortable(generatedAtIso).slice(0, 10) || "undated";
  return `marketing-manager-scorecard-${cairoDay}.${extension}`;
}
