import ExcelJS from "exceljs";

import { systemDocuments } from "@/config/system-settings";
import { HOUSE_DOCUMENT_STANDARD, HOUSE_XLSX_COLORS } from "@/lib/export/house-xlsx-palette";
import { cvDatabaseHeaders } from "@/lib/cv/cv-database";

const dataStartRow = 6;
const dataEndRow = 105;

function solidFill(argb: string): ExcelJS.Fill {
  return {
    fgColor: { argb },
    pattern: "solid",
    type: "pattern",
  };
}

function border(color = HOUSE_XLSX_COLORS.hair): Partial<ExcelJS.Borders> {
  return {
    bottom: { color: { argb: color }, style: "thin" },
    left: { color: { argb: color }, style: "thin" },
    right: { color: { argb: color }, style: "thin" },
    top: { color: { argb: color }, style: "thin" },
  };
}

function styleTitle(sheet: ExcelJS.Worksheet) {
  // The title takes the left of row 1 and the standard's own id the right, as on the specimen. The
  // merge stops at F so the id has cells of its own rather than being lost inside the title's.
  sheet.mergeCells("A1:F1");
  sheet.mergeCells("G1:H1");
  sheet.getCell("G1").value = HOUSE_DOCUMENT_STANDARD;
  sheet.getCell("G1").font = { color: { argb: HOUSE_XLSX_COLORS.muted }, name: "Aptos", size: 7.5 };
  sheet.getCell("G1").alignment = { horizontal: "right", vertical: "middle" };
  sheet.getCell("A1").value = systemDocuments.titles.cvDatabaseUploadTemplate;
  sheet.getCell("A1").font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos Display", size: 16 };
  sheet.getCell("A1").alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  sheet.getRow(1).height = 30;

  sheet.mergeCells("A2:H2");
  sheet.getCell("A2").value =
    "Use this sheet for candidate CV tracking only. Do not add HR_ID because these candidates are not employees yet.";
  sheet.getCell("A2").font = { color: { argb: HOUSE_XLSX_COLORS.muted }, name: "Aptos", size: 9 };
  sheet.getCell("A2").alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  sheet.getRow(2).height = 24;

  // Row 3 — the Brand Blue rule, and the standard's id opposite it. This is the one filled shape the
  // ink rule allows outside the zebra, and the row was previously blank spacing.
  for (let column = 1; column <= 8; column += 1) sheet.getCell(3, column).fill = solidFill(HOUSE_XLSX_COLORS.blue);
  sheet.getRow(3).height = 3;
}

function styleSectionRow(sheet: ExcelJS.Worksheet) {
  // Three groups that used to be an orange, a teal and a navy BLOCK. Each cell already names its
  // own group in words, so under SATO-DIS-2026-01 v1.0 the block goes and the label carries the
  // colour itself — one deep type over a light rule, the same for all three, because the words are
  // what tell them apart and three different colours never did.
  const sections = [
    { end: 2, label: "Candidate", start: 1 },
    { end: 6, label: "Medical Sales Experience", start: 3 },
    { end: 8, label: "Source File", start: 7 },
  ];

  for (const section of sections) {
    sheet.mergeCells(4, section.start, 4, section.end);
    const cell = sheet.getCell(4, section.start);
    cell.value = section.label;
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 10 };
    cell.alignment = { horizontal: "left", indent: 1, vertical: "bottom" };

    for (let column = section.start; column <= section.end; column += 1) {
      sheet.getCell(4, column).border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.light }, style: "medium" } };
    }
  }

  sheet.getRow(4).height = 24;
}

function styleHeaderRow(sheet: ExcelJS.Worksheet) {
  const row = sheet.getRow(5);
  row.values = [...cvDatabaseHeaders];
  row.height = 34;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 10 };
    cell.border = {
      bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" },
      top: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "thin" },
    };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
}

function styleInputRows(sheet: ExcelJS.Worksheet) {
  for (let rowNumber = dataStartRow; rowNumber <= dataEndRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.height = 24;

    for (let column = 1; column <= cvDatabaseHeaders.length; column += 1) {
      const cell = row.getCell(column);
      cell.border = border();
      cell.alignment = { vertical: "middle", wrapText: true };
      if (rowNumber % 2 !== 0) cell.fill = solidFill(HOUSE_XLSX_COLORS.tint);
      cell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: "Aptos", size: 10 };
    }
  }

  sheet.getColumn(2).numFmt = "yyyy-mm-dd";
  sheet.getColumn(4).numFmt = "yyyy-mm-dd";
  sheet.getColumn(5).numFmt = "yyyy-mm-dd";
}

function addValidations(sheet: ExcelJS.Worksheet) {
  for (let rowNumber = dataStartRow; rowNumber <= dataEndRow; rowNumber += 1) {
    sheet.getCell(rowNumber, 2).dataValidation = {
      allowBlank: true,
      error: "Use a valid CV sending date.",
      errorTitle: "Invalid date",
      formulae: [new Date(2020, 0, 1), new Date(2035, 11, 31)],
      operator: "between",
      showErrorMessage: true,
      type: "date",
    };
    sheet.getCell(rowNumber, 3).dataValidation = {
      allowBlank: true,
      error: "Choose Yes, No, Fresh, or Unknown.",
      errorTitle: "Invalid value",
      formulae: ['"Yes,No,Fresh,Unknown"'],
      showErrorMessage: true,
      type: "list",
    };

    for (const column of [4, 5]) {
      sheet.getCell(rowNumber, column).dataValidation = {
        allowBlank: true,
        error: "Use a valid experience start/end date.",
        errorTitle: "Invalid date",
        formulae: [new Date(1990, 0, 1), new Date(2035, 11, 31)],
        operator: "between",
        showErrorMessage: true,
        type: "date",
      };
    }
  }
}

function addInstructions(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet("Instructions");
  sheet.columns = [
    { key: "field", width: 26 },
    { key: "rule", width: 92 },
  ];

  sheet.mergeCells("A1:B1");
  sheet.getCell("A1").value = "How to use the CV Database template";
  sheet.getCell("A1").font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos Display", size: 16 };
  sheet.getCell("A1").alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  sheet.getRow(1).height = 30;
  for (const column of [1, 2]) sheet.getCell(2, column).fill = solidFill(HOUSE_XLSX_COLORS.blue);
  sheet.getRow(2).height = 3;

  const rows = [
    ["Name", "Candidate full name as written on the CV."],
    ["Date of sending CV", "The date HR received or saved the CV. Use yyyy-mm-dd."],
    ["Medical Sales Exp?", "Use Yes, No, Fresh, or Unknown. The app can also infer experience from dates or companies."],
    ["From / To", "Use the candidate's medical sales promotion experience period. Leave blank for fresh candidates."],
    ["Duration", "Optional. Examples: 2 years, 18 months, 1 year 6 months. If blank, the app calculates from From and To."],
    ["Companies", "Previous companies separated by semicolon, comma, or line break."],
    ["CV Name", "The file name stored in your CV folder, for example mona-ali.pdf."],
  ];

  sheet.getRow(3).values = ["Field", "Rule"];
  sheet.getRow(3).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 10 };
    cell.border = {
      bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" },
      top: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "thin" },
    };
    cell.alignment = { horizontal: "left", indent: 1, vertical: "bottom" };
  });

  rows.forEach((values, index) => {
    const row = sheet.getRow(index + 4);
    row.values = values;
    row.height = 36;
    row.eachCell((cell, column) => {
      if (index % 2 !== 0) cell.fill = solidFill(HOUSE_XLSX_COLORS.tint);
      cell.border = border();
      cell.alignment = { vertical: "top", wrapText: true };
      cell.font = column === 1
        ? { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 10 }
        : { color: { argb: HOUSE_XLSX_COLORS.body }, name: "Aptos", size: 10 };
    });
  });

  sheet.views = [{ state: "frozen", ySplit: 3 }];
}

export async function generateCvDatabaseTemplateWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("CV Database", {
    views: [{ state: "frozen", ySplit: 5 }],
  });
  sheet.properties.defaultRowHeight = 22;
  sheet.columns = [
    { key: "name", width: 28 },
    { key: "dateOfSendingCv", width: 18 },
    { key: "medicalSalesExp", width: 20 },
    { key: "from", width: 14 },
    { key: "to", width: 14 },
    { key: "duration", width: 18 },
    { key: "companies", width: 38 },
    { key: "cvName", width: 34 },
  ];

  styleTitle(sheet);
  styleSectionRow(sheet);
  styleHeaderRow(sheet);
  styleInputRows(sheet);
  addValidations(sheet);
  sheet.autoFilter = {
    from: { column: 1, row: 5 },
    to: { column: cvDatabaseHeaders.length, row: dataEndRow },
  };

  addInstructions(workbook);
  return workbook;
}
