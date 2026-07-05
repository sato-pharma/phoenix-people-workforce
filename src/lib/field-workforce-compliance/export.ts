import ExcelJS from "exceljs";

import { systemDocuments, systemIdentity } from "@/config/system-settings";
import type {
  FieldWorkforceArchiveDetail,
  FieldWorkforceCellStatus,
  FieldWorkforceDayCell,
  FieldWorkforceEmployeeSummary,
  FieldWorkforceFinalAction,
  FieldWorkforceRecommendation,
  FieldWorkforceRecommendationsReport,
  FieldWorkforceReviewCandidate,
  FieldWorkforceValidationIssue,
} from "@/lib/field-workforce-compliance/types";

const phoenixOrange = "FFC2410C";
const phoenixSlate = "FF0F172A";
const softBorder = "FFE2E8F0";
const bandFill = "FFF8FAFC";

/** A value that ExcelJS can render directly in a cell. */
type CellValue = string | number | null;

function styleTitle(cell: ExcelJS.Cell) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: phoenixOrange } };
  cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
  cell.alignment = { horizontal: "center", vertical: "middle" };
}

function styleHeader(row: ExcelJS.Row) {
  row.height = 24;
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: phoenixSlate } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      bottom: { style: "thin", color: { argb: softBorder } },
      left: { style: "thin", color: { argb: softBorder } },
      right: { style: "thin", color: { argb: softBorder } },
      top: { style: "thin", color: { argb: softBorder } },
    };
  });
}

function styleBody(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.font = { color: { argb: phoenixSlate }, size: 10 };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FFF1F5F9" } } };
  });
}

function formatDates(dates: string[]) {
  return dates.join(", ");
}

function actionRow(action: FieldWorkforceFinalAction) {
  return [
    action.employeeName,
    action.employeeCode,
    action.monthKey,
    action.actionType,
    formatDates(action.approvedDates),
    action.approvedDaysCount,
    action.decisionReason || "",
    action.decisionStatus,
    action.hrNote,
    action.approvedBy ?? "",
    action.approvedAt ?? "",
    action.amount ?? "Amount requires payroll calculation",
    action.pushStatus,
  ];
}

export function generateFieldWorkforceFinalActionsWorkbook(report: FieldWorkforceRecommendationsReport) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.company = systemIdentity.appName;
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet("Final Actions", {
    views: [{ state: "frozen", ySplit: 5 }],
  });
  const headers = [
    "Employee",
    "Code",
    "Month",
    "Action Type",
    "Approved Dates",
    "Approved Days Count",
    "Reason",
    "HR Decision",
    "HR Note",
    "Approved By",
    "Approved At",
    "Estimated Amount",
    "Push Status",
  ];

  sheet.mergeCells(1, 1, 1, headers.length);
  styleTitle(sheet.getCell(1, 1));
  sheet.getCell(1, 1).value = `${systemIdentity.appName} - Workforce Compliance Final Approved Actions`;

  sheet.mergeCells(2, 1, 2, headers.length);
  sheet.getCell(2, 1).value = "This export does not execute payroll or leave changes.";
  sheet.getCell(2, 1).font = { bold: true, color: { argb: "FF9A3412" }, italic: true };
  sheet.getCell(2, 1).alignment = { horizontal: "center" };

  sheet.mergeCells(3, 1, 3, headers.length);
  sheet.getCell(3, 1).value = `Month: ${report.archive.monthKey} | Rows: ${report.finalActions.length} | Push status: Export only`;
  sheet.getCell(3, 1).font = { color: { argb: "FF475569" }, italic: true };
  sheet.getCell(3, 1).alignment = { horizontal: "center" };

  sheet.addRow([]);
  sheet.addRow(headers);
  styleHeader(sheet.getRow(5));

  for (const action of report.finalActions) {
    styleBody(sheet.addRow(actionRow(action)));
  }

  headers.forEach((header, index) => {
    const longest = Math.max(
      header.length,
      ...report.finalActions.slice(0, 500).map((action) => String(actionRow(action)[index] ?? "").length),
    );
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 3, 14), 42);
  });

  sheet.autoFilter = {
    from: { column: 1, row: 5 },
    to: { column: headers.length, row: 5 },
  };

  const notes = workbook.addWorksheet("Safety Notes");
  notes.columns = [{ width: 36 }, { width: 110 }];
  notes.addRows([
    ["Note", "Details"],
    ["Execution boundary", "This export is report-only. It does not push to payroll, mutate leave balances, or approve final execution."],
    ["Payroll amount", "Estimated amount is blank unless a safe payroll calculation is connected. Current Phase 4 output requires payroll confirmation."],
    ["Leave action", "Leave adjustment rows are recommendations for reconciliation reports only."],
  ]);
  styleHeader(notes.getRow(1));
  for (let row = 2; row <= notes.rowCount; row += 1) {
    styleBody(notes.getRow(row));
  }

  return workbook;
}

// ===========================================================================
// Whole-module exports
// ---------------------------------------------------------------------------
// Two report-only exports of an archived month:
//  - a simple single-sheet Monthly Summary, and
//  - the "god-mode" book: every workspace tab as its own sheet, plus a Summary,
//    a visual color-coded Calendar Grid, and a Legend, using the advanced Excel
//    features ExcelJS supports (conditional formatting / color scales / data
//    bars, freeze panes, filters, row outlines, formulas, number formats, cell
//    comments, hyperlinks, defined names, print setup).
// Note: ExcelJS cannot author native charts or PivotTables; the Day Data sheet
// is provided as a pivot-ready source and conditional formatting supplies the
// in-cell "heatmap" analytics instead.
// ===========================================================================

const STATUS_MEANINGS: Record<FieldWorkforceCellStatus, string> = {
  AV: "Vacation signal",
  BLANK: "Blank",
  CP: "Campaign",
  F: "Friday",
  N: "No activity",
  UNKNOWN: "Unknown value",
  VISITS: "Visits",
};

/** Cell fill + font colors that mirror the on-screen timeline legend. */
const STATUS_STYLES: Record<FieldWorkforceCellStatus, { fill: string; font: string }> = {
  AV: { fill: "FFE0F2FE", font: "FF075985" },
  BLANK: { fill: "FFFFFFFF", font: "FF94A3B8" },
  CP: { fill: "FFF3E8FF", font: "FF6B21A8" },
  F: { fill: "FFF1F5F9", font: "FF64748B" },
  N: { fill: "FFFFE4E6", font: "FF9F1239" },
  UNKNOWN: { fill: "FFFEE2E2", font: "FF991B1B" },
  VISITS: { fill: "FFD1FAE5", font: "FF065F46" },
};

const holidayBorderColor = "FFF59E0B";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayLabel(dateIso: string) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  return WEEKDAY_LABELS[date.getUTCDay()] ?? "";
}

function yesNo(value: boolean) {
  return value ? "Yes" : "No";
}

function rawCellText(value: FieldWorkforceDayCell["rawValue"]): CellValue {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return value;
  return String(value);
}

function hierarchyValue(value: string | null | undefined): string {
  return value ?? "";
}

function createWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.company = systemIdentity.appName;
  workbook.created = new Date();
  workbook.modified = new Date();
  return workbook;
}

function applyPrintSetup(sheet: ExcelJS.Worksheet) {
  sheet.pageSetup = {
    fitToHeight: 0,
    fitToPage: true,
    fitToWidth: 1,
    margins: { bottom: 0.5, footer: 0.3, header: 0.3, left: 0.4, right: 0.4, top: 0.5 },
    orientation: "landscape",
  };
}

function sortedEmployees(detail: FieldWorkforceArchiveDetail) {
  return [...detail.preview.employees].sort((left, right) => left.employeeName.localeCompare(right.employeeName));
}

type StyledSheetContext = {
  columnCount: number;
  firstDataRow: number;
  headerRow: number;
  lastDataRow: number;
};

/**
 * Adds a Phoenix-styled worksheet: orange title, italic subtitle, a slate header
 * row, banded body rows, auto-sized columns, freeze panes, auto-filter and print
 * setup. Optional number formats and an `afterBody` hook (for conditional
 * formatting / totals / defined names) keep the advanced sheets DRY.
 */
function addStyledSheet(
  workbook: ExcelJS.Workbook,
  options: {
    afterBody?: (sheet: ExcelJS.Worksheet, context: StyledSheetContext) => void;
    freezeColumns?: number;
    headers: string[];
    name: string;
    numberFormats?: Record<number, string>;
    rows: CellValue[][];
    subtitle: string;
    title: string;
  },
) {
  const { afterBody, freezeColumns = 0, headers, name, numberFormats, rows, subtitle, title } = options;
  const columnCount = Math.max(headers.length, 1);
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", xSplit: freezeColumns, ySplit: 4 }],
  });

  sheet.mergeCells(1, 1, 1, columnCount);
  styleTitle(sheet.getCell(1, 1));
  sheet.getCell(1, 1).value = title;

  sheet.mergeCells(2, 1, 2, columnCount);
  sheet.getCell(2, 1).value = subtitle;
  sheet.getCell(2, 1).font = { color: { argb: "FF475569" }, italic: true };
  sheet.getCell(2, 1).alignment = { horizontal: "center" };

  sheet.addRow([]);
  sheet.addRow(headers);
  styleHeader(sheet.getRow(4));

  rows.forEach((row, index) => {
    const bodyRow = sheet.addRow(row);
    styleBody(bodyRow);
    if (index % 2 === 1) {
      bodyRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bandFill } };
      });
    }
  });

  headers.forEach((header, index) => {
    const longest = Math.max(
      header.length,
      ...rows.slice(0, 500).map((row) => String(row[index] ?? "").length),
    );
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 3, 12), 48);
    const numFmt = numberFormats?.[index + 1];
    if (numFmt) sheet.getColumn(index + 1).numFmt = numFmt;
  });

  if (rows.length > 0) {
    sheet.autoFilter = { from: { column: 1, row: 4 }, to: { column: columnCount, row: 4 } };
  }

  applyPrintSetup(sheet);

  if (afterBody) {
    afterBody(sheet, {
      columnCount,
      firstDataRow: 5,
      headerRow: 4,
      lastDataRow: 4 + rows.length,
    });
  }

  return sheet;
}

// --- Severity conditional formatting shared by the review/recommendation sheets.

function applySeverityConditionalFormatting(sheet: ExcelJS.Worksheet, column: number, context: StyledSheetContext) {
  if (context.lastDataRow < context.firstDataRow) return;
  const letter = sheet.getColumn(column).letter;
  const ref = `${letter}${context.firstDataRow}:${letter}${context.lastDataRow}`;
  sheet.addConditionalFormatting({
    ref,
    rules: [
      {
        operator: "containsText",
        priority: 1,
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFECACA" } }, font: { bold: true, color: { argb: "FF991B1B" } } },
        text: "High",
        type: "containsText",
      },
      {
        operator: "containsText",
        priority: 2,
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFEF3C7" } }, font: { color: { argb: "FF92400E" } } },
        text: "Review",
        type: "containsText",
      },
      {
        operator: "containsText",
        priority: 3,
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFEF3C7" } }, font: { color: { argb: "FF92400E" } } },
        text: "Medium",
        type: "containsText",
      },
    ],
  });
}

// --- Monthly Summary (advanced analytics table, shared by simple + god-mode).

const MONTHLY_SUMMARY_HEADERS = [
  "Employee",
  "HR ID",
  "Hiring Date",
  "Manager",
  "Line",
  "Area",
  "Team",
  "Role",
  "Employment Status",
  "Eligible Days",
  "Worked Days",
  "Compliance %",
  "No Activity (N)",
  "Vacation (AV)",
  "Campaign (CP)",
  "Total Visits",
  "Holiday Warnings",
  "Pre-hire Values",
  "Unknown Values",
  "Longest N Streak",
  "High Severity",
];

function monthlySummaryRow(employee: FieldWorkforceEmployeeSummary): CellValue[] {
  return [
    employee.employeeName,
    employee.hrId,
    employee.hiringDateIso ?? "",
    hierarchyValue(employee.managerName),
    hierarchyValue(employee.lineName),
    hierarchyValue(employee.areaName),
    hierarchyValue(employee.teamName),
    hierarchyValue(employee.roleName),
    hierarchyValue(employee.employmentStatus),
    employee.eligibleWorkingDays,
    employee.workedDays,
    employee.compliancePercent,
    employee.noActivityCandidates,
    employee.vacationSignalDays,
    employee.campaignDays,
    employee.totalVisits,
    employee.holidayWarnings,
    employee.preHireIgnoredValues,
    employee.unknownValues,
    employee.noActivityPattern.longestStreak,
    employee.severityCounts.High,
  ];
}

/** Numeric columns (1-based) in the Monthly Summary and their number formats. */
const MONTHLY_SUMMARY_NUMBER_FORMATS: Record<number, string> = {
  10: "#,##0",
  11: "#,##0",
  12: '0.0"%"',
  13: "#,##0",
  14: "#,##0",
  15: "#,##0",
  16: "#,##0",
  17: "#,##0",
  18: "#,##0",
  19: "#,##0",
  20: "#,##0",
  21: "#,##0",
};

function addMonthlySummarySheet(workbook: ExcelJS.Workbook, detail: FieldWorkforceArchiveDetail) {
  const employees = sortedEmployees(detail);
  const sheet = addStyledSheet(workbook, {
    afterBody: (target, context) => {
      if (context.lastDataRow < context.firstDataRow) return;
      const letter = (column: number) => target.getColumn(column).letter;
      const complianceRef = `${letter(12)}${context.firstDataRow}:${letter(12)}${context.lastDataRow}`;
      const visitsRef = `${letter(16)}${context.firstDataRow}:${letter(16)}${context.lastDataRow}`;
      const streakRef = `${letter(20)}${context.firstDataRow}:${letter(20)}${context.lastDataRow}`;
      const highSevRef = `${letter(21)}${context.firstDataRow}:${letter(21)}${context.lastDataRow}`;

      // Compliance % heatmap (red -> amber -> green).
      target.addConditionalFormatting({
        ref: complianceRef,
        rules: [
          {
            cfvo: [
              { type: "num", value: 0 },
              { type: "num", value: 50 },
              { type: "num", value: 100 },
            ],
            color: [{ argb: "FFF87171" }, { argb: "FFFDE047" }, { argb: "FF4ADE80" }],
            priority: 1,
            type: "colorScale",
          },
        ],
      });
      // Total visits heatmap (white -> green). ExcelJS data bars emit an invalid
      // empty <x14:id/> in an extLst that Excel repairs, so use a colorScale.
      target.addConditionalFormatting({
        ref: visitsRef,
        rules: [
          {
            cfvo: [{ type: "min" }, { type: "max" }],
            color: [{ argb: "FFFFFFFF" }, { argb: "FF34D399" }],
            priority: 2,
            type: "colorScale",
          },
        ],
      });
      // No-activity streak escalation.
      target.addConditionalFormatting({
        ref: streakRef,
        rules: [
          {
            // Longest N streak of 3+ days (greaterThanOrEqual is not in ExcelJS CellIsOperators, so > 2).
            formulae: ["2"],
            operator: "greaterThan",
            priority: 3,
            style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFCA5A5" } }, font: { bold: true, color: { argb: "FF991B1B" } } },
            type: "cellIs",
          },
          {
            formulae: ["2"],
            operator: "equal",
            priority: 4,
            style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFDE68A" } } },
            type: "cellIs",
          },
        ],
      });
      // Any high-severity days highlighted.
      target.addConditionalFormatting({
        ref: highSevRef,
        rules: [
          {
            formulae: ["0"],
            operator: "greaterThan",
            priority: 5,
            style: { font: { bold: true, color: { argb: "FF991B1B" } } },
            type: "cellIs",
          },
        ],
      });

      // Totals row (respects the auto-filter via SUBTOTAL).
      const totalsRowNumber = context.lastDataRow + 1;
      const totalsRow = target.getRow(totalsRowNumber);
      totalsRow.getCell(1).value = "Totals (filtered)";
      const sumColumns = [10, 11, 13, 14, 15, 16, 17, 18, 19, 21];
      for (const column of sumColumns) {
        totalsRow.getCell(column).value = { formula: `SUBTOTAL(109,${letter(column)}${context.firstDataRow}:${letter(column)}${context.lastDataRow})` };
      }
      totalsRow.getCell(12).value = { formula: `SUBTOTAL(101,${letter(12)}${context.firstDataRow}:${letter(12)}${context.lastDataRow})` };
      totalsRow.getCell(20).value = { formula: `SUBTOTAL(105,${letter(20)}${context.firstDataRow}:${letter(20)}${context.lastDataRow})` };
      totalsRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: phoenixSlate } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
        cell.border = { top: { style: "medium", color: { argb: softBorder } } };
      });
      for (const [column, numFmt] of Object.entries(MONTHLY_SUMMARY_NUMBER_FORMATS)) {
        totalsRow.getCell(Number(column)).numFmt = numFmt;
      }

      // Defined name over the data range for downstream formulas / pivots.
      try {
        workbook.definedNames.add(
          `'${target.name}'!$A$${context.firstDataRow}:$${letter(context.columnCount)}$${context.lastDataRow}`,
          "MonthlySummary",
        );
      } catch {
        // Defined-name collisions are non-fatal for a report export.
      }
    },
    freezeColumns: 2,
    headers: MONTHLY_SUMMARY_HEADERS,
    name: "Monthly Summary",
    numberFormats: MONTHLY_SUMMARY_NUMBER_FORMATS,
    rows: employees.map(monthlySummaryRow),
    subtitle: `Month ${detail.archive.monthKey} | ${employees.length} employees | compliance + visit heatmaps | report-only`,
    title: `${systemIdentity.appName} - Workforce Compliance Monthly Summary`,
  });
  return sheet;
}

// --- Visual color-coded Calendar Grid (replaces the flat daily grid as the
// primary view; the flat Day Data sheet remains as a pivot source).

function calendarCellLabel(cell: FieldWorkforceDayCell): CellValue {
  if (cell.status === "VISITS") return cell.visitCount ?? 0;
  if (cell.status === "BLANK") return "";
  return cell.status;
}

function addCalendarGridSheet(workbook: ExcelJS.Workbook, detail: FieldWorkforceArchiveDetail) {
  // One row per rep, sorted by team so teams read contiguously. Deliberately uses
  // ONLY Excel-safe constructs (cell fills, freeze panes, top-row merges, values):
  // hyperlinks, mid-data merged team headers, and row outlines each made Excel
  // report a corrupt part and blank the sheet, so they are intentionally omitted.
  const employees = [...detail.preview.employees].sort((left, right) => {
    const byTeam = (left.teamName ?? "").localeCompare(right.teamName ?? "");
    return byTeam !== 0 ? byTeam : left.employeeName.localeCompare(right.employeeName);
  });
  const dateSet = new Set<string>();
  for (const employee of employees) {
    for (const cell of employee.timeline) dateSet.add(cell.dateIso);
  }
  const dates = [...dateSet].sort();
  const labelColumns = ["Employee", "HR ID", "Team", "Manager"];
  const columnCount = labelColumns.length + dates.length;

  const sheet = workbook.addWorksheet("Calendar Grid", {
    views: [{ state: "frozen", xSplit: labelColumns.length, ySplit: 4 }],
  });

  sheet.mergeCells(1, 1, 1, columnCount);
  styleTitle(sheet.getCell(1, 1));
  sheet.getCell(1, 1).value = `Workforce Compliance Calendar - ${detail.archive.monthKey}`;

  sheet.mergeCells(2, 1, 2, columnCount);
  sheet.getCell(2, 1).value = "Color-coded month grid: one row per rep (sorted by team), one column per day. See the Legend sheet for colors; the Day Data sheet has each day's reason and visit link.";
  sheet.getCell(2, 1).font = { color: { argb: "FF475569" }, italic: true };
  sheet.getCell(2, 1).alignment = { horizontal: "center" };

  sheet.addRow([]);

  // Header row: label columns + one column per day (day number over weekday).
  const headerValues = [...labelColumns, ...dates.map((date) => `${Number(date.slice(8, 10))}\n${weekdayLabel(date)}`)];
  styleHeader(sheet.addRow(headerValues));

  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 10;
  sheet.getColumn(3).width = 16;
  sheet.getColumn(4).width = 16;
  for (let index = 0; index < dates.length; index += 1) {
    sheet.getColumn(labelColumns.length + 1 + index).width = 5;
  }

  for (const employee of employees) {
    const cellByDate = new Map(employee.timeline.map((cell) => [cell.dateIso, cell]));
    const row = sheet.addRow([
      employee.employeeName,
      employee.hrId,
      hierarchyValue(employee.teamName),
      hierarchyValue(employee.managerName),
    ]);
    row.getCell(1).font = { bold: true, color: { argb: phoenixSlate }, size: 10 };
    row.getCell(2).font = { color: { argb: "FF64748B" }, size: 9 };
    row.getCell(3).font = { color: { argb: "FF64748B" }, size: 9 };
    row.getCell(4).font = { color: { argb: "FF64748B" }, size: 9 };

    dates.forEach((date, index) => {
      const column = labelColumns.length + 1 + index;
      const cell = sheet.getCell(row.number, column);
      const dayCell = cellByDate.get(date);
      if (!dayCell) {
        cell.value = "";
        return;
      }
      const style = STATUS_STYLES[dayCell.status];
      cell.value = calendarCellLabel(dayCell);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: style.fill } };
      cell.font = {
        bold: dayCell.status === "N" || dayCell.status === "UNKNOWN",
        color: { argb: style.font },
        italic: dayCell.isPreHire,
        size: 9,
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      if (dayCell.isPublicHoliday) {
        cell.border = {
          bottom: { style: "medium", color: { argb: holidayBorderColor } },
          left: { style: "medium", color: { argb: holidayBorderColor } },
          right: { style: "medium", color: { argb: holidayBorderColor } },
          top: { style: "medium", color: { argb: holidayBorderColor } },
        };
      }
    });
  }

  applyPrintSetup(sheet);
  return sheet;
}

// --- Remaining data sheets.

const DAILY_GRID_HEADERS = [
  "Employee",
  "HR ID",
  "Date",
  "Weekday",
  "Day #",
  "Raw Value",
  "Status",
  "Meaning",
  "Severity",
  "Worked Day",
  "Visit Count",
  "Public Holiday",
  "Holiday Name",
  "Pre-hire",
  "Ignored",
  "Explanation",
  "Manager",
  "Line",
  "Area",
  "Team",
  "Role",
];

function dailyGridRows(employees: FieldWorkforceEmployeeSummary[]): CellValue[][] {
  const rows: CellValue[][] = [];
  for (const employee of employees) {
    for (const cell of employee.timeline) {
      rows.push([
        employee.employeeName,
        employee.hrId,
        cell.dateIso,
        weekdayLabel(cell.dateIso),
        cell.dayNumber,
        rawCellText(cell.rawValue),
        cell.status,
        STATUS_MEANINGS[cell.status] ?? cell.status,
        cell.severity ?? "",
        yesNo(cell.countedAsWorkedDay),
        cell.visitCount ?? "",
        yesNo(cell.isPublicHoliday),
        cell.holidayName ?? "",
        yesNo(cell.isPreHire),
        yesNo(cell.ignored),
        cell.explanation,
        hierarchyValue(employee.managerName),
        hierarchyValue(employee.lineName),
        hierarchyValue(employee.areaName),
        hierarchyValue(employee.teamName),
        hierarchyValue(employee.roleName),
      ]);
    }
  }
  return rows;
}

const REVIEW_QUEUE_HEADERS = [
  "Employee",
  "HR ID",
  "Date",
  "Raw Value",
  "Meaning",
  "Severity",
  "Type",
  "Explanation",
  "Context",
];

function reviewQueueRows(candidates: FieldWorkforceReviewCandidate[]): CellValue[][] {
  return candidates.map((candidate) => [
    candidate.employeeName,
    candidate.hrId,
    candidate.dateIso ?? "",
    rawCellText(candidate.rawValue),
    candidate.normalizedMeaning,
    candidate.severity,
    candidate.type,
    candidate.explanation,
    candidate.context.join(", "),
  ]);
}

const RECOMMENDATION_HEADERS = [
  "Employee",
  "Code",
  "Month",
  "Category",
  "Recommendation",
  "Dates",
  "Days",
  "Severity",
  "Source",
  "Coverage Status",
  "Decision Status",
  "Decision Reason",
  "HR Note",
  "Estimated Amount",
  "Manager",
  "Line",
  "Area",
  "Team",
  "Role",
];

const COVERAGE_LABELS: Record<FieldWorkforceRecommendation["existingCoverageStatus"], string> = {
  already_covered: "Already covered",
  leave_source_not_connected: "Leave source not connected yet",
  needs_reconciliation: "Needs reconciliation",
  not_applicable: "Not applicable",
  payroll_calculation_required: "Amount requires payroll calculation",
};

function recommendationRow(recommendation: FieldWorkforceRecommendation, category: string): CellValue[] {
  return [
    recommendation.employeeName,
    recommendation.employeeCode,
    recommendation.monthKey,
    category,
    recommendation.recommendation,
    formatDates(recommendation.dates),
    recommendation.daysCount,
    recommendation.severity,
    recommendation.sourceLabel,
    COVERAGE_LABELS[recommendation.existingCoverageStatus] ?? recommendation.existingCoverageStatus,
    recommendation.decisionStatus,
    recommendation.decisionReason || "",
    recommendation.hrNote,
    recommendation.estimatedAmount ?? "Amount requires payroll calculation",
    hierarchyValue(recommendation.managerName),
    hierarchyValue(recommendation.lineName),
    hierarchyValue(recommendation.areaName),
    hierarchyValue(recommendation.teamName),
    hierarchyValue(recommendation.roleName),
  ];
}

const FINAL_ACTION_HEADERS = [
  "Employee",
  "Code",
  "Month",
  "Action Type",
  "Approved Dates",
  "Approved Days Count",
  "Reason",
  "HR Decision",
  "HR Note",
  "Approved By",
  "Approved At",
  "Estimated Amount",
  "Push Status",
];

const DIAGNOSTICS_HEADERS = ["Severity", "Code", "Row", "Message"];

function diagnosticsRows(issues: FieldWorkforceValidationIssue[]): CellValue[][] {
  return issues.map((issue) => [issue.severity, issue.code, issue.rowNumber ?? "", issue.message]);
}

function summaryMetricRows(detail: FieldWorkforceArchiveDetail): CellValue[][] {
  const { preview } = detail;
  const employees = preview.employees;
  const totalEligible = employees.reduce((total, employee) => total + employee.eligibleWorkingDays, 0);
  const totalWorked = employees.reduce((total, employee) => total + employee.workedDays, 0);
  const averageCompliance = employees.length
    ? Math.round((employees.reduce((total, employee) => total + employee.compliancePercent, 0) / employees.length) * 100) / 100
    : 0;

  return [
    ["Month", detail.archive.monthKey],
    ["Source file", detail.archive.sourceFilename],
    ["Sheet", preview.metadata.sheetName],
    ["Parsed month", `${preview.metadata.monthLabel} ${preview.metadata.year}`],
    ["Date range", `${preview.metadata.dateRange.start ?? "-"} to ${preview.metadata.dateRange.end ?? "-"}`],
    ["Employees", preview.metadata.employeeCount],
    ["Matched HR IDs", preview.metadata.matchedEmployees],
    ["Unmatched HR IDs", preview.metadata.unmatchedEmployees],
    ["Review candidates", preview.reviewCandidates.length],
    ["High severity", preview.severityCounts.High],
    ["Review severity", preview.severityCounts.Review],
    ["Medium severity", preview.severityCounts.Medium],
    ["Low severity", preview.severityCounts.Low],
    ["Public holidays detected", preview.metadata.holidaysDetected],
    ["Total eligible working days", totalEligible],
    ["Total worked days", totalWorked],
    ["Average compliance %", averageCompliance],
    ["Total no-activity (N) days", employees.reduce((total, employee) => total + employee.noActivityCandidates, 0)],
    ["Total vacation (AV) days", employees.reduce((total, employee) => total + employee.vacationSignalDays, 0)],
    ["Total campaign (CP) days", employees.reduce((total, employee) => total + employee.campaignDays, 0)],
    ["Total visits", employees.reduce((total, employee) => total + employee.totalVisits, 0)],
    ["Holiday warnings", employees.reduce((total, employee) => total + employee.holidayWarnings, 0)],
    ["Unknown values", employees.reduce((total, employee) => total + employee.unknownValues, 0)],
    ["Export scope", "Report-only. No payroll, leave, or integration action."],
  ];
}

function addLegendSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet("Legend");
  sheet.getColumn(1).width = 18;
  sheet.getColumn(2).width = 26;
  sheet.getColumn(3).width = 80;

  sheet.mergeCells(1, 1, 1, 3);
  styleTitle(sheet.getCell(1, 1));
  sheet.getCell(1, 1).value = `${systemIdentity.appName} - Workforce Compliance Legend`;

  const header = sheet.addRow(["Code", "Meaning", "Notes"]);
  styleHeader(header);

  const legendRows: Array<{ code: FieldWorkforceCellStatus | "H"; meaning: string; note: string }> = [
    { code: "N", meaning: "No activity", note: "Eligible working day with no recorded visits or approved reason." },
    { code: "AV", meaning: "Vacation signal", note: "Calendar shows a vacation marker; reconcile against approved leave." },
    { code: "CP", meaning: "Campaign", note: "Campaign / cycle-meeting day." },
    { code: "VISITS", meaning: "Visits", note: "Numeric visits recorded. Cells link to that day's visit drill-down." },
    { code: "F", meaning: "Friday", note: "Weekend / non-working day (not counted as eligible)." },
    { code: "UNKNOWN", meaning: "Unknown value", note: "Unrecognized raw value - needs manual review." },
    { code: "H", meaning: "Public holiday", note: "Amber border overlay; warning only, no automatic calculation change." },
  ];

  for (const entry of legendRows) {
    const row = sheet.addRow([entry.code, entry.meaning, entry.note]);
    const swatch = row.getCell(1);
    if (entry.code === "H") {
      swatch.border = {
        bottom: { style: "medium", color: { argb: holidayBorderColor } },
        left: { style: "medium", color: { argb: holidayBorderColor } },
        right: { style: "medium", color: { argb: holidayBorderColor } },
        top: { style: "medium", color: { argb: holidayBorderColor } },
      };
    } else {
      const style = STATUS_STYLES[entry.code];
      swatch.fill = { type: "pattern", pattern: "solid", fgColor: { argb: style.fill } };
      swatch.font = { bold: true, color: { argb: style.font } };
    }
    swatch.alignment = { horizontal: "center", vertical: "middle" };
    row.getCell(2).font = { bold: true, color: { argb: phoenixSlate } };
    row.getCell(3).font = { color: { argb: "FF475569" } };
    row.getCell(3).alignment = { vertical: "middle", wrapText: true };
  }

  sheet.addRow([]);
  const severityHeader = sheet.addRow(["Severity", "", "Meaning"]);
  styleHeader(severityHeader);
  const severityRows: Array<[string, string, string]> = [
    ["High", "", "Strong compliance concern (e.g. 3+ consecutive no-activity days)."],
    ["Review", "", "Needs a human look before any decision."],
    ["Medium", "", "Minor signal worth noting."],
    ["Low", "", "Informational only."],
  ];
  for (const entry of severityRows) {
    const row = sheet.addRow(entry);
    row.getCell(1).font = { bold: true, color: { argb: phoenixSlate } };
    row.getCell(3).font = { color: { argb: "FF475569" } };
  }

  sheet.addRow([]);
  const scope = sheet.addRow(["Scope", "", "This workbook is report-only. It does not push payroll, mutate leave, or approve execution. Native Excel charts / PivotTables are not embedded; use the Day Data sheet as a PivotTable source."]);
  sheet.mergeCells(scope.number, 3, scope.number, 3);
  scope.getCell(1).font = { bold: true, color: { argb: "FF9A3412" } };
  scope.getCell(3).font = { color: { argb: "FF9A3412" }, italic: true };
  scope.getCell(3).alignment = { vertical: "middle", wrapText: true };

  applyPrintSetup(sheet);
  return sheet;
}

/** Simple single-sheet export: the advanced Monthly Employee Summary. */
export function generateFieldWorkforceSimpleSummaryWorkbook(detail: FieldWorkforceArchiveDetail) {
  const workbook = createWorkbook();
  addMonthlySummarySheet(workbook, detail);
  return workbook;
}

/**
 * God-mode book: every workspace tab as its own sheet plus a Summary, a visual
 * Calendar Grid and a Legend, using the advanced Excel features ExcelJS supports.
 * Recommendations / Final Actions are omitted gracefully when the report is null.
 */
export function generateFieldWorkforceGodModeWorkbook(
  detail: FieldWorkforceArchiveDetail,
  report: FieldWorkforceRecommendationsReport | null,
) {
  const workbook = createWorkbook();
  const monthKey = detail.archive.monthKey;
  const employees = sortedEmployees(detail);

  addStyledSheet(workbook, {
    headers: ["Metric", "Value"],
    name: "Summary",
    rows: summaryMetricRows(detail),
    subtitle: `Whole-module snapshot for ${monthKey}. Report-only - no payroll, leave, or integration action.`,
    title: `${systemIdentity.appName} - Workforce Compliance God-Mode Book`,
  });

  addMonthlySummarySheet(workbook, detail);

  addCalendarGridSheet(workbook, detail);

  addStyledSheet(workbook, {
    afterBody: (sheet, context) => applySeverityConditionalFormatting(sheet, 6, context),
    headers: REVIEW_QUEUE_HEADERS,
    name: "Review Queue",
    rows: reviewQueueRows(detail.preview.reviewCandidates),
    subtitle: `${detail.preview.reviewCandidates.length} review candidates - labels only, no action taken.`,
    title: `Review Candidate Queue - ${monthKey}`,
  });

  const recommendationRows: CellValue[][] = report
    ? [
        ...report.leaveRecommendations.map((recommendation) => recommendationRow(recommendation, "Leave Reconciliation")),
        ...report.payrollRecommendations.map((recommendation) => recommendationRow(recommendation, "Payroll Deduction")),
      ]
    : [];
  addStyledSheet(workbook, {
    afterBody: (sheet, context) => applySeverityConditionalFormatting(sheet, 8, context),
    headers: RECOMMENDATION_HEADERS,
    name: "Recommendations",
    numberFormats: { 7: "#,##0" },
    rows: recommendationRows,
    subtitle: report
      ? `${recommendationRows.length} reconciliation recommendations - report-only.`
      : "Recommendations unavailable for this archived month.",
    title: `Compliance Recommendations - ${monthKey}`,
  });

  addStyledSheet(workbook, {
    headers: FINAL_ACTION_HEADERS,
    name: "Final Actions",
    numberFormats: { 6: "#,##0" },
    rows: report ? report.finalActions.map((action) => actionRow(action)) : [],
    subtitle: report
      ? `${report.finalActions.length} approved report actions - export only, no execution.`
      : "Final actions unavailable for this archived month.",
    title: `Final Approved Actions - ${monthKey}`,
  });

  addStyledSheet(workbook, {
    headers: DAILY_GRID_HEADERS,
    name: "Day Data",
    rows: dailyGridRows(employees),
    subtitle: "One row per employee per day - PivotTable-ready source behind the Calendar Grid.",
    title: `Daily Compliance Data - ${monthKey}`,
  });

  addStyledSheet(workbook, {
    headers: DIAGNOSTICS_HEADERS,
    name: "Diagnostics",
    rows: diagnosticsRows([...detail.preview.errors, ...detail.preview.warnings]),
    subtitle: `${detail.preview.errors.length} errors, ${detail.preview.warnings.length} warnings from parsing.`,
    title: `Import Diagnostics - ${monthKey}`,
  });

  addLegendSheet(workbook);

  return workbook;
}
