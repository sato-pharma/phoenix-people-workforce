// Company Activity Report — XLSX export. This report reaches the CEO, Super Admin and SFE Manager,
// so it follows the BLACK + ORANGE branded workbook kit (src/lib/sales/sales-workbook-kit.ts +
// src/lib/export/phoenix-xlsx-style.ts) — the idiom roughly 18 export builders across this codebase
// already share, and the one whose own consumer states the reason directly: "the owner's rule is
// that a new surface matches its siblings exactly" (src/lib/deductions/exports/category-workbook.ts).
// Two earlier versions of this file each matched a single sibling instead of the actual dominant
// house style — first src/lib/business-review/excel-export.ts (the routine admin idiom), then
// src/lib/sales/weekly/summary-workbook.ts's ink/cream "premium" idiom, which turned out to be
// shared by only one other file in the whole codebase. This version is built directly on the shared
// kit: Cover (brand band + confidentiality callout + provenance/KPI rows, via buildCoverSheet) —
// Summary (one row per employee, via writeTable) — Daily Detail (one row per employee per day in
// range, every day, via writeTable) — Notes & Legend (definitions, also via writeTable).
//
// Cover carries every company-wide KPI, including the unplanned-visits-vs-unplanned-days comparison as
// one explicit row ("N visits across N days — X.X visits/day average") — the concrete ask this report
// was still missing across the earlier styling-only revisions.

import ExcelJS from "exceljs";

import { buildCoverSheet, ORANGE_SOFT, type CoverProvenance } from "@/lib/export/phoenix-xlsx-style";
import {
  AMBER,
  bandHeader,
  MUTED,
  SLATE,
  UNITS_FMT,
  WHITE,
  writeTable,
  type CellValue,
  type TableColumn,
} from "@/lib/sales/sales-workbook-kit";
import type {
  CompanyActivityDayOutcome,
  CompanyActivityDayRow,
  CompanyActivityEmployeeSummary,
  CompanyActivityReport,
} from "@/lib/company-activity-report/types";

// ── Palette additions ────────────────────────────────────────────────────────
// The shared kit's own palette (BLACK/ORANGE/AMBER/WHITE/SLATE/MUTED/ZEBRA) has no alarm red and no
// "clean" green — reasonable for its sales-data origin, but this report's own accuracy signals (a
// working day with nothing recorded at all; a day where presence and leave disagree) genuinely need
// them. These are the only local additions layered on top of the imported kit.
const ORANGE_DEEP = "FFC2410C"; // ORANGE, deepened for legibility as small text on a light fill
const DANGER = "FFB91C1C"; // the one real alarm colour — a working day with nothing recorded
const DANGER_FILL = "FFFEE2E2";
const ATTENTION_FONT = "FF92400E"; // legible on AMBER — "still pending, needs a decision"
const INFO_FILL = "FFEEF2F6"; // a quiet gray tint for settled/informational rows, distinct from zebra
const GOOD_FILL = "FFDCFCE7";
const GOOD_FONT = "FF15803D";

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
  "after_exit",
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
  after_exit: "No Longer Employed",
};

/** office_present / crm_field_visit deliberately map to WHITE — "no need to out-shout a normal
 * day" — which the row-banding code below treats as a sentinel meaning "leave the zebra stripe
 * alone" rather than painting every plain row solid white. Every OTHER outcome gets a real,
 * distinct tint: quiet gray for settled/informational states, amber for the one genuinely
 * undecided state (a pending leave request), red for the one real alarm (nothing recorded at all
 * on a working day). Conflict (below) overrides all of these regardless of outcome. */
export const OUTCOME_FILL: Record<CompanyActivityDayOutcome, string> = {
  office_present: WHITE,
  crm_field_visit: WHITE,
  crm_leave: INFO_FILL,
  leave_approved: INFO_FILL,
  leave_pending: AMBER,
  device_outage: INFO_FILL,
  no_signal: INFO_FILL,
  no_entry: DANGER_FILL,
  weekly_off: INFO_FILL,
  holiday: INFO_FILL,
  future: INFO_FILL,
  // Quiet gray, same tier as weekly_off/holiday/device_outage — this is informational, not an
  // alarm: the employee simply does not work here any more on this date, which is not their fault
  // and not a gap in coverage that needs attention the way no_entry's red does.
  after_exit: INFO_FILL,
};

// The text partner for each OUTCOME_FILL — a colored fill with matching text reads as a real badge
// rather than a fill with plain body text sitting on top of it.
export const OUTCOME_FONT: Record<CompanyActivityDayOutcome, string> = {
  office_present: SLATE,
  crm_field_visit: SLATE,
  crm_leave: MUTED,
  leave_approved: MUTED,
  leave_pending: ATTENTION_FONT,
  device_outage: MUTED,
  no_signal: MUTED,
  no_entry: DANGER,
  weekly_off: MUTED,
  holiday: MUTED,
  future: MUTED,
  after_exit: MUTED,
};

/** Overrides the outcome's own fill — a conflict needs to stand out regardless of which outcome
 * won the day. Uses the workbook's own brand accent (ORANGE) rather than a shade close enough to
 * no_entry's DANGER to blur together on a quick read: a conflict is a data disagreement to review,
 * not the same kind of failure as a silent gap (owner feedback, 2026-08-28). */
const CONFLICT_FILL = ORANGE_SOFT;
const CONFLICT_FONT = ORANGE_DEEP;

/** Severity banding for this report's own accuracy signals (No Entry / No Signal / Conflict day
 * counts) in the Summary table — green (clean), amber (worth a glance), red (alarm), tuned to a
 * PER-EMPLOYEE count, which is the scale at which these numbers are actually actionable. Cover's
 * company-wide totals are deliberately NOT banded the same way — see Notes & Legend's "Severity
 * banding" row for why. */
function severityFill(count: number): string {
  if (count <= 0) return GOOD_FILL;
  if (count <= 2) return AMBER;
  return DANGER_FILL;
}
function severityFont(count: number): string {
  if (count <= 0) return GOOD_FONT;
  if (count <= 2) return ATTENTION_FONT;
  return DANGER;
}

function minutesToClock(minutes: number | null): string {
  if (minutes == null) return "";
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/**
 * The Phoenix field set on one visit, appended to that visit's phrase in the Visit Details cell.
 *
 * 🔴 NOT FLAT COLUMNS HERE, and that is forced by the sheet's own shape: this cell holds a WHOLE DAY,
 * whose visit count varies by row, so there is no fixed number of columns to spread them over. The
 * other exports keep them flat because each of their rows is one visit. A vendor visit adds nothing,
 * so a day of vendor visits reads byte-for-byte as it did.
 */
function phoenixVisitPhrase(visit: CompanyActivityDayRow["crmVisits"][number]): string {
  const parts = [visit.partner2Name ? `and ${visit.partner2Name}` : null];
  const detail = visit.phoenix;
  if (detail) {
    parts.push(
      detail.kindLabel,
      detail.products.length > 0 ? detail.products.join(", ") : null,
      detail.samples,
      detail.availability,
      detail.objection,
      detail.nextStep,
      detail.pharmacyFeedback,
      detail.offPlan,
      detail.location,
      detail.evidence,
      detail.capture,
    );
  }
  const kept = parts.map((part) => (part ?? "").trim()).filter(Boolean);
  return kept.length > 0 ? ` (${kept.join(" · ")})` : "";
}

function visitSummaryText(day: CompanyActivityDayRow): string {
  if (day.crmVisits.length === 0) return "";
  return day.crmVisits
    .map((visit) => {
      const detail = visit.customerName?.trim() || visit.contactName?.trim() || visit.comment?.trim() || "";
      const base = detail ? `${visit.label}: ${detail}` : visit.label;
      return `${base}${phoenixVisitPhrase(visit)}`;
    })
    .join("; ");
}

function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

// ── Summary sheet ─────────────────────────────────────────────────────────────

const SUMMARY_COLUMNS: TableColumn[] = [
  { label: "HR ID", width: 12 },
  { label: "Employee", width: 22 },
  { label: "Job Title", width: 20 },
  { label: "Line", width: 16 },
  { label: "Team", width: 14 },
  { label: "Area", width: 16 },
  { label: "Region", width: 16 },
  { label: "Working Days", numFmt: UNITS_FMT, right: true, width: 12 },
  { label: "Office Present Days", numFmt: UNITS_FMT, right: true, width: 14 },
  { label: "CRM Field Visit Days", numFmt: UNITS_FMT, right: true, width: 14 },
  { label: "Total CRM Visits", numFmt: UNITS_FMT, right: true, width: 13 },
  { label: "Unplanned Visits", numFmt: UNITS_FMT, right: true, width: 13 },
  { label: "Unplanned Visit Days", numFmt: UNITS_FMT, right: true, width: 14 },
  { label: "Leave Days (Approved/CRM)", numFmt: UNITS_FMT, right: true, width: 16 },
  { label: "Leave Days (Pending)", numFmt: UNITS_FMT, right: true, width: 14 },
  { label: "No Entry Days", numFmt: UNITS_FMT, right: true, width: 12 },
  { label: "No Signal Days", numFmt: UNITS_FMT, right: true, width: 12 },
  { label: "Conflict Days", numFmt: UNITS_FMT, right: true, width: 12 },
  { label: "Attendance Channel", width: 14 },
  { label: "CRM Channel", width: 12 },
];

// 1-based column indexes into SUMMARY_COLUMNS that get severity banding after writeTable runs.
const SUMMARY_COL_NO_ENTRY = 16;
const SUMMARY_COL_NO_SIGNAL = 17;
const SUMMARY_COL_CONFLICT = 18;

function summaryRowValues(row: CompanyActivityEmployeeSummary): CellValue[] {
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
    row.campaignVisitDays,
    row.leaveApprovedDays,
    row.leavePendingDays,
    row.noEntryDays,
    row.noSignalDays,
    row.conflictDays,
    row.hasAttendanceChannel ? "Yes" : "No",
    row.hasCrmChannel ? "Yes" : "No",
  ];
}

/**
 * One row per employee, via the shared kit's writeTable. bandHeader writes only rows 1-3, so row 4
 * comes out blank for free — app/api/company-activity-report/export/route.ts stamps the active
 * filter note there. writeTable's OWN title band would otherwise land on row 4 (see
 * monthly-closing-export.ts's `let row = 4` convention) — starting the table at row 5 instead is
 * this report's one deliberate deviation from that, to preserve the stamp contract.
 */
function addSummarySheet(workbook: ExcelJS.Workbook, report: CompanyActivityReport, rangeLabel: string): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet("Summary");
  bandHeader(sheet, SUMMARY_COLUMNS.length, "Company Activity Report", rangeLabel);
  // Row 4 stays untouched (blank) — see the function comment above.

  const summaries = report.summaries;
  const total = (pick: (row: CompanyActivityEmployeeSummary) => number) => sumBy(summaries, pick);
  const totalsRow: CellValue[] = [
    "TOTAL", "", "", "", "", "", "",
    total((s) => s.workingDays), total((s) => s.officePresentDays), total((s) => s.crmFieldVisitDays), total((s) => s.totalCrmVisits),
    total((s) => s.campaignVisits), total((s) => s.campaignVisitDays),
    total((s) => s.leaveApprovedDays), total((s) => s.leavePendingDays),
    total((s) => s.noEntryDays), total((s) => s.noSignalDays), total((s) => s.conflictDays),
    "", "",
  ];

  writeTable(sheet, 5, {
    columns: SUMMARY_COLUMNS,
    rows: summaries.map(summaryRowValues),
    title: "Per-Employee Breakdown",
    totals: totalsRow,
    note:
      "Every number aggregates the SAME per-employee rows shown here — never recomputed independently, so Cover's KPIs and this table can never disagree. " +
      "No Entry / No Signal / Conflict Days are banded green (0), amber (1-2), or red (3+) per employee — a per-employee scale, not applied to Cover's " +
      "company-wide totals, which would read as red almost regardless of the real distribution at that scale.",
  });

  const firstDataRow = 7; // startRow(5) + title row + header row
  summaries.forEach((row, i) => {
    const excelRow = sheet.getRow(firstDataRow + i);
    const band = (col: number, count: number) => {
      const cell = excelRow.getCell(col);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: severityFill(count) } };
      cell.font = { bold: true, color: { argb: severityFont(count) }, name: "Calibri", size: 10.5 };
    };
    band(SUMMARY_COL_NO_ENTRY, row.noEntryDays);
    band(SUMMARY_COL_NO_SIGNAL, row.noSignalDays);
    band(SUMMARY_COL_CONFLICT, row.conflictDays);
  });

  return sheet;
}

// ── Daily Detail sheet ───────────────────────────────────────────────────────

const DETAIL_COLUMNS: TableColumn[] = [
  { label: "HR ID", width: 12 },
  { label: "Employee", width: 22 },
  { label: "Date", width: 12 },
  { label: "Weekday", width: 11 },
  { label: "Day Type", width: 11 },
  { label: "Outcome", width: 20 },
  { label: "Reason", width: 46 },
  { label: "Visit Count", numFmt: UNITS_FMT, right: true, width: 10 },
  { label: "Unplanned Visits", numFmt: UNITS_FMT, right: true, width: 13 },
  { label: "Visit Details", width: 46 },
  { label: "Office First Punch", width: 13 },
  { label: "Office Last Punch", width: 13 },
  { label: "Leave Status", width: 16 },
  { label: "Leave Type", width: 14 },
  { label: "Conflict", width: 10 },
];

// 1-based column indexes into DETAIL_COLUMNS that get banded after writeTable runs.
const DETAIL_COL_OUTCOME = 6;
const DETAIL_COL_CONFLICT = 15;

function detailRowValues(input: {
  day: CompanyActivityDayRow;
  employeeNameByHrId: Map<string, string>;
}): CellValue[] {
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

/** Same row-4-blank contract and same row-5-start deviation as addSummarySheet — see its comment. */
function addDailyDetailSheet(
  workbook: ExcelJS.Workbook,
  report: CompanyActivityReport,
  rangeLabel: string,
  employeeNameByHrId: Map<string, string>,
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet("Daily Detail");
  bandHeader(sheet, DETAIL_COLUMNS.length, "Company Activity Report", rangeLabel);
  // Row 4 stays untouched (blank) — see addSummarySheet's comment; same contract, same reason.

  writeTable(sheet, 5, {
    columns: DETAIL_COLUMNS,
    rows: report.days.map((day) => detailRowValues({ day, employeeNameByHrId })),
    title: "Every employee, every day in range",
    note:
      "One row per employee per day in range, every day — including weekly-off, holidays, and days with nothing recorded — so no day is silently omitted. " +
      "Visit Count and Unplanned Visits reconcile exactly with Cover's company-wide totals.",
  });

  const firstDataRow = 7;
  report.days.forEach((day, i) => {
    const excelRow = sheet.getRow(firstDataRow + i);
    const outcomeFill = day.conflict ? CONFLICT_FILL : OUTCOME_FILL[day.outcome];
    // WHITE is the sentinel for "plain day, leave the zebra stripe alone" — see OUTCOME_FILL above.
    if (outcomeFill !== WHITE) {
      const cell = excelRow.getCell(DETAIL_COL_OUTCOME);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: outcomeFill } };
      cell.font = { bold: true, color: { argb: day.conflict ? CONFLICT_FONT : OUTCOME_FONT[day.outcome] }, name: "Calibri", size: 10.5 };
    }
    if (day.conflict) {
      const cell = excelRow.getCell(DETAIL_COL_CONFLICT);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CONFLICT_FILL } };
      cell.font = { bold: true, color: { argb: CONFLICT_FONT }, name: "Calibri", size: 10.5 };
    }
  });

  return sheet;
}

// ── Notes & Legend sheet ─────────────────────────────────────────────────────

const NOTES_COLUMNS: TableColumn[] = [
  { label: "Term", width: 32 },
  { label: "Meaning", width: 100 },
];

/** Not one of route.ts's stamped sheets — pure reference, so it needs no row-4 spacer and starts
 * its table at row 4 directly, the same row monthly-closing-export.ts itself starts at. */
function addNotesSheet(workbook: ExcelJS.Workbook, report: CompanyActivityReport): ExcelJS.Worksheet {
  const rows: CellValue[][] = [
    ["Unplanned Visit", "A visit Phoenix CRM marked out of list or out of plan; on days before Phoenix, a visit iReports360 logged as \"Campaign/Prospection\". It replaced the campaign count (owner, 6 Nov 2026) and is distinct from the broader set of non-desk CRM activity types (meetings, training, etc.) that also count as a CRM Field Visit day."],
    ["Unplanned Visits vs. Unplanned Visit Days", "\"Unplanned Visits\" sums every unplanned visit in range; \"Unplanned Visit Days\" counts the distinct days that had at least one. Read together, not as duplicates — e.g. 6 visits over 2 days (3/day, concentrated) reads very differently from 6 visits over 6 days (1/day, spread out), even though the visit total is identical. Cover states this comparison directly for the whole filtered roster."],
    ["CRM Field Visit", "A day with a real CRM-logged visit — either a Regular customer visit or one of the CP-type activities (Conference, Group Meeting, Campaign, Training, Meeting, Traveling, Health Day, and the vendor's undocumented-but-classified codes). Counted as proof of field work, the same rule the payroll digest engine uses."],
    ["CRM Leave (Annual Vacation)", "The CRM itself recorded an Annual Vacation entry that day, with no office punch and no CRM field visit — a CRM-confirmed leave signal, independent of whether a matching Phoenix leave request exists."],
    ["Office Present", "At least one fingerprint device punch was recorded for this employee on this day."],
    ["Leave Approved / Leave Pending", "From Phoenix's own leave requests (v2_vacation_requests), shown with their REAL status — Approved, Pending Manager, Pending HR, Submitted, or Needs Assignment — never collapsed to a payroll-style yes/no. A rejected or cancelled request is not shown as leave at all."],
    ["No Entry", "A working day (not weekly-off, not a holiday, not in the future) with no office punch, no CRM visit, no device outage, and no leave request on record."],
    ["No Signal Available", "This employee has neither an active fingerprint device mapping nor a Phoenix CRM seat — the system has no way to observe them at all that day. Distinct from No Entry, which means the systems could see them and saw nothing."],
    ["Device Outage", "A company-wide fingerprint device/sync outage was detected for this date — no punch data is available for ANYONE that day, so an empty punch record here is not necessarily this employee's absence."],
    ["Conflict", "This day shows evidence of BOTH physical presence (an office punch or a real CRM field visit) AND a leave signal (CRM leave or a Phoenix leave request) covering the same date. Surfaced for review, never auto-resolved — this report exists to show what actually happened, not to make a payroll judgment."],
    ["Weekly Off / Holiday", "Not counted as a working day for the No Entry / No Signal tallies, but still listed in Daily Detail so the day-by-day picture is never missing a row."],
    ["No Longer Employed", "This employee's employment ended before this date (their own last working date falls before it). Not counted as a working day, a No Entry, or a No Signal day for this employee — a leaver does not get judged on whether they showed up somewhere they no longer work. Still listed in Daily Detail for every day in range, and any real punch/CRM/leave data actually recorded on the date (a rare late-sync edge case) is still shown in the row's own detail columns."],
    ["Severity banding (Summary)", "No Entry / No Signal / Conflict Days in the per-employee table are banded green (0), amber (1-2), or red (3+) — a per-employee scale. The same totals company-wide, on Cover, are not banded the same way: a company-wide sum banded on a per-employee threshold would read as red almost regardless of the real distribution."],
    ["Data freshness", "A Phoenix CRM visit captured offline reaches this report only once it syncs, still dated the day it was captured — a just-elapsed date showing No Entry is not yet a confirmed gap."],
    ["Scope", "This report is NOT a payroll report. It exists for awareness and accuracy review only; it does not drive any deduction, incentive, or leave-balance calculation."],
    ["Public holidays", report.holidayCalendarReachable
      ? "Google's Egypt holiday calendar was read for every month in this range."
      : "Google's Egypt holiday calendar could NOT be read for part of this range. Company and fixed-date public holidays are still applied, but the moving Islamic and Coptic holidays — both Eids, Islamic New Year, the Prophet's Birthday and Coptic Easter — are missing, so such a day shows here as an ordinary working day."],
    ["Unmapped CRM visits", report.unmappedCrmVisitCount == null
      ? "Not computed for this query (only tracked on a full company-wide scan)."
      : `${report.unmappedCrmVisitCount} CRM visit(s) in this date range have no resolved employee identity at all (company-wide, not limited to the filtered roster) — a blind spot in CRM attribution, not necessarily related to anyone shown above.`],
  ];

  const sheet = workbook.addWorksheet("Notes & Legend");
  bandHeader(sheet, NOTES_COLUMNS.length, "Company Activity Report — Notes & Legend", "Definitions, methodology, and data-freshness caveats for every figure in this workbook.");

  writeTable(sheet, 4, {
    columns: NOTES_COLUMNS,
    rows,
    title: "Notes & Legend",
    note: "This is NOT a payroll report. It exists for awareness and accuracy review only — it drives no deduction, incentive, or leave-balance calculation.",
  });

  return sheet;
}

// ── Cover sheet ───────────────────────────────────────────────────────────────

function buildCoverProvenance(report: CompanyActivityReport, rangeLabel: string): CoverProvenance {
  const summaries = report.summaries;
  const total = (pick: (row: CompanyActivityEmployeeSummary) => number) => sumBy(summaries, pick);
  const totalCampaignVisits = total((s) => s.campaignVisits);
  const totalCampaignVisitDays = total((s) => s.campaignVisitDays);

  const rows: Array<[string, string]> = [
    ["Date range", `${report.startDate} to ${report.endDate}`],
    ["Employees in view", `${summaries.length.toLocaleString("en-US")} (matching the active filters)`],
    ["Working days", `${total((s) => s.workingDays).toLocaleString("en-US")} (sum across every employee shown)`],
    ["Office present days", `${total((s) => s.officePresentDays).toLocaleString("en-US")} (at least one fingerprint punch that day)`],
    ["CRM field visit days", `${total((s) => s.crmFieldVisitDays).toLocaleString("en-US")} (at least one CRM-logged field visit that day)`],
    [
      "Unplanned visits vs. unplanned days",
      totalCampaignVisitDays > 0
        ? `${totalCampaignVisits.toLocaleString("en-US")} unplanned visits across ${totalCampaignVisitDays.toLocaleString("en-US")} days — ${(totalCampaignVisits / totalCampaignVisitDays).toFixed(1)} visits/day average`
        : `${totalCampaignVisits.toLocaleString("en-US")} unplanned visits`,
    ],
    ["Leave days", `${total((s) => s.leaveApprovedDays).toLocaleString("en-US")} approved/CRM, ${total((s) => s.leavePendingDays).toLocaleString("en-US")} pending`],
    ["No entry days", `${total((s) => s.noEntryDays).toLocaleString("en-US")} (working days with nothing recorded at all)`],
    ["No signal days", `${total((s) => s.noSignalDays).toLocaleString("en-US")} (no device mapping and no Phoenix CRM seat)`],
    ["Conflict days", `${total((s) => s.conflictDays).toLocaleString("en-US")} (presence evidence AND a leave signal on the same date — review, never auto-resolved)`],
  ];
  if (report.unmappedCrmVisitCount != null && report.unmappedCrmVisitCount > 0) {
    rows.push(["Unmapped CRM visits", `${report.unmappedCrmVisitCount.toLocaleString("en-US")} (company-wide CRM attribution blind spot — not limited to this filter)`]);
  }
  rows.push(["Generated", new Date().toISOString().slice(0, 10)]);

  return {
    title: "Company Activity Report",
    subtitle: rangeLabel,
    confidentialNote:
      "NOT a payroll report — shown for awareness and accuracy review only. A Conflict Day is presence evidence AND a leave signal on the same date; " +
      "it is surfaced here for review, never auto-resolved.",
    rows,
  };
}

// ── Workbook assembly ────────────────────────────────────────────────────────

/**
 * Four-sheet Company Activity Report workbook: Cover (brand band + confidentiality callout +
 * company-wide KPI/provenance rows, including the unplanned-visits-vs-unplanned-days comparison),
 * Summary (one row per employee), Daily Detail (one row per employee per day in range, every day),
 * and Notes & Legend. Export always carries full detail regardless of what's expanded on screen —
 * every employee, every day.
 */
export function generateCompanyActivityReportWorkbook(input: {
  report: CompanyActivityReport;
  employeeNameByHrId: Map<string, string>;
}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  workbook.modified = new Date();

  const rangeLabel = `Range: ${input.report.startDate} to ${input.report.endDate} | Employees: ${input.report.summaries.length} | Generated: ${new Date().toISOString().slice(0, 10)}`;

  // buildCoverSheet also sets workbook.creator/company (to systemIdentity.appName) — deliberately
  // left to it rather than set separately, matching every other Cover-sheet consumer in the kit.
  buildCoverSheet(workbook, buildCoverProvenance(input.report, rangeLabel));
  addSummarySheet(workbook, input.report, rangeLabel);
  addDailyDetailSheet(workbook, input.report, rangeLabel, input.employeeNameByHrId);

  // Last sheet on purpose — a reader who scrolls to the end finds the definitions, and a reader
  // who does not still saw every term used consistently throughout the first three sheets.
  addNotesSheet(workbook, input.report);

  return workbook;
}
