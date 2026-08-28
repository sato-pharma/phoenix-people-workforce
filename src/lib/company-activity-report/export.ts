// Company Activity Report — premium XLSX export. Styling follows the established Phoenix export
// identity (see src/lib/business-review/excel-export.ts, src/lib/attendance/monthly-summary-export.ts):
// orange title band, slate column headers, hairline borders, zebra striping, banded signal cells.
// Owner instruction, 2026-08-28: this workbook reaches the CEO, so it must read as premium and
// professional — not merely correct.
//
// Three sheets: Executive Summary (company-wide KPIs, aggregated verbatim from the same per-employee
// rows the table below shows — so the headline numbers can never drift from the detail), Daily Detail
// (one row per employee per day in range, every day — the "very detailed everything" tab), and
// Notes & Legend (definitions and methodology). Export always carries full detail regardless of what
// is expanded on screen — every employee, every day.

import ExcelJS from "exceljs";

import { systemDocuments, systemIdentity } from "@/config/system-settings";
import type {
  CompanyActivityDayOutcome,
  CompanyActivityDayRow,
  CompanyActivityEmployeeSummary,
  CompanyActivityReport,
} from "@/lib/company-activity-report/types";

const ORANGE = "FFC2410C";
const SLATE = "FF0F172A";
const SOFT = "FFE2E8F0";
const HAIR = "FFF1F5F9";
const MUTED = "FF475569";
const ZEBRA = "FFF8FAFC";
const WHITE = "FFFFFFFF";

/** Every value CompanyActivityDayOutcome can take, listed by hand (not derived — the type is
 * erased at runtime) so a registered test can assert OUTCOME_LABEL/OUTCOME_FILL below stay
 * exhaustive as the union grows. Per AGENTS.md's "an exhaustive Record does not gate the build"
 * rule: next.config sets ignoreBuildErrors, so a Record literal missing a new outcome would still
 * compile and ship with silently blank cell text/color for that outcome. */
export const ALL_COMPANY_ACTIVITY_DAY_OUTCOMES: readonly CompanyActivityDayOutcome[] = [
  "office_present",
  "crm_field_visit",
  "crm_leave",
  "leave_approved",
  "leave_pending",
  "device_outage",
  "no_signal",
  "no_entry",
  "weekly_off",
  "holiday",
  "future",
];

// Exported so a registered test can iterate ALL_COMPANY_ACTIVITY_DAY_OUTCOMES and assert both
// Records stay exhaustive at runtime — see the comment on ALL_COMPANY_ACTIVITY_DAY_OUTCOMES above.
export const OUTCOME_LABEL: Record<CompanyActivityDayOutcome, string> = {
  office_present: "Office Present",
  crm_field_visit: "CRM Field Visit",
  crm_leave: "CRM Leave (Annual Vacation)",
  leave_approved: "Leave Approved",
  leave_pending: "Leave Pending",
  device_outage: "Device Outage",
  no_signal: "No Signal Available",
  no_entry: "No Entry",
  weekly_off: "Weekly Off",
  holiday: "Holiday",
  future: "Future",
};

export const OUTCOME_FILL: Record<CompanyActivityDayOutcome, string> = {
  office_present: "FFDCFCE7",
  crm_field_visit: "FFDBEAFE",
  crm_leave: "FFE0F2FE",
  leave_approved: "FFE0F2FE",
  leave_pending: "FFFEF9C3",
  device_outage: "FFF1F5F9",
  no_signal: "FFF1F5F9",
  no_entry: "FFFEE2E2",
  weekly_off: "FFF8FAFC",
  holiday: "FFF8FAFC",
  future: "FFFFFFFF",
};

// The x-700 font partner for each OUTCOME_FILL x-100/50 fill — same Tailwind shade-pairing
// convention as severityFont/achFont elsewhere in these exports, so the Outcome cell in Daily
// Detail reads as a real badge (colored fill + matching bold text), not a fill with plain text.
export const OUTCOME_FONT: Record<CompanyActivityDayOutcome, string> = {
  office_present: "FF047857",
  crm_field_visit: "FF1D4ED8",
  crm_leave: "FF0369A1",
  leave_approved: "FF0369A1",
  leave_pending: "FFA16207",
  device_outage: MUTED,
  no_signal: MUTED,
  no_entry: "FFBE123C",
  weekly_off: MUTED,
  holiday: MUTED,
  future: MUTED,
};

/** Overrides the outcome's own fill — a conflict needs to stand out regardless of which outcome
 * won the day. Deliberately violet, not a shade of red: red is already this workbook's "count of
 * a bad thing" color (no_entry, severity banding), and a conflict is a different KIND of signal —
 * a data disagreement to review, not a failure — so it gets its own hue rather than one close
 * enough to no_entry's FFFEE2E2 to blur together on a quick read (owner feedback, 2026-08-28). */
const CONFLICT_FILL = "FFEDE9FE";
const CONFLICT_FONT = "FF6D28D9";

/** Severity banding for this report's own accuracy signals (No Entry / No Signal / Conflict day
 * counts) — same visual language as the achievement banding used elsewhere in the product, tuned
 * to "fewer is better" and to a PER-EMPLOYEE count, which is the scale at which these numbers are
 * actually actionable (see the comment on the Executive Summary KPI block below for why the
 * company-wide totals are deliberately NOT banded the same way). */
function severityFill(count: number): string {
  if (count <= 0) return "FFD1FAE5"; // emerald — clean
  if (count <= 2) return "FFFEF3C7"; // amber
  return "FFFFE4E6"; // red
}
function severityFont(count: number): string {
  if (count <= 0) return "FF047857";
  if (count <= 2) return "FFB45309";
  return "FFBE123C";
}

/** Three-row banner shared by every sheet: bold white-on-orange title, italic muted subtitle, and
 * an optional bold-orange note — matches src/lib/business-review/excel-export.ts's titleBand
 * exactly so every export in the product reads as one visual family. Never writes row 4 — the
 * export route reserves that row on the data sheets to stamp the caller's active filter. */
function titleBand(sheet: ExcelJS.Worksheet, ncols: number, title: string, subtitle: string, note?: string) {
  sheet.mergeCells(1, 1, 1, ncols);
  const t = sheet.getCell(1, 1);
  t.value = title;
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE } };
  t.font = { bold: true, color: { argb: WHITE }, size: 16 };
  t.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 32;

  sheet.mergeCells(2, 1, 2, ncols);
  const s = sheet.getCell(2, 1);
  s.value = subtitle;
  s.font = { color: { argb: MUTED }, italic: true, size: 10 };
  s.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  sheet.getRow(2).height = 18;

  if (note) {
    sheet.mergeCells(3, 1, 3, ncols);
    const n = sheet.getCell(3, 1);
    n.value = note;
    n.font = { bold: true, color: { argb: ORANGE }, italic: true, size: 9 };
    n.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    sheet.getRow(3).height = 20;
  }
}

/** Slate header row with a frozen pane and an autoFilter anchored to it — matches
 * business-review's headerRow() exactly. Column widths are set separately (see autoFitColumns)
 * because this report auto-fits from actual content rather than guessing fixed widths. */
function tableHeaderRow(sheet: ExcelJS.Worksheet, rowIdx: number, headers: string[]) {
  const row = sheet.getRow(rowIdx);
  headers.forEach((label, i) => {
    const cell = row.getCell(i + 1);
    cell.value = label;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SLATE } };
    cell.font = { bold: true, color: { argb: WHITE }, size: 10 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: SOFT } },
      left: { style: "thin", color: { argb: SOFT } },
      right: { style: "thin", color: { argb: SOFT } },
      bottom: { style: "thin", color: { argb: SOFT } },
    };
  });
  row.height = 28;
  sheet.views = [{ state: "frozen", ySplit: rowIdx }];
  sheet.autoFilter = { from: { row: rowIdx, column: 1 }, to: { row: rowIdx, column: headers.length } };
}

/** Sizes every column from its own header and (up to the first 1000) values, capped to keep any
 * one column from swallowing the sheet — real auto-fit rather than a guessed fixed width. */
function autoFitColumns<T>(
  sheet: ExcelJS.Worksheet,
  headers: string[],
  rows: T[],
  rowValues: (row: T) => Array<string | number>,
) {
  headers.forEach((header, index) => {
    const longest = Math.max(
      header.length,
      ...rows.slice(0, 1000).map((row) => String(rowValues(row)[index] ?? "").length),
    );
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 3, 12), 48);
  });
}

function minutesToClock(minutes: number | null): string {
  if (minutes == null) return "";
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function visitSummaryText(day: CompanyActivityDayRow): string {
  if (day.crmVisits.length === 0) return "";
  return day.crmVisits
    .map((visit) => {
      const detail = visit.customerName?.trim() || visit.contactName?.trim() || visit.comment?.trim() || "";
      return detail ? `${visit.label}: ${detail}` : visit.label;
    })
    .join("; ");
}

/**
 * One reusable sheet builder for a plain data sheet (Daily Detail) — title banner, description,
 * range/count stamp, a blank spacer row (row 4) the export route writes its filter note into,
 * blank row 5, frozen header row 6, zebra-striped rows with specific columns banded, autoWidth,
 * autoFilter.
 *
 * Zebra is the ROW's base fill; `bandColumns` overrides specific cells on top of it — same split
 * as business-review's bodyRow (zebra + achCols) and this file's own Executive Summary table
 * (zebra + the three severity-banded columns). Painting the WHOLE row in a semantic color (the
 * previous version of this function) buried every other column in solid color and had no zebra
 * at all — a wall of color, not the "premium" look this workbook is meant to match (owner
 * feedback, 2026-08-28).
 */
function buildDataSheet<T>(input: {
  workbook: ExcelJS.Workbook;
  sheetName: string;
  title: string;
  description: string;
  rangeLabel: string;
  headers: string[];
  rows: T[];
  rowValues: (row: T) => Array<string | number>;
  bandColumns?: (row: T) => Array<{ col: number; fill: string; font: string }>;
}): ExcelJS.Worksheet {
  const sheet = input.workbook.addWorksheet(input.sheetName, { properties: { tabColor: { argb: ORANGE } } });

  titleBand(sheet, input.headers.length, input.title, input.description, input.rangeLabel);
  // Row 4 stays untouched (blank) — the export route stamps the active filter description there.

  const headerRowIndex = 6;
  tableHeaderRow(sheet, headerRowIndex, input.headers);

  input.rows.forEach((row, i) => {
    const excelRow = sheet.getRow(headerRowIndex + 1 + i);
    const zebra = i % 2 === 1;
    input.rowValues(row).forEach((value, colIndex) => {
      const cell = excelRow.getCell(colIndex + 1);
      cell.value = value;
      cell.font = { color: { argb: SLATE }, size: 10 };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: HAIR } } };
      if (zebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
    });
    for (const band of input.bandColumns?.(row) ?? []) {
      const cell = excelRow.getCell(band.col);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: band.fill } };
      cell.font = { bold: true, color: { argb: band.font }, size: 10 };
    }
    excelRow.height = 18;
  });

  autoFitColumns(sheet, input.headers, input.rows, input.rowValues);

  return sheet;
}

const SUMMARY_HEADERS = [
  "HR ID", "Employee", "Job Title", "Line", "Team", "Area", "Region",
  "Working Days", "Office Present Days", "CRM Field Visit Days", "Total CRM Visits",
  "Campaign Visits", "Leave Days (Approved/CRM)", "Leave Days (Pending)",
  "No Entry Days", "No Signal Days", "Conflict Days", "Attendance Channel", "CRM Channel",
];

// 1-based column indexes into SUMMARY_HEADERS that get severity banding in the employee table.
const SUMMARY_COL_NO_ENTRY = 15;
const SUMMARY_COL_NO_SIGNAL = 16;
const SUMMARY_COL_CONFLICT = 17;

function summaryRowValues(row: CompanyActivityEmployeeSummary): Array<string | number> {
  return [
    row.employeeHrId,
    row.employeeName,
    row.jobTitle ?? "",
    row.lineName ?? "",
    row.teamName ?? "",
    row.areaName ?? "",
    row.regionName ?? "",
    row.workingDays,
    row.officePresentDays,
    row.crmFieldVisitDays,
    row.totalCrmVisits,
    row.campaignVisits,
    row.leaveApprovedDays,
    row.leavePendingDays,
    row.noEntryDays,
    row.noSignalDays,
    row.conflictDays,
    row.hasAttendanceChannel ? "Yes" : "No",
    row.hasCrmChannel ? "Yes" : "No",
  ];
}

const DETAIL_HEADERS = [
  "HR ID", "Employee", "Date", "Weekday", "Day Type", "Outcome", "Reason",
  "Visit Count", "Campaign Visits", "Visit Details",
  "Office First Punch", "Office Last Punch", "Leave Status", "Leave Type", "Conflict",
];

// 1-based column indexes into DETAIL_HEADERS that get banded — see buildDataSheet's bandColumns.
const DETAIL_COL_OUTCOME = 6;
const DETAIL_COL_CONFLICT = 15;

function detailRowValues(input: {
  day: CompanyActivityDayRow;
  employeeNameByHrId: Map<string, string>;
}): Array<string | number> {
  const { day } = input;
  return [
    day.employeeHrId,
    input.employeeNameByHrId.get(day.employeeHrId) ?? day.employeeHrId,
    day.dateIso,
    day.weekday,
    day.dayType,
    OUTCOME_LABEL[day.outcome],
    day.reason,
    day.crmVisitCount,
    day.crmCampaignVisitCount,
    visitSummaryText(day),
    minutesToClock(day.firstPunchMinutes),
    minutesToClock(day.lastPunchMinutes),
    day.leave?.status ?? "",
    day.leave?.vacationType ?? "",
    day.conflict ? "Yes" : "No",
  ];
}

function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

const EXECUTIVE_SUMMARY_SHEET_NAME = "Executive Summary";

/**
 * The tab a reader opens first. A KPI headline block — every number aggregated verbatim from the
 * SAME per-employee rows the table below shows, never recomputed independently, so the two can
 * never disagree — followed by the full per-employee table, zebra-striped and severity-banded on
 * the three accuracy-flag columns (No Entry / No Signal / Conflict Days).
 *
 * The company-wide KPI values are deliberately NOT severity-banded the way the per-employee table
 * is: a fixed per-employee threshold (e.g. "3+ conflict days is red") means nothing applied to a
 * company-wide sum across a whole roster, where almost any nonzero total would read as red — a
 * banded company total would be a confident-looking number that means nothing. The three
 * accuracy-flag KPIs are still visually marked (bold orange) as "pay attention to this", with the
 * real, meaningful banding reserved for where it is actionable: each employee's own count, below.
 */
function addExecutiveSummarySheet(
  workbook: ExcelJS.Workbook,
  report: CompanyActivityReport,
  rangeLabel: string,
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(EXECUTIVE_SUMMARY_SHEET_NAME, { properties: { tabColor: { argb: ORANGE } } });
  const ncols = SUMMARY_HEADERS.length;

  titleBand(
    sheet,
    ncols,
    `${systemIdentity.appName} - Company Activity Report`,
    rangeLabel,
    "NOT a payroll report — shown for awareness and accuracy review only. A Conflict Day is presence evidence AND a leave signal on the same date; it is surfaced here for review, never auto-resolved.",
  );
  // Row 4 stays untouched (blank) — the export route stamps the active filter description there.
  // Row 5 stays untouched (blank spacer) — the KPI block starts at row 6.

  const summaries = report.summaries;
  const total = (pick: (row: CompanyActivityEmployeeSummary) => number) => sumBy(summaries, pick);

  // Same KPI-row idiom as business-review's own "Executive Summary" sheet (addSummarySheet in
  // src/lib/business-review/excel-export.ts): label | big number | a short CONTEXTUAL aside, one
  // row per metric — never a full definition, since that already lives on Notes & Legend and
  // repeating it here read as cluttered and duplicative (owner feedback, 2026-08-28).
  let r = 6;
  const kpi = (label: string, value: number, sub: string, color?: string) => {
    const l = sheet.getCell(r, 1);
    l.value = label;
    l.font = { bold: true, color: { argb: MUTED }, size: 9 };
    const v = sheet.getCell(r, 2);
    v.value = value;
    v.numFmt = "#,##0";
    v.font = { bold: true, color: { argb: color ?? SLATE }, size: 13 };
    sheet.mergeCells(r, 4, r, ncols);
    const s = sheet.getCell(r, 4);
    s.value = sub;
    s.font = { color: { argb: MUTED }, size: 9, italic: true };
    r += 1;
  };

  kpi("Employees in view", summaries.length, "matching the active filters");
  kpi("Working days", total((s) => s.workingDays), "sum across every employee shown");
  kpi("Office present days", total((s) => s.officePresentDays), "at least one fingerprint punch that day");
  kpi(
    "CRM field visit days",
    total((s) => s.crmFieldVisitDays),
    `of which ${total((s) => s.campaignVisits).toLocaleString("en-US")} were campaign visits`,
  );
  kpi(
    "Leave days",
    total((s) => s.leaveApprovedDays) + total((s) => s.leavePendingDays),
    `${total((s) => s.leaveApprovedDays).toLocaleString("en-US")} approved/CRM · ${total((s) => s.leavePendingDays).toLocaleString("en-US")} pending`,
  );
  kpi("No entry days", total((s) => s.noEntryDays), "working days with nothing recorded at all", ORANGE);
  kpi("No signal days", total((s) => s.noSignalDays), "no device mapping and no CRM identity", ORANGE);
  kpi(
    "Conflict days",
    total((s) => s.conflictDays),
    "presence evidence AND a leave signal on the same date — surfaced for review, never auto-resolved",
    CONFLICT_FONT,
  );
  if (report.unmappedCrmVisitCount != null && report.unmappedCrmVisitCount > 0) {
    kpi(
      "Unmapped CRM visits",
      report.unmappedCrmVisitCount,
      "company-wide CRM attribution blind spot — not limited to this filter",
      ORANGE,
    );
  }

  r += 1;
  sheet.mergeCells(r, 1, r, ncols);
  const heading = sheet.getCell(r, 1);
  heading.value = "PER-EMPLOYEE BREAKDOWN";
  heading.font = { bold: true, color: { argb: ORANGE }, size: 11 };
  r += 1;

  const headerRowIndex = r;
  tableHeaderRow(sheet, headerRowIndex, SUMMARY_HEADERS);
  r += 1;

  summaries.forEach((row, i) => {
    const excelRow = sheet.getRow(r);
    const zebra = i % 2 === 1;
    summaryRowValues(row).forEach((value, colIndex) => {
      const cell = excelRow.getCell(colIndex + 1);
      cell.value = value;
      cell.font = { color: { argb: SLATE }, size: 10 };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: HAIR } } };
      if (zebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
    });
    excelRow.height = 18;

    const band = (col: number, count: number) => {
      const cell = excelRow.getCell(col);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: severityFill(count) } };
      cell.font = { bold: true, color: { argb: severityFont(count) }, size: 10 };
    };
    band(SUMMARY_COL_NO_ENTRY, row.noEntryDays);
    band(SUMMARY_COL_NO_SIGNAL, row.noSignalDays);
    band(SUMMARY_COL_CONFLICT, row.conflictDays);

    r += 1;
  });

  autoFitColumns(sheet, SUMMARY_HEADERS, summaries, summaryRowValues);

  return sheet;
}

/**
 * The system sheet: definitions, methodology, and known data-freshness caveats for every figure
 * in the workbook — last on purpose, mirroring business-review's own Coverage & Sources sheet.
 */
function addNotesSheet(workbook: ExcelJS.Workbook, report: CompanyActivityReport): ExcelJS.Worksheet {
  const notes = workbook.addWorksheet("Notes & Legend", { properties: { tabColor: { argb: ORANGE } } });
  notes.getColumn(1).width = 32;
  notes.getColumn(2).width = 118;

  titleBand(
    notes,
    2,
    `${systemIdentity.appName} - Company Activity Report - Notes & Legend`,
    "Definitions, methodology, and data-freshness caveats for every figure in this workbook.",
    "This is NOT a payroll report. It exists for awareness and accuracy review only — it drives no deduction, incentive, or leave-balance calculation.",
  );

  const rows: Array<[string, string]> = [
    ["Campaign Visit", "A CRM visit logged with type \"Campaign/Prospection\" (iReports360 code -8) — the owner's specific ask, distinct from the broader set of non-desk CRM activity types (meetings, training, etc.) that also count as a CRM Field Visit day."],
    ["CRM Field Visit", "A day with a real CRM-logged visit — either a Regular customer visit or one of the CP-type activities (Conference, Group Meeting, Campaign, Training, Meeting, Traveling, Health Day, and the vendor's undocumented-but-classified codes). Counted as proof of field work, the same rule the payroll digest engine uses."],
    ["CRM Leave (Annual Vacation)", "The CRM itself recorded an Annual Vacation entry that day, with no office punch and no CRM field visit — a CRM-confirmed leave signal, independent of whether a matching Phoenix leave request exists."],
    ["Office Present", "At least one fingerprint device punch was recorded for this employee on this day."],
    ["Leave Approved / Leave Pending", "From Phoenix's own leave requests (v2_vacation_requests), shown with their REAL status — Approved, Pending Manager, Pending HR, Submitted, or Needs Assignment — never collapsed to a payroll-style yes/no. A rejected or cancelled request is not shown as leave at all."],
    ["No Entry", "A working day (not weekly-off, not a holiday, not in the future) with no office punch, no CRM visit, no device outage, and no leave request on record."],
    ["No Signal Available", "This employee has neither an active fingerprint device mapping nor a resolved CRM identity — the system has no way to observe them at all that day. Distinct from No Entry, which means the systems could see them and saw nothing."],
    ["Device Outage", "A company-wide fingerprint device/sync outage was detected for this date — no punch data is available for ANYONE that day, so an empty punch record here is not necessarily this employee's absence."],
    ["Conflict", "This day shows evidence of BOTH physical presence (an office punch or a real CRM field visit) AND a leave signal (CRM leave or a Phoenix leave request) covering the same date. Surfaced for review, never auto-resolved — this report exists to show what actually happened, not to make a payroll judgment."],
    ["Weekly Off / Holiday", "Not counted as a working day for the No Entry / No Signal tallies, but still listed in Daily Detail so the day-by-day picture is never missing a row."],
    ["Severity banding (Executive Summary)", "No Entry / No Signal / Conflict Days in the per-employee table are banded green (0), amber (1-2), or red (3+) — a per-employee scale. The same totals at company level in the KPI block above are not banded the same way: a company-wide sum banded on a per-employee threshold would read as red almost regardless of the real distribution, which is why that block marks them in orange (attention) rather than a severity color."],
    ["Data freshness", "The CRM (iReports360) mirror can lag live field activity by up to roughly two days — a just-elapsed date showing No Entry is not yet a confirmed gap."],
    ["Scope", "This report is NOT a payroll report. It exists for awareness and accuracy review only; it does not drive any deduction, incentive, or leave-balance calculation."],
    ["Unmapped CRM visits", report.unmappedCrmVisitCount == null
      ? "Not computed for this query (only tracked on a full company-wide scan)."
      : `${report.unmappedCrmVisitCount} CRM visit(s) in this date range have no resolved employee identity at all (company-wide, not limited to the filtered roster) — a blind spot in CRM attribution, not necessarily related to anyone shown above.`],
  ];

  const headerRowIndex = 5;
  tableHeaderRow(notes, headerRowIndex, ["Term", "Meaning"]);
  rows.forEach(([term, meaning], i) => {
    const excelRow = notes.getRow(headerRowIndex + 1 + i);
    [term, meaning].forEach((value, colIndex) => {
      const cell = excelRow.getCell(colIndex + 1);
      cell.value = value;
      cell.font = { color: { argb: SLATE }, size: 10 };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: HAIR } } };
      if (i % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
    });
  });

  return notes;
}

/**
 * Three-sheet Company Activity Report workbook: Executive Summary (company-wide KPIs + the full
 * per-employee table), Daily Detail (one row per employee per day in range, every day), and
 * Notes & Legend. Export always carries full detail regardless of what's expanded on screen —
 * every employee, every day.
 */
export function generateCompanyActivityReportWorkbook(input: {
  report: CompanyActivityReport;
  employeeNameByHrId: Map<string, string>;
}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.company = systemDocuments.workbookCompany;
  workbook.created = new Date();
  workbook.modified = new Date();

  const rangeLabel = `Range: ${input.report.startDate} to ${input.report.endDate} | Employees: ${input.report.summaries.length} | Generated: ${new Date().toISOString().slice(0, 10)}`;

  addExecutiveSummarySheet(workbook, input.report, rangeLabel);

  buildDataSheet<CompanyActivityDayRow>({
    workbook,
    sheetName: "Daily Detail",
    title: `${systemIdentity.appName} - Company Activity Report - Daily Detail`,
    description: "One row per employee per day in range, every day — including weekly-off, holidays, and days with nothing recorded — so no day is silently omitted.",
    rangeLabel,
    headers: DETAIL_HEADERS,
    rows: input.report.days,
    rowValues: (day) => detailRowValues({ day, employeeNameByHrId: input.employeeNameByHrId }),
    bandColumns: (day) => {
      const bands = [{
        col: DETAIL_COL_OUTCOME,
        fill: day.conflict ? CONFLICT_FILL : OUTCOME_FILL[day.outcome],
        font: day.conflict ? CONFLICT_FONT : OUTCOME_FONT[day.outcome],
      }];
      if (day.conflict) bands.push({ col: DETAIL_COL_CONFLICT, fill: CONFLICT_FILL, font: CONFLICT_FONT });
      return bands;
    },
  });

  // Last sheet on purpose — a reader who scrolls to the end finds the definitions, and a reader
  // who does not still saw every term used consistently throughout the first two sheets.
  addNotesSheet(workbook, input.report);

  return workbook;
}
