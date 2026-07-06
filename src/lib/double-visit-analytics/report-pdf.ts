import pdfMake from "pdfmake";
import type { Content } from "pdfmake";

import { buildReportSummaryMetrics, formatActiveFilters } from "@/lib/double-visit-analytics/report-filters";
import type {
  DoubleVisitFocusProbationEntry,
  DoubleVisitFocusRosterEntry,
  DoubleVisitReportData,
  DoubleVisitReportRow,
} from "@/lib/double-visit-analytics/types";

// Code-built PDF (no headless browser) — deliberately lightweight for Vercel's serverless
// nodejs runtime. Uses one of the 14 standard PDF fonts (Helvetica), so no font files need to
// be embedded/bundled. Content is capped to a preview table (see PREVIEW_ROW_CAP) — PDFs don't
// paginate wide/long tables well, so the full row-by-row detail belongs in the xlsx export;
// this format is for a quick, printable snapshot of the same filtered scope.

pdfMake.setFonts({
  Helvetica: { normal: "Helvetica", bold: "Helvetica-Bold", italics: "Helvetica-Oblique", bolditalics: "Helvetica-BoldOblique" },
});

const PREVIEW_ROW_CAP = 50;

export type DoubleVisitReportPdfTab = "log" | "neverVisited" | "probation";

export type DoubleVisitReportFilteredData = {
  logRows: DoubleVisitReportRow[];
  neverVisitedRows: DoubleVisitFocusRosterEntry[];
  probationRows: DoubleVisitFocusProbationEntry[];
};

type PdfDocDefinition = Parameters<typeof pdfMake.createPdf>[0];

function buildPreviewTable(
  filtered: DoubleVisitReportFilteredData,
  tab: DoubleVisitReportPdfTab,
): { table: Content; title: string; totalRows: number; truncated: boolean } {
  if (tab === "neverVisited") {
    const rows = filtered.neverVisitedRows;
    const preview = rows.slice(0, PREVIEW_ROW_CAP);
    return {
      table: {
        layout: "lightHorizontalLines",
        table: {
          body: [
            [
              { bold: true, text: "Name" },
              { bold: true, text: "Area" },
              { bold: true, text: "Hired" },
              { bold: true, text: "Days Since Hire" },
              { bold: true, text: "Overdue" },
            ],
            ...preview.map((row) => [
              row.name,
              row.areaName ?? "—",
              row.hireDate ?? "—",
              String(row.daysSinceHire ?? "—"),
              row.flagged ? "Yes" : "No",
            ]),
          ],
          headerRows: 1,
          widths: ["*", "auto", "auto", "auto", "auto"],
        },
      },
      title: "Never Visited / At Risk (preview)",
      totalRows: rows.length,
      truncated: rows.length > PREVIEW_ROW_CAP,
    };
  }

  if (tab === "probation") {
    const rows = filtered.probationRows;
    const preview = rows.slice(0, PREVIEW_ROW_CAP);
    return {
      table: {
        layout: "lightHorizontalLines",
        table: {
          body: [
            [
              { bold: true, text: "Name" },
              { bold: true, text: "Hired" },
              { bold: true, text: "Probation End" },
              { bold: true, text: "Days Left" },
              { bold: true, text: "DV Count" },
              { bold: true, text: "DV Status" },
            ],
            ...preview.map((row) => [
              row.name,
              row.hireDate,
              row.probationEndDate,
              String(row.daysRemaining),
              String(row.dvCount),
              row.dvDone === null ? "N/A" : row.dvDone ? "Done" : "Pending",
            ]),
          ],
          headerRows: 1,
          widths: ["*", "auto", "auto", "auto", "auto", "auto"],
        },
      },
      title: "Probation Watchlist (preview)",
      totalRows: rows.length,
      truncated: rows.length > PREVIEW_ROW_CAP,
    };
  }

  const rows = filtered.logRows;
  const preview = rows.slice(0, PREVIEW_ROW_CAP);
  return {
    table: {
      layout: "lightHorizontalLines",
      table: {
        body: [
          [
            { bold: true, text: "Date" },
            { bold: true, text: "Double Visitor" },
            { bold: true, text: "Job Title" },
            { bold: true, text: "Visited MR" },
            { bold: true, text: "Area" },
            { bold: true, text: "Region" },
            { bold: true, text: "Period" },
            { bold: true, text: "Type" },
            { bold: true, text: "Visits" },
          ],
          ...preview.map((row) => [
            row.activityDate,
            row.doubleVisitorName ?? row.doubleVisitorHrId ?? "—",
            row.doubleVisitorRole ?? "—",
            row.visitedName ?? row.visitedHrId ?? "—",
            row.areaName ?? "—",
            row.regionName ?? "—",
            row.period,
            row.visitKind,
            String(row.visitCount),
          ]),
        ],
        headerRows: 1,
        widths: ["auto", "*", "auto", "*", "auto", "auto", "auto", "auto", "auto"],
      },
    },
    title: "Visit Log (preview)",
    totalRows: rows.length,
    truncated: rows.length > PREVIEW_ROW_CAP,
  };
}

export function buildDoubleVisitReportPdfDocDefinition(
  data: DoubleVisitReportData,
  filtered: DoubleVisitReportFilteredData,
  activeFilters: Record<string, string>,
  tab: DoubleVisitReportPdfTab,
): PdfDocDefinition {
  const summaryMetrics = buildReportSummaryMetrics(filtered);
  const preview = buildPreviewTable(filtered, tab);

  const summaryTable: Content = {
    layout: "lightHorizontalLines",
    table: {
      body: [
        [
          { bold: true, text: "Metric" },
          { bold: true, text: "Value" },
        ],
        ["Date Range", `${data.dateFrom} to ${data.dateTo}`],
        ["Active Filters", formatActiveFilters(activeFilters)],
        ...summaryMetrics.map((row) => [row.metric, String(row.value)]),
      ],
      widths: ["*", "*"],
    },
  };

  return {
    content: [
      { style: "title", text: "Double Visit Report" },
      { margin: [0, 0, 0, 12] as [number, number, number, number], style: "subtitle", text: `Generated ${data.asOfDate}` },
      { style: "sectionHeader", text: "Executive Summary" },
      summaryTable,
      { margin: [0, 16, 0, 4] as [number, number, number, number], style: "sectionHeader", text: preview.title },
      preview.table,
      ...(preview.truncated
        ? [
            {
              margin: [0, 6, 0, 0] as [number, number, number, number],
              style: "note",
              text: `Showing ${PREVIEW_ROW_CAP} of ${preview.totalRows} filtered rows — download the Excel report for the full list.`,
            },
          ]
        : []),
    ],
    defaultStyle: { font: "Helvetica", fontSize: 9 },
    pageMargins: [30, 40, 30, 40],
    pageOrientation: "landscape",
    styles: {
      note: { color: "#B45309", fontSize: 8, italics: true },
      sectionHeader: { bold: true, color: "#0F172A", fontSize: 12 },
      subtitle: { color: "#64748B", fontSize: 9 },
      title: { bold: true, fontSize: 18 },
    },
  };
}

export async function buildDoubleVisitReportPdf(
  data: DoubleVisitReportData,
  filtered: DoubleVisitReportFilteredData,
  activeFilters: Record<string, string>,
  tab: DoubleVisitReportPdfTab,
): Promise<Buffer> {
  const docDefinition = buildDoubleVisitReportPdfDocDefinition(data, filtered, activeFilters, tab);
  const pdf = pdfMake.createPdf(docDefinition);
  return pdf.getBuffer();
}
