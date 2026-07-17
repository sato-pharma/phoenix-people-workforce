import ExcelJS from "exceljs";

import { systemDocuments, systemIdentity } from "@/config/system-settings";
import type { CompanyVacationReportRow } from "@/lib/vacation/company-vacation-report";

const phoenixOrange = "FFC2410C";
const phoenixSlate = "FF0F172A";
const softBorder = "FFE2E8F0";

const SOURCE_FILL: Record<CompanyVacationReportRow["source"], string> = {
  "HR Approved": "FFDCFCE7",
  "HR Cancelled": "FFF1F5F9",
  "HR Pending": "FFFEF9C3",
  "HR Rejected": "FFFEE2E2",
  "CRM Signal — Vacation": "FFE0F2FE",
  "CRM Signal — Half-Day (Attendance Partial)": "FFFEF3C7",
};

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

function rowValues(row: CompanyVacationReportRow) {
  return [
    row.hrId,
    row.employeeName,
    row.jobTitle ?? "",
    row.lineName ?? "",
    row.source,
    row.startDate,
    row.endDate,
    row.workingDays,
    row.detail,
    row.requestId ?? "",
  ];
}

/**
 * Full company vacation report workbook: every HR vacation request plus every CRM-derived
 * leave signal, one sheet, each row tagged and color-coded by Source. Report-only — this
 * export never pushes to payroll or leave balances; CRM Signal rows are unverified estimates
 * that require HR review before becoming a real leave adjustment.
 */
export function generateCompanyVacationReportWorkbook(input: {
  endDate: string;
  rows: CompanyVacationReportRow[];
  startDate: string;
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.company = systemIdentity.appName;
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet("Company Vacation Report", {
    views: [{ state: "frozen", ySplit: 6 }],
  });
  const headers = [
    "HR ID",
    "Employee",
    "Job Title",
    "Line",
    "Source",
    "Start Date",
    "End Date",
    "Days",
    "Detail",
    "HR Request ID",
  ];

  sheet.mergeCells(1, 1, 1, headers.length);
  styleTitle(sheet.getCell(1, 1));
  sheet.getCell(1, 1).value = `${systemIdentity.appName} - Company Vacation Report`;

  sheet.mergeCells(2, 1, 2, headers.length);
  sheet.getCell(2, 1).value = "\"HR ...\" rows are official system records. \"CRM Signal\" rows are unverified estimates from CRM/attendance data and require HR review before any leave-balance action.";
  sheet.getCell(2, 1).font = { bold: true, color: { argb: "FF9A3412" }, italic: true };
  sheet.getCell(2, 1).alignment = { horizontal: "center", wrapText: true };

  sheet.mergeCells(3, 1, 3, headers.length);
  sheet.getCell(3, 1).value = `Range: ${input.startDate} to ${input.endDate} | Rows: ${input.rows.length} | Generated: ${new Date().toISOString().slice(0, 10)}`;
  sheet.getCell(3, 1).font = { color: { argb: "FF475569" }, italic: true };
  sheet.getCell(3, 1).alignment = { horizontal: "center" };

  sheet.addRow([]);
  sheet.addRow([]);
  sheet.addRow(headers);
  styleHeader(sheet.getRow(6));

  for (const row of input.rows) {
    const excelRow = sheet.addRow(rowValues(row));
    excelRow.eachCell((cell) => {
      cell.font = { color: { argb: phoenixSlate }, size: 10 };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FFF1F5F9" } } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SOURCE_FILL[row.source] } };
    });
  }

  headers.forEach((header, index) => {
    const longest = Math.max(
      header.length,
      ...input.rows.slice(0, 1000).map((row) => String(rowValues(row)[index] ?? "").length),
    );
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 3, 12), 48);
  });

  sheet.autoFilter = {
    from: { column: 1, row: 6 },
    to: { column: headers.length, row: 6 },
  };

  const notes = workbook.addWorksheet("Source Key & Safety Notes");
  notes.columns = [{ width: 36 }, { width: 110 }];
  notes.addRows([
    ["Source", "Meaning"],
    ["HR Approved / Pending / Rejected / Cancelled", "Official record from v2_vacation_requests, at its current status. This is the system of record."],
    ["CRM Signal — Vacation", "An Annual Vacation entry logged in the field CRM (iReports360), with no fingerprint or field-activity contradiction found. Not yet a formal HR request."],
    ["CRM Signal — Half-Day (Attendance Partial)", "A CRM vacation entry where the employee (fingerprint-mapped only) also had under 5 hours of fingerprint activity that day — likely a half-day, not a full vacation day."],
    ["Execution boundary", "This export is report-only. \"CRM Signal\" rows are unverified estimates — they do not deduct or restore any leave balance and are not employee-submitted requests. Turning one into a real leave adjustment requires explicit HR review through the Field Workforce Compliance recommendation workflow."],
    ["Excluded from this report", "Public national holidays, CRM entries whose comment reads as an excuse (e.g. \"Afternoon Excuse\") rather than actual vacation, and any day a fingerprint-mapped employee proved 5+ hours worked are already filtered out — this report never shows a 0-day row."],
  ]);
  styleHeader(notes.getRow(1));
  for (let row = 2; row <= notes.rowCount; row += 1) {
    notes.getRow(row).eachCell((cell) => {
      cell.font = { color: { argb: phoenixSlate }, size: 10 };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FFF1F5F9" } } };
    });
  }

  return workbook;
}
