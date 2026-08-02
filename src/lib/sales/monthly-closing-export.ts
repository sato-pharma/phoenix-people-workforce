import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";
import type { ClosingExportData, MonthlyClosingComparison } from "@/lib/sales/monthly-closing-comparison";
import type { ClosingDetailRow, ClosingDetailsResult } from "@/lib/sales/monthly-closing-details";

// Phoenix-branded Monthly Closing workbook. A hidden "Calc" sheet holds the pre-aggregated facts;
// EVERY number in the report sheets is a live Excel formula (SUMIFS / COUNTIFS / division)
// that references the Calc sheet, written with a cached result so the file opens showing the
// right values and recalculates when edited. No charts. The selection/order of top-N rows and
// the white-space lists are decided in code; the numbers inside them are formulas.
//
// On top of that sit two VISIBLE audit sheets, so the closing can be re-added by hand:
//
//   "Data"  — one row per distributor invoice line exactly as imported, with the Phoenix
//             brick -> area -> region master joined on and an Included-in-Closing flag.
//   "Total" — an Area x Product grid whose every number is a live SUMIFS over "Data",
//             plus a reconciliation block that proves it ties to the Closing Matrix.
//
// Confidential products (LA003 / LA004 / SS001) never appear on Data/Total. When a CEO or
// Super Admin opts in they get their own separate "Confidential" sheet, so the audit grid
// keeps tying to the published headline either way.

const BLACK = "FF000000";
const ORANGE = "FFF97316";
const AMBER = "FFFDE7C7";
const ACH_ORANGE = "FFF2B05A"; // darker orange tint for the Achievement % column
const DIRECT_FILL = "FFB6CEF8"; // blue band for the Direct (company) channel rows
const DIRECT_TEXT = "FF1E3A8A";
const ORANGE_LINE = "FFF8B56B";
const WHITE = "FFFFFFFF";
const SLATE = "FF334155";
const MUTED = "FF94A3B8";
const ZEBRA = "FFF8FAFC";

const UNITS_FMT = "#,##0";
const VALUE_FMT = "#,##0.00";
const PCT_FMT = "0.0%";

function gridBorder(): ExcelJS.Borders {
  const side = { style: "thin" as const, color: { argb: ORANGE_LINE } };
  return { top: side, left: side, bottom: side, right: side } as ExcelJS.Borders;
}

function sanitizeSheetName(name: string) {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || "Sheet").slice(0, 31);
}

// ── Formula helpers ──────────────────────────────────────────────────────────

type Formula = { formula: string; result: number };
const isFormula = (value: unknown): value is Formula =>
  typeof value === "object" && value !== null && "formula" in (value as Record<string, unknown>);
const F = (formula: string, result: number): Formula => ({ formula, result });

const quote = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
const sumifs = (sumRange: string, criteria: [string, string | number][]) =>
  `SUMIFS(${sumRange}${criteria.map(([range, value]) => `,${range},${quote(value)}`).join("")})`;
const countifs = (criteria: [string, string | number][]) =>
  `COUNTIFS(${criteria.map(([range, value]) => `${range},${quote(value)}`).join(",")})`;
const sumAll = (range: string) => `SUM(${range})`;
const div0 = (numerator: string, denominator: string) => `IFERROR(${numerator}/${denominator},0)`;

// ── Hidden Calc sheet (single source of truth for the report-sheet formulas) ──

// The hidden aggregate sheet used to be called "Data". It was renamed when the visible raw
// "Data" sheet was added — the report formulas below all resolve through this constant.
const CALC_SHEET = "Calc";

type DataRefs = {
  abdArea: string; abdDist: string; abdValue: string;
  brkDist: string; brkId: string; brkUnits: string; brkValue: string;
  custCode: string; custDist: string; custUnits: string; custValue: string;
  dpArea: string; dpDist: string; dpProduct: string; dpRegion: string; dpUnits: string; dpValue: string;
  maCode: string; mbId: string;
  pbdDist: string; pbdProduct: string; pbdValue: string;
};

type DataBlock = { firstData: number; headerRow: number; headers: string[]; rows: (string | number)[][] };

// Plans the hidden Data sheet layout (and the formula ranges) WITHOUT writing it, so the
// report sheets can be written first and the Data sheet added last — keeping a visible report
// sheet as the active tab (Excel refuses to hide the active sheet, which made Data show).
function planDataLayout(data: ClosingExportData): { blocks: DataBlock[]; ref: DataRefs } {
  const defs: { headers: string[]; rows: (string | number)[][] }[] = [
    {
      headers: ["Distributor", "Region Code", "Region", "Area Code", "Area", "Product Code", "Product", "Units", "Value"],
      rows: data.distProduct.map((r) => [r.distributorCode, r.regionCode, r.regionName, r.areaCode, r.areaName, r.productCode, r.productName, r.units, r.value]),
    },
    { headers: ["Client Code", "Client", "Distributor", "Units", "Value"], rows: data.customers.map((c) => [c.clientCode, c.clientName, c.distributorCode, c.units, c.value]) },
    { headers: ["Distributor", "Brick ID", "Brick", "Units", "Value"], rows: data.bricks.map((b) => [b.distributorCode, b.brickId, b.brickName, b.units, b.value]) },
    { headers: ["Distributor", "Product Code", "Value"], rows: data.productByDist.map((p) => [p.distributorCode, p.productCode, p.value]) },
    { headers: ["Distributor", "Area Code", "Value"], rows: data.areaByDist.map((a) => [a.distributorCode, a.areaCode, a.value]) },
    { headers: ["Area Code", "Area", "Region"], rows: data.masterAreas.map((a) => [a.areaCode, a.areaName, a.regionName]) },
    { headers: ["Brick ID", "Brick", "Area", "Region"], rows: data.masterBricks.map((b) => [b.brickId, b.brickName, b.areaName, b.regionName]) },
  ];

  let cursor = 3; // after the intro row (1) + a blank row (2)
  const blocks: DataBlock[] = defs.map((def) => {
    const headerRow = cursor;
    const firstData = headerRow + 1;
    const span = Math.max(1, def.rows.length); // keep a valid range even when empty
    cursor = firstData + span - 1 + 1 + 2; // last data row + gap
    return { firstData, headerRow, headers: def.headers, rows: def.rows };
  });

  const lastOf = (block: DataBlock) => block.firstData + Math.max(1, block.rows.length) - 1;
  const range = (col: string, block: DataBlock) =>
    `${CALC_SHEET}!$${col}$${block.firstData}:$${col}$${lastOf(block)}`;
  const [dp, cust, brk, pbd, abd, ma, mb] = blocks;
  const ref: DataRefs = {
    abdArea: range("B", abd), abdDist: range("A", abd), abdValue: range("C", abd),
    brkDist: range("A", brk), brkId: range("B", brk), brkUnits: range("D", brk), brkValue: range("E", brk),
    custCode: range("A", cust), custDist: range("C", cust), custUnits: range("D", cust), custValue: range("E", cust),
    dpArea: range("D", dp), dpDist: range("A", dp), dpProduct: range("F", dp), dpRegion: range("B", dp), dpUnits: range("H", dp), dpValue: range("I", dp),
    maCode: range("A", ma), mbId: range("A", mb),
    pbdDist: range("A", pbd), pbdProduct: range("B", pbd), pbdValue: range("C", pbd),
  };
  return { blocks, ref };
}

function writeDataSheet(workbook: ExcelJS.Workbook, blocks: DataBlock[]) {
  const sheet = workbook.addWorksheet(CALC_SHEET);
  sheet.state = "hidden";
  const intro = sheet.getCell(1, 1);
  intro.value = "Pre-aggregated facts — the report sheets reference these cells with live formulas. Editing these recalculates the report. The raw invoice lines are on the visible \"Data\" sheet.";
  intro.font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 10 };
  blocks.forEach((block) => {
    block.headers.forEach((header, index) => {
      const cell = sheet.getCell(block.headerRow, index + 1);
      cell.value = header;
      cell.font = { bold: true, name: "Calibri", size: 10 };
    });
    block.rows.forEach((cells, rowOffset) => {
      cells.forEach((value, index) => { sheet.getCell(block.firstData + rowOffset, index + 1).value = value; });
    });
  });
  for (let col = 1; col <= 9; col += 1) sheet.getColumn(col).width = 16;
}

// ── Visible audit sheets: raw "Data" + formula-driven "Total" ────────────────

// One column spec per Data-sheet column. `key` reads the value off a detail row; the order here
// IS the sheet order, and the Total sheet resolves its SUMIFS ranges from this array by name —
// so inserting a column can never silently point a formula at the wrong data.
type RawColumn = {
  name: string;
  width: number;
  numFmt?: string;
  value: (row: ClosingDetailRow) => string | number;
};

const RAW_COLUMNS: RawColumn[] = [
  { name: "Distributor", width: 13, value: (r) => r.distributorCode },
  { name: "Invoice Date", width: 12, value: (r) => r.invoiceDate ?? "" },
  { name: "Region Code", width: 11, value: (r) => r.regionCode },
  { name: "Region", width: 18, value: (r) => r.regionName },
  { name: "Area Code", width: 11, value: (r) => r.areaCode },
  { name: "Area", width: 22, value: (r) => r.areaName },
  { name: "Block", width: 11, value: (r) => r.blockCode },
  { name: "Brick ID", width: 12, value: (r) => r.brickId },
  { name: "Brick Name", width: 22, value: (r) => r.brickName },
  { name: "Sheet Area Code", width: 14, value: (r) => r.sheetAreaCode },
  { name: "Client Code", width: 13, value: (r) => r.clientCode },
  { name: "Client Name", width: 30, value: (r) => r.clientName },
  { name: "Client Address", width: 30, value: (r) => r.clientAddress },
  { name: "Product Code", width: 12, value: (r) => r.productCode },
  { name: "Product", width: 22, value: (r) => r.productName },
  { name: "Family", width: 14, value: (r) => r.family },
  { name: "Factory Price", width: 13, numFmt: VALUE_FMT, value: (r) => r.factoryPrice },
  { name: "Qty", width: 10, numFmt: UNITS_FMT, value: (r) => r.qty },
  { name: "Bonus Qty", width: 11, numFmt: UNITS_FMT, value: (r) => r.bonusQty },
  { name: "Discount", width: 10, numFmt: "0.00%", value: (r) => r.discount },
  { name: "Effective Units", width: 14, numFmt: VALUE_FMT, value: (r) => r.effectiveUnits },
  { name: "Sales Value", width: 15, numFmt: VALUE_FMT, value: (r) => r.salesValue },
  { name: "Sheet Value", width: 15, numFmt: VALUE_FMT, value: (r) => r.sheetValue },
  { name: "Direct", width: 9, value: (r) => (r.isDirect ? "Yes" : "No") },
  { name: "In Closing", width: 11, value: (r) => (r.includedInClosing ? "Yes" : "No") },
  { name: "Excluded Because", width: 22, value: (r) => r.exclusions.join(" + ") },
  { name: "Area Mismatch", width: 13, value: (r) => (r.areaMismatch ? "Yes" : "") },
  { name: "Brick Unmapped", width: 14, value: (r) => (r.brickUnmapped ? "Yes" : "") },
  { name: "Sheet Row #", width: 11, numFmt: UNITS_FMT, value: (r) => r.rowNumber ?? "" },
];

/** Whole-column reference on a raw sheet for a named column (e.g. `'Data'!$R:$R`). */
function rawCol(sheetName: string, columnName: string): string {
  const index = RAW_COLUMNS.findIndex((column) => column.name === columnName);
  if (index === -1) throw new Error(`Unknown Data column: ${columnName}`);
  const letter = columnLetter(index + 1);
  return `'${sheetName}'!$${letter}:$${letter}`;
}

/** 1-based column index → Excel column letter. */
function columnLetter(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * One row per imported invoice line, exactly as it came off the distributor sheet, with the
 * Phoenix master joined on. This is the sheet a reader re-adds by hand to check the closing.
 */
function writeRawDataSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  rows: ClosingDetailRow[],
  subtitle: string,
  line: string | null,
  period: string | null,
) {
  const sheet = workbook.addWorksheet(sanitizeSheetName(sheetName), {
    views: [{ state: "frozen", ySplit: 5 }],
  });
  bandHeader(sheet, line, period, subtitle, RAW_COLUMNS.length);

  const headerRow = sheet.getRow(5);
  RAW_COLUMNS.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.name;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.border = gridBorder();
    sheet.getColumn(index + 1).width = column.width;
  });
  headerRow.height = 20;

  rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(6 + rowIndex);
    RAW_COLUMNS.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1);
      const value = column.value(row);
      cell.value = value === "" ? "" : value;
      if (typeof value === "number" && column.numFmt) cell.numFmt = column.numFmt;
      cell.font = {
        color: { argb: row.includedInClosing ? SLATE : MUTED },
        name: "Calibri",
        size: 10,
      };
      cell.border = gridBorder();
      // Excluded rows are tinted so "why doesn't this match the headline?" answers itself.
      if (!row.includedInClosing) {
        cell.fill = { fgColor: { argb: AMBER }, pattern: "solid", type: "pattern" };
      } else if (rowIndex % 2 === 1) {
        cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
      }
    });
  });

  if (rows.length > 0) sheet.autoFilter = { from: { column: 1, row: 5 }, to: { column: RAW_COLUMNS.length, row: 5 } };
  return sheet;
}

/**
 * Area x Product grid where every number is a live SUMIFS over the visible Data sheet — the
 * Phoenix equivalent of the SFE closing file's Total tab. Edit a Qty on Data and this
 * recalculates, which is the whole point: the arithmetic is checkable in the file itself.
 */
// The company-wide grand total to reconcile Data/Total against, when one is available. A scoped
// export (a viewer with no whole-line/whole-company visibility) has no such headline to compare
// to — writeTotalSheet degrades to showing only its own internal totals in that case.
type ClosingHeadline = { salesUnits: number; salesValue: number };

function writeTotalSheet(
  workbook: ExcelJS.Workbook,
  headline: ClosingHeadline | null,
  details: ClosingDetailsResult,
  dataSheetName: string,
) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Total"), {
    views: [{ state: "frozen", ySplit: 5 }],
  });
  const columns: TableColumn[] = [
    { label: "Region Code", width: 11 },
    { label: "Region", width: 18 },
    { label: "Area Code", width: 11 },
    { label: "Area", width: 24 },
    { label: "Product Code", width: 12 },
    { label: "Product", width: 22 },
    { label: "Factory Price", numFmt: VALUE_FMT, right: true },
    { label: "Sales Units", numFmt: UNITS_FMT, right: true },
    { label: "Effective Units", numFmt: VALUE_FMT, right: true, width: 14 },
    { label: "Sales Value", numFmt: VALUE_FMT, right: true, width: 15 },
  ];
  bandHeader(sheet, details.line, details.period, "Total — live SUMIFS over the Data sheet", columns.length);

  const areaRange = rawCol(dataSheetName, "Area Code");
  const productRange = rawCol(dataSheetName, "Product Code");
  const inClosingRange = rawCol(dataSheetName, "In Closing");
  const qtyRange = rawCol(dataSheetName, "Qty");
  const effRange = rawCol(dataSheetName, "Effective Units");
  const valueRange = rawCol(dataSheetName, "Sales Value");

  // Only rows that feed the closing are summed here (In Closing = "Yes"), so this grid is
  // directly comparable to the Closing Matrix. The excluded buckets are reconciled below.
  const cellFor = (sumRange: string, areaCode: string, productCode: string) =>
    sumifs(sumRange, [
      [areaRange, areaCode],
      [productRange, productCode],
      [inClosingRange, "Yes"],
    ]);

  // Grid keys: every (area, product) pair that actually has a row, ordered region → area → product.
  const included = details.rows.filter((row) => row.includedInClosing);
  const keys = new Map<string, ClosingDetailRow>();
  for (const row of included) {
    const key = `${row.areaCode}||${row.productCode}`;
    if (!keys.has(key)) keys.set(key, row);
  }
  const ordered = [...keys.values()].sort(
    (left, right) =>
      left.regionCode.localeCompare(right.regionCode) ||
      left.areaName.localeCompare(right.areaName) ||
      left.productName.localeCompare(right.productName),
  );

  const sumOf = (predicate: (row: ClosingDetailRow) => boolean, pick: (row: ClosingDetailRow) => number) =>
    details.rows.reduce((total, row) => (predicate(row) ? total + pick(row) : total), 0);

  const rows: CellValue[][] = ordered.map((row) => {
    const match = (candidate: ClosingDetailRow) =>
      candidate.includedInClosing &&
      candidate.areaCode === row.areaCode &&
      candidate.productCode === row.productCode;
    return [
      row.regionCode,
      row.regionName,
      row.areaCode,
      row.areaName,
      row.productCode,
      row.productName,
      row.factoryPrice,
      F(cellFor(qtyRange, row.areaCode, row.productCode), sumOf(match, (r) => r.qty)),
      F(cellFor(effRange, row.areaCode, row.productCode), sumOf(match, (r) => r.effectiveUnits)),
      F(cellFor(valueRange, row.areaCode, row.productCode), sumOf(match, (r) => r.salesValue)),
    ];
  });

  const totalsRow: CellValue[] = [
    "TOTAL",
    null,
    null,
    null,
    null,
    null,
    null,
    F(sumifs(qtyRange, [[inClosingRange, "Yes"]]), details.reconciliation.includedInClosing.units),
    F(sumifs(effRange, [[inClosingRange, "Yes"]]), details.reconciliation.includedInClosing.effectiveUnits),
    F(sumifs(valueRange, [[inClosingRange, "Yes"]]), details.reconciliation.includedInClosing.salesValue),
  ];

  const row = writeTable(sheet, 4, {
    columns,
    note:
      "Every number above is =SUMIFS over the Data sheet, filtered to In Closing = \"Yes\". " +
      "Change a Qty on Data and this grid recalculates.",
    rows,
    title: "Area × Product (matrix-eligible rows only)",
    totals: totalsRow,
  });

  // ── Reconciliation: does the grid tie to the published headline, and what was dropped? ──
  const recon = details.reconciliation;
  // writeTable returns (note row + 2) when it wrote both a totals row and a note, so the TOTAL
  // row sits 3 above the returned cursor. With no data rows it writes neither — fall back to a
  // plain number so the reconciliation never points at an empty cell.
  const totalValueRef: CellValue = rows.length > 0
    ? F(`${columnLetter(10)}${row - 3}`, recon.includedInClosing.salesValue)
    : recon.includedInClosing.salesValue;
  const differenceRef: CellValue = !headline
    ? null
    : rows.length > 0
      ? F(
        `${columnLetter(10)}${row - 3}-${headline.salesValue}`,
        recon.includedInClosing.salesValue - headline.salesValue,
      )
      : recon.includedInClosing.salesValue - headline.salesValue;

  const headlineRows: CellValue[][] = headline
    ? [
      [
        "Closing Matrix grand total",
        headline.salesUnits,
        headline.salesValue,
        "Published headline for this line and month.",
      ],
      [
        "Difference",
        recon.includedInClosing.units - headline.salesUnits,
        differenceRef,
        "Zero means the audit sheet reproduces the headline exactly.",
      ],
    ]
    : [];

  writeTable(sheet, row, {
    columns: [
      { label: "Reconciliation", width: 42 },
      { label: "Units", numFmt: UNITS_FMT, right: true },
      { label: "Value (EGP)", numFmt: VALUE_FMT, right: true, width: 16 },
      { label: "Note", width: 52 },
    ],
    note: headline
      ? "The closing matrix counts every imported row except Direct orders and confidential products. " +
        "The two Excluded lines below are real sales the headline does not include; the Data-quality " +
        "lines ARE included in the headline but point at rows worth fixing."
      : "This export is scoped to your access and has no company-wide Closing Matrix to compare " +
        "against — the totals below are internal to this Data sheet only.",
    rows: [
      [
        headline ? "Data sheet — rows feeding the closing" : "Data sheet — rows feeding the closing (in scope)",
        recon.includedInClosing.units,
        totalValueRef,
        headline ? "Should equal the Closing Matrix grand total." : "Sum of every in-scope row below marked \"In Closing\".",
      ],
      ...headlineRows,
      [
        "Excluded — Direct orders",
        recon.excludedDirect.units,
        recon.excludedDirect.salesValue,
        "Reported separately by the Direct rows on the Closing Matrix.",
      ],
      [
        "Excluded — confidential products",
        recon.excludedConfidential.units,
        recon.excludedConfidential.salesValue,
        "LA003 / LA004 / SS001 — on the Confidential sheet when revealed.",
      ],
      [
        "Data quality — no client code",
        recon.missingClientCode.units,
        recon.missingClientCode.salesValue,
        "Counted in the headline, but the sale cannot be traced to an outlet.",
      ],
      [
        "Data quality — brick not in Phoenix master",
        recon.unmappedBricks.units,
        recon.unmappedBricks.salesValue,
        "These bricks roll up to no area; fix the master or the sheet.",
      ],
      [
        "Data quality — sheet area ≠ brick's area",
        recon.areaMismatches.units,
        recon.areaMismatches.salesValue,
        "Counted under the brick's Phoenix area, not the area printed on the sheet.",
      ],
    ],
    title: "Reconciliation",
  });
}

// ── Generic table writer ─────────────────────────────────────────────────────

type TableColumn = { dataBar?: boolean; label: string; numFmt?: string; right?: boolean; width?: number };
type CellValue = string | number | null | Formula;

function setColumnWidth(sheet: ExcelJS.Worksheet, index: number, width: number) {
  const column = sheet.getColumn(index);
  column.width = Math.max(column.width ?? 9, width);
}

function applyDataBar(sheet: ExcelJS.Worksheet, ref: string) {
  try {
    const rule = { cfvo: [{ type: "min" as const }, { type: "max" as const }], color: { argb: ORANGE }, gradient: false, priority: 1, showValue: true, type: "dataBar" as const };
    sheet.addConditionalFormatting({ ref, rules: [rule] });
  } catch {
    // data-bars are optional cosmetics — never fail the export over them.
  }
}

function setCell(cell: ExcelJS.Cell, raw: CellValue, numFmt?: string) {
  if (raw === null || raw === undefined || raw === "") {
    cell.value = "";
  } else if (isFormula(raw)) {
    cell.value = { formula: raw.formula, result: raw.result };
    if (numFmt) cell.numFmt = numFmt;
  } else {
    cell.value = raw;
    if (typeof raw === "number" && numFmt) cell.numFmt = numFmt;
  }
}

function writeTable(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  options: { columns: TableColumn[]; note?: string; rows: CellValue[][]; title: string; totals?: CellValue[] },
): number {
  const { columns, rows, title, totals, note } = options;
  const colCount = Math.max(1, columns.length);
  let row = startRow;

  sheet.mergeCells(row, 1, row, colCount);
  const titleCell = sheet.getCell(row, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, color: { argb: ORANGE }, name: "Calibri", size: 12 };
  titleCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  titleCell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  titleCell.border = { top: { style: "medium" as const, color: { argb: ORANGE } } };
  sheet.getRow(row).height = 22;
  row += 1;

  const headerRow = sheet.getRow(row);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: column.right ? "right" : "left", vertical: "middle", wrapText: true };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.border = gridBorder();
    setColumnWidth(sheet, index + 1, column.width ?? Math.max(12, column.label.length + 2));
  });
  headerRow.height = 18;
  row += 1;

  const firstDataRow = row;
  rows.forEach((cells, rowIndex) => {
    const excelRow = sheet.getRow(row);
    columns.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1);
      setCell(cell, cells[index], column.numFmt);
      cell.font = { color: { argb: SLATE }, name: "Calibri", size: 10.5 };
      cell.alignment = { horizontal: column.right ? "right" : "left", indent: column.right ? 0 : 1, vertical: "middle" };
      cell.border = gridBorder();
      if (rowIndex % 2 === 1) cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
    });
    row += 1;
  });
  const lastDataRow = row - 1;

  if (totals && rows.length > 0) {
    const totalRow = sheet.getRow(row);
    columns.forEach((column, index) => {
      const cell = totalRow.getCell(index + 1);
      setCell(cell, totals[index], column.numFmt);
      cell.font = { bold: true, color: { argb: BLACK }, name: "Calibri", size: 10.5 };
      cell.alignment = { horizontal: column.right ? "right" : "left", indent: column.right ? 0 : 1, vertical: "middle" };
      cell.fill = { fgColor: { argb: AMBER }, pattern: "solid", type: "pattern" };
      cell.border = gridBorder();
    });
    row += 1;
  }

  if (lastDataRow >= firstDataRow) {
    columns.forEach((column, index) => {
      if (column.dataBar) {
        const letter = sheet.getColumn(index + 1).letter;
        applyDataBar(sheet, `${letter}${firstDataRow}:${letter}${lastDataRow}`);
      }
    });
  }

  if (note) {
    sheet.getCell(row, 1).value = note;
    sheet.getCell(row, 1).font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 9.5 };
    row += 1;
  }

  return row + 1;
}

function bandHeader(sheet: ExcelJS.Worksheet, line: string | null, period: string | null, subtitle: string, cols: number) {
  const existingViews = sheet.views as ExcelJS.WorksheetView[];
  sheet.views = existingViews.length > 0
    ? existingViews.map((v) => ({ ...v, showGridLines: false }))
    : [{ showGridLines: false }];

  sheet.mergeCells(1, 1, 1, cols);
  const title = sheet.getCell(1, 1);
  title.value = `${systemIdentity.appName} — Monthly Closing`;
  title.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 16 };
  title.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  title.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  title.border = { bottom: { style: "medium", color: { argb: ORANGE } } };
  sheet.getRow(1).height = 36;

  sheet.mergeCells(2, 1, 2, cols);
  const sub = sheet.getCell(2, 1);
  sub.value = `${subtitle}  ·  Line: ${line ?? "—"}  ·  Month: ${period ?? "—"}  ·  Values in EGP (live formulas)`;
  sub.font = { color: { argb: WHITE }, italic: true, name: "Calibri", size: 10 };
  sub.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  sub.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  sheet.getRow(2).height = 18;

  // Row 3 — premium divider with a bold amber lead.
  const leadSpan = Math.max(1, Math.min(cols, Math.ceil(cols * 0.45)));
  if (leadSpan < cols) {
    sheet.mergeCells(3, 1, 3, leadSpan);
    const accentLead = sheet.getCell(3, 1);
    accentLead.value = "";
    accentLead.font = { color: { argb: WHITE }, name: "Calibri", size: 8 };
    accentLead.fill = { fgColor: { argb: AMBER }, pattern: "solid", type: "pattern" };
    accentLead.alignment = { horizontal: "left", vertical: "middle" };

    sheet.mergeCells(3, leadSpan + 1, 3, cols);
    const accentTail = sheet.getCell(3, leadSpan + 1);
    accentTail.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  } else {
    sheet.mergeCells(3, 1, 3, cols);
    const accentLead = sheet.getCell(3, 1);
    accentLead.value = "";
    accentLead.font = { color: { argb: WHITE }, name: "Calibri", size: 8 };
    accentLead.fill = { fgColor: { argb: AMBER }, pattern: "solid", type: "pattern" };
    accentLead.alignment = { horizontal: "left", vertical: "middle" };
  }
  sheet.getRow(3).height = 8;
}

function leaderText(leader: { distributorName: string; share: number } | null) {
  return leader ? `${leader.distributorName} (${(leader.share * 100).toFixed(0)}%)` : "—";
}

// ── Sheet 1 — closing matrix (formulas) ──────────────────────────────────────

type Tone = "area" | "subtotal" | "grand";

function fillFor(tone: Tone, zebra: boolean): string | null {
  if (tone === "grand") return BLACK;
  if (tone === "subtotal") return AMBER;
  return zebra ? ZEBRA : null;
}

function writeMatrixSheet(workbook: ExcelJS.Workbook, matrix: MonthlyClosingMatrix, ref: DataRefs) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Closing Matrix"), { views: [{ state: "frozen", xSplit: 2, ySplit: 5 }] });
  const products = matrix.columns;
  const productCols = products.length * 5;
  const totalCols = 2 + productCols + 3;
  const productStart = (index: number) => 3 + index * 5;
  const grandStart = 3 + productCols;

  bandHeader(sheet, matrix.line, matrix.period, "Closing Matrix", totalCols);

  const bandRow = sheet.getRow(4);
  const metricRow = sheet.getRow(5);
  bandRow.height = 20;
  metricRow.height = 18;
  const headerStyle = (cell: ExcelJS.Cell, label: string) => {
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.border = gridBorder();
  };
  sheet.mergeCells(4, 1, 5, 1); headerStyle(sheet.getCell(4, 1), "Area");
  sheet.mergeCells(4, 2, 5, 2); headerStyle(sheet.getCell(4, 2), "Area Name");
  const metricLabels = ["Units", "Value", "Tgt Units", "Tgt Value", "Ach %"];
  products.forEach((product, index) => {
    const start = productStart(index);
    sheet.mergeCells(4, start, 4, start + 4);
    headerStyle(sheet.getCell(4, start), `${product.productName} (${product.productCode})`);
    metricLabels.forEach((label, metricIndex) => headerStyle(metricRow.getCell(start + metricIndex), label));
  });
  sheet.mergeCells(4, grandStart, 4, grandStart + 2);
  headerStyle(sheet.getCell(4, grandStart), "Grand Total");
  ["Value", "Tgt Value", "Ach %"].forEach((label, index) => headerStyle(metricRow.getCell(grandStart + index), label));

  let rowIndex = 6;
  let zebra = false;
  // Set while writing a Direct (company) row so its whole band reads blue + bold.
  let rowAccent: string | null = null;
  const num = (cell: ExcelJS.Cell, value: CellValue, fmt: string, tone: Tone, ach = false) => {
    const textColor = rowAccent ? DIRECT_TEXT : tone === "grand" ? WHITE : SLATE;
    cell.font = { bold: tone !== "area" || Boolean(rowAccent), color: { argb: textColor }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "right", vertical: "middle" };
    cell.border = gridBorder();
    // Achievement % columns get a darker-orange tint (kept on the dark national row).
    const fill = rowAccent ?? (ach && tone !== "grand" ? ACH_ORANGE : fillFor(tone, zebra));
    if (fill) cell.fill = { fgColor: { argb: fill }, pattern: "solid", type: "pattern" };
    setCell(cell, value, fmt);
  };
  const label = (cell: ExcelJS.Cell, text: string, tone: Tone) => {
    const textColor = rowAccent ? DIRECT_TEXT : tone === "grand" ? WHITE : tone === "subtotal" ? BLACK : SLATE;
    cell.value = text;
    cell.font = { bold: tone !== "area" || Boolean(rowAccent), color: { argb: textColor }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
    cell.border = gridBorder();
    const fill = rowAccent ?? fillFor(tone, zebra);
    if (fill) cell.fill = { fgColor: { argb: fill }, pattern: "solid", type: "pattern" };
  };

  const valueCrit = (level: Tone, key: string, productCode?: string): [string, string | number][] => {
    const base: [string, string | number][] = productCode ? [[ref.dpProduct, productCode]] : [];
    if (level === "area") return [[ref.dpArea, key], ...base];
    if (level === "subtotal") return [[ref.dpRegion, key], ...base];
    return base; // grand
  };

  // `isStatic` rows (Direct channel) are written as plain cached values, not Data-sheet
  // formulas, because Direct value is taken straight from the sheet (it has no Data block).
  const writeRow = (level: Tone, key: string, name: string, cells: MonthlyClosingCell[], rowTotal: MonthlyClosingCell, tone: Tone, isStatic = false, accent: string | null = null) => {
    rowAccent = accent;
    const row = sheet.getRow(rowIndex);
    label(row.getCell(1), key, tone);
    label(row.getCell(2), name, tone);
    products.forEach((product, index) => {
      const start = productStart(index);
      const cell = cells[index];
      const units = isStatic ? (cell?.salesUnits ?? 0) : F(sumifs(ref.dpUnits, valueCrit(level, key, product.productCode)), cell?.salesUnits ?? 0);
      const value = isStatic ? (cell?.salesValue ?? 0) : F(sumifs(ref.dpValue, valueCrit(level, key, product.productCode)), cell?.salesValue ?? 0);
      num(row.getCell(start), units, UNITS_FMT, tone);
      num(row.getCell(start + 1), value, VALUE_FMT, tone);
      // Targets and achievement come off the matrix cell, which sourced them from
      // au.monthly_targets — the same engine the Targets workspace reads, so the two can never
      // disagree. They are plain cached values rather than Data-sheet formulas: the Calc sheet
      // holds distributor invoice lines only, so there is nothing there to SUMIFS a target out
      // of. A null stays blank, so an area with no target reads "—" and never a fabricated 0.
      num(row.getCell(start + 2), cell?.targetUnits ?? null, UNITS_FMT, tone);
      num(row.getCell(start + 3), cell?.targetValue ?? null, VALUE_FMT, tone);
      num(row.getCell(start + 4), cell?.achievement ?? null, PCT_FMT, tone, true);
    });
    const totalValue = isStatic
      ? rowTotal.salesValue
      : F(level === "grand" ? sumAll(ref.dpValue) : sumifs(ref.dpValue, valueCrit(level, key)), rowTotal.salesValue);
    num(row.getCell(grandStart), totalValue, VALUE_FMT, tone);
    num(row.getCell(grandStart + 1), rowTotal.targetValue, VALUE_FMT, tone);
    num(row.getCell(grandStart + 2), rowTotal.achievement, PCT_FMT, tone, true);
    rowAccent = null;
    rowIndex += 1;
  };

  matrix.regions.forEach((region) => {
    region.areas.forEach((area) => {
      const isDirect = Boolean(area.isDirect);
      writeRow("area", isDirect ? "◆ Direct" : area.areaCode, isDirect ? "Direct orders (company)" : area.areaName, area.cells, area.rowTotal, "area", isDirect, isDirect ? DIRECT_FILL : null);
      zebra = !zebra;
    });
    writeRow("subtotal", region.regionCode, `${region.regionName} (Region)`, region.subtotal.cells, region.subtotal.rowTotal, "subtotal");
    zebra = false;
  });
  writeRow("grand", "", "National Grand Total", matrix.grandTotal.cells, matrix.grandTotal.rowTotal, "grand");
  if (matrix.directNational) {
    writeRow("subtotal", "◆ DIRECT", "Direct – National", matrix.directNational.cells, matrix.directNational.rowTotal, "subtotal", true, DIRECT_FILL);
  }
  if (matrix.companyTotal) {
    writeRow("grand", "", "Grand Total (incl. Direct)", matrix.companyTotal.cells, matrix.companyTotal.rowTotal, "grand", true);
  }

  sheet.getColumn(1).width = 12;
  sheet.getColumn(2).width = 26;
  for (let col = 3; col <= totalCols; col += 1) sheet.getColumn(col).width = 13;
}

// ── Sheets 2-5 — comparison + insights (formulas) ────────────────────────────

function writeComparisonSheet(workbook: ExcelJS.Workbook, c: MonthlyClosingComparison, ref: DataRefs) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Distributor Comparison"));
  bandHeader(sheet, c.line, c.period, "Distributor Comparison", 9);
  let row = 4;

  row = writeTable(sheet, row, {
    columns: [
      { label: "Distributor", width: 18 }, { label: "Units", numFmt: UNITS_FMT, right: true }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true },
      { label: "% Share", numFmt: PCT_FMT, right: true }, { label: "Products", numFmt: UNITS_FMT, right: true }, { label: "Areas", numFmt: UNITS_FMT, right: true },
      { label: "Bricks", numFmt: UNITS_FMT, right: true }, { label: "Customers", numFmt: UNITS_FMT, right: true }, { label: "Avg Value/Customer", numFmt: VALUE_FMT, right: true, width: 18 },
    ],
    rows: c.byDistributor.map((d) => [
      d.distributorName,
      F(sumifs(ref.dpUnits, [[ref.dpDist, d.distributorCode]]), d.units),
      F(sumifs(ref.dpValue, [[ref.dpDist, d.distributorCode]]), d.value),
      F(div0(sumifs(ref.dpValue, [[ref.dpDist, d.distributorCode]]), sumAll(ref.dpValue)), d.valueShare),
      F(countifs([[ref.pbdDist, d.distributorCode], [ref.pbdValue, ">0"]]), d.productCount),
      F(countifs([[ref.abdDist, d.distributorCode], [ref.abdValue, ">0"]]), d.areaCount),
      F(countifs([[ref.brkDist, d.distributorCode], [ref.brkValue, ">0"]]), d.brickCount),
      F(countifs([[ref.custDist, d.distributorCode]]), d.customerCount),
      F(div0(sumifs(ref.dpValue, [[ref.dpDist, d.distributorCode]]), countifs([[ref.custDist, d.distributorCode]])), d.avgValuePerCustomer),
    ]),
    title: "By Distributor",
    totals: ["TOTAL", F(sumAll(ref.dpUnits), c.national.units), F(sumAll(ref.dpValue), c.national.value), null, null, null, null, null, null],
  });

  const gridColumns = (firstLabel: string): TableColumn[] => [
    { label: firstLabel, width: 24 },
    ...c.distributors.map((d) => ({ label: d.name, numFmt: VALUE_FMT, right: true })),
    { dataBar: true, label: "Total", numFmt: VALUE_FMT, right: true }, { label: "Leader", width: 18 },
  ];
  const gridRows = (rows: MonthlyClosingComparison["productByDistributor"], keyRange: string) =>
    rows.map((r) => [
      r.label,
      ...c.distributors.map((d) => F(sumifs(ref.dpValue, [[ref.dpDist, d.code], [keyRange, r.key]]), r.byDistributor[d.code] ?? 0)),
      F(sumifs(ref.dpValue, [[keyRange, r.key]]), r.total),
      leaderText(r.leader),
    ]);

  row = writeTable(sheet, row, { columns: gridColumns("Product"), rows: gridRows(c.productByDistributor, ref.dpProduct), title: "Product × Distributor (Value)" });
  row = writeTable(sheet, row, { columns: gridColumns("Region"), rows: gridRows(c.regionByDistributor, ref.dpRegion), title: "Region × Distributor (Value)" });
  row = writeTable(sheet, row, { columns: gridColumns("Area"), rows: gridRows(c.areaByDistributor, ref.dpArea), title: "Area × Distributor (Value)" });

  writeTable(sheet, row, {
    columns: [
      { label: "Distributor", width: 18 }, { label: "Areas Reached", numFmt: UNITS_FMT, right: true }, { label: "Area %", numFmt: PCT_FMT, right: true },
      { label: "Bricks Reached", numFmt: UNITS_FMT, right: true }, { label: "Brick %", numFmt: PCT_FMT, right: true },
    ],
    note: `Coverage vs master: ${c.totalAreas} areas, ${c.totalBricks} bricks.`,
    rows: c.byDistributor.map((d) => [
      d.distributorName,
      F(countifs([[ref.abdDist, d.distributorCode], [ref.abdValue, ">0"]]), d.areaCount),
      F(div0(countifs([[ref.abdDist, d.distributorCode], [ref.abdValue, ">0"]]), `COUNTA(${ref.maCode})`), c.totalAreas > 0 ? d.areaCount / c.totalAreas : 0),
      F(countifs([[ref.brkDist, d.distributorCode], [ref.brkValue, ">0"]]), d.brickCount),
      F(div0(countifs([[ref.brkDist, d.distributorCode], [ref.brkValue, ">0"]]), `COUNTA(${ref.mbId})`), c.totalBricks > 0 ? d.brickCount / c.totalBricks : 0),
    ]),
    title: "Coverage",
  });
}

function writeRankingsSheet(workbook: ExcelJS.Workbook, c: MonthlyClosingComparison, ref: DataRefs) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Rankings & Mix"));
  bandHeader(sheet, c.line, c.period, "Rankings & Mix", 6);
  let row = 4;
  const distName = new Map(c.distributors.map((d) => [d.code, d.name]));

  const rankCols = (label: string, sub?: string): TableColumn[] => [
    { label: "#", numFmt: UNITS_FMT, right: true, width: 5 }, { label, width: 24 },
    ...(sub ? [{ label: sub, width: 16 } as TableColumn] : []),
    { label: "Units", numFmt: UNITS_FMT, right: true }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true }, { label: "% Share", numFmt: PCT_FMT, right: true },
  ];
  const keyRank = (rows: MonthlyClosingComparison["rankings"]["products"], keyUnits: string, keyValue: string, keyRange: string, withSub: boolean) =>
    rows.map((r) => {
      const value = F(sumifs(keyValue, [[keyRange, r.key]]), r.value);
      const units = F(sumifs(keyUnits, [[keyRange, r.key]]), r.units);
      const share = F(div0(sumifs(keyValue, [[keyRange, r.key]]), sumAll(keyValue)), r.share);
      return withSub ? [r.rank, r.label, r.sublabel, units, value, share] : [r.rank, r.label, units, value, share];
    });

  row = writeTable(sheet, row, { columns: rankCols("Product", "Code"), rows: keyRank(c.rankings.products, ref.dpUnits, ref.dpValue, ref.dpProduct, true), title: "Top 10 Products" });
  row = writeTable(sheet, row, { columns: rankCols("Area", "Region"), rows: keyRank(c.rankings.areas, ref.dpUnits, ref.dpValue, ref.dpArea, true), title: "Top 10 Areas" });
  row = writeTable(sheet, row, { columns: rankCols("Region"), rows: keyRank(c.rankings.regions, ref.dpUnits, ref.dpValue, ref.dpRegion, false), title: "Top 10 Regions" });
  row = writeTable(sheet, row, { columns: rankCols("Brick ID"), rows: keyRank(c.rankings.bricks, ref.brkUnits, ref.brkValue, ref.brkId, false), title: "Top 10 Bricks" });

  const topCustomers = [...c.data.customers].sort((a, b) => b.value - a.value).slice(0, 10);
  const custTotal = c.data.customers.reduce((sum, cu) => sum + cu.value, 0);
  row = writeTable(sheet, row, {
    columns: rankCols("Customer", "Distributor"),
    rows: topCustomers.map((cu, index) => [
      index + 1, cu.clientName, distName.get(cu.distributorCode) ?? cu.distributorCode,
      F(sumifs(ref.custUnits, [[ref.custCode, cu.clientCode], [ref.custDist, cu.distributorCode]]), cu.units),
      F(sumifs(ref.custValue, [[ref.custCode, cu.clientCode], [ref.custDist, cu.distributorCode]]), cu.value),
      F(div0(sumifs(ref.custValue, [[ref.custCode, cu.clientCode], [ref.custDist, cu.distributorCode]]), sumAll(ref.custValue)), custTotal > 0 ? cu.value / custTotal : 0),
    ]),
    title: "Top 10 Customers",
  });

  const mixCols: TableColumn[] = [{ label: "Label", width: 24 }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true }, { label: "% Share", numFmt: PCT_FMT, right: true }];
  const mixRows = (rows: MonthlyClosingComparison["productByDistributor"], keyRange: string, total: number) =>
    rows.map((r) => [r.label, F(sumifs(ref.dpValue, [[keyRange, r.key]]), r.total), F(div0(sumifs(ref.dpValue, [[keyRange, r.key]]), sumAll(ref.dpValue)), total > 0 ? r.total / total : 0)]);
  row = writeTable(sheet, row, { columns: mixCols, rows: mixRows(c.productByDistributor, ref.dpProduct, c.national.value), title: "Product Mix" });
  row = writeTable(sheet, row, { columns: mixCols, rows: mixRows(c.regionByDistributor, ref.dpRegion, c.national.value), title: "Region Mix" });
  row = writeTable(sheet, row, {
    columns: mixCols,
    rows: c.byDistributor.map((d) => [d.distributorName, F(sumifs(ref.dpValue, [[ref.dpDist, d.distributorCode]]), d.value), F(div0(sumifs(ref.dpValue, [[ref.dpDist, d.distributorCode]]), sumAll(ref.dpValue)), d.valueShare)]),
    title: "Distributor Mix",
  });

  let cumulative = "";
  writeTable(sheet, row, {
    columns: [{ label: "Customer", width: 28 }, { label: "Value", numFmt: VALUE_FMT, right: true }, { label: "Cumulative %", numFmt: PCT_FMT, right: true }],
    note: `Top 10 customers = ${(c.pareto.customers.share * 100).toFixed(1)}% of the line's sales.`,
    rows: topCustomers.map((cu, index) => {
      const valueFormula = sumifs(ref.custValue, [[ref.custCode, cu.clientCode], [ref.custDist, cu.distributorCode]]);
      cumulative = cumulative ? `${cumulative}+${valueFormula}` : valueFormula;
      const cumulativeRatio = c.pareto.customers.rows[index]?.cumulativeShare ?? 0;
      return [cu.clientName, F(valueFormula, cu.value), F(div0(`(${cumulative})`, sumAll(ref.custValue)), cumulativeRatio)];
    }),
    title: "Customer Concentration (Pareto)",
  });
}

function writeGapsSheet(workbook: ExcelJS.Workbook, c: MonthlyClosingComparison, ref: DataRefs) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Gaps & White-Space"));
  bandHeader(sheet, c.line, c.period, "Gaps & White-Space", 5);
  let row = 4;

  row = writeTable(sheet, row, {
    columns: [{ label: "Area", width: 22 }, { label: "Region", width: 16 }, { label: "Sales (proof)", numFmt: VALUE_FMT, right: true }],
    note: `${c.whiteSpace.zeroSalesAreas.length} of ${c.totalAreas} areas had zero sales.`,
    rows: c.whiteSpace.zeroSalesAreas.map((a) => [a.areaName, a.regionName, F(sumifs(ref.dpValue, [[ref.dpArea, a.areaCode]]), 0)]),
    title: "Zero-Sales Areas",
  });
  row = writeTable(sheet, row, {
    columns: [{ label: "Brick ID", width: 12 }, { label: "Brick Name", width: 24 }, { label: "Area", width: 18 }, { label: "Region", width: 14 }, { label: "Sales (proof)", numFmt: VALUE_FMT, right: true }],
    note: `${c.whiteSpace.zeroSalesBricks.length} of ${c.totalBricks} bricks had no sales.`,
    rows: c.whiteSpace.zeroSalesBricks.map((b) => [b.brickId, b.brickName, b.areaName, b.regionName, F(sumifs(ref.brkValue, [[ref.brkId, b.brickId]]), 0)]),
    title: "Zero-Sales Bricks",
  });
  row = writeTable(sheet, row, {
    columns: [{ label: "Area", width: 22 }, { label: "Region", width: 16 }, { label: "Only Distributor", width: 18 }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true }],
    rows: c.whiteSpace.singleDistributorAreas.map((s) => [s.areaName, s.regionName, s.distributorName, F(sumifs(ref.dpValue, [[ref.dpArea, s.areaCode]]), s.value)]),
    title: "Single-Distributor Areas",
  });
  row = writeTable(sheet, row, {
    columns: [{ label: "Product", width: 24 }, { label: "Sold Regions", width: 30 }, { label: "Missing Regions", width: 30 }, { label: "# Missing", numFmt: UNITS_FMT, right: true }],
    rows: c.whiteSpace.productGaps.map((g) => [g.productName, g.soldRegions.join(", "), g.missingRegions.join(", "), g.missingRegions.length]),
    title: "Product Gaps (regions with no sales)",
  });
  writeTable(sheet, row, {
    columns: [{ label: "Product", width: 24 }, { label: "Distributor", width: 18 }, { label: "Units", numFmt: UNITS_FMT, right: true }, { label: "Value", numFmt: VALUE_FMT, right: true }, { label: "Avg Price", numFmt: VALUE_FMT, right: true }],
    rows: c.avgPrice.map((a) => [
      a.productName, a.distributorName,
      F(sumifs(ref.dpUnits, [[ref.dpDist, a.distributorCode], [ref.dpProduct, a.productCode]]), a.units),
      F(sumifs(ref.dpValue, [[ref.dpDist, a.distributorCode], [ref.dpProduct, a.productCode]]), a.value),
      F(div0(sumifs(ref.dpValue, [[ref.dpDist, a.distributorCode], [ref.dpProduct, a.productCode]]), sumifs(ref.dpUnits, [[ref.dpDist, a.distributorCode], [ref.dpProduct, a.productCode]])), a.avgPrice),
    ]),
    title: "Average Realized Price (Value ÷ Units)",
  });
}

/**
 * Target vs Achievement — the comparison the workbook never had.
 *
 * Every other comparison sheet (Distributor, Rankings & Mix, Gaps, Summary) answers "who sold
 * what", never "against what they were asked to sell": monthly-closing-comparison.ts carries no
 * target field at all. This sheet is built from the MATRIX rather than from the comparison data,
 * because the matrix is where au.monthly_targets was joined on — so a number here can never
 * disagree with the Closing Matrix sheet sitting next to it.
 *
 * Sales and target are written as the matrix's own cached values (the hidden Calc sheet holds
 * distributor invoice lines only — there is nothing there to SUMIFS a target out of, and pairing
 * a live sales formula with a static target would let the two drift apart on recalculation).
 * Achievement IS a live formula dividing this row's two cells, so editing either keeps it honest.
 *
 * An area with no target shows blank, not 0 — a 0 target would read as "asked to sell nothing"
 * and turn achievement into a division by nothing.
 */
function writeTargetAchievementSheet(workbook: ExcelJS.Workbook, matrix: MonthlyClosingMatrix) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Target vs Achievement"), {
    views: [{ state: "frozen", ySplit: 5 }],
  });
  const columns: TableColumn[] = [
    { label: "Region", width: 18 },
    { label: "Area", width: 26 },
    { label: "Sales Units", numFmt: UNITS_FMT, right: true },
    { label: "Tgt Units", numFmt: UNITS_FMT, right: true },
    { dataBar: true, label: "Sales Value", numFmt: VALUE_FMT, right: true, width: 16 },
    { label: "Tgt Value", numFmt: VALUE_FMT, right: true, width: 16 },
    { label: "Ach %", numFmt: PCT_FMT, right: true },
  ];
  bandHeader(sheet, matrix.line, matrix.period, "Target vs Achievement", columns.length);

  // writeTable puts the title on `startRow`, the header on the next row, and the first data row
  // two below — so the achievement formula can reference its own row deterministically.
  const START_ROW = 4;
  const FIRST_DATA_ROW = START_ROW + 2;
  const SALES_VALUE_COL = columnLetter(5);
  const TARGET_VALUE_COL = columnLetter(6);

  const rows: CellValue[][] = [];
  const push = (region: string, area: string, cell: MonthlyClosingCell) => {
    const excelRow = FIRST_DATA_ROW + rows.length;
    rows.push([
      region,
      area,
      cell.salesUnits,
      cell.targetUnits,
      cell.salesValue,
      cell.targetValue,
      // Live division, blank when there is no target to divide by.
      F(
        `IFERROR(${SALES_VALUE_COL}${excelRow}/${TARGET_VALUE_COL}${excelRow},"")`,
        cell.achievement ?? 0,
      ),
    ]);
  };

  matrix.regions.forEach((region) => {
    region.areas.forEach((area) => {
      push(region.regionName, area.isDirect ? "Direct orders (company)" : area.areaName, area.rowTotal);
    });
    push(region.regionName, `${region.regionName} — REGION TOTAL`, region.subtotal.rowTotal);
  });

  const grandRow = FIRST_DATA_ROW + rows.length;
  const totals: CellValue[] = [
    "NATIONAL",
    "Grand Total",
    matrix.grandTotal.rowTotal.salesUnits,
    matrix.grandTotal.rowTotal.targetUnits,
    matrix.grandTotal.rowTotal.salesValue,
    matrix.grandTotal.rowTotal.targetValue,
    F(
      `IFERROR(${SALES_VALUE_COL}${grandRow}/${TARGET_VALUE_COL}${grandRow},"")`,
      matrix.grandTotal.rowTotal.achievement ?? 0,
    ),
  ];

  const hasAnyTarget =
    matrix.grandTotal.rowTotal.targetValue !== null ||
    matrix.regions.some((region) => region.subtotal.rowTotal.targetValue !== null);

  writeTable(sheet, START_ROW, {
    columns,
    note: hasAnyTarget
      ? "Achievement % is a live formula (Sales Value ÷ Tgt Value) on each row, so it stays correct " +
        "if a figure is edited. A blank target means no target was uploaded for that area and " +
        "product — it is NOT a target of zero, and no achievement is claimed against it. " +
        "Region totals divide summed sales by summed targets; they are never the average of the " +
        "area percentages."
      : "No targets are loaded for this line and month, so every target and achievement cell is " +
        "blank. This is an absence of data, not a target of zero — upload the line's targets to " +
        "populate this sheet.",
    rows,
    title: "Sales vs Target by Area",
    totals,
  });
}

function writeSummarySheet(workbook: ExcelJS.Workbook, c: MonthlyClosingComparison, ref: DataRefs) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Summary & Insights"));
  bandHeader(sheet, c.line, c.period, "Summary & Insights", 2);
  let row = 4;
  const leader = c.byDistributor[0];

  row = writeTable(sheet, row, {
    columns: [{ label: "Metric", width: 26 }, { label: "Value", width: 32 }],
    rows: [
      ["Line", c.line ?? "—"], ["Month", c.period ?? "—"],
      ["Total Value (EGP)", F(sumAll(ref.dpValue), c.national.value)],
      ["Total Units", F(sumAll(ref.dpUnits), c.national.units)],
      ["Distributors", c.distributors.length],
      ["Products sold", c.national.productCount],
      ["Areas with sales", c.national.areaCount],
      ["Customers", F(`COUNTA(${ref.custCode})`, c.national.customerCount)],
      ["Leading distributor", leader ? `${leader.distributorName} (${(leader.valueShare * 100).toFixed(1)}%)` : "—"],
    ],
    title: "Key Metrics",
  });

  writeTable(sheet, row, {
    columns: [{ label: "Category", width: 16 }, { label: "Insight", width: 90 }],
    note: "Values in EGP · live formulas referencing the hidden Data sheet · recomputed as Qty × (1 − discount) × factory price · single month (month-over-month N/A until more months are uploaded).",
    rows: c.insights.map((b) => [b.category, b.text]),
    title: "Key Insights",
  });
}

export async function buildMonthlyClosingWorkbook(
  matrix: MonthlyClosingMatrix,
  comparison: MonthlyClosingComparison,
  details?: ClosingDetailsResult,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();

  // Plan the Calc layout first (for the formula ranges), write the visible report sheets,
  // then add the hidden Calc sheet LAST so a report sheet stays the active tab.
  const { blocks, ref } = planDataLayout(comparison.data);
  writeMatrixSheet(workbook, matrix, ref);
  // Directly after the matrix: the same numbers judged against their targets. It sits here rather
  // than at the end because "did we hit the number" is the second question a reader asks.
  writeTargetAchievementSheet(workbook, matrix);
  writeComparisonSheet(workbook, comparison, ref);
  writeRankingsSheet(workbook, comparison, ref);
  writeGapsSheet(workbook, comparison, ref);
  writeSummarySheet(workbook, comparison, ref);

  // Audit pair. Confidential rows are split onto their own sheet so "Data" + "Total" keep
  // reconciling to the published headline whether or not they were revealed.
  if (details) {
    const visible = details.rows.filter((row) => !row.isConfidential);
    const confidential = details.rows.filter((row) => row.isConfidential);
    writeRawDataSheet(
      workbook,
      "Data",
      visible,
      "Data — every imported invoice line",
      details.line,
      details.period,
    );
    const headline: ClosingHeadline = {
      salesUnits: matrix.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0),
      salesValue: matrix.grandTotal.rowTotal.salesValue,
    };
    writeTotalSheet(workbook, headline, { ...details, rows: visible }, "Data");
    if (confidential.length > 0) {
      writeRawDataSheet(
        workbook,
        "Confidential",
        confidential,
        "Confidential products — excluded from Data, Total and the Closing Matrix",
        details.line,
        details.period,
      );
    }
  }

  writeDataSheet(workbook, blocks);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Details-only export: just "Data" (+ "Total" + "Confidential" when applicable) — no Matrix,
 * Comparison, Rankings, Gaps, or Summary. For a viewer whose access is scoped to part of the
 * company (a single line, region, or product allowlist), the full Closing Matrix + distributor
 * comparison are unscoped, company-wide reads (loadMonthlyClosing / loadMonthlyClosingComparison
 * have no region/product narrowing) — sending them to a scoped viewer would leak data outside
 * their access. `loadMonthlyClosingDetails`, by contrast, is already correctly scoped (region,
 * per-user product allowlist, confidential lock), so this builder is safe for any caller: it can
 * only ever contain what the viewer was already allowed to see.
 *
 * `Total`'s reconciliation section has no company-wide headline to compare against here — it
 * shows only the totals of the rows in this export (writeTotalSheet(..., headline: null, ...)).
 */
export async function buildClosingDetailsWorkbook(details: ClosingDetailsResult): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();

  const visible = details.rows.filter((row) => !row.isConfidential);
  const confidential = details.rows.filter((row) => row.isConfidential);

  writeRawDataSheet(workbook, "Data", visible, "Data — every invoice line in your scope", details.line, details.period);
  writeTotalSheet(workbook, null, { ...details, rows: visible }, "Data");
  if (confidential.length > 0) {
    writeRawDataSheet(
      workbook,
      "Confidential",
      confidential,
      "Confidential products — excluded from Data and Total",
      details.line,
      details.period,
    );
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
