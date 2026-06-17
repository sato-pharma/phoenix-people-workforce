// Weekly Sales — mapping workbook builder (Download Mapping).
//
// Mirrors the Source-of-Sales master workbook concept (src/lib/sales/master-data/export-workbook.ts):
// Phoenix-styled, cell-protected sheets pre-filled with the distributor's current mapping, hidden
// reference sheets listing valid official product/region codes, an "Official Name" column that
// auto-fills from the code via VLOOKUP, and ~200 spare unlocked rows for adding new mappings.
//
// One sheet per (dimension, map_type): "Products" plus "Regions" (or "Regions (Sales)" /
// "Regions (Stock)" when the distributor splits its weekly feed, e.g. POS).

import ExcelJS from "exceljs";

import {
  loadMappingAdmin,
  type OfficialProductRef,
  type OfficialRegionRef,
  type WeeklyMappingRow,
} from "@/lib/sales/weekly/mapping";

const BLACK = "FF000000";
const ORANGE = "FFF97316";
const ORANGE_SOFT = "FFFFF7ED";
const ORANGE_LINE = "FFF8B56B";
const WHITE = "FFFFFFFF";
const SLATE = "FF334155";
const MUTED = "FF94A3B8";
const LOCKED_FILL = "FFF1F5F9";
const COMPUTED_FILL = "FFEFF6FF";
const SPARE_ROWS = 200;

const REF_PRODUCTS = "_ref_products";
const REF_REGIONS = "_ref_regions";

function gridBorder(): ExcelJS.Borders {
  const side = { style: "thin" as const, color: { argb: ORANGE_LINE } };
  return { top: side, left: side, bottom: side, right: side } as ExcelJS.Borders;
}

function sanitizeSheetName(name: string) {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || "Sheet").slice(0, 31);
}

function columnLetter(index: number) {
  let value = index;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function addHiddenRefSheet(workbook: ExcelJS.Workbook, name: string, header: string[], rows: (string | number)[][]) {
  const sheet = workbook.addWorksheet(name, { state: "veryHidden" });
  const headerRow = sheet.getRow(1);
  header.forEach((label, index) => {
    headerRow.getCell(index + 1).value = label;
  });
  rows.forEach((values, rowIndex) => {
    const excelRow = sheet.getRow(rowIndex + 2);
    values.forEach((value, index) => {
      excelRow.getCell(index + 1).value = value;
    });
  });
}

/**
 * One mapping sheet. Columns: Raw Value (match key — locked on existing rows), Official Code
 * (editable), Official Name (auto VLOOKUP, locked). Existing rows + 200 spare unlocked rows.
 */
function addMappingSheet(input: {
  workbook: ExcelJS.Workbook;
  sheetName: string;
  title: string;
  subtitle: string;
  rows: WeeklyMappingRow[];
  refSheetName: string;
  refColCount: number; // total columns in the ref sheet (for the VLOOKUP range)
}) {
  const { workbook, rows, refSheetName, refColCount } = input;
  const sheet = workbook.addWorksheet(sanitizeSheetName(input.sheetName), { views: [{ state: "frozen", ySplit: 3 }] });
  const colCount = 3;
  const lastRefLetter = columnLetter(refColCount);
  const codeLetter = "B"; // Official Code is column 2

  // Row 1 — title
  sheet.mergeCells(1, 1, 1, colCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = input.title;
  titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: ORANGE } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  titleCell.protection = { locked: true };
  sheet.getRow(1).height = 30;

  // Row 2 — subtitle
  sheet.mergeCells(2, 1, 2, colCount);
  const subCell = sheet.getCell(2, 1);
  subCell.value = input.subtitle;
  subCell.font = { name: "Calibri", size: 10, italic: true, color: { argb: MUTED } };
  subCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  subCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  subCell.protection = { locked: true };
  sheet.getRow(2).height = 18;

  // Row 3 — header
  const labels = ["Raw Value (from file)", "Official Code", "Official Name (auto)"];
  const headerRow = sheet.getRow(3);
  labels.forEach((label, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = label;
    cell.font = { name: "Calibri", size: 11.5, bold: true, color: { argb: WHITE } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
    cell.border = gridBorder();
    cell.protection = { locked: true };
  });
  headerRow.height = 22;

  const nameFormula = (rowNumber: number) =>
    `IFERROR(VLOOKUP(${codeLetter}${rowNumber},'${refSheetName}'!$A:$${lastRefLetter},2,FALSE),"")`;

  const firstDataRow = 4;
  rows.forEach((row, rowIndex) => {
    const rowNumber = firstDataRow + rowIndex;
    const excelRow = sheet.getRow(rowNumber);
    // Raw Value (match key) — locked on existing rows
    const rawCell = excelRow.getCell(1);
    rawCell.value = row.rawValue;
    rawCell.protection = { locked: true };
    if (rowIndex % 2 === 1) rawCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LOCKED_FILL } };
    // Official Code — editable
    const codeCell = excelRow.getCell(2);
    codeCell.value = row.officialCode;
    codeCell.protection = { locked: false };
    codeCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE_SOFT } };
    // Official Name — auto VLOOKUP, locked
    const nameCell = excelRow.getCell(3);
    nameCell.value = { formula: nameFormula(rowNumber), result: row.officialName };
    nameCell.protection = { locked: true };
    nameCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COMPUTED_FILL } };

    for (let c = 1; c <= colCount; c += 1) {
      const cell = excelRow.getCell(c);
      cell.font = { name: "Calibri", size: 10.5, color: { argb: SLATE } };
      cell.alignment = { vertical: "middle", horizontal: "left" };
      cell.border = gridBorder();
    }
  });

  // Spare rows — Raw Value + Official Code unlocked; Official Name auto + locked.
  const firstSpareRow = firstDataRow + rows.length;
  for (let i = 0; i < SPARE_ROWS; i += 1) {
    const rowNumber = firstSpareRow + i;
    const excelRow = sheet.getRow(rowNumber);
    excelRow.getCell(1).protection = { locked: false };
    excelRow.getCell(2).protection = { locked: false };
    const nameCell = excelRow.getCell(3);
    nameCell.value = { formula: nameFormula(rowNumber), result: "" };
    nameCell.protection = { locked: true };
    nameCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COMPUTED_FILL } };
    for (let c = 1; c <= colCount; c += 1) {
      const cell = excelRow.getCell(c);
      cell.font = { name: "Calibri", size: 10.5, color: { argb: SLATE } };
      cell.alignment = { vertical: "middle", horizontal: "left" };
      cell.border = gridBorder();
    }
  }

  sheet.getColumn(1).width = 40;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 34;

  return sheet;
}

/**
 * Core workbook builder shared by the Weekly Mapping download and the Weekly Missing Data
 * download. Both produce the same Products + Regions sheets and hidden reference sheets; they
 * differ only in which rows are pre-filled (full mapping vs just the unmapped labels).
 */
export async function buildMappingWorkbook(input: {
  distName: string;
  product: WeeklyMappingRow[];
  region: WeeklyMappingRow[];
  productRefs: OfficialProductRef[];
  regionRefs: OfficialRegionRef[];
}): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  // Hidden reference sheets (valid official codes).
  addHiddenRefSheet(
    workbook,
    REF_PRODUCTS,
    ["Code", "Name", "Line", "Price"],
    input.productRefs.map((p) => [p.code, p.name, p.line, p.price]),
  );
  addHiddenRefSheet(
    workbook,
    REF_REGIONS,
    ["Code", "Name"],
    input.regionRefs.map((r) => [r.code, r.name]),
  );

  // Product sheet.
  addMappingSheet({
    workbook,
    sheetName: "Products",
    title: `${input.distName} — Product Mapping`,
    subtitle:
      "Map each raw item code/name from this distributor's file to an official Product Code. The name auto-fills; add new rows at the bottom.",
    rows: input.product,
    refSheetName: REF_PRODUCTS,
    refColCount: 4,
  });

  // Region sheet (one combined map per distributor; all branch/outlet/customer spellings live here).
  addMappingSheet({
    workbook,
    sheetName: "Regions",
    title: `${input.distName} — Region Mapping`,
    subtitle:
      "Map each raw branch/outlet/customer label to an official Region Code. The name auto-fills; add new rows at the bottom.",
    rows: input.region,
    refSheetName: REF_REGIONS,
    refColCount: 2,
  });

  // Protect every data sheet (locked cells only; spare rows + Official Code stay editable).
  for (const sheet of workbook.worksheets) {
    if (sheet.state === "veryHidden") continue;
    await sheet.protect("", {
      autoFilter: true,
      formatCells: false,
      formatColumns: true,
      formatRows: true,
      insertRows: true,
      selectLockedCells: true,
      selectUnlockedCells: true,
      sort: true,
    });
  }

  return workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}

/** Builds the per-distributor mapping workbook (Products + Region sheets), pre-filled with the full mapping. */
export async function buildWeeklyMappingWorkbook(distributorCode: string): Promise<ArrayBuffer> {
  const admin = await loadMappingAdmin(distributorCode);
  const distName = admin.distributors.find((d) => d.code === admin.distributorCode)?.name ?? admin.distributorCode;
  return buildMappingWorkbook({
    distName,
    product: admin.product,
    region: admin.region,
    productRefs: admin.productRefs,
    regionRefs: admin.regionRefs,
  });
}
