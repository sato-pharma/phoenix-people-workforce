/**
 * "What to fix" — the dry run's findings, as a workbook you can actually work from.
 *
 * WHY THIS EXISTS. The import preview showed the first TEN problems and then "+N more". For a file
 * of three hundred people that is not a summary, it is a wall: you cannot see the rest, you cannot
 * sort them, you cannot tell which person each belongs to, and you certainly cannot work through
 * them beside the sheet you have to edit. The rest of the findings existed only in a response body
 * nobody could read.
 *
 * So the same dry run that produced the preview also produces this: every finding, none truncated,
 * each carrying the row number in the user's OWN file, the person it is about, the column at fault
 * and what to do about it. Two windows side by side and the job is mechanical.
 *
 * IT IS A REPORT, NEVER AN IMPORT. Nothing reads this file back — it deliberately does not carry
 * the Employee Master's column headers, so it cannot be confused for the template and re-uploaded.
 * That is also why it is free to put its cover sheet first, which the template itself cannot do.
 */

import ExcelJS from "exceljs";
import { HOUSE_XLSX_FONT } from "@/lib/export/house-xlsx-palette";

import { systemDocuments } from "@/config/system-settings";
import {
  HOUSE_XLSX_COLORS,
  houseBodyStyle,
  houseCalloutStyle,
  houseHeaderStyle,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import {
  buildFixListEntries,
  type FixListEntry,
} from "@/lib/employees/employee-import-findings";
import type { EmployeeImportValidationResult } from "@/lib/imports/employee-import-types";

function addSummarySheet(
  workbook: ExcelJS.Workbook,
  result: EmployeeImportValidationResult,
  entries: FixListEntry[],
  sourceFileName: string,
  omitMoney = false,
) {
  const sheet = workbook.addWorksheet("Summary", { properties: { defaultRowHeight: 18 } });
  sheet.views = [{ showGridLines: false }];
  sheet.getColumn(1).width = 4;
  sheet.getColumn(2).width = 34;
  sheet.getColumn(3).width = 92;

  const blocking = entries.filter((entry) => entry.severity === "Blocks the row").length;
  const reviewing = entries.length - blocking;

  writeHouseMasthead(workbook, sheet, {
    columns: 3,
    provenance: [sourceFileName, `Checked ${new Date().toISOString().slice(0, 10)}`],
    subtitle: "What the upload found in your file, and what will happen if you send it as it is.",
    title: "Employee Import — What To Fix",
  });

  let row = 6;

  const stat = (label: string, value: string, note: string) => {
    const labelCell = sheet.getCell(row, 2);
    labelCell.value = label;
    labelCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 10 };
    const valueCell = sheet.getCell(row, 3);
    valueCell.value = value;
    houseCalloutStyle(valueCell, { emphasis: true });
    valueCell.note = note;
    sheet.getRow(row).height = 20;
    row += 1;
  };

  const line = (label: string, body: string) => {
    const labelCell = sheet.getCell(row, 2);
    labelCell.value = label;
    labelCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
    labelCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    const bodyCell = sheet.getCell(row, 3);
    bodyCell.value = body;
    bodyCell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
    bodyCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    sheet.getRow(row).height = Math.max(18, Math.ceil(body.length / 100) * 13 + 6);
    row += 1;
  };

  const heading = (text: string) => {
    row += 1;
    sheet.mergeCells(row, 2, row, 3);
    const cell = sheet.getCell(row, 2);
    cell.value = text;
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 11 };
    cell.border = { bottom: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } } };
    sheet.getCell(row, 3).border = { bottom: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } } };
    sheet.getRow(row).height = 20;
    row += 1;
  };

  heading("If you upload this file as it is");
  stat(
    "People created",
    String(result.rowsToInsert.length),
    "Rows whose Employee ID does not exist yet. Each becomes a new active employee.",
  );
  stat(
    "People updated",
    String(result.rowsToUpdate.length),
    "Rows matched to an existing Employee ID. Only the cells you filled in are written.",
  );
  stat(
    "Rows skipped",
    String(result.failedRows),
    "Blocked rows are skipped. The rest of the file still imports — nothing is all-or-nothing here.",
  );

  heading("What was found");
  stat("Findings that block a row", String(blocking), "Fix these, or those rows will not import.");
  stat("Findings to review", String(reviewing), "These import, but the value may not be what you expect.");

  if (result.missingRequiredColumns.length > 0) {
    heading("A column is missing from the file");
    line(
      "Nothing can import",
      `The header row is missing: ${result.missingRequiredColumns.join(", ")}. This is usually a file ` +
        "saved from a filtered or partially copied sheet. Download the template again and paste your " +
        "values into it rather than rebuilding the header by hand.",
    );
  }

  heading("How to work through this");
  line("1 · Open both", "Keep this sheet beside the file you uploaded. The Row column is the row number in YOUR file — type it into Excel's name box to jump straight there.");
  line("2 · Blocks first", "Everything marked \"Blocks the row\" has to change before that person imports. Everything marked \"Review\" will import as it stands.");
  line("3 · Re-upload", "Upload the corrected file again. The dry run runs from scratch each time, so nothing from this attempt is remembered.");

  heading("Two things worth knowing");
  if (omitMoney) {
    // The salary-blind seat's upload carries no salary and refuses one, so neither money paragraph
    // below applies to it — and "type 0" would be advice to type exactly what it refuses.
    line(
      "A blank cell changes nothing",
      "Clearing a cell does not erase the stored value — blanks are skipped entirely.",
    );
    line(
      "No salary figures",
      "Salary, allowance, insurance and tax amounts are not part of this upload. Their columns must stay empty.",
    );
  } else {
    line(
      "A blank cell changes nothing",
      "Clearing a cell does not erase the stored value — blanks are skipped entirely. If you need a number to become nothing, type 0.",
    );
    line(
      "Salary figures are recalculated",
      "Base, Basic, Net and Gross are normalized to payroll policy on upload. A \"Review\" finding about one of them means your figure differed and the policy figure won.",
    );
  }

  row += 1;
  sheet.mergeCells(row, 2, row, 3);
  const footer = sheet.getCell(row, 2);
  footer.value = systemDocuments.workbookExportScopeNote;
  footer.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, name: HOUSE_XLSX_FONT, size: 8 };
}

function addFindingsSheet(workbook: ExcelJS.Workbook, entries: FixListEntry[], sourceFileName: string) {
  const sheet = workbook.addWorksheet("What To Fix", { properties: { defaultRowHeight: 18 } });
  const widths = [10, 14, 26, 16, 24, 74];
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  writeHouseMasthead(workbook, sheet, {
    columns: widths.length,
    provenance: [`${entries.length} finding${entries.length === 1 ? "" : "s"}`, sourceFileName],
    subtitle: "Every finding, in the order worth working through. Row is the row number in your own file.",
    title: "What To Fix",
  });

  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 5 }];
  sheet.getRow(4).height = 6;

  const headers = ["Row", "Employee ID", "Name", "Severity", "Column to fix", "What to fix"];
  const headerRow = sheet.getRow(5);
  headerRow.height = 22;
  headers.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
    houseHeaderStyle(cell);
  });

  if (entries.length === 0) {
    // An empty table reads as "the check did not run". Say the actual result instead.
    sheet.mergeCells(6, 1, 6, widths.length);
    const clear = sheet.getCell(6, 1);
    clear.value = "Nothing to fix — every row in this file passed every check the upload runs.";
    houseCalloutStyle(clear, { emphasis: true });
    sheet.getRow(6).height = 26;
    return;
  }

  entries.forEach((entry, index) => {
    const rowNumber = 6 + index;
    const row = sheet.getRow(rowNumber);
    const zebra = index % 2 === 1;
    const values = [
      entry.rowNumber ?? "whole file",
      entry.hrId,
      entry.fullName,
      entry.severity,
      entry.column,
      entry.message,
    ];
    values.forEach((value, valueIndex) => {
      const cell = row.getCell(valueIndex + 1);
      cell.value = value as ExcelJS.CellValue;
      houseBodyStyle(cell, { size: 9.5, zebra });
      cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    });
    // Severity carried in TYPE, never a fill — the ink rule holds for an error too.
    row.getCell(4).font = {
      bold: true,
      color: {
        argb: entry.severity === "Blocks the row" ? HOUSE_XLSX_COLORS.flag : HOUSE_XLSX_COLORS.deep,
      },
      name: HOUSE_XLSX_FONT,
      size: 9,
    };
    row.getCell(2).font = { color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 9.5 };
    row.height = Math.max(18, Math.ceil(entry.message.length / 78) * 13 + 5);
  });

  sheet.autoFilter = {
    from: { column: 1, row: 5 },
    to: { column: widths.length, row: 5 + entries.length },
  };
}

export type BuildFixListWorkbookInput = {
  result: EmployeeImportValidationResult;
  /** The name of the file the person uploaded, echoed back so two attempts cannot be confused. */
  sourceFileName?: string;
  /** The salary-blind importer (isSalaryBlindRole): the guidance says nothing about salary figures. */
  omitMoney?: boolean;
};

export async function buildEmployeeImportFixListWorkbook(
  input: BuildFixListWorkbookInput,
): Promise<ExcelJS.Workbook> {
  const { result } = input;
  const sourceFileName = input.sourceFileName?.trim() || "uploaded file";
  const entries = buildFixListEntries(result);

  const workbook = new ExcelJS.Workbook();
  workbook.company = systemDocuments.workbookCompany;
  workbook.created = new Date();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.modified = new Date();
  workbook.subject = "Employee import findings";
  workbook.title = "Employee Import — What To Fix";

  // Cover first: unlike the template, nothing parses this file, so the reading order is free.
  addSummarySheet(workbook, result, entries, sourceFileName, input.omitMoney === true);
  addFindingsSheet(workbook, entries, sourceFileName);

  return workbook;
}

export function employeeImportFixListFileName(now: Date = new Date()): string {
  return `employee-import-what-to-fix-${now.toISOString().slice(0, 10)}.xlsx`;
}

export {
  buildFixListEntries,
  importFieldColumnHeader,
  type FixListEntry,
  type FixListSeverity,
} from "@/lib/employees/employee-import-findings";
