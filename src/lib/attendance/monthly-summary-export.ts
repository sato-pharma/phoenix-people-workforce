import ExcelJS from "exceljs";

import { systemDocuments } from "@/config/system-settings";
import {
  attendanceMonthlyCycleNote,
  type MonthlyAttendanceSummaryData,
  type MonthlyAttendanceSummaryRow,
} from "@/lib/attendance/monthly-summary";

const phoenixOrange = "FFC2410C";
const phoenixSlate = "FF0F172A";
const softBorder = "FFE2E8F0";

const summaryColumns: Array<{ key: keyof MonthlyAttendanceSummaryRow; label: string }> = [
  { key: "employeeHrId", label: "Employee ID" },
  { key: "employeeName", label: "Name" },
  { key: "jobTitle", label: "Job Title" },
  { key: "department", label: "Department" },
  { key: "expectedWorkingDays", label: "Expected Days" },
  { key: "presentDays", label: "Present" },
  { key: "absentDays", label: "Absent" },
  { key: "leaveDays", label: "On Leave" },
  { key: "holidayDays", label: "Holidays" },
  { key: "lateCount", label: "Late" },
  { key: "earlyLeaveCount", label: "Early Leave" },
  { key: "singlePunchCount", label: "Single Punch" },
  { key: "exceptionDays", label: "Exceptions" },
  { key: "totalDeductionDays", label: "Deduction Days" },
  { key: "totalDeductionValue", label: "Deduction Value" },
];

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
    cell.alignment = { horizontal: "center", vertical: "middle" };
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
    cell.alignment = { vertical: "middle" };
    cell.border = { bottom: { style: "thin", color: { argb: "FFF1F5F9" } } };
  });
}

function absentFill(absentDays: number) {
  if (absentDays <= 0) return "FFD1FAE5";
  if (absentDays <= 2) return "FFFFEDD5";
  return "FFFFE4E6";
}

export async function generateMonthlyAttendanceSummaryWorkbook(data: MonthlyAttendanceSummaryData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet("Monthly Summary", {
    views: [{ state: "frozen", ySplit: 4 }],
  });

  const columnCount = summaryColumns.length;
  sheet.mergeCells(1, 1, 1, columnCount);
  styleTitle(sheet.getCell(1, 1));
  sheet.getCell(1, 1).value = `Monthly Attendance Summary — ${data.month}`;

  sheet.mergeCells(2, 1, 2, columnCount);
  sheet.getCell(2, 1).value =
    `Period: ${data.dateFrom} to ${data.dateTo} | Employees: ${data.totals.employees} | ` +
    `Expected: ${data.totals.expectedWorkingDays} | Present: ${data.totals.presentDays} | ` +
    `Absent: ${data.totals.absentDays} (${data.totals.absenceRate}%) | Late: ${data.totals.lateCount}`;
  sheet.getCell(2, 1).font = { color: { argb: "FF475569" }, italic: true };
  sheet.getCell(2, 1).alignment = { horizontal: "center" };

  sheet.mergeCells(3, 1, 3, columnCount);
  sheet.getCell(3, 1).value = attendanceMonthlyCycleNote;
  sheet.getCell(3, 1).font = { bold: true, color: { argb: phoenixOrange }, italic: true };
  sheet.getCell(3, 1).alignment = { horizontal: "center" };

  sheet.addRow(summaryColumns.map((column) => column.label));
  styleHeader(sheet.getRow(4));

  const absentIndex = summaryColumns.findIndex((column) => column.key === "absentDays") + 1;

  for (const row of data.rows) {
    const excelRow = sheet.addRow(summaryColumns.map((column) => row[column.key] ?? ""));
    styleBody(excelRow);
    if (absentIndex > 0) {
      excelRow.getCell(absentIndex).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: absentFill(row.absentDays) },
      };
      excelRow.getCell(absentIndex).font = { bold: true, color: { argb: phoenixSlate }, size: 10 };
    }
  }

  summaryColumns.forEach((column, index) => {
    const longest = Math.max(
      column.label.length,
      ...data.rows.slice(0, 500).map((row) => String(row[column.key] ?? "").length),
    );
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 3, 12), 32);
  });

  sheet.autoFilter = {
    from: { column: 1, row: 4 },
    to: { column: columnCount, row: 4 },
  };

  return workbook;
}
