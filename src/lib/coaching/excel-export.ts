import { canonicalHrIdKey } from "@/lib/hr-id";
import ExcelJS from "exceljs";
import { HOUSE_XLSX_DISPLAY_FONT, HOUSE_XLSX_FONT } from "@/lib/export/house-xlsx-palette";

import { HOUSE_XLSX_COLORS, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";

import { systemDocuments } from "@/config/system-settings";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import type {
  CoachingPerformanceZone,
  CoachingReportDetail,
  CoachingReportFilters,
  CoachingReportStatus,
  CoachingReportSummaryRow,
} from "@/lib/coaching/types";



const completedStatuses = new Set<CoachingReportStatus>(["submitted", "reviewed_by_employee", "locked"]);

const zoneLabels: Record<CoachingPerformanceZone, string> = {
  critical_red: "Red Zone / Below Expectations",
  excellence_zone: "Excellence Zone / Exceeds Expectations",
  green_zone: "Green Zone / Meets Expectations",
  red_zone: "Red Zone / Below Expectations",
  yellow_zone: "Yellow Zone / Needs Improvement",
};

const statusLabels: Record<CoachingReportStatus, string> = {
  cancelled: "Cancelled",
  draft: "Draft",
  locked: "Locked",
  reviewed_by_employee: "Reviewed by Employee",
  submitted: "Submitted",
};

type CoachingExportReport = {
  detail: CoachingReportDetail;
  employee: EmployeeDirectoryRow | null;
  summary: CoachingReportSummaryRow;
};

export type GenerateCoachingReportsWorkbookInput = {
  exportDate?: Date;
  exportedBy?: string | null;
  filters?: CoachingReportFilters;
  reports: CoachingExportReport[];
};

type QuarterlyExportRow = {
  averageScore: number;
  bestScore: number;
  coachingCount: number;
  firstScore: number;
  improvementScore: number;
  latestScore: number;
  latestZone: CoachingPerformanceZone | null;
  lowestScore: number;
  medicalRepHrId: string;
  medicalRepName: string;
  quarter: number;
  year: number;
  lastCoachingDate: string | null;
};

type SummaryMetrics = {
  acknowledgmentRate: number;
  averageScore: number;
  statusCounts: Map<string, number>;
  totalReports: number;
  zoneCounts: Map<string, number>;
};

export function sanitizeExcelText(value: unknown, maxLength = 32767) {
  if (value === null || typeof value === "undefined") return "";
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .slice(0, maxLength);
}

export function safeWorksheetName(value: string, fallback: string) {
  const cleaned = sanitizeExcelText(value)
    .replace(/[\\/?*[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31);
  return cleaned || fallback.slice(0, 31);
}

export function coachingZoneLabel(zone: string | null | undefined) {
  if (!zone || !(zone in zoneLabels)) return "Not scored";
  return zoneLabels[zone as CoachingPerformanceZone];
}

export function coachingStatusLabel(status: string | null | undefined) {
  if (!status || !(status in statusLabels)) return "Unknown";
  return statusLabels[status as CoachingReportStatus];
}

export function coachingScoreMeaning(score: number | string | null | undefined) {
  const numeric = Number(score);
  if (numeric === 0) return "No Score";
  if (numeric === 1) return "Below Expectations";
  if (numeric === 2) return "Needs Improvement";
  if (numeric === 3) return "Within Average";
  if (numeric === 4) return "Meets Expectations";
  if (numeric === 5) return "Exceeds Expectations";
  return "Not scored";
}

function toExcelDate(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? sanitizeExcelText(value) : date;
}

function toExcelDateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? sanitizeExcelText(value) : date;
}

function normalizeHrId(value: string | null | undefined) {
  return canonicalHrIdKey(sanitizeExcelText(value)) ?? "";
}

function setWorkbookMetadata(workbook: ExcelJS.Workbook) {
  workbook.creator = systemDocuments.workbookCreator;
  workbook.company = systemDocuments.workbookCompany;
  workbook.subject = "Coaching Reports Export";
  workbook.title = systemDocuments.titles.coachingReportsExport;
  workbook.created = new Date();
  workbook.modified = new Date();
}

function styleSectionRow(row: ExcelJS.Row) {
  row.height = 20;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 10 };
    cell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
    // The caption sits ON the masthead's rule row, so its bottom border IS that rule — one line
    // doing both jobs rather than a caption stacked under a bar.
    cell.border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" } };
  });
}

function styleHeaderRow(row: ExcelJS.Row) {
  row.height = 26;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 9.5 };
    cell.alignment = { horizontal: "left", vertical: "bottom", wrapText: true };
    cell.border = {
      bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" },
      top: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "thin" },
    };
  });
}

function styleBodyRows(worksheet: ExcelJS.Worksheet, startRow: number) {
  for (let rowNumber = startRow; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const zebra = rowNumber % 2 === 0;
    row.eachCell((cell) => {
      if (zebra) {
        cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
      } else {
        cell.border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "hair" } };
      }
      cell.alignment = { vertical: "top", wrapText: true };
      cell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
    });
  }
}

function applySheetBase(worksheet: ExcelJS.Worksheet) {
  worksheet.properties.defaultRowHeight = 20;
  worksheet.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];
}

function applyAutoFilter(worksheet: ExcelJS.Worksheet, headerRowNumber: number, columnCount: number) {
  if (worksheet.rowCount < headerRowNumber) return;
  worksheet.autoFilter = {
    from: { column: 1, row: headerRowNumber },
    to: { column: columnCount, row: Math.max(headerRowNumber, worksheet.rowCount) },
  };
}

function addTitle(
  workbook: ExcelJS.Workbook,
  worksheet: ExcelJS.Worksheet,
  title: string,
  subtitle: string,
  span: number,
  sectionTitle?: string,
) {
  // Masthead on rows 1-3, table header on 4 — the rows this sheet already used, so the frozen pane
  // and every `styleBodyRows(worksheet, 5)` call still line up.
  //
  // Row 3 is normally the masthead's brand rule. A sheet with a section caption takes that row
  // instead and carries the rule as its own bottom border, so the caption and the rule share one
  // row rather than the caption pushing the table down.
  writeHouseMasthead(workbook, worksheet, {
    columns: span,
    provenance: [],
    subtitle: sanitizeExcelText(subtitle),
    title: sanitizeExcelText(title),
  });

  if (sectionTitle) {
    for (let columnNumber = 1; columnNumber <= span; columnNumber += 1) {
      worksheet.getRow(3).getCell(columnNumber).fill = { pattern: "none", type: "pattern" };
    }
    worksheet.mergeCells(3, 1, 3, span);
    worksheet.getCell(3, 1).value = sanitizeExcelText(sectionTitle);
    styleSectionRow(worksheet.getRow(3));
  }
}

function filterSummary(filters: CoachingReportFilters | undefined) {
  if (!filters) return "No explicit filters applied.";
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== null && typeof value !== "undefined" && String(value).trim())
    .map(([key, value]) => `${key}: ${sanitizeExcelText(value)}`);
  return entries.length ? entries.join(" | ") : "No explicit filters applied.";
}

function buildMetrics(reports: CoachingExportReport[]): SummaryMetrics {
  const completedReports = reports.filter((item) => completedStatuses.has(item.summary.status));
  const scored = completedReports.map((item) => item.summary.finalScorePercent);
  const acknowledgedCount = completedReports.filter((item) => item.summary.acknowledged).length;
  const zoneCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();

  for (const item of reports) {
    const zone = coachingZoneLabel(item.summary.performanceZone);
    const status = coachingStatusLabel(item.summary.status);
    zoneCounts.set(zone, (zoneCounts.get(zone) ?? 0) + 1);
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }

  return {
    acknowledgmentRate: completedReports.length ? (acknowledgedCount / completedReports.length) * 100 : 0,
    averageScore: scored.length ? scored.reduce((sum, value) => sum + value, 0) / scored.length : 0,
    statusCounts,
    totalReports: reports.length,
    zoneCounts,
  };
}

function buildQuarterlyRows(reports: CoachingExportReport[]): QuarterlyExportRow[] {
  const buckets = new Map<string, CoachingExportReport[]>();
  for (const item of reports) {
    if (!completedStatuses.has(item.summary.status)) continue;
    const key = `${item.summary.medicalRepHrId}|${item.summary.coachingYear}|${item.summary.coachingQuarter}`;
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }

  return [...buckets.values()].map((items) => {
    const sorted = [...items].sort((left, right) => left.summary.coachingDate.localeCompare(right.summary.coachingDate));
    const first = sorted[0].summary;
    const latest = sorted[sorted.length - 1].summary;
    const scores = sorted.map((item) => item.summary.finalScorePercent);

    return {
      averageScore: scores.reduce((sum, value) => sum + value, 0) / scores.length,
      bestScore: Math.max(...scores),
      coachingCount: sorted.length,
      firstScore: first.finalScorePercent,
      improvementScore: latest.finalScorePercent - first.finalScorePercent,
      lastCoachingDate: latest.coachingDate,
      latestScore: latest.finalScorePercent,
      latestZone: latest.performanceZone,
      lowestScore: Math.min(...scores),
      medicalRepHrId: latest.medicalRepHrId,
      medicalRepName: latest.medicalRepName,
      quarter: latest.coachingQuarter,
      year: latest.coachingYear,
    };
  }).sort((left, right) => right.year - left.year || right.quarter - left.quarter || left.medicalRepName.localeCompare(right.medicalRepName));
}

/**
 * The performance zone, as type.
 *
 * Dropping the fills is safe here because THE CELL ALREADY SAYS THE ZONE — its value is the label,
 * "Red Zone" / "Green Zone" — so the colour was reinforcement, never the carrier. That is the test
 * for whether a fill may go: the attendance reports grade a bare NUMBER, so their colour was doing
 * real work and had to become weight rather than vanish.
 *
 * Four steps, one of which needs acting on: the flag colour is spent there and nowhere else, so the
 * sheet does not shout in four directions at once.
 */
function colorZoneCell(cell: ExcelJS.Cell, zone: string | null | undefined) {
  if (zone === "critical_red" || zone === "red_zone") {
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.flag }, name: HOUSE_XLSX_FONT, size: 9.5 };
  } else if (zone === "yellow_zone") {
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 9.5 };
  } else if (zone === "green_zone") {
    cell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
  } else if (zone === "excellence_zone") {
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.light }, name: HOUSE_XLSX_FONT, size: 9.5 };
  }
}

function buildEmployeeMap(reports: CoachingExportReport[]) {
  const map = new Map<string, EmployeeDirectoryRow>();
  for (const item of reports) {
    const key = normalizeHrId(item.employee?.hrId);
    if (key && item.employee) map.set(key, item.employee);
  }
  return map;
}

function addExecutiveSummarySheet(workbook: ExcelJS.Workbook, input: GenerateCoachingReportsWorkbookInput) {
  const worksheet = workbook.addWorksheet(safeWorksheetName("Executive Summary", "Summary"));
  applySheetBase(worksheet);
  addTitle(workbook, worksheet, "Coaching Reports", "Field Coaching & Excellence Module", 8, "Executive dashboard");

  const metrics = buildMetrics(input.reports);
  const exportDate = input.exportDate ?? new Date();

  worksheet.mergeCells("A4:B4");
  worksheet.mergeCells("C4:D4");
  worksheet.mergeCells("E4:F4");
  worksheet.mergeCells("G4:H4");
  worksheet.mergeCells("A6:B6");
  worksheet.mergeCells("C6:D6");
  worksheet.mergeCells("E6:F6");
  worksheet.mergeCells("G6:H6");

  const kpis = [
    ["A4", "A5", "Total Reports", metrics.totalReports],
    ["C4", "C5", "Average Score", metrics.averageScore],
    ["E4", "E5", "Acknowledgment Rate", metrics.acknowledgmentRate],
    ["G4", "G5", "Red Zone Count", (metrics.zoneCounts.get(zoneLabels.critical_red) ?? 0) + (metrics.zoneCounts.get(zoneLabels.red_zone) ?? 0)],
    ["A6", "A7", "Yellow Zone Count", metrics.zoneCounts.get(zoneLabels.yellow_zone) ?? 0],
    ["C6", "C7", "Green Zone Count", metrics.zoneCounts.get(zoneLabels.green_zone) ?? 0],
    ["E6", "E7", "Excellence Zone Count", metrics.zoneCounts.get(zoneLabels.excellence_zone) ?? 0],
    ["G6", "G7", "Export Date", exportDate],
  ] as const;

  for (const [labelCell, valueCell, label, value] of kpis) {
    const labelTarget = worksheet.getCell(labelCell);
    const valueTarget = worksheet.getCell(valueCell);
    labelTarget.value = label;
    // A KPI tile: a label in small caps over a figure, separated by a rule rather than boxed in.
    labelTarget.font = {
      bold: true,
      color: { argb: HOUSE_XLSX_COLORS.light },
      name: HOUSE_XLSX_FONT,
      size: 8,
    };
    labelTarget.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
    valueTarget.value = value;
    valueTarget.font = {
      bold: true,
      color: { argb: HOUSE_XLSX_COLORS.deep },
      name: HOUSE_XLSX_DISPLAY_FONT,
      size: 15,
    };
    valueTarget.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
    valueTarget.border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "thin" } };
  }
  worksheet.getCell("C5").numFmt = "0.0";
  worksheet.getCell("E5").numFmt = "0.0";
  worksheet.getCell("G7").numFmt = "yyyy-mm-dd hh:mm";

  worksheet.addRow([]);
  worksheet.addRow(["Performance Zone", "Count", "", "Status", "Count", "", "Export Context", "Value"]);
  const summaryHeaderRow = worksheet.rowCount;
  styleHeaderRow(worksheet.getRow(summaryHeaderRow));
  for (const [label, count] of metrics.zoneCounts.entries()) {
    const row = worksheet.addRow([label, count]);
    if (label === zoneLabels.critical_red || label === zoneLabels.red_zone) colorZoneCell(row.getCell(1), "red_zone");
    if (label === zoneLabels.yellow_zone) colorZoneCell(row.getCell(1), "yellow_zone");
    if (label === zoneLabels.green_zone) colorZoneCell(row.getCell(1), "green_zone");
    if (label === zoneLabels.excellence_zone) colorZoneCell(row.getCell(1), "excellence_zone");
  }

  let statusRow = summaryHeaderRow + 1;
  for (const [label, count] of metrics.statusCounts.entries()) {
    worksheet.getRow(statusRow).getCell(4).value = label;
    worksheet.getRow(statusRow).getCell(5).value = count;
    statusRow += 1;
  }
  worksheet.getRow(summaryHeaderRow + 1).getCell(7).value = "Exported by";
  worksheet.getRow(summaryHeaderRow + 1).getCell(8).value = input.exportedBy || systemDocuments.workbookCreator;
  worksheet.getRow(summaryHeaderRow + 2).getCell(7).value = "Applied filters";
  worksheet.getRow(summaryHeaderRow + 2).getCell(8).value = filterSummary(input.filters);
  worksheet.getRow(summaryHeaderRow + 3).getCell(7).value = "Access scope note";
  worksheet.getRow(summaryHeaderRow + 3).getCell(8).value = systemDocuments.workbookExportScopeNote;

  worksheet.columns = [
    { key: "label", width: 28 },
    { key: "value", width: 14 },
    { width: 4 },
    { width: 26 },
    { width: 14 },
    { width: 4 },
    { width: 24 },
    { width: 48 },
  ];
  styleBodyRows(worksheet, 4);
  worksheet.getColumn(8).alignment = { wrapText: true, vertical: "top" };
}

function addReportsSheet(workbook: ExcelJS.Workbook, reports: CoachingExportReport[]) {
  const worksheet = workbook.addWorksheet(safeWorksheetName("Coaching Reports", "Reports"));
  applySheetBase(worksheet);
  addTitle(workbook, worksheet, "Coaching Reports — Export", "Detailed report records in the current export scope", 25, "Report information");

  const headers = [
    "Report Number",
    "Medical Rep HR ID",
    "Medical Rep Name",
    "Job Title",
    "Coach HR ID",
    "Coach Name",
    "Coach Role",
    "Line",
    "Area",
    "Team",
    "Coaching Date",
    "Month",
    "Quarter",
    "Year",
    "Actual Score",
    "Max Score",
    "Final Score %",
    "Performance Zone",
    "Status",
    "Employee Acknowledged",
    "Acknowledged At",
    "Submitted At",
    "Area of Development",
    "Strength Points",
    "General Remarks",
  ];
  worksheet.addRow(headers);
  styleHeaderRow(worksheet.getRow(4));

  for (const item of reports) {
    const report = item.detail.report;
    worksheet.addRow([
      item.summary.reportNumber,
      item.summary.medicalRepHrId,
      item.summary.medicalRepName,
      item.employee?.jobTitle ?? "",
      item.summary.coachHrId,
      item.summary.coachName,
      report.coach_role ?? "",
      item.summary.lineName ?? "",
      item.summary.areaName ?? "",
      item.summary.teamName ?? "",
      toExcelDate(item.summary.coachingDate),
      item.summary.coachingMonth,
      item.summary.coachingQuarter,
      item.summary.coachingYear,
      item.summary.actualScore,
      item.summary.maxScore,
      item.summary.finalScorePercent,
      coachingZoneLabel(item.summary.performanceZone),
      coachingStatusLabel(item.summary.status),
      item.summary.acknowledged ? "Yes" : "No",
      toExcelDateTime(item.summary.acknowledgedAt),
      toExcelDateTime(item.summary.submittedAt),
      sanitizeExcelText(report.area_of_development),
      sanitizeExcelText(report.strength_points),
      sanitizeExcelText(report.general_remarks),
    ]);
  }

  worksheet.columns = [
    { width: 20 },
    { width: 18 },
    { width: 28 },
    { width: 22 },
    { width: 18 },
    { width: 26 },
    { width: 18 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 14 },
    { width: 9 },
    { width: 9 },
    { width: 9 },
    { width: 12 },
    { width: 12 },
    { width: 14 },
    { width: 28 },
    { width: 22 },
    { width: 18 },
    { width: 20 },
    { width: 20 },
    { width: 34 },
    { width: 34 },
    { width: 38 },
  ];
  worksheet.getColumn(11).numFmt = "yyyy-mm-dd";
  worksheet.getColumn(17).numFmt = "0.0";
  worksheet.getColumn(21).numFmt = "yyyy-mm-dd hh:mm";
  worksheet.getColumn(22).numFmt = "yyyy-mm-dd hh:mm";
  styleBodyRows(worksheet, 5);
  reports.forEach((item, index) => {
    colorZoneCell(worksheet.getRow(5 + index).getCell(18), item.summary.performanceZone);
  });
  applyAutoFilter(worksheet, 4, headers.length);
}

function addScoreItemsSheet(workbook: ExcelJS.Workbook, reports: CoachingExportReport[]) {
  const worksheet = workbook.addWorksheet(safeWorksheetName("Score Items", "Scores"));
  applySheetBase(worksheet);
  addTitle(workbook, worksheet, "Coaching Score Items", "Structured scoring item detail for exported coaching reports", 10, "Score breakdown");

  const headers = [
    "Report Number",
    "Medical Rep HR ID",
    "Medical Rep Name",
    "Coaching Date",
    "Parameter Category",
    "Score Item Label",
    "Score",
    "Score Meaning",
    "Item Area to be Improved",
    "Item Strength Point",
  ];
  worksheet.addRow(headers);
  styleHeaderRow(worksheet.getRow(4));

  for (const item of reports) {
    for (const score of item.detail.scores) {
      worksheet.addRow([
        item.summary.reportNumber,
        item.summary.medicalRepHrId,
        item.summary.medicalRepName,
        toExcelDate(item.summary.coachingDate),
        sanitizeExcelText(score.parameter_category.replace(/_/g, " ")),
        sanitizeExcelText(score.score_item_label),
        score.score,
        coachingScoreMeaning(score.score),
        sanitizeExcelText(score.area_to_be_improved),
        sanitizeExcelText(score.strength_point),
      ]);
    }
  }

  worksheet.columns = [
    { width: 20 },
    { width: 18 },
    { width: 28 },
    { width: 14 },
    { width: 26 },
    { width: 42 },
    { width: 10 },
    { width: 34 },
    { width: 38 },
    { width: 38 },
  ];
  worksheet.getColumn(4).numFmt = "yyyy-mm-dd";
  styleBodyRows(worksheet, 5);
  applyAutoFilter(worksheet, 4, headers.length);
}

function addQuarterlySummarySheet(workbook: ExcelJS.Workbook, reports: CoachingExportReport[]) {
  const worksheet = workbook.addWorksheet(safeWorksheetName("Quarterly Summary", "Quarterly"));
  applySheetBase(worksheet);
  addTitle(workbook, worksheet, "Quarterly Coaching Summary", "Filtered quarterly coaching performance summary", 13, "Quarterly intelligence");

  const headers = [
    "Medical Rep HR ID",
    "Medical Rep Name",
    "Year",
    "Quarter",
    "Coaching Count",
    "Average Score",
    "Best Score",
    "Lowest Score",
    "First Score",
    "Latest Score",
    "Improvement Score",
    "Latest Zone",
    "Last Coaching Date",
  ];
  worksheet.addRow(headers);
  styleHeaderRow(worksheet.getRow(4));

  const quarterlyRows = buildQuarterlyRows(reports);
  for (const row of quarterlyRows) {
    worksheet.addRow([
      row.medicalRepHrId,
      row.medicalRepName,
      row.year,
      row.quarter,
      row.coachingCount,
      row.averageScore,
      row.bestScore,
      row.lowestScore,
      row.firstScore,
      row.latestScore,
      row.improvementScore,
      coachingZoneLabel(row.latestZone),
      toExcelDate(row.lastCoachingDate),
    ]);
  }

  worksheet.columns = [
    { width: 18 },
    { width: 28 },
    { width: 10 },
    { width: 10 },
    { width: 16 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 18 },
    { width: 30 },
    { width: 18 },
  ];
  for (const columnNumber of [6, 7, 8, 9, 10, 11]) {
    worksheet.getColumn(columnNumber).numFmt = "0.0";
  }
  worksheet.getColumn(13).numFmt = "yyyy-mm-dd";
  styleBodyRows(worksheet, 5);
  quarterlyRows.forEach((row, index) => {
    colorZoneCell(worksheet.getRow(5 + index).getCell(12), row.latestZone);
    const improvementCell = worksheet.getRow(5 + index).getCell(11);
    // Improvement is a SIGNED NUMBER, so unlike the zone column its cell does not say in words
    // which direction it went — the colour is doing real work and stays, in the house palette.
    // A decline gets the flag colour; a gain gets Brand Blue rather than a green the mark has not
    // got. The sign is still in the value, so neither reading depends on colour alone.
    if (row.improvementScore > 0) {
      improvementCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.light }, name: HOUSE_XLSX_FONT, size: 9.5 };
    } else if (row.improvementScore < 0) {
      improvementCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.flag }, name: HOUSE_XLSX_FONT, size: 9.5 };
    }
  });
  applyAutoFilter(worksheet, 4, headers.length);
}

export async function generateCoachingReportsWorkbook(input: GenerateCoachingReportsWorkbookInput) {
  const workbook = new ExcelJS.Workbook();
  setWorkbookMetadata(workbook);

  const employeeMap = buildEmployeeMap(input.reports);
  const normalizedReports = input.reports.map((item) => ({
    ...item,
    employee: item.employee ?? employeeMap.get(normalizeHrId(item.summary.medicalRepHrId)) ?? null,
  }));

  addExecutiveSummarySheet(workbook, { ...input, reports: normalizedReports });
  addReportsSheet(workbook, normalizedReports);
  addScoreItemsSheet(workbook, normalizedReports);
  addQuarterlySummarySheet(workbook, normalizedReports);

  const output = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}
