import ExcelJS from "exceljs";

import { systemDocuments, systemIdentity } from "@/config/system-settings";
import type { FieldWorkforceFinalAction, FieldWorkforceRecommendationsReport } from "@/lib/field-workforce-compliance/types";

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
  sheet.getCell(1, 1).value = `${systemIdentity.appName} - Field Workforce Compliance Final Approved Actions`;

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
