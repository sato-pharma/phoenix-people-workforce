import ExcelJS from "exceljs";

import { systemDocuments } from "@/config/system-settings";
import type { FingerprintReportData, FingerprintReportRow } from "@/lib/attendance/fingerprint-report";

const phoenixOrange = "FFC2410C";
const phoenixSlate = "FF0F172A";
const softBorder = "FFE2E8F0";

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

function statusFill(status: string) {
  if (status === "Complete") return "FFD1FAE5";
  if (status === "Short day") return "FFFFEDD5";
  return "FFFFE4E6";
}

function rowValues(data: FingerprintReportData, row: FingerprintReportRow) {
  return data.columns.map((column) => row[column.key] ?? "");
}

export async function generateFingerprintReportWorkbook(data: FingerprintReportData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet("Fingerprint Report", {
    views: [{ state: "frozen", ySplit: 5 }],
  });

  const columnCount = data.columns.length;
  sheet.mergeCells(1, 1, 1, columnCount);
  styleTitle(sheet.getCell(1, 1));
  sheet.getCell(1, 1).value = systemDocuments.titles.fingerprintAttendanceReport;

  sheet.mergeCells(2, 1, 2, columnCount);
  sheet.getCell(2, 1).value = `Period: ${data.filters.dateFrom} to ${data.filters.dateTo} | Rows: ${data.summary.rows} | Deduction Flags: ${data.summary.deductions}`;
  sheet.getCell(2, 1).font = { color: { argb: "FF475569" }, italic: true };
  sheet.getCell(2, 1).alignment = { horizontal: "center" };

  sheet.addRow([]);
  sheet.addRow(data.columns.map((column) => column.label));
  styleHeader(sheet.getRow(4));

  for (const row of data.rows) {
    const excelRow = sheet.addRow(rowValues(data, row));
    styleBody(excelRow);
    const statusIndex = data.columns.findIndex((column) => column.key === "status") + 1;
    if (statusIndex > 0) {
      excelRow.getCell(statusIndex).fill = { type: "pattern", pattern: "solid", fgColor: { argb: statusFill(row.status) } };
      excelRow.getCell(statusIndex).font = { bold: true, color: { argb: phoenixSlate }, size: 10 };
    }
  }

  data.columns.forEach((column, index) => {
    const longest = Math.max(
      column.label.length,
      ...data.rows.slice(0, 500).map((row) => String(row[column.key] ?? "").length),
    );
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 3, 14), 32);
  });

  sheet.autoFilter = {
    from: { column: 1, row: 4 },
    to: { column: columnCount, row: 4 },
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
  styleHeader(policySheet.getRow(1));
  for (const row of data.policyDetails) {
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
    styleBody(excelRow);
  }
  policySheet.columns.forEach((column) => {
    column.width = 18;
  });

  const notesSheet = workbook.addWorksheet("Notes");
  notesSheet.columns = [{ width: 32 }, { width: 100 }];
  notesSheet.addRows([
    ["Note", "Details"],
    ["Source", "Rows are calculated from attendance_raw_punches after active device user mappings resolve to employee HR_ID."],
    ["Deduction Days / Amount", "Deduction amount is estimated from employee base salary / 30 * deduction day fraction. Current report does not mutate payroll."],
    ["Scheduled Times", "Daily rows use the active policy resolved by HR_ID, then job title, then default policy. Grace minutes are a daily budget shared between late arrival and early leave."],
    ["Workdays", "When an attendance policy has custom workdays, only those weekdays are expected attendance days. Empty workdays use the standard company weekend policy."],
    ["Approved Vacation/Leave, Approved Excuse, CRM Activity, Weekly Plan", "Supporting evidence only -- these columns do not change this report's own Status/Deduction figures. They show what Phoenix vacation/excuse requests, the CRM (iReports360) mirror, and the employee's approved weekly plan record for that same day, so a reviewer can manually cross-check a flagged day the same way the Employee Day-by-Day Report's reconciliation does."],
  ]);
  styleHeader(notesSheet.getRow(1));
  for (let row = 2; row <= notesSheet.rowCount; row += 1) {
    styleBody(notesSheet.getRow(row));
  }

  return workbook;
}
