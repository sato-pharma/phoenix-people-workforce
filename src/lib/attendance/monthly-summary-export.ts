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
import {
  attendanceMonthlyCycleNote,
  type MonthlyAttendanceSummaryData,
  type MonthlyAttendanceSummaryRow,
} from "@/lib/attendance/monthly-summary";



const summaryColumns: Array<{ key: keyof MonthlyAttendanceSummaryRow; label: string }> = [
  { key: "employeeHrId", label: "Employee ID" },
  { key: "employeeName", label: "Name" },
  { key: "jobTitle", label: "Job Title" },
  { key: "department", label: "Department" },
  { key: "expectedWorkingDays", label: "Expected Days" },
  { key: "presentDays", label: "Present" },
  { key: "absentDays", label: "Absent" },
  // Days the attendance device delivered nothing at all. Shown next to Absent so a reader can see
  // at a glance that a low Present count is missing data rather than missing people.
  { key: "noDataDays", label: "No Data" },
  { key: "leaveDays", label: "On Leave" },
  { key: "holidayDays", label: "Holidays" },
  { key: "lateCount", label: "Late" },
  { key: "earlyLeaveCount", label: "Early Leave" },
  { key: "singlePunchCount", label: "Single Punch" },
  { key: "exceptionDays", label: "Exceptions" },
  { key: "totalDeductionDays", label: "Deduction Days" },
  { key: "totalDeductionValue", label: "Deduction Value" },
];

/**
 * Absences, as a grade. Same three steps the cell fills used to draw, carried by type — and by the
 * same helper the fingerprint report grades its Status column with, so "2 absences" here and "Short
 * day" there mean the same thing to someone who opens both.
 */
function absentSeverity(absentDays: number): AttendanceSeverity {
  if (absentDays <= 0) return "normal";
  if (absentDays <= 2) return "watch";
  return "alert";
}

export async function generateMonthlyAttendanceSummaryWorkbook(data: MonthlyAttendanceSummaryData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet("Monthly Summary", {
    views: [{ showGridLines: false, state: "frozen", ySplit: 6 }],
  });

  const columnCount = summaryColumns.length;
  writeAttendanceMasthead(workbook, sheet, {
    columns: columnCount,
    provenance: [`${data.totals.employees} employee${data.totals.employees === 1 ? "" : "s"}`],
    subtitle: `${data.dateFrom} to ${data.dateTo}`,
    title: `Monthly Attendance Summary — ${data.month}`,
  });

  // The absence figures must never leave this file looking complete when they are not: a day the
  // attendance device never reported is excluded from Expected/Absent upstream, and is called out
  // here so nobody reads a quiet month as a well-behaved one.
  const missingDataNote = data.missingDataDates.length > 0
    ? ` | INCOMPLETE — no attendance data for ${data.missingDataDates.length} working ` +
      `${data.missingDataDates.length === 1 ? "day" : "days"} (${data.missingDataDates.join(", ")}), ` +
      `excluded from Expected and Absent`
    : "";
  // Row 4 carries the totals AND, when data is missing, the warning — flagged, because a month the
  // device never fully reported must not read as a well-behaved one.
  writeAttendanceNote(
    sheet,
    4,
    columnCount,
    `Period: ${data.dateFrom} to ${data.dateTo} · Employees: ${data.totals.employees} · ` +
      `Expected: ${data.totals.expectedWorkingDays} · Present: ${data.totals.presentDays} · ` +
      `Absent: ${data.totals.absentDays} (${data.totals.absenceRate}%) · Late: ${data.totals.lateCount}` +
      missingDataNote,
    { alert: data.missingDataDates.length > 0 },
  );

  writeAttendanceNote(sheet, 5, columnCount, attendanceMonthlyCycleNote);

  sheet.getRow(6).values = summaryColumns.map((column) => column.label);
  styleAttendanceHeaderRow(sheet.getRow(6));

  const absentIndex = summaryColumns.findIndex((column) => column.key === "absentDays") + 1;

  data.rows.forEach((row, index) => {
    const excelRow = sheet.getRow(7 + index);
    excelRow.values = summaryColumns.map((column) => row[column.key] ?? "");
    styleAttendanceBodyRow(excelRow, { zebra: index % 2 === 1 });
    if (absentIndex > 0) {
      excelRow.getCell(absentIndex).font = attendanceSeverityFont(absentSeverity(row.absentDays));
    }
  });

  summaryColumns.forEach((column, index) => {
    const longest = Math.max(
      column.label.length,
      ...data.rows.slice(0, 500).map((row) => String(row[column.key] ?? "").length),
    );
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 3, 12), 32);
  });

  // Row 6, following the header. It was 4 — which is now the totals/warning note, so the filter
  // would have been attached to a merged banner rather than to the table.
  sheet.autoFilter = {
    from: { column: 1, row: 6 },
    to: { column: columnCount, row: 6 },
  };

  return workbook;
}
