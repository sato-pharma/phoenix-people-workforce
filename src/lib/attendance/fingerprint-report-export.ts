import ExcelJS from "exceljs";

import { systemDocuments } from "@/config/system-settings";
import {
  attendanceSeverityFont,
  styleAttendanceBodyRow,
  styleAttendanceHeaderRow,
  writeAttendanceMasthead,
  writeAttendanceNote,
  type AttendanceSeverity,
} from "@/lib/attendance/attendance-sheet-style";
import { isNoRecordDay, mergeNoRecordDays, NO_RECORD_STATUS } from "@/lib/attendance/attendance-day-display";
import type {
  FingerprintPolicyDetailRow,
  FingerprintReportColumnKey,
  FingerprintReportData,
  FingerprintReportRow,
} from "@/lib/attendance/fingerprint-report";

/**
 * The day's status, as a grade.
 *
 * Was a green / orange / pink cell fill. It is the same three steps, carried by type — see
 * `attendance-sheet-style` for why, and so that this report and the monthly summary grade a cell
 * the same way rather than each inventing a scale.
 */
function statusSeverity(status: string): AttendanceSeverity {
  // A day with no punch is neutral, as on the page — never graded like an absence.
  if (status === "Complete" || status === NO_RECORD_STATUS) return "normal";
  if (status === "Short day") return "watch";
  return "alert";
}

function rowValues(data: FingerprintReportData, row: FingerprintReportRow) {
  return data.columns.map((column) => row[column.key] ?? "");
}

// The report's own MM/DD/YYYY, so a "No record" day sorts and reads like every punched day beside it.
function displayDate(dateKey: string) {
  const [year, month, day] = dateKey.split("-");
  return `${month}/${day}/${year}`;
}

// A working day with no punch: who it is and which day, "No record", and nothing else — no punch,
// no minutes, no deduction, never a zero that reads as a measured one.
function noRecordCell(key: FingerprintReportColumnKey, dateKey: string, policy: FingerprintPolicyDetailRow | undefined) {
  if (key === "date") return displayDate(dateKey);
  if (key === "status") return NO_RECORD_STATUS;
  if (key === "employeeHrId") return policy?.employeeHrId ?? "";
  if (key === "employeeName") return policy?.employeeName ?? "";
  if (key === "jobTitle") return policy?.jobTitle ?? "";
  if (key === "department") return policy?.department ?? "";
  return "";
}

type SheetRow = { status: string; values: string[] };

function sheetRows(data: FingerprintReportData, noRecordDates: readonly string[] | undefined): SheetRow[] {
  const punched = (row: FingerprintReportRow): SheetRow => ({ status: row.status, values: rowValues(data, row) });
  if (!noRecordDates || noRecordDates.length === 0) return data.rows.map(punched);
  const recorded = data.rows.map((row) => ({ rawDate: row.sortKey.slice(0, 10), row }));
  const policy = data.policyDetails[0];
  // The report's rows run oldest first (fingerprint-report.ts sorts by sortKey); the merge guesses
  // the order from the first and last row, and one punch or none reads as newest first. The sort is
  // stable, so two people on one day keep the report's order.
  const merged = mergeNoRecordDays(recorded, noRecordDates).sort((a, b) => a.rawDate.localeCompare(b.rawDate));
  return merged.map((entry) =>
    isNoRecordDay(entry)
      ? {
          status: NO_RECORD_STATUS,
          values: data.columns.map((column) => noRecordCell(column.key, entry.rawDate, policy)),
        }
      : punched(entry.row),
  );
}

/**
 * `noRecordDates` — the employee export's working days with no punch (`fingerprintNoRecordDates`),
 * listed as "No record" in date order among the punched days, as the portal page lists them. The
 * admin report passes none and is unchanged.
 */
export async function generateFingerprintReportWorkbook(
  data: FingerprintReportData,
  options: { noRecordDates?: readonly string[] } = {},
) {
  const rows = sheetRows(data, options.noRecordDates);
  const noRecordCount = rows.length - data.rows.length;
  const noRecordText = noRecordCount > 0 ? ` · No record: ${noRecordCount} working day${noRecordCount === 1 ? "" : "s"}` : "";
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet("Fingerprint Report", {
    views: [{ state: "frozen", ySplit: 5 }],
  });

  const columnCount = data.columns.length;
  // Masthead on rows 1-3, the period note on 4, headers on 5 — the row the frozen pane already
  // expected, so nothing that reads this sheet moves.
  writeAttendanceMasthead(workbook, sheet, {
    columns: columnCount,
    provenance: [
      `${data.summary.rows} row${data.summary.rows === 1 ? "" : "s"}`,
      ...(noRecordCount > 0 ? [`${noRecordCount} day${noRecordCount === 1 ? "" : "s"} with no record`] : []),
    ],
    subtitle: `${data.filters.dateFrom} to ${data.filters.dateTo}`,
    title: systemDocuments.titles.fingerprintAttendanceReport,
  });
  writeAttendanceNote(
    sheet,
    4,
    columnCount,
    `Period: ${data.filters.dateFrom} to ${data.filters.dateTo} · Rows: ${data.summary.rows} · Deduction flags: ${data.summary.deductions}${noRecordText}`,
  );

  sheet.getRow(5).values = data.columns.map((column) => column.label);
  styleAttendanceHeaderRow(sheet.getRow(5));

  const statusIndex = data.columns.findIndex((column) => column.key === "status") + 1;
  rows.forEach((row, index) => {
    const excelRow = sheet.getRow(6 + index);
    excelRow.values = row.values;
    styleAttendanceBodyRow(excelRow, { zebra: index % 2 === 1 });
    if (statusIndex > 0) {
      excelRow.getCell(statusIndex).font = attendanceSeverityFont(statusSeverity(row.status));
    }
  });

  data.columns.forEach((column, index) => {
    const longest = Math.max(
      column.label.length,
      ...rows.slice(0, 500).map((row) => String(row.values[index] ?? "").length),
    );
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 3, 14), 32);
  });

  sheet.autoFilter = {
    from: { column: 1, row: 5 },
    to: { column: columnCount, row: 5 },
  };

  const policySheet = workbook.addWorksheet("Policy Details", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  policySheet.addRow([
    "Employee ID",
    "Name",
    "Job Title",
    "Department",
    "Scheduled Start",
    "Scheduled End",
    "Daily Grace",
    "Workdays",
    "Policy",
    "Effective From",
    "Effective To",
  ]);
  styleAttendanceHeaderRow(policySheet.getRow(1));
  data.policyDetails.forEach((row, index) => {
    const excelRow = policySheet.addRow([
      row.employeeHrId,
      row.employeeName,
      row.jobTitle,
      row.department,
      row.scheduledStart,
      row.scheduledEnd,
      row.graceMinutes,
      row.workingDays,
      row.policyName,
      row.effectiveFrom,
      row.effectiveTo,
    ]);
    styleAttendanceBodyRow(excelRow, { zebra: index % 2 === 1 });
  });
  policySheet.columns.forEach((column) => {
    column.width = 18;
  });

  const notesSheet = workbook.addWorksheet("Notes");
  notesSheet.columns = [{ width: 32 }, { width: 100 }];
  notesSheet.addRows([
    ["Note", "Details"],
    ["Source", "Rows are calculated from attendance_raw_punches after active device user mappings resolve to employee HR_ID."],
    ["Deduction Days / Amount", "Deduction amount is estimated from employee base salary divided by the month's calendar days, times the deduction day fraction. Current report does not mutate payroll."],
    ["Scheduled Times", "Daily rows use the active policy resolved by HR_ID, then job title, then default policy. Grace minutes are a daily budget shared between late arrival and early leave."],
    ["Workdays", "When an attendance policy has custom workdays, only those weekdays are expected attendance days. Empty workdays use the standard company weekend policy."],
    ["Approved Vacation/Leave, Approved Excuse, CRM Activity, Weekly Plan", "Supporting evidence only -- these columns do not change this report's own Status/Deduction figures. They show what Phoenix vacation/excuse requests, Phoenix CRM (the iReports360 archive before each team's start), and the employee's approved weekly plan record for that same day, so a reviewer can manually cross-check a flagged day the same way the Employee Day-by-Day Report's reconciliation does."],
  ]);
  styleAttendanceHeaderRow(notesSheet.getRow(1));
  for (let row = 2; row <= notesSheet.rowCount; row += 1) {
    styleAttendanceBodyRow(notesSheet.getRow(row), { zebra: row % 2 === 1 });
  }
  notesSheet.views = [{ showGridLines: false }];

  return workbook;
}
