import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { directRowsCarryOwnArea, isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import { CLOSING_EPDA_SHEET_NAME, closingEpdaSheetSpec } from "@/lib/sales/closing-epda-sheet";
import { normalizeCode } from "@/lib/sales/master-data/definitions";
import {
  emptyClosingCell,
  rebuildMatrixFromRows,
  roundedClosingCell,
  type MonthlyClosingCell,
  type MonthlyClosingColumn,
  type MonthlyClosingDirectCell,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import type { ClosingExportData, MonthlyClosingComparison } from "@/lib/sales/monthly-closing-comparison";
import {
  BREAKDOWN_DIMENSIONS,
  breakdownLeader,
  breakdownSelfCheck,
  channelShare,
  resolveBreakdownLabel,
  sumBreakdownRows,
  type BreakdownNameMaps,
  type ChannelBreakdown,
  type ChannelBreakdownDimension,
  type ChannelBreakdownRow,
  type ChannelComparison,
} from "@/lib/sales/monthly-closing-channel-comparison";
import type { ClosingDetailRow, ClosingDetailsResult } from "@/lib/sales/monthly-closing-details";
import { JULY_2026_DIRECT_PERIOD, JULY_2026_DIRECT_ROWS, type JulyDirectRow } from "@/lib/sales/july-2026-direct-orders";
import { lineHasOfficeChannel } from "@/lib/sales/office-distributor";
import {
  CLOSING_MATRIX_NO_OFFICE_NOTE,
  CLOSING_MATRIX_NO_OFFICE_SHEET,
  matrixWithoutOffice,
} from "@/lib/sales/closing-matrix-without-office";
import {
  foldStoreSplitByArea,
  foldStoreSplitByCustomer,
  foldStoreSplitDetail,
  type StoreSplitMonth,
} from "@/lib/sales/closing-store-split-months";
import {
  detailStoreSplitByCustomer,
  isStoreCitySplitActive,
  summariseStoreSplitByArea,
  summariseStoreSplitByCustomer,
  areaProductKey,
  type StoreSplitAreaMovement,
  type StoreSplitAreaSummary,
  type StoreSplitCustomerSummary,
  type StoreSplitDetailRow,
  type SplitRegions,
} from "@/lib/sales/store-sales-city-split";
import type { MonthlySourceCoverage, SourceCoverageEntry } from "@/lib/sales/source-coverage";
import { unprotectExcelWorkbook } from "@/lib/sales/closing-workbook-lock";

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
//   "Total" — an Area x Product grid built by live SUMIFS over "Data", plus each area's store
//             split share and direct orders, so every area matches the Closing Matrix; and a
//             reconciliation block that proves the grand total ties to it.
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

const REGION_TOTAL_FILL = "FF7C2D12"; // deep clay — the region total, distinct from the black grand total
const BLOCK_TINT = "FFFDFAF6";        // barely-there warm wash on alternate product blocks

function gridBorder(): ExcelJS.Borders {
  const side = { style: "thin" as const, color: { argb: ORANGE_LINE } };
  return { top: side, left: side, bottom: side, right: side } as ExcelJS.Borders;
}

/**
 * Same grid, but with a heavy rule down the LEFT edge — the divider that opens a product block.
 *
 * Each product occupies seven columns, so on a wide line the eye has no way to tell where one
 * product ends and the next begins; the numbers run together into a single band. A medium rule in
 * the header orange at each block's first column gives the reader a vertical gutter to track,
 * without adding a spacer column that would break every SUMIFS range and column reference.
 */
function blockStartBorder(): ExcelJS.Borders {
  const side = { style: "thin" as const, color: { argb: ORANGE_LINE } };
  const edge = { style: "medium" as const, color: { argb: ORANGE } };
  return { top: side, left: edge, bottom: side, right: side } as ExcelJS.Borders;
}

function sanitizeSheetName(name: string) {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || "Sheet").slice(0, 31);
}

// ── Formula helpers ──────────────────────────────────────────────────────────

// `result` is the value Excel SHOWS until the sheet is recalculated, so it is whatever the formula
// evaluates to — a number almost everywhere, and a string for the self-check verdicts, which are
// IF()s that produce wording ("OK — whole month present" / "MISMATCH — 4,363,635.38 EGP MISSING").
// Those have to be live rather than typed in: a reader who edits a channel figure must see the
// verdict move with it, which is the whole point of a self-check on an editable sheet.
type Formula = { formula: string; result: number | string };
const isFormula = (value: unknown): value is Formula =>
  typeof value === "object" && value !== null && "formula" in (value as Record<string, unknown>);
const F = (formula: string, result: number | string): Formula => ({ formula, result });

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
  /** A geography code kept only as a formula key or for a filter: hidden, so the sheet reads by name. */
  hidden?: boolean;
  numFmt?: string;
  value: (row: ClosingDetailRow) => string | number;
};

const RAW_COLUMNS: RawColumn[] = [
  { name: "Distributor", width: 13, value: (r) => r.distributorCode },
  { name: "Invoice Date", width: 12, value: (r) => r.invoiceDate ?? "" },
  // The Closing Matrix's region (the organogram territory that owns the row's closing area), so this
  // sheet names the same region as the matrix beside it — on Anti Infective the map says Upper Egypt
  // where the matrix says Upper Egypt 1 or 2 (owner, 2026-09-16). Geography only where the organogram
  // has nothing.
  // Bricks, areas and regions read by NAME, never by code (owner, 2026-10-26: "in bricks and areas
  // and overall never use code always use name"). The code columns stay in the file HIDDEN: the
  // Total sheet's SUMIFS key on Area Code (an area name can repeat -- two CNS areas both print
  // "Qena"), and a hidden column costs a reader nothing.
  { name: "Region Code", width: 11, hidden: true, value: (r) => r.operationalRegionCode || r.regionCode },
  { name: "Region", width: 18, value: (r) => r.operationalRegionName || r.regionName },
  { name: "Area Code", width: 11, hidden: true, value: (r) => r.areaCode },
  { name: "Area", width: 22, value: (r) => r.areaName },
  { name: "Block", width: 11, value: (r) => r.blockCode },
  { name: "Brick ID", width: 12, hidden: true, value: (r) => r.brickId },
  { name: "Brick Name", width: 22, value: (r) => r.brickName },
  { name: "Sheet Area", width: 18, value: (r) => r.sheetAreaName || r.sheetAreaCode },
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
    if (column.hidden) sheet.getColumn(index + 1).hidden = true;
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
 * Area x Product grid built by live SUMIFS over the visible Data sheet — the Phoenix equivalent of
 * the SFE closing file's Total tab. Edit a Qty on Data and this recalculates, which is the whole
 * point: the arithmetic is checkable in the file itself.
 *
 * Beside a Closing Matrix it also carries what that matrix adds to each area's Data rows: the
 * area's share of its city's wholesaler sales (the store split) and the direct orders folded into
 * it. Sales = Data + Store Split + Direct, area by area, so every row agrees with the Closing
 * Matrix and not only the grand total. Owner's ruling, 2026-09-18 ("Make Total match the Matrix"):
 * the grid used to stop at Data, so Anti Infective 2026-07 showed Mahalla D15 25,785.00 away from
 * the Closing Matrix on the sheet the Dashboard calls the proof.
 */
// The company-wide grand total to reconcile Data/Total against, when one is available. A scoped
// export (a viewer with no whole-line/whole-company visibility) has no such headline to compare
// to — writeTotalSheet degrades to showing only its own internal totals in that case.
type ClosingHeadline = { salesUnits: number; salesValue: number };

type ClosingCellAmount = { units: number; value: number };

/**
 * What the Closing Matrix beside the Total sheet adds to each area's Data rows. `matrix` is that
 * Closing Matrix, and names the rows only it has (an area with no invoice line, a region's Direct
 * row). `storeSplit` is applyStoreSplitToMatrix's `cells`; `direct` is directByTotalCell's answer.
 */
type TotalSheetMatrixCells = {
  direct: ReadonlyMap<string, ClosingCellAmount>;
  matrix: MonthlyClosingMatrix;
  storeSplit: ReadonlyMap<string, { qty: number; value: number }>;
};

const NO_AMOUNT: ClosingCellAmount = { units: 0, value: 0 };

/**
 * One Total-grid cell's key: its area and product. The synthetic "Direct orders (company)" row is
 * the exception — every region carries one under the same area code, so its key names the region
 * too, or two regions' direct would collapse into one row.
 */
function totalCellKey(regionCode: string, areaCode: string, productCode: string, syntheticDirect: boolean): string {
  const area = syntheticDirect ? `${normalizeCode(areaCode)}@${normalizeCode(regionCode)}` : normalizeCode(areaCode);
  return `${area}||${normalizeCode(productCode)}`;
}

function matrixCellsByTotalKey(matrix: MonthlyClosingMatrix): Map<string, ClosingCellAmount> {
  const cells = new Map<string, ClosingCellAmount>();
  matrix.regions.forEach((region) => region.areas.forEach((area) => {
    const synthetic = isSyntheticDirectArea(area);
    area.cells.forEach((cell, index) => {
      const column = matrix.columns[index];
      if (!column) return;
      const key = totalCellKey(region.regionCode, area.areaCode, column.productCode, synthetic);
      const soFar = cells.get(key) ?? NO_AMOUNT;
      cells.set(key, { units: soFar.units + cell.salesUnits, value: soFar.value + cell.salesValue });
    });
  }));
  return cells;
}

/**
 * The direct money inside each cell of a Closing Matrix, keyed for the Total sheet: the matrix
 * with direct minus the same matrix without it, cell by cell. Derived as a difference for the same
 * reason the Total sheet's grand-total bridge is — a direct order whose area or product has no cell
 * on the matrix is never placed, and summing the direct rows would count it anyway. Where the store
 * split was written back to both halves alike (the retail channel beside the master), it cancels
 * and the difference is still exactly the direct.
 */
export function directByTotalCell(
  withDirect: MonthlyClosingMatrix,
  withoutDirect: MonthlyClosingMatrix,
): Map<string, ClosingCellAmount> {
  const withCells = matrixCellsByTotalKey(withDirect);
  const withoutCells = matrixCellsByTotalKey(withoutDirect);
  const direct = new Map<string, ClosingCellAmount>();
  for (const key of new Set([...withCells.keys(), ...withoutCells.keys()])) {
    const inWith = withCells.get(key) ?? NO_AMOUNT;
    const inWithout = withoutCells.get(key) ?? NO_AMOUNT;
    // Rounded because both sides are rounded money: an unrounded difference leaves a float residue
    // on cells that hold no direct at all, and a row of 0.0000000001 reads as a defect.
    const units = Number((inWith.units - inWithout.units).toFixed(6));
    const value = Number((inWith.value - inWithout.value).toFixed(2));
    if (units !== 0 || value !== 0) direct.set(key, { units, value });
  }
  return direct;
}

type TotalGridEntry = {
  areaCode: string;
  areaName: string;
  direct: ClosingCellAmount;
  factoryPrice: number | null;
  productCode: string;
  productName: string;
  regionCode: string;
  regionName: string;
  split: ClosingCellAmount;
  // False only for a region's synthetic Direct row: it has no invoice lines, and a SUMIFS on its
  // shared area code would sum every region's Direct into each of them.
  sumsData: boolean;
};

function writeTotalSheet(
  workbook: ExcelJS.Workbook,
  headline: ClosingHeadline | null,
  details: ClosingDetailsResult,
  dataSheetName: string,
  // True when the whole workbook is a filtered slice: the headline row then names the FILTERED
  // matrix total (which still ties, because every sheet was built from the same rows), so a
  // reader never mistakes it for the whole-month published number.
  filtered = false,
  // Net store split that landed on the matrix in THIS workbook. Zero on a whole-month export.
  // On a filtered one it is the bridge between the Data sheet and the headline: the Data rows are
  // raw sell-in, the matrix has them re-allocated across each store's city, and part of that
  // allocation belongs to areas the filter excluded. Stating it is what keeps Difference at zero.
  storeSplitApplied: { qty: number; value: number } = { qty: 0, value: 0 },
  // Direct money the Closing Matrix counts but the Data sheet cannot show. Direct orders reach the
  // closing from the Direct Orders module, never as a distributor invoice line, so they are absent
  // from Data by construction — `details.reconciliation.excludedDirect` is therefore ALWAYS zero
  // and cannot explain the gap. Stating the real figures here is what turns an unexplained
  // Difference into a bridge that lands on zero. `placed` is the direct inside the grand total
  // (the per-region Direct rows / July's merged area rows); `national` is the Direct – National
  // row, which sits ABOVE the grand total and is counted only in the company total.
  directInMatrix: { national: { units: number; value: number }; placed: { units: number; value: number } } = {
    national: { units: 0, value: 0 },
    placed: { units: 0, value: 0 },
  },
  // What the Closing Matrix beside this sheet adds to each area's Data rows. Null only for the
  // details-only workbook, which has no Closing Matrix to agree with and keeps the Data columns alone.
  matrixCells: TotalSheetMatrixCells | null = null,
) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Total"), {
    views: [{ state: "frozen", ySplit: 5 }],
  });
  // Columns 6-8 are the Data sheet's own sums on every workbook. Beside a Closing Matrix they are
  // named for what they are, and the columns after them carry the matrix's additions and the
  // area's Sales. The reconciliation below reads Data Value's TOTAL.
  // Regions and areas read by NAME (owner, 2026-10-26: "never use code always use name"). Their
  // codes ride HIDDEN at the far right -- a hidden column hides for every table on the sheet, and
  // the reconciliation under the grid uses the first four. The SUMIFS carry the area code as a
  // literal, so no figure reads either hidden column.
  const columns: TableColumn[] = [
    { label: "Region", width: 18 },
    { label: "Area", width: 24 },
    { label: "Product Code", width: 12 },
    { label: "Product", width: 22 },
    { label: "Factory Price", numFmt: VALUE_FMT, right: true },
    { label: matrixCells ? "Data Units" : "Sales Units", numFmt: UNITS_FMT, right: true },
    { label: "Effective Units", numFmt: VALUE_FMT, right: true, width: 14 },
    { label: matrixCells ? "Data Value" : "Sales Value", numFmt: VALUE_FMT, right: true, width: 15 },
    ...(matrixCells
      ? [
        { label: "Store Split Units", numFmt: UNITS_FMT, right: true, width: 14 },
        { label: "Store Split Value", numFmt: VALUE_FMT, right: true, width: 15 },
        { label: "Direct Units", numFmt: UNITS_FMT, right: true, width: 13 },
        { label: "Direct Value", numFmt: VALUE_FMT, right: true, width: 15 },
        { label: "Sales Units", numFmt: UNITS_FMT, right: true, width: 13 },
        { label: "Sales Value", numFmt: VALUE_FMT, right: true, width: 15 },
      ]
      : []),
    { label: "Region Code", width: 11, hidden: true },
    { label: "Area Code", width: 11, hidden: true },
  ];
  bandHeader(
    sheet,
    details.line,
    details.period,
    matrixCells
      ? "Total — the Data sheet by SUMIFS, plus the store split and direct orders: each area as on the Closing Matrix"
      : "Total — live SUMIFS over the Data sheet",
    columns.length,
  );

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

  // Grid keys: every (area, product) pair that actually has a row, then — beside a Closing Matrix —
  // every cell the store split or direct orders add to. Ordered region → area → product.
  const included = details.rows.filter((row) => row.includedInClosing);
  // Region labels are the matrix's own (see RAW_COLUMNS). The SUMIFS key on area and product only,
  // so relabelling moves no number.
  const regionCodeOf = (row: ClosingDetailRow) => row.operationalRegionCode || row.regionCode;
  const entries = new Map<string, TotalGridEntry>();
  for (const row of included) {
    const key = totalCellKey(regionCodeOf(row), row.areaCode, row.productCode, false);
    if (entries.has(key)) continue;
    entries.set(key, {
      areaCode: row.areaCode,
      areaName: row.areaName,
      direct: NO_AMOUNT,
      factoryPrice: row.factoryPrice,
      productCode: row.productCode,
      productName: row.productName,
      regionCode: regionCodeOf(row),
      regionName: row.operationalRegionName || row.regionName,
      split: NO_AMOUNT,
      sumsData: true,
    });
  }
  if (matrixCells) {
    const { matrix } = matrixCells;
    // A product's price for the rows only the matrix has. Any Data row of the product carries it;
    // a product with none (a region's direct on a product nobody invoiced) leaves the cell blank.
    const priceOf = new Map<string, number>();
    for (const row of details.rows) {
      if (row.factoryPrice && !priceOf.has(normalizeCode(row.productCode))) priceOf.set(normalizeCode(row.productCode), row.factoryPrice);
    }
    const seen = new Set<string>();
    for (const region of matrix.regions) {
      for (const area of region.areas) {
        const synthetic = isSyntheticDirectArea(area);
        area.cells.forEach((_, index) => {
          const column = matrix.columns[index];
          if (!column) return;
          const key = totalCellKey(region.regionCode, area.areaCode, column.productCode, synthetic);
          // Both maps already hold a key's whole amount, so a key the matrix lists twice is taken once.
          if (seen.has(key)) return;
          seen.add(key);
          // The split never touches a synthetic Direct row (applyStoreSplitToMatrix skips it).
          const landed = synthetic ? undefined : matrixCells.storeSplit.get(areaProductKey(area.areaCode, column.productCode));
          const split = landed ? { units: landed.qty, value: landed.value } : NO_AMOUNT;
          const direct = matrixCells.direct.get(key) ?? NO_AMOUNT;
          if (split.units === 0 && split.value === 0 && direct.units === 0 && direct.value === 0) return;
          const existing = entries.get(key);
          entries.set(key, existing ? { ...existing, direct, split } : {
            areaCode: area.areaCode,
            areaName: area.areaName,
            direct,
            factoryPrice: priceOf.get(normalizeCode(column.productCode)) ?? null,
            productCode: column.productCode,
            productName: column.productName,
            regionCode: region.regionCode,
            regionName: region.regionName,
            split,
            sumsData: !synthetic,
          });
        });
      }
    }
  }
  const ordered = [...entries.values()].sort(
    (left, right) =>
      left.regionCode.localeCompare(right.regionCode) ||
      left.areaName.localeCompare(right.areaName) ||
      left.productName.localeCompare(right.productName),
  );

  const sumOf = (predicate: (row: ClosingDetailRow) => boolean, pick: (row: ClosingDetailRow) => number) =>
    details.rows.reduce((total, row) => (predicate(row) ? total + pick(row) : total), 0);

  // writeTable puts its title on the start row and the column headers under it, so the grid's
  // first row is two below. Sales Units and Sales Value are formulas over their own row's cells.
  const gridStartRow = 4;
  const firstGridRow = gridStartRow + 2;
  const sum = { directUnits: 0, directValue: 0, splitUnits: 0, splitValue: 0 };
  const rows: CellValue[][] = ordered.map((entry, index) => {
    const match = (candidate: ClosingDetailRow) =>
      candidate.includedInClosing &&
      normalizeCode(candidate.areaCode) === normalizeCode(entry.areaCode) &&
      normalizeCode(candidate.productCode) === normalizeCode(entry.productCode);
    const dataUnits = entry.sumsData ? sumOf(match, (r) => r.qty) : 0;
    const dataEffective = entry.sumsData ? sumOf(match, (r) => r.effectiveUnits) : 0;
    const dataValue = entry.sumsData ? sumOf(match, (r) => r.salesValue) : 0;
    const codes: CellValue[] = [entry.regionCode, entry.areaCode];
    const base: CellValue[] = [
      entry.regionName,
      entry.areaName,
      entry.productCode,
      entry.productName,
      entry.factoryPrice,
      entry.sumsData ? F(cellFor(qtyRange, entry.areaCode, entry.productCode), dataUnits) : 0,
      entry.sumsData ? F(cellFor(effRange, entry.areaCode, entry.productCode), dataEffective) : 0,
      entry.sumsData ? F(cellFor(valueRange, entry.areaCode, entry.productCode), dataValue) : 0,
    ];
    if (!matrixCells) return [...base, ...codes];
    sum.splitUnits += entry.split.units;
    sum.splitValue += entry.split.value;
    sum.directUnits += entry.direct.units;
    sum.directValue += entry.direct.value;
    const at = firstGridRow + index;
    return [
      ...base,
      entry.split.units,
      entry.split.value,
      entry.direct.units,
      entry.direct.value,
      F(`${columnLetter(6)}${at}+${columnLetter(9)}${at}+${columnLetter(11)}${at}`, dataUnits + entry.split.units + entry.direct.units),
      F(`${columnLetter(8)}${at}+${columnLetter(10)}${at}+${columnLetter(12)}${at}`, dataValue + entry.split.value + entry.direct.value),
      ...codes,
    ];
  });

  const totalsAt = firstGridRow + rows.length;
  const columnSum = (column: number, cached: number): CellValue =>
    F(`SUM(${columnLetter(column)}${firstGridRow}:${columnLetter(column)}${totalsAt - 1})`, cached);
  const totalsRow: CellValue[] = [
    "TOTAL",
    null,
    null,
    null,
    null,
    F(sumifs(qtyRange, [[inClosingRange, "Yes"]]), details.reconciliation.includedInClosing.units),
    F(sumifs(effRange, [[inClosingRange, "Yes"]]), details.reconciliation.includedInClosing.effectiveUnits),
    F(sumifs(valueRange, [[inClosingRange, "Yes"]]), details.reconciliation.includedInClosing.salesValue),
    ...(matrixCells
      ? [
        columnSum(9, sum.splitUnits),
        columnSum(10, sum.splitValue),
        columnSum(11, sum.directUnits),
        columnSum(12, sum.directValue),
        F(
          `${columnLetter(6)}${totalsAt}+${columnLetter(9)}${totalsAt}+${columnLetter(11)}${totalsAt}`,
          details.reconciliation.includedInClosing.units + sum.splitUnits + sum.directUnits,
        ),
        F(
          `${columnLetter(8)}${totalsAt}+${columnLetter(10)}${totalsAt}+${columnLetter(12)}${totalsAt}`,
          details.reconciliation.includedInClosing.salesValue + sum.splitValue + sum.directValue,
        ),
      ]
      : []),
    null,
    null,
  ];

  const row = writeTable(sheet, gridStartRow, {
    columns,
    note: matrixCells
      ? "Data Units, Effective Units and Data Value are =SUMIFS over the Data sheet, filtered to In Closing = "
        + "\"Yes\" — change a Qty on Data and they recalculate. Store Split is the area's share of its city's "
        + "wholesaler sales, moved in or out exactly as on the Closing Matrix. Direct is the direct orders the "
        + "Closing Matrix counts in the area; they never arrive as an invoice line. Sales = Data + Store Split + "
        + "Direct, and equals the same area and product on the Closing Matrix."
      : "Every number above is =SUMIFS over the Data sheet, filtered to In Closing = \"Yes\". " +
        "Change a Qty on Data and this grid recalculates.",
    rows,
    title: matrixCells
      ? "Area × Product — each area as on the Closing Matrix"
      : "Area × Product (matrix-eligible rows only)",
    totals: totalsRow,
  });

  // ── Reconciliation: does the grid tie to the published headline, and what was dropped? ──
  const recon = details.reconciliation;
  // writeTable returns (note row + 2) when it wrote both a totals row and a note, so the TOTAL
  // row sits 3 above the returned cursor. With no data rows it writes neither — fall back to a
  // plain number so the reconciliation never points at an empty cell.
  const totalValueRef: CellValue = rows.length > 0
    ? F(`${columnLetter(8)}${row - 3}`, recon.includedInClosing.salesValue)
    : recon.includedInClosing.salesValue;

  // The Data rows are raw sell-in; the matrix has store sales re-allocated across each store's
  // city. Both terms therefore belong on the left of the comparison, or the difference measures
  // the re-allocation rather than an error. `applied` is zero on a whole-month export, so this
  // reduces to exactly the arithmetic that was here before.
  const applied = storeSplitApplied.value;
  const appliedUnits = storeSplitApplied.qty;
  // Direct belongs on the left of the comparison for the same reason the store split does: it is
  // real money the headline counts, and leaving it out measures the channel rather than an error.
  const directPlaced = directInMatrix.placed.value;
  const directPlacedUnits = directInMatrix.placed.units;
  const dataPlusSplit = recon.includedInClosing.salesValue + applied + directPlaced;
  const signed = (value: number) => `${value < 0 ? "-" : "+"}${Math.abs(value)}`;
  const differenceRef: CellValue = !headline
    ? null
    : rows.length > 0
      ? F(
        `${columnLetter(8)}${row - 3}${signed(applied)}${signed(directPlaced)}-${headline.salesValue}`,
        dataPlusSplit - headline.salesValue,
      )
      : dataPlusSplit - headline.salesValue;

  // Named only when it exists — a zero row in a reconciliation reads as a defect, not reassurance.
  const directRows: CellValue[][] = directPlaced !== 0 || directPlacedUnits !== 0
    ? [[
      "+ Direct orders counted in the matrix",
      directPlacedUnits,
      directPlaced,
      "Company direct orders. They reach the closing from the Direct Orders module, never as a "
        + "distributor invoice line, so no row for them exists on the Data sheet.",
    ]]
    : [];

  const nationalRows: CellValue[][] = directInMatrix.national.value !== 0 || directInMatrix.national.units !== 0
    ? [[
      "Direct – National (above the grand total)",
      directInMatrix.national.units,
      directInMatrix.national.value,
      "Direct orders that belong to no area. The company total is the grand total plus this row.",
    ]]
    : [];

  // Only shown when it is not zero — a whole-month export has nothing to explain, and a row of
  // zeroes in a reconciliation reads as a defect rather than as reassurance.
  const storeSplitRows: CellValue[][] = headline && applied !== 0
    ? [[
      applied < 0
        ? "Store split — share of these areas' store sales that belongs to city areas outside this filter"
        : "Store split — share these areas received from stores in city areas outside this filter",
      appliedUnits,
      applied,
      "A wholesaler supplies its whole city, so its sell-in is shared evenly across every area of "
        + "that city. The share is the same here as in the unfiltered export; this line is the part "
        + "of it that sits outside the filter.",
    ]]
    : [];

  const headlineRows: CellValue[][] = headline
    ? [
      ...storeSplitRows,
      [
        filtered ? "Closing Matrix grand total (filtered)" : "Closing Matrix grand total",
        headline.salesUnits,
        headline.salesValue,
        filtered
          ? "Grand total of the filtered Closing Matrix sheet in this workbook."
          : "Published headline for this line and month.",
      ],
      [
        "Difference",
        recon.includedInClosing.units + appliedUnits + directPlacedUnits - headline.salesUnits,
        differenceRef,
        "Zero means the lines above add up to the headline exactly.",
      ],
      ...nationalRows,
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
      ? (filtered
        ? "This workbook is a FILTERED slice — every sheet, including the Closing Matrix, was built " +
          "from the same filtered rows (the filter is named on the Closing Matrix sheet). "
        : "The Data sheet holds distributor invoice lines only. Direct orders are added on the line "
          + "that names them, because they never arrive as an invoice. ") +
        "The Excluded line is real sales the headline does not include; the Data-quality lines ARE " +
        "included in the headline but point at rows worth fixing."
      : "This export is scoped to your access and has no company-wide Closing Matrix to compare " +
        "against — the totals below are internal to this Data sheet only.",
    rows: [
      [
        headline
          ? "Data sheet — distributor rows feeding the closing"
          : "Data sheet — rows feeding the closing (in scope)",
        recon.includedInClosing.units,
        totalValueRef,
        headline
          ? "Every Data row marked \"In Closing\". Distributor sell-out only."
          : "Sum of every in-scope row below marked \"In Closing\".",
      ],
      ...directRows,
      ...headlineRows,
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

// `hidden` hides the whole sheet column, so only a table that has its sheet to itself may use it.
type TableColumn = { dataBar?: boolean; hidden?: boolean; label: string; numFmt?: string; right?: boolean; width?: number };
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
    if (column.hidden) sheet.getColumn(index + 1).hidden = true;
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

// No `ref: DataRefs` parameter, deliberately: this sheet must not be able to reach the hidden Calc
// sheet at all. Taking the ranges away is what stops a future edit quietly adding a SUMIFS back —
// see the long note above the row-writing loop for the 1.1M EGP of misstated subtotals that cost.
//
// `office` was added by the "of which Office" work, which was written before that note existed and
// still passed `ref` in order to write its Office cells as SUMIFS over the Calc sheet. The parameter
// is carried over; the SUMIFS are NOT. An Office figure is a plain value like every other number
// here, for exactly the reasons the note gives.
//
// `sheetName` exists for ONE caller — the Office-free twin written straight after this grid (owner,
// 2026-10-05). It names the tab AND the band header, so the two can never disagree: a band reading
// "Closing Matrix" over a tab that is not it is how a forwarded screenshot gets quoted as the
// published closing. It is not a styling hook, and every other caller leaves it alone.
function writeMatrixSheet(
  workbook: ExcelJS.Workbook,
  matrix: MonthlyClosingMatrix,
  note?: string,
  office?: MonthlyClosingMatrix | null,
  sheetName: string = "Closing Matrix",
) {
  const sheet = workbook.addWorksheet(sanitizeSheetName(sheetName), { views: [{ state: "frozen", xSplit: 2, ySplit: 5 }] });
  const products = matrix.columns;
  // Each product block is Units, [of wh. Office], Value, Tgt Units, Tgt Value, Ach %, then this
  // row's share of the LINE for that product — sales share and target share.
  //
  // "of wh. Office" is how many of those Units came from the Office channel rather than a real
  // distributor invoice (see MonthlyClosingParts.office). It is present only when the caller
  // supplied the Office grid, so EVERY offset below is named rather than a literal: adding a metric
  // in the middle of a block silently re-points every SUMIFS and every column letter on the sheet
  // if the offsets are open-coded.
  const showOffice = Boolean(office);
  const METRICS_PER_PRODUCT = showOffice ? 8 : 7;
  const M_UNITS = 0;
  const M_OFFICE = 1;
  const M_VALUE = showOffice ? 2 : 1;
  const M_TGT_UNITS = showOffice ? 3 : 2;
  const M_TGT_VALUE = showOffice ? 4 : 3;
  const M_ACH = showOffice ? 5 : 4;
  const M_SALES_CONTR = showOffice ? 6 : 5;
  const M_TGT_CONTR = showOffice ? 7 : 6;
  // Grand Total block: Value, [of wh. Office], Tgt Value, Ach %.
  const GRAND_METRICS = showOffice ? 4 : 3;
  const G_VALUE = 0;
  const G_OFFICE = 1;
  const G_TGT = showOffice ? 2 : 1;
  const G_ACH = showOffice ? 3 : 2;
  const productCols = products.length * METRICS_PER_PRODUCT;
  // + the Grand Total metrics, then the same two share columns for the row as a whole.
  const totalCols = 2 + productCols + GRAND_METRICS + 2;
  const productStart = (index: number) => 3 + index * METRICS_PER_PRODUCT;
  const grandStart = 3 + productCols;
  const contribStart = grandStart + GRAND_METRICS;

  // The Office component of any row/product on this grid, keyed `${tone}:${key}` — the same pair
  // that identifies the row itself, so a row and its Office figure can never point at different
  // areas. The original keyed this on a separate `level` argument that fed the SUMIFS criteria;
  // `level` is gone (see writeRow) and was identical to `tone` at all five call sites, so the tone
  // IS the level here.
  const officeUnitsBy = new Map<string, number>();
  const officeValueBy = new Map<string, number>();
  if (office) {
    const codes = office.columns.map((c) => c.productCode);
    const put = (key: string, cells: MonthlyClosingCell[], total: MonthlyClosingCell) => {
      cells.forEach((cell, idx) => {
        if (codes[idx]) officeUnitsBy.set(`${key}|${codes[idx]}`, cell.salesUnits ?? 0);
      });
      officeValueBy.set(key, total.salesValue ?? 0);
    };
    for (const region of office.regions) {
      for (const area of region.areas) put(`area:${area.areaCode}`, area.cells, area.rowTotal);
      put(`subtotal:${region.regionCode}`, region.subtotal.cells, region.subtotal.rowTotal);
    }
    // Both "National Grand Total" and "Grand Total (incl. Direct)" are written at level "grand"
    // with an empty key, and both take the national Office figure — Direct carries none.
    put("grand:", office.grandTotal.cells, office.grandTotal.rowTotal);
  }

  bandHeader(sheet, matrix.line, matrix.period, sheetName, totalCols);

  const bandRow = sheet.getRow(4);
  const metricRow = sheet.getRow(5);
  bandRow.height = 20;
  metricRow.height = 18;
  // The first column of every product block (and of the Grand Total block) opens with a heavy
  // rule, so a line with many products reads as a row of distinct panels rather than one wall of
  // numbers. Kept as a border rather than a spacer column: an inserted column would shift every
  // SUMIFS range and column letter on the sheet.
  const isBlockStart = (col: number) =>
    col === grandStart || (col >= 3 && col < grandStart && (col - 3) % METRICS_PER_PRODUCT === 0);
  const borderFor = (col: number) => (isBlockStart(col) ? blockStartBorder() : gridBorder());

  const headerStyle = (cell: ExcelJS.Cell, label: string) => {
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
    cell.border = borderFor(Number(cell.col));
  };
  // By NAME, never by code (owner, 2026-10-26): the region beside each area, because an area name
  // can repeat across regions (two CNS areas both print "Qena").
  sheet.mergeCells(4, 1, 5, 1); headerStyle(sheet.getCell(4, 1), "Region");
  sheet.mergeCells(4, 2, 5, 2); headerStyle(sheet.getCell(4, 2), "Area");
  // The last two are CONTRIBUTION percentages — this row's share of the line, not an achievement
  // against a target. The header says "Contr%" outright (owner, 2026-08-05): read as a bare "%"
  // beside "Ach %" they were taken for a second achievement figure.
  const metricLabels = showOffice
    ? ["Units", "of wh. Office", "Value", "Tgt Units", "Tgt Value", "Ach %", "Sales Contr% of Line", "Tgt Contr% of Line"]
    : ["Units", "Value", "Tgt Units", "Tgt Value", "Ach %", "Sales Contr% of Line", "Tgt Contr% of Line"];
  products.forEach((product, index) => {
    const start = productStart(index);
    sheet.mergeCells(4, start, 4, start + METRICS_PER_PRODUCT - 1);
    headerStyle(sheet.getCell(4, start), `${product.productName} (${product.productCode})`);
    metricLabels.forEach((label, metricIndex) => headerStyle(metricRow.getCell(start + metricIndex), label));
  });
  sheet.mergeCells(4, grandStart, 4, grandStart + GRAND_METRICS - 1);
  headerStyle(sheet.getCell(4, grandStart), "Grand Total");
  (showOffice ? ["Value", "of wh. Office", "Tgt Value", "Ach %"] : ["Value", "Tgt Value", "Ach %"])
    .forEach((label, index) => headerStyle(metricRow.getCell(grandStart + index), label));
  sheet.mergeCells(4, contribStart, 4, contribStart + 1);
  headerStyle(sheet.getCell(4, contribStart), "Contribution of Line (Contr%)");
  ["Sales Contr% of Line", "Tgt Contr% of Line"].forEach((label, index) => headerStyle(metricRow.getCell(contribStart + index), label));

  // ── Contribution denominators ────────────────────────────────────────────────
  // Each row's share is measured against the LINE's own total, so the shares on this sheet add
  // up to 100%. The denominator row must therefore be the last total written — "Grand Total
  // (incl. Direct)" when Direct exists, otherwise "National Grand Total" — because that is the
  // only row that contains every EGP on the sheet. Its index is computed BEFORE any row is
  // written, since every contribution cell above it has to point at it.
  //
  // Both cells are live formulas dividing this row's own Grand Total cell by that row's, so
  // editing any value keeps the percentage honest. Guarded twice: a blank numerator stays blank
  // (an area with no target must never read "0.0%"), and IFERROR covers a zero denominator.
  const areaAndSubtotalRows = matrix.regions.reduce((count, region) => count + region.areas.length + 1, 0);
  const nationalGrandRow = 6 + areaAndSubtotalRows;
  // Written order below is: National Grand Total, then Direct – National, then Grand Total (incl.
  // Direct). Point at the company total when it exists (it is the last row and the only one that
  // includes Direct); otherwise the national grand total IS the line total. Spelled out per
  // combination rather than summing flags, so a future change that emits one without the other
  // cannot silently aim the denominator at the Direct row.
  const denominatorRow = matrix.companyTotal
    ? nationalGrandRow + (matrix.directNational ? 1 : 0) + 1
    : nationalGrandRow;
  const GRAND_VALUE_COL = columnLetter(grandStart + G_VALUE);
  const GRAND_TARGET_COL = columnLetter(grandStart + G_TGT);
  const shareCell = (excelRow: number, col: string, numerator: number | null, denominator: number): CellValue =>
    F(
      `IFERROR(IF(${col}${excelRow}="","",${col}${excelRow}/$${col}$${denominatorRow}),"")`,
      numerator !== null && denominator ? numerator / denominator : 0,
    );
  const denominatorTotals = matrix.companyTotal ?? matrix.grandTotal;

  let rowIndex = 6;
  let zebra = false;
  // Set while writing a Direct (company) row so its whole band reads blue + bold.
  let rowAccent: string | null = null;
  // An accent band carries its OWN text colour. The Direct band is pale blue and wants dark blue
  // ink; the region-total band is deep clay and would render that ink illegibly, so the colour
  // travels with the accent rather than being assumed from it.
  let rowAccentText: string = DIRECT_TEXT;
  const num = (cell: ExcelJS.Cell, value: CellValue, fmt: string, tone: Tone, ach = false, blockIndex = -1) => {
    const textColor = rowAccent ? rowAccentText : tone === "grand" ? WHITE : SLATE;
    cell.font = { bold: tone !== "area" || Boolean(rowAccent), color: { argb: textColor }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "right", vertical: "middle" };
    cell.border = borderFor(Number(cell.col));
    // Achievement % columns get a darker-orange tint (kept on the dark national row).
    // Otherwise, alternate product blocks carry a whisper-light warm wash so the eye can follow a
    // single product straight down the sheet. It is applied ONLY where there is no stronger fill
    // to state — an accent, a total band or the achievement tint always wins.
    const base = fillFor(tone, zebra);
    const blockWash = tone === "area" && !base && blockIndex >= 0 && blockIndex % 2 === 1 ? BLOCK_TINT : null;
    const fill = rowAccent ?? (ach && tone !== "grand" ? ACH_ORANGE : base ?? blockWash);
    if (fill) cell.fill = { fgColor: { argb: fill }, pattern: "solid", type: "pattern" };
    setCell(cell, value, fmt);
  };
  const label = (cell: ExcelJS.Cell, text: string, tone: Tone) => {
    const textColor = rowAccent ? rowAccentText : tone === "grand" ? WHITE : tone === "subtotal" ? BLACK : SLATE;
    cell.value = text;
    cell.font = { bold: tone !== "area" || Boolean(rowAccent), color: { argb: textColor }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
    cell.border = borderFor(Number(cell.col));
    const fill = rowAccent ?? fillFor(tone, zebra);
    if (fill) cell.fill = { fgColor: { argb: fill }, pattern: "solid", type: "pattern" };
  };

  // EVERY SALES NUMBER ON THIS SHEET IS A VALUE, NEVER A SUMIFS. See the block above the call
  // sites below for why. `level` is gone from the signature because it only ever existed to build
  // those SUMIFS criteria, and it was identical to `tone` at all five call sites.
  const writeRow = (key: string, name: string, cells: MonthlyClosingCell[], rowTotal: MonthlyClosingCell, tone: Tone, accent: string | null = null, accentText: string = DIRECT_TEXT) => {
    rowAccent = accent;
    rowAccentText = accentText;
    const row = sheet.getRow(rowIndex);
    label(row.getCell(1), key, tone);
    label(row.getCell(2), name, tone);
    products.forEach((product, index) => {
      const start = productStart(index);
      const cell = cells[index];
      num(row.getCell(start + M_UNITS), cell?.salesUnits ?? 0, UNITS_FMT, tone, false, index);
      if (showOffice) {
        // A VALUE, like every other number on this sheet. The original wrote this as the Units
        // SUMIFS plus one criterion on the Distributor column, gated on an `isStatic` flag — the
        // very hand-maintained flag the note below records as the thing that kept failing. An
        // Office SUMIFS would have been the worst of them: it matches on the GEOGRAPHIC region_code
        // in the Calc sheet, so the organogram regrouping that already zeroed 18 of 22 region
        // subtotals would silently re-derive these too.
        num(
          row.getCell(start + M_OFFICE),
          officeUnitsBy.get(`${tone}:${key}|${product.productCode}`) ?? 0,
          UNITS_FMT,
          tone,
          false,
          index,
        );
      }
      num(row.getCell(start + M_VALUE), cell?.salesValue ?? 0, VALUE_FMT, tone, false, index);
      // Targets and achievement come off the matrix cell, which sourced them from
      // au.monthly_targets — the same engine the Targets workspace reads, so the two can never
      // disagree. They are plain cached values rather than Data-sheet formulas: the Calc sheet
      // holds distributor invoice lines only, so there is nothing there to SUMIFS a target out
      // of. A null stays blank, so an area with no target reads "—" and never a fabricated 0.
      num(row.getCell(start + M_TGT_UNITS), cell?.targetUnits ?? null, UNITS_FMT, tone, false, index);
      num(row.getCell(start + M_TGT_VALUE), cell?.targetValue ?? null, VALUE_FMT, tone, false, index);
      num(row.getCell(start + M_ACH), cell?.achievement ?? null, PCT_FMT, tone, true, index);
      // This row's share of the LINE for THIS product — sales and target, against the same
      // denominator row every other share on the sheet uses, so the column adds to 100%.
      const denomCell = denominatorTotals.cells[index];
      num(
        row.getCell(start + M_SALES_CONTR),
        shareCell(rowIndex, columnLetter(start + M_VALUE), cell?.salesValue ?? null, denomCell?.salesValue ?? 0),
        PCT_FMT,
        tone,
        false,
        index,
      );
      num(
        row.getCell(start + M_TGT_CONTR),
        shareCell(rowIndex, columnLetter(start + M_TGT_VALUE), cell?.targetValue ?? null, denomCell?.targetValue ?? 0),
        PCT_FMT,
        tone,
        false,
        index,
      );
    });
    num(row.getCell(grandStart + G_VALUE), rowTotal.salesValue, VALUE_FMT, tone);
    if (showOffice) {
      // Value, not a SUMIFS — same reasoning as the per-product Office cell above.
      num(row.getCell(grandStart + G_OFFICE), officeValueBy.get(`${tone}:${key}`) ?? 0, VALUE_FMT, tone);
    }
    num(row.getCell(grandStart + G_TGT), rowTotal.targetValue, VALUE_FMT, tone);
    num(row.getCell(grandStart + G_ACH), rowTotal.achievement, PCT_FMT, tone, true);
    num(
      row.getCell(contribStart),
      shareCell(rowIndex, GRAND_VALUE_COL, rowTotal.salesValue, denominatorTotals.rowTotal.salesValue),
      PCT_FMT,
      tone,
    );
    num(
      row.getCell(contribStart + 1),
      shareCell(rowIndex, GRAND_TARGET_COL, rowTotal.targetValue, denominatorTotals.rowTotal.targetValue ?? 0),
      PCT_FMT,
      tone,
    );
    rowAccent = null;
    rowIndex += 1;
  };

  // ── WHY EVERY SALES NUMBER ON THIS SHEET IS A VALUE AND NOT A FORMULA ───────
  //
  // This grid used to write each Units/Value cell as =SUMIFS over the hidden Calc sheet, keeping
  // the screen's own number only as that formula's CACHED result. That is what made the downloaded
  // workbook disagree with the Closing Matrix on screen — permanently, and un-fixable by re-syncing
  // any data, because it was never a data problem:
  //
  //   * ExcelJS stamps the file calcId 171027 (Excel 2010) and writes no calcChain.xml, so a modern
  //     Excel fully recalculates ON OPEN and discards every cached value.
  //   * The Calc sheet holds phx_closing_distributor_product — distributor invoice lines keyed by
  //     the GEOGRAPHIC region_code. The screen's matrix is that same SQL plus TypeScript transforms
  //     the Calc sheet knows nothing about: direct injection, the Fayoum/Beni Suef area merge,
  //     ORGANOGRAM region grouping (applyOperationalRegions), the store city split, and targets.
  //   * The organogram one was fatal, because it re-labels the very key the subtotal SUMIFS matched
  //     on. Measured against production for 2026-07: Anti Infective's UE-1 and UE-2 have no
  //     geographic equivalent at all, so both subtotals recalculated to ZERO (-33,589.80 and
  //     -81,621.90 EGP). CNS lost 329,320.95 from OT and 177,609.81 from AB while gaining
  //     212,604.13 on D1. 18 of 22 region subtotals across the three lines were wrong on open.
  //
  // Each earlier transform had been patched one at a time with a "render this row static" flag
  // (hasMergedDirect, storeSplitAdjusted, and markMergedAreaRowsStatic reusing that same flag) — a
  // hand-maintained list that must grow with every new closing rule, and which the organogram
  // grouping was simply never added to. The permanent fix is to stop re-deriving at all: a REPORT
  // sheet states what the application computed. Independent re-derivation belongs to the visible
  // Data + Total audit pair, which exists for exactly that and already carries a Difference row to
  // name any gap it finds.
  //
  // DO NOT reintroduce a Calc-sheet formula on this grid. tests/closing-export-matches-screen.test.ts
  // fails on any Closing Matrix cell that carries one.
  //
  // The only formulas left here are the Contr% cells, which divide two cells on THIS sheet by a
  // third on THIS sheet. They recalculate to exactly the values written above them, so they cannot
  // drift from the screen.
  //
  // isSyntheticDirectArea still drives the LABEL and the blue band (the "◆ Direct" pseudo-area).
  // That is a different question from where a row's money came from: a real area that absorbed
  // July's direct sales is still "GZ1 / Giza - Giza Centers" and must keep its own name.

  matrix.regions.forEach((region) => {
    region.areas.forEach((area) => {
      const synthetic = isSyntheticDirectArea(area);
      writeRow(
        synthetic ? "◆ Direct" : region.regionName,
        synthetic ? "Direct orders (company)" : area.areaName,
        area.cells,
        area.rowTotal,
        "area",
        synthetic ? DIRECT_FILL : null,
      );
      zebra = !zebra;
    });
    writeRow(region.regionName, `${region.regionName} (Region)`, region.subtotal.cells, region.subtotal.rowTotal, "subtotal");
    zebra = false;
  });
  // When the reader has filtered down to a single region, calling the bottom line "National Grand
  // Total" is simply false — it is that region's total and nothing else. Name it for what it is,
  // and give it its own deep-clay band so it cannot be mistaken either for an area row above it or
  // for the black national total a full export ends with.
  const soleRegion = matrix.regions.length === 1 ? matrix.regions[0] : null;
  writeRow(
    "",
    soleRegion ? `${soleRegion.regionName} — Region Total` : "National Grand Total",
    matrix.grandTotal.cells,
    matrix.grandTotal.rowTotal,
    "grand",
    soleRegion ? REGION_TOTAL_FILL : null,
    WHITE,
  );
  if (matrix.directNational) {
    writeRow("◆ DIRECT", "Direct – National", matrix.directNational.cells, matrix.directNational.rowTotal, "subtotal", DIRECT_FILL);
  }
  if (matrix.companyTotal) {
    writeRow("", "Grand Total (incl. Direct)", matrix.companyTotal.cells, matrix.companyTotal.rowTotal, "grand");
  }

  // Filter stamp — a filtered workbook gets forwarded like any other, so the sheet itself must
  // say what slice it covers. Written after every data row, so nothing above it moves.
  if (note) {
    rowIndex += 1;
    sheet.mergeCells(rowIndex, 1, rowIndex, totalCols);
    const noteCell = sheet.getCell(rowIndex, 1);
    noteCell.value = note;
    noteCell.font = { color: { argb: SLATE }, italic: true, name: "Calibri", size: 10 };
    noteCell.alignment = { horizontal: "left", vertical: "middle" };
    sheet.getRow(rowIndex).height = 16;
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

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-01" -> "Jan 2026". Names, never codes — and short enough that no header ever wraps.
 *
 * Exported because the download FILENAME uses it too: a workbook whose sheets say "Jul 2026" and
 * whose file says "2026-07" makes the reader do the translation twice.
 */
export function monthLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!match) return period;
  const index = Number(match[2]) - 1;
  return index >= 0 && index < 12 ? `${MONTH_NAMES[index]} ${match[1]}` : period;
}

/**
 * Channel Comparison — Hospitals vs Stores vs Pharmacies, month by month.
 *
 * WHY THIS SHEET HOLDS VALUES WHERE EVERY OTHER SHEET HOLDS =SUMIFS(Calc!…):
 * the hidden Calc sheet carries Distributor | Region | Area | Product | Units | Value and nothing
 * else — no customer NAME (the channel is derived from it) and no MONTH (this sheet compares the
 * months either side of the exported one). Neither dimension exists there to sum over, so a
 * SUMIFS could not be written at all without first shipping a second copy of these very figures
 * into Calc for the formula to read back — ceremony that would look live while adding nothing.
 *
 * So the same split the "Target vs Achievement" sheet already uses applies here: the measured
 * figures are written as VALUES, and every number DERIVED from them — row totals, share of the
 * line, the monthly mix, achievement — is a live formula over this sheet's own cells. Edit a
 * figure and everything computed from it still moves. The sheet says so on itself, so it does not
 * read as an inconsistency someone should "fix".
 *
 * Targets are shown for the MONTH TOTAL only, never per channel: they are keyed
 * (month, line, area, product) and carry no channel dimension, so a per-channel target would be a
 * number Phoenix invented rather than one anybody set.
 */
function writeChannelComparisonSheet(
  workbook: ExcelJS.Workbook,
  c: ChannelComparison,
  period: string | null,
  /** This workbook's own Closing Matrix headline, for the exported month's extra tie. Null when
   *  there is no matrix to tie to, in which case that one row is omitted rather than faked. */
  matrixValue: number | null,
) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Channel Comparison"), {
    views: [{ state: "frozen", xSplit: 1, ySplit: 5 }],
  });

  const months = c.periods;
  const monthCount = months.length;
  // Channel | one column per month | Total | % Share
  const FIRST_MONTH_COL = 2;
  const totalCol = FIRST_MONTH_COL + monthCount;
  const shareCol = totalCol + 1;
  const colOf = (monthIndex: number) => columnLetter(FIRST_MONTH_COL + monthIndex);
  const firstMonthLetter = colOf(0);
  const lastMonthLetter = monthCount > 0 ? colOf(monthCount - 1) : firstMonthLetter;

  bandHeader(sheet, c.line, period, "Channel Comparison", Math.max(3, shareCol));

  if (monthCount === 0) {
    writeTable(sheet, 4, {
      columns: [{ label: "Channel", width: 24 }],
      note: "No validated month of this line has any customer sales, so there is nothing to compare yet.",
      rows: [],
      title: "Sales by Customer Channel",
    });
    return;
  }

  // writeTable puts the title on `start`, the header on start+1 and the first data row on start+2.
  // The channel rows then a TOTAL row, so every cross-block reference below is deterministic.
  //
  // Counted off `c.rows`, NOT off CHANNEL_ORDER: the three unattributed rows are dropped on a line
  // that has no unattributed money, so the two differ on every clean line. Using the constant would
  // leave every SUM range in this sheet three rows too long — reaching into the TOTAL row and
  // double-counting the month.
  const CHANNEL_ROWS = c.rows.length;
  const blockFirstRow = (start: number) => start + 2;
  const blockTotalRow = (start: number) => start + 2 + CHANNEL_ROWS;

  const monthColumns = (): TableColumn[] =>
    months.map((month) => ({ label: monthLabel(month), numFmt: VALUE_FMT, right: true, width: 13 }));

  const scopeNote = c.restrictedProductsIncluded
    ? "Figures INCLUDE the restricted products (Lacto Basic 1 & 2, Satoslim) because this export was "
      + "taken with them revealed. Every other export of this month excludes them and will show smaller numbers."
    : "Figures EXCLUDE the restricted products (Lacto Basic 1 & 2, Satoslim), which is the default view for "
      + "every role. A CEO or Super Admin who reveals them gets a materially different picture, not a rounding difference.";

  let row = 4;

  // ── Block 1 — Value by month ───────────────────────────────────────────────
  const valueStart = row;
  const valueFirstRow = blockFirstRow(valueStart);
  const valueTotalRow = blockTotalRow(valueStart);
  row = writeTable(sheet, valueStart, {
    columns: [
      { label: "Channel", width: 24 },
      ...monthColumns(),
      { dataBar: true, label: "Total", numFmt: VALUE_FMT, right: true, width: 15 },
      { label: "% Share", numFmt: PCT_FMT, right: true, width: 10 },
    ],
    note:
      `This sheet spans ${monthLabel(months[0])} to ${monthLabel(months[monthCount - 1])} — every validated month `
      + "of this line up to and including the one named at the top. It is the only sheet in this workbook that "
      + "looks outside the exported month. Every figure below is the SAME money the Closing Matrix publishes for "
      + "each of those months, split by who bought it. The channel comes from the customer's name, and the name is "
      + "not in this workbook's hidden Calc sheet — so the monthly figures are written as values while every total, "
      + "share and percentage is a live formula over the cells beside it. " + scopeNote,
    rows: c.rows.map((channelRow, index) => {
      const excelRow = valueFirstRow + index;
      return [
        channelRow.label,
        ...months.map((month) => channelRow.byPeriod[month]?.value ?? 0),
        F(`SUM(${firstMonthLetter}${excelRow}:${lastMonthLetter}${excelRow})`, channelRow.total.value),
        F(
          `IFERROR(${columnLetter(totalCol)}${excelRow}/${columnLetter(totalCol)}$${valueTotalRow},0)`,
          channelShare(channelRow.total.value, c.grandTotal.value),
        ),
      ];
    }),
    title: "1 · Value by Month (EGP)",
    totals: [
      "TOTAL",
      ...months.map((month, index) =>
        F(
          `SUM(${colOf(index)}${valueFirstRow}:${colOf(index)}${valueFirstRow + CHANNEL_ROWS - 1})`,
          c.totalsByPeriod[month]?.value ?? 0,
        ),
      ),
      F(`SUM(${firstMonthLetter}${valueTotalRow}:${lastMonthLetter}${valueTotalRow})`, c.grandTotal.value),
      F(`IFERROR(${columnLetter(totalCol)}${valueTotalRow}/${columnLetter(totalCol)}${valueTotalRow},0)`, 1),
    ],
  });

  // ── Block 2 — Units by month ───────────────────────────────────────────────
  const unitsStart = row;
  const unitsFirstRow = blockFirstRow(unitsStart);
  const unitsTotalRow = blockTotalRow(unitsStart);
  row = writeTable(sheet, unitsStart, {
    columns: [
      { label: "Channel", width: 24 },
      ...months.map((month) => ({ label: monthLabel(month), numFmt: UNITS_FMT, right: true, width: 13 })),
      { dataBar: true, label: "Total", numFmt: UNITS_FMT, right: true, width: 15 },
      { label: "% Share", numFmt: PCT_FMT, right: true, width: 10 },
    ],
    note:
      "Units are boxes, counted the same way the closing counts them. A channel can move in units without "
      + "moving in value when its product mix changes, which is exactly what this block is here to expose.",
    rows: c.rows.map((channelRow, index) => {
      const excelRow = unitsFirstRow + index;
      return [
        channelRow.label,
        ...months.map((month) => channelRow.byPeriod[month]?.units ?? 0),
        F(`SUM(${firstMonthLetter}${excelRow}:${lastMonthLetter}${excelRow})`, channelRow.total.units),
        F(
          `IFERROR(${columnLetter(totalCol)}${excelRow}/${columnLetter(totalCol)}$${unitsTotalRow},0)`,
          channelShare(channelRow.total.units, c.grandTotal.units),
        ),
      ];
    }),
    title: "2 · Units by Month",
    totals: [
      "TOTAL",
      ...months.map((month, index) =>
        F(
          `SUM(${colOf(index)}${unitsFirstRow}:${colOf(index)}${unitsFirstRow + CHANNEL_ROWS - 1})`,
          c.totalsByPeriod[month]?.units ?? 0,
        ),
      ),
      F(`SUM(${firstMonthLetter}${unitsTotalRow}:${lastMonthLetter}${unitsTotalRow})`, c.grandTotal.units),
      F(`IFERROR(${columnLetter(totalCol)}${unitsTotalRow}/${columnLetter(totalCol)}${unitsTotalRow},0)`, 1),
    ],
  });

  // ── Block 3 — Customers by month ───────────────────────────────────────────
  // No Total column that SUMS: the same pharmacy buys in most months, so adding the months would
  // report several times more pharmacies than the line has. The busiest single month is the
  // honest headline, and it is a live MAX over the row rather than a number typed in.
  const customersStart = row;
  const customersFirstRow = blockFirstRow(customersStart);
  row = writeTable(sheet, customersStart, {
    columns: [
      { label: "Channel", width: 24 },
      ...months.map((month) => ({ label: monthLabel(month), numFmt: UNITS_FMT, right: true, width: 13 })),
      { label: "Busiest Month", numFmt: UNITS_FMT, right: true, width: 15 },
    ],
    note:
      "Distinct customers that bought in that month — a pharmacy buying from three distributors counts ONCE. "
      + "The months are deliberately not added together: nearly every customer buys in more than one month, so a "
      + "sum would multiply the customer base. The last column is the busiest single month instead. Direct orders "
      + "carry no customer code, so each distinct direct customer NAME counts as one customer.",
    rows: c.rows.map((channelRow, index) => {
      const excelRow = customersFirstRow + index;
      return [
        channelRow.label,
        ...months.map((month) => channelRow.byPeriod[month]?.customers ?? 0),
        F(`MAX(${firstMonthLetter}${excelRow}:${lastMonthLetter}${excelRow})`, channelRow.total.customers),
      ];
    }),
    title: "3 · Customers by Month (distinct)",
    totals: [
      "TOTAL",
      ...months.map((month, index) =>
        F(
          `SUM(${colOf(index)}${customersFirstRow}:${colOf(index)}${customersFirstRow + CHANNEL_ROWS - 1})`,
          c.totalsByPeriod[month]?.customers ?? 0,
        ),
      ),
      F(
        `MAX(${firstMonthLetter}${blockTotalRow(customersStart)}:${lastMonthLetter}${blockTotalRow(customersStart)})`,
        c.grandTotal.customers,
      ),
    ],
  });

  // ── Block 4 — Mix % by month ───────────────────────────────────────────────
  // Entirely live: each cell divides Block 1's channel cell by Block 1's month total, so the mix
  // can never drift from the money it describes.
  const mixStart = row;
  const mixFirstRow = blockFirstRow(mixStart);
  row = writeTable(sheet, mixStart, {
    columns: [
      { label: "Channel", width: 24 },
      ...months.map((month) => ({ label: monthLabel(month), numFmt: PCT_FMT, right: true, width: 13 })),
      { label: "Total", numFmt: PCT_FMT, right: true, width: 15 },
    ],
    note:
      "Each channel as a share of that month's value. This is the block worth reading first: a channel can hold "
      + "its money while its share of the line moves, and the value columns above will look flat while it happens. "
      + "Every cell divides the matching cell of block 1 by that month's total, so it recalculates with them.",
    rows: c.rows.map((channelRow, index) => {
      const valueRow = valueFirstRow + index;
      return [
        channelRow.label,
        ...months.map((month, monthIndex) =>
          F(
            `IFERROR(${colOf(monthIndex)}${valueRow}/${colOf(monthIndex)}$${valueTotalRow},0)`,
            channelShare(channelRow.byPeriod[month]?.value ?? 0, c.totalsByPeriod[month]?.value ?? 0),
          ),
        ),
        F(
          `IFERROR(${columnLetter(totalCol)}${valueRow}/${columnLetter(totalCol)}$${valueTotalRow},0)`,
          channelShare(channelRow.total.value, c.grandTotal.value),
        ),
      ];
    }),
    title: "4 · Mix % by Month (share of the month's value)",
    totals: [
      "TOTAL",
      ...months.map((month, monthIndex) =>
        F(
          `SUM(${colOf(monthIndex)}${mixFirstRow}:${colOf(monthIndex)}${mixFirstRow + CHANNEL_ROWS - 1})`,
          (c.totalsByPeriod[month]?.value ?? 0) > 0 ? 1 : 0,
        ),
      ),
      F(`SUM(${columnLetter(totalCol)}${mixFirstRow}:${columnLetter(totalCol)}${mixFirstRow + CHANNEL_ROWS - 1})`, c.grandTotal.value > 0 ? 1 : 0),
    ],
  });

  // ── Block 5 — Month total vs target ────────────────────────────────────────
  const targetStart = row;
  const targetFirstRow = blockFirstRow(targetStart);
  const hasAnyTarget = months.some(
    (month) => c.targetsByPeriod[month]?.targetValue != null || c.targetsByPeriod[month]?.targetUnits != null,
  );
  row = writeTable(sheet, targetStart, {
    columns: [
      { label: "Month", width: 24 },
      { dataBar: true, label: "Sales Value", numFmt: VALUE_FMT, right: true, width: 16 },
      { label: "Target Value", numFmt: VALUE_FMT, right: true, width: 16 },
      { label: "Ach %", numFmt: PCT_FMT, right: true, width: 10 },
      { label: "Sales Units", numFmt: UNITS_FMT, right: true, width: 13 },
      { label: "Target Units", numFmt: UNITS_FMT, right: true, width: 13 },
    ],
    note:
      "THE TARGET IS THE MONTH TOTAL, NOT A PER-CHANNEL TARGET, AND THAT IS DELIBERATE. Targets are set per "
      + "month, line, area and product — they carry no customer channel at all, so splitting one across "
      + "Hospitals, Stores and Pharmacies would invent three numbers nobody set. The month total beside the "
      + "channel split is the real figure. "
      + (hasAnyTarget
        ? "A blank target is a month no target was uploaded for — it is NOT a target of zero, and no achievement "
          + "is claimed against it. Sales Value reads from block 1's TOTAL row and Ach % divides this row's own "
          + "two cells, so both stay correct if a figure is edited. On the ALL MONTHS row, Sales Value is every "
          + "month, but Ach % counts ONLY the months that carry a target — dividing untargeted months' sales by "
          + "the targeted months' figure would print a percentage against a target nobody set."
        : "No targets are loaded for any month of this line, so the target and achievement columns are blank "
          + "throughout. That is an absence of data, not a target of zero."),
    rows: months.map((month, monthIndex) => {
      const excelRow = targetFirstRow + monthIndex;
      const target = c.targetsByPeriod[month] ?? { targetUnits: null, targetValue: null };
      const totals = c.totalsByPeriod[month] ?? { customers: 0, units: 0, value: 0 };
      return [
        monthLabel(month),
        F(`${colOf(monthIndex)}${valueTotalRow}`, totals.value),
        target.targetValue,
        // Blank rather than 0 when there is no target to divide by.
        F(
          `IFERROR(IF(C${excelRow}="","",B${excelRow}/C${excelRow}),"")`,
          target.targetValue ? totals.value / target.targetValue : 0,
        ),
        F(`${colOf(monthIndex)}${unitsTotalRow}`, totals.units),
        target.targetUnits,
      ];
    }),
    title: "5 · Month Total vs Target",
    totals: (() => {
      const lastTargetRow = targetFirstRow + monthCount - 1;
      const targetValueSum = months.reduce((sum, month) => sum + (c.targetsByPeriod[month]?.targetValue ?? 0), 0);
      const targetUnitsSum = months.reduce((sum, month) => sum + (c.targetsByPeriod[month]?.targetUnits ?? 0), 0);
      // Sales of the months that carry a target — the only sales an achievement % may be taken on.
      const targetedSalesValue = months.reduce(
        (sum, month) => sum + ((c.targetsByPeriod[month]?.targetValue ?? 0) > 0 ? (c.totalsByPeriod[month]?.value ?? 0) : 0),
        0,
      );
      return [
        "ALL MONTHS",
        F(`SUM(B${targetFirstRow}:B${lastTargetRow})`, c.grandTotal.value),
        F(`SUM(C${targetFirstRow}:C${lastTargetRow})`, targetValueSum),
        // Summed sales over summed targets — never the average of the monthly percentages, and
        // deliberately only over the months that HAVE a target. Most months here have none, so
        // dividing every month's sales by the one month that was targeted would print a wildly
        // flattering percentage against a target nobody set for those months.
        F(
          `IFERROR(IF(SUM(C${targetFirstRow}:C${lastTargetRow})=0,"",`
          + `SUMIF(C${targetFirstRow}:C${lastTargetRow},">0",B${targetFirstRow}:B${lastTargetRow})`
          + `/SUM(C${targetFirstRow}:C${lastTargetRow})),"")`,
          targetValueSum > 0 ? targetedSalesValue / targetValueSum : 0,
        ),
        F(`SUM(E${targetFirstRow}:E${lastTargetRow})`, c.grandTotal.units),
        F(`SUM(F${targetFirstRow}:F${lastTargetRow})`, targetUnitsSum),
      ];
    })(),
  });

  // ── Block 6 — Self-check, EVERY month ──────────────────────────────────────
  //
  // The old version of this block checked the exported month alone. CNS 2026-07 happens to have no
  // unattributable money, so a CNS July export printed "Difference 0.00 — this sheet and the Data
  // sheet are the same money" while the six month blocks ABOVE it were short by as much as
  // 4,363,635.38 each. A check that covers one of seven months is not a check; it is a reassurance.
  //
  // WHAT IT CHECKS AGAINST. Not the other blocks of this sheet — they are the same query added up a
  // second way and would agree with themselves whatever the query did. `phx_closing_channel_totals`
  // re-aggregates each month straight from source_of_sales_fact_rollup and
  // source_of_sales_import_rows, with the guards WRITTEN OUT AGAIN rather than reused, and returns
  // it as its own row. So a filter added to the channel query moves the left column and not the
  // right one, and this block goes red.
  const selfStart = row;
  const selfFirstRow = blockFirstRow(selfStart);
  const failures = c.selfCheck.filter((check) => !check.ok);
  const verdictFormula = (excelRow: number) =>
    `IF(ROUND(D${excelRow},2)=0,"OK — whole month present",`
    + `"MISMATCH — "&TEXT(ABS(D${excelRow}),"#,##0.00")&" EGP "&IF(D${excelRow}<0,"MISSING","EXTRA"))`;
  const verdictText = (difference: number) =>
    Math.abs(Number(difference.toFixed(2))) < 0.005
      ? "OK — whole month present"
      : `MISMATCH — ${Math.abs(difference).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} EGP ${difference < 0 ? "MISSING" : "EXTRA"}`;
  // A month the database could not supply an independent total for is NOT checked, and says so.
  // Letting it fall back to the sheet's own figure would print a difference of 0.00 and an OK —
  // which is the exact behaviour that made a CNS July export look reconciled while six months
  // behind it were short.
  const NOT_CHECKED = "NOT CHECKED — no independent total from the database";

  const selfRows: CellValue[][] = c.selfCheck.map((check, index) => {
    const excelRow = selfFirstRow + index;
    const monthIndex = months.indexOf(check.period);
    return [
      monthLabel(check.period),
      // Live: the TOTAL cell of block 1 for this month. Edit a channel figure above and this check
      // re-runs against it, which is the only way a self-check on an editable sheet stays true.
      monthIndex >= 0 ? F(`${colOf(monthIndex)}${valueTotalRow}`, check.sheetValue) : check.sheetValue,
      check.populationAvailable ? check.populationValue : null,
      check.populationAvailable ? F(`B${excelRow}-C${excelRow}`, check.differenceValue) : null,
      check.populationAvailable ? check.differenceUnits : null,
      check.populationAvailable ? F(verdictFormula(excelRow), verdictText(check.differenceValue)) : NOT_CHECKED,
    ];
  });

  // The exported month gets one extra line: this workbook's OWN Closing Matrix. The two are built
  // from different queries and meet only if the whole chain agrees, so it is the strongest single
  // check in the file — and the one a reader can verify by looking at sheet 1.
  const exportedCheck = period ? c.selfCheck.find((check) => check.period === period) : undefined;
  if (matrixValue != null && exportedCheck) {
    const excelRow = selfFirstRow + selfRows.length;
    selfRows.push([
      `${monthLabel(exportedCheck.period)} — against the Closing Matrix in this workbook`,
      exportedCheck.sheetValue,
      matrixValue,
      F(`B${excelRow}-C${excelRow}`, exportedCheck.sheetValue - matrixValue),
      null,
      F(verdictFormula(excelRow), verdictText(exportedCheck.sheetValue - matrixValue)),
    ]);
  }

  const totalSheetValue = c.selfCheck.reduce((sum, check) => sum + check.sheetValue, 0);
  const totalPopulation = c.selfCheck.reduce((sum, check) => sum + check.populationValue, 0);
  writeTable(sheet, selfStart, {
    columns: [
      { label: "Month", width: 52 },
      { label: "This sheet (EGP)", numFmt: VALUE_FMT, right: true, width: 18 },
      { label: "Source tables (EGP)", numFmt: VALUE_FMT, right: true, width: 18 },
      { label: "Difference", numFmt: VALUE_FMT, right: true, width: 15 },
      { label: "Units diff.", numFmt: UNITS_FMT, right: true, width: 12 },
      { label: "Verdict", width: 44 },
    ],
    note: c.selfCheck.every((check) => !check.populationAvailable)
      ? "NOT CHECKED. This database returned no independent month total, so nothing on this sheet has been "
        + "verified against the source tables. A blank Difference is honest; a 0.00 would not be. Apply "
        + "migration 20260806160000 and re-export to get a real check."
      : failures.length > 0
      ? `THIS SHEET IS NOT THE WHOLE LINE. ${failures.length} of ${c.selfCheck.length} months do not tie, `
        + `the worst by ${Math.abs(c.worstSelfCheck?.differenceValue ?? 0).toFixed(2)} EGP in `
        + `${monthLabel(c.worstSelfCheck?.period ?? "")}. Every month above is checked, not only the exported `
        + "one. A negative difference means money exists in the source tables that no row on this sheet "
        + "carries — do not publish these figures until the Verdict column reads OK on every line."
      : "Every month this sheet displays is checked here, not only the exported one — a check that covers "
        + "one month of seven is a reassurance, not a check, and that is exactly how six short CNS months "
        + "went out. The right-hand figure is the month re-added from the source tables inside "
        + "phx_closing_channel_totals, with its guards written out a second time rather than reused, so a "
        + "filter added to the channel query would move the left column and not the right one. Difference "
        + "and Verdict are live formulas over this block's own cells.",
    rows: selfRows,
    title: `6 · Self-check — all ${c.selfCheck.length} month${c.selfCheck.length === 1 ? "" : "s"} on this sheet`,
    totals: [
      "ALL MONTHS",
      F(`SUM(B${selfFirstRow}:B${selfFirstRow + c.selfCheck.length - 1})`, totalSheetValue),
      F(`SUM(C${selfFirstRow}:C${selfFirstRow + c.selfCheck.length - 1})`, totalPopulation),
      F(`SUM(D${selfFirstRow}:D${selfFirstRow + c.selfCheck.length - 1})`, totalSheetValue - totalPopulation),
      c.selfCheck.reduce((sum, check) => sum + check.differenceUnits, 0),
      c.selfCheck.every((check) => !check.populationAvailable)
        ? "NOT CHECKED — no independent total from the database"
        : failures.length === 0
          ? "OK — every month ties"
          : `${failures.length} of ${c.selfCheck.length} MONTHS DO NOT TIE`,
    ],
  });
}

/**
 * Channel by Product / Rep / Area / Brick — the exported month, cut four ways.
 *
 * The companion to Channel Comparison: that sheet answers "how did the three channels move month by
 * month", this one answers "inside THIS month, which products, reps, areas and bricks is that money
 * in". Four grids, same shape as the Product/Region/Area × Distributor grids on the Distributor
 * Comparison sheet, so a reader who can read one can read these.
 *
 * ON ITS OWN SHEET, NOT APPENDED TO Channel Comparison: the brick grid alone runs to hundreds of
 * rows (234 on Anti Infective 2026-07, and Gaps & White-Space already reaches 508), which would
 * bury the month-by-month blocks under a scroll.
 *
 * EVERY GRID SUMS TO THE MONTH TOTAL, and that is the property to protect. Money that reaches no
 * product, rep, area or brick gets a named row rather than being dropped — direct orders carry no
 * area and no brick at all, an area can be absent from the seat model, and a seat can have no
 * current occupant. Each of those is a visible row here, so the four TOTAL rows agree with each
 * other and with the Closing Matrix.
 *
 * Same convention as the sheet before it: the measured figures are values (the channel comes from
 * the customer's name, which the hidden Calc sheet does not carry), and every number derived from
 * them — each row's Total, and each grid's TOTAL row — is a live formula over this sheet's cells.
 */
function writeChannelBreakdownSheet(
  workbook: ExcelJS.Workbook,
  breakdown: ChannelBreakdown,
  matrix: MonthlyClosingMatrix,
  comparison: MonthlyClosingComparison,
) {
  // Excel caps a sheet name at 31 characters and sanitizeSheetName truncates silently, so the tab
  // keeps a short name and the band header below carries the full "by Product / Rep / Area / Brick"
  // title. A truncated tab would also miss its SHEET_GUIDE key and render "—" on the Dashboard.
  const sheet = workbook.addWorksheet(sanitizeSheetName("Channel Breakdown"), {
    views: [{ state: "frozen", xSplit: 1, ySplit: 5 }],
  });

  const upperKey = (value: string) => value.trim().toUpperCase();
  const maps: BreakdownNameMaps = {
    areaName: new Map(comparison.data.masterAreas.map((area) => [upperKey(area.areaCode), area.areaName])),
    brickName: new Map(comparison.data.masterBricks.map((brick) => [upperKey(brick.brickId), brick.brickName])),
    productName: new Map(matrix.columns.map((product) => [upperKey(product.productCode), product.productName])),
  };

  // Row label | the channel columns | Total | Leader. The channel columns are three when every
  // customer on the sheet could be identified, and up to six when they could not — decided ONCE
  // below for all four grids, so a reader scrolling between them never finds Total in a new place.
  const gridTotals = BREAKDOWN_DIMENSIONS.map((dimension) => sumBreakdownRows(breakdown.byDimension[dimension]));
  type BucketColumn = { label: string; pick: (row: ChannelBreakdownRow) => number };
  // Annotated before `.filter`, not after: the filter's input literal has no contextual type of its
  // own, so annotating only the result leaves every `row` parameter an implicit any.
  const allBucketColumns: readonly BucketColumn[] = [
    { label: "No client code", pick: (row) => row.unidentifiedNoCode },
    { label: "No customer name", pick: (row) => row.unidentifiedNoName },
    { label: "Direct, unnamed", pick: (row) => row.directUnnamed },
  ];
  const bucketColumns = allBucketColumns.filter(
    (column) => gridTotals.some((totals) => column.pick(totals) !== 0),
  );

  const channelColumnCount = 3 + bucketColumns.length;
  // B is the first channel column. Derived rather than typed so the SUM ranges cannot drift from
  // the headers above them when a bucket column appears or disappears.
  const firstChannelLetter = columnLetter(2);
  const lastChannelLetter = columnLetter(1 + channelColumnCount);
  const totalLetter = columnLetter(2 + channelColumnCount);
  const COLS = channelColumnCount + 3;
  bandHeader(sheet, breakdown.line, breakdown.period, "Channel by Product / Rep / Area / Brick", COLS);

  const scopeNote = breakdown.restrictedProductsIncluded
    ? "Figures INCLUDE the restricted products (Lacto Basic 1 & 2, Satoslim) because this export was taken with them revealed."
    : "Figures EXCLUDE the restricted products (Lacto Basic 1 & 2, Satoslim), which is the default view for every role.";

  // The store city split moved money between the areas of a city BEFORE these grids were written —
  // the same movement the Closing Matrix and Total sheets carry. Said out loud on the three grids
  // it touches, because an area figure here that differs from a pre-split number elsewhere is the
  // first thing a reader will question.
  const splitApplied = breakdown.storeSplit?.applied === true;
  const splitMoved = breakdown.storeSplit?.movedValue ?? 0;
  const splitNote = splitApplied
    ? (splitMoved > 0
      ? `The store city split IS applied to this grid: ${splitMoved.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} EGP `
        + "of wholesaler sell-in was shared evenly across the areas of each store's city before these figures "
        + "were written, exactly as on the Closing Matrix and Total sheets. Both sheets therefore publish the "
        + "same number for the same area."
      : "The store city split is applied to this grid and moved nothing this month — no wholesaler sold in a "
        + "city that has more than one area. These figures and the Closing Matrix's are the same either way.")
    : "WARNING: the store city split was NOT applied to this grid, so its area figures do not match the "
      + "Closing Matrix sheet in this workbook. Do not reconcile the two until this is fixed.";

  // July 2026 only: the owner hand-mapped that month's direct orders to areas and reps, and the
  // Closing Matrix uses that mapping. Said out loud because in every OTHER month a direct order
  // correctly has no area and sits in its own row — a reader who knows that rule needs to be told
  // where the exception applies, and how much money it moved.
  const julyDirectNote = breakdown.julyDirect?.applied
    ? ` July 2026's direct orders are on their mapped AREAS AND REPS here, not in a Direct row: the owner mapped `
      + `${(breakdown.julyDirect.value).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} EGP `
      + "of them on 2026-08-03 and the Closing Matrix places them the same way, so the two sheets agree area by "
      + "area. This is a one-off for this month; in every other month a direct order has no area and keeps its "
      + "own row."
    : "";

  const grids: ReadonlyArray<{ dimension: ChannelBreakdownDimension; first: string; note: string; title: string }> = [
    {
      dimension: "product",
      first: "Product",
      note: "Which products the store and hospital money is actually in. A product sold only through pharmacies "
        + "and one leaning on wholesalers need different conversations, and the value columns alone never show it.",
      title: "1 · Product × Channel",
    },
    {
      dimension: "rep",
      first: "Medical Rep",
      note: "A sale reaches a rep through its area: sales area → canonical area → this line's active REP seat → "
        + "that seat's current occupant. Sales that reach no rep are NOT hidden — an area that is not on the seat "
        + "model, a seat nobody occupies today, and the direct orders (which no seat owns) each get their own row. "
        + "Those rows are the interesting part, not an error to look past. " + splitNote
        + " That is what stops a wholesaler's whole sell-in being credited to the one rep whose area the shop "
        + "stands in." + julyDirectNote,
      title: "2 · Medical Rep × Channel",
    },
    {
      dimension: "area",
      first: "Area",
      note: "Direct orders carry no area on the row at all — they reach the closing from the Direct Orders module "
        + "rather than a distributor invoice line — so they appear as their own named row rather than being spread "
        + "over areas they were never tagged with, or dropped. " + splitNote + julyDirectNote,
      title: "3 · Area × Channel",
    },
    {
      dimension: "brick",
      first: "Brick",
      note: "The finest cut, and the longest grid. Three kinds of row carry no brick and are named as such: direct "
        + "orders, distributor lines whose brick did not map to the master, and — because a wholesaler supplies its "
        + "whole city rather than the street it stands on — the store sales the city split shared out. That last "
        + "row is the brick-side of the same movement the Area grid above shows: once a store's sell-in belongs to "
        + "every area of its city, it belongs to no single brick, including the shop's own.",
      title: "4 · Brick × Channel",
    },
  ];

  let row = 4;
  grids.forEach((grid, index) => {
    const rows = breakdown.byDimension[grid.dimension];
    const totals = gridTotals[BREAKDOWN_DIMENSIONS.indexOf(grid.dimension)] ?? sumBreakdownRows(rows);
    const firstDataRow = row + 2;
    const lastDataRow = firstDataRow + rows.length - 1;

    row = writeTable(sheet, row, {
      columns: [
        // Wide enough for the longest bucket wording ("Store sales shared across the city — no
        // single brick", 52 characters) so no row label is clipped by the number column beside it.
        { label: grid.first, width: 54 },
        { label: "Hospitals", numFmt: VALUE_FMT, right: true, width: 14 },
        { label: "Stores", numFmt: VALUE_FMT, right: true, width: 14 },
        { label: "Pharmacies", numFmt: VALUE_FMT, right: true, width: 14 },
        ...bucketColumns.map((column) => (
          { label: column.label, numFmt: VALUE_FMT, right: true, width: 16 } satisfies TableColumn
        )),
        { dataBar: true, label: "Total", numFmt: VALUE_FMT, right: true, width: 15 },
        { label: "Leader", width: 24 },
      ],
      note: index === 0
        ? `${grid.note} Every grid on this sheet adds up to the SAME month total the Closing Matrix publishes — `
          + "money that reaches no product, rep, area or brick is given a named row rather than dropped, and money "
          + "that reaches no CUSTOMER gets its own column rather than falling into Pharmacies, so the four TOTAL "
          + "rows agree with each other and with block 5 below. The channel columns are values (the channel comes "
          + "from the customer's name, which the hidden Calc sheet does not carry); Total and the TOTAL row are "
          + `live formulas. ${scopeNote}`
        : grid.note,
      rows: rows.map((entry, rowIndex) => {
        const excelRow = firstDataRow + rowIndex;
        const leader = breakdownLeader(entry);
        return [
          resolveBreakdownLabel(grid.dimension, entry, maps),
          entry.hospital,
          entry.store,
          entry.pharmacy,
          ...bucketColumns.map((column) => column.pick(entry)),
          F(`SUM(${firstChannelLetter}${excelRow}:${lastChannelLetter}${excelRow})`, entry.total),
          leaderText(leader ? { distributorName: leader.label, share: leader.share } : null),
        ];
      }),
      title: grid.title,
      totals: rows.length > 0
        ? [
          "TOTAL",
          F(`SUM(B${firstDataRow}:B${lastDataRow})`, totals.hospital),
          F(`SUM(C${firstDataRow}:C${lastDataRow})`, totals.store),
          F(`SUM(D${firstDataRow}:D${lastDataRow})`, totals.pharmacy),
          ...bucketColumns.map((column, bucketIndex) => {
            const letter = columnLetter(5 + bucketIndex);
            return F(`SUM(${letter}${firstDataRow}:${letter}${lastDataRow})`, column.pick(totals));
          }),
          F(`SUM(${totalLetter}${firstDataRow}:${totalLetter}${lastDataRow})`, totals.total),
          null,
        ]
        : undefined,
    });
  });

  // ── Block 5 — Self-check, every grid ───────────────────────────────────────
  //
  // Deliberately NOT "do the four grids agree with each other". They are four cuts of ONE query, so
  // they agree with each other whether or not that query holds the month — which is precisely how a
  // missing 4.36M went unnoticed on CNS. `phx_closing_channel_breakdown` re-adds the month straight
  // from the source tables, with its guards written out a second time rather than reused, and
  // returns it as its own row. That is what these four are measured against.
  const checks = breakdownSelfCheck(breakdown);
  const failed = checks.filter((check) => !check.ok);
  const checkFirstRow = row + 2;
  writeTable(sheet, row, {
    columns: [
      { label: "Grid", width: 54 },
      { label: "Grid TOTAL (EGP)", numFmt: VALUE_FMT, right: true, width: 18 },
      { label: "Source tables (EGP)", numFmt: VALUE_FMT, right: true, width: 18 },
      { label: "Difference", numFmt: VALUE_FMT, right: true, width: 15 },
      { label: "Verdict", width: 44 },
    ],
    note: checks.every((check) => !check.available)
      ? "NOT CHECKED. This database returned no independent month total, so the four grids could only have "
        + "been compared with each other — and four cuts of one query agree with each other whether or not "
        + "that query holds the month. Apply migration 20260806160000 and re-export to get a real check."
      : failed.length > 0
      ? `THIS SHEET IS NOT THE WHOLE MONTH. ${failed.length} of ${checks.length} grids do not tie to the source `
        + "tables. Do not reconcile against these grids until the Verdict column reads OK on every line."
      : "Each grid is checked against the month re-added from source_of_sales_fact_rollup and "
        + "source_of_sales_import_rows inside the RPC, not against the other grids — four cuts of one query "
        + "agree with each other whether or not that query is right. Difference and Verdict are live formulas.",
    rows: checks.map((check, index) => {
      const excelRow = checkFirstRow + index;
      const grid = grids.find((entry) => entry.dimension === check.dimension);
      return [
        `${grid?.title ?? check.dimension} — TOTAL row`,
        check.gridValue,
        check.available ? check.population : null,
        check.available ? F(`B${excelRow}-C${excelRow}`, check.difference) : null,
        check.available
          ? F(
            `IF(ROUND(D${excelRow},2)=0,"OK — whole month present",`
            + `"MISMATCH — "&TEXT(ABS(D${excelRow}),"#,##0.00")&" EGP "&IF(D${excelRow}<0,"MISSING","EXTRA"))`,
            check.ok
              ? "OK — whole month present"
              : `MISMATCH — ${Math.abs(check.difference).toFixed(2)} EGP ${check.difference < 0 ? "MISSING" : "EXTRA"}`,
          )
          // Never an OK it did not earn — see the Channel Comparison sheet's block 6 for why.
          : "NOT CHECKED — no independent total from the database",
      ];
    }),
    title: "5 · Self-check — does each grid hold the whole month?",
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
  // The ranked label is the brick's NAME (its code only where the master has no name).
  row = writeTable(sheet, row, { columns: rankCols("Brick"), rows: keyRank(c.rankings.bricks, ref.brkUnits, ref.brkValue, ref.brkId, false), title: "Top 10 Bricks" });

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
    columns: [{ label: "Brick", width: 24 }, { label: "Area", width: 18 }, { label: "Region", width: 14 }, { label: "Sales (proof)", numFmt: VALUE_FMT, right: true }],
    note: `${c.whiteSpace.zeroSalesBricks.length} of ${c.totalBricks} bricks had no sales.`,
    rows: c.whiteSpace.zeroSalesBricks.map((b) => [b.brickName || b.brickId, b.areaName, b.regionName, F(sumifs(ref.brkValue, [[ref.brkId, b.brickId]]), 0)]),
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
    { label: "Tgt % of Line", numFmt: PCT_FMT, right: true, width: 13 },
    { label: "Ach %", numFmt: PCT_FMT, right: true },
  ];
  bandHeader(sheet, matrix.line, matrix.period, "Target vs Achievement", columns.length);

  // writeTable puts the title on `startRow`, the header on the next row, and the first data row
  // two below — so the achievement formula can reference its own row deterministically.
  const START_ROW = 4;
  const FIRST_DATA_ROW = START_ROW + 2;
  const SALES_VALUE_COL = columnLetter(5);
  const TARGET_VALUE_COL = columnLetter(6);

  // The grand-total row index, known BEFORE building the rows (areas + one REGION TOTAL per
  // region), because every "Tgt % of Line" cell divides by the grand total's target on that row.
  const dataRowCount = matrix.regions.reduce((count, region) => count + region.areas.length + 1, 0);
  const grandRow = FIRST_DATA_ROW + dataRowCount;
  const grandTargetValue = matrix.grandTotal.rowTotal.targetValue;
  // Live share of the line's total target. Blank-guarded on the ROW's own target first: in Excel
  // a blank cell divided by a number is 0, which would print a fake "0.0%" for an area that
  // simply has no target — and a blank target on this sheet must never read as a zero.
  const contributionCell = (excelRow: number, targetValue: number | null): CellValue =>
    F(
      `IFERROR(IF(${TARGET_VALUE_COL}${excelRow}="","",${TARGET_VALUE_COL}${excelRow}/$${TARGET_VALUE_COL}$${grandRow}),"")`,
      targetValue !== null && grandTargetValue ? targetValue / grandTargetValue : 0,
    );

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
      contributionCell(excelRow, cell.targetValue),
      // Live division, blank when there is no target to divide by.
      F(
        `IFERROR(${SALES_VALUE_COL}${excelRow}/${TARGET_VALUE_COL}${excelRow},"")`,
        cell.achievement ?? 0,
      ),
    ]);
  };

  matrix.regions.forEach((region) => {
    region.areas.forEach((area) => {
      // Synthetic pseudo-area only. A real area that absorbed July's direct money keeps its own
      // name here exactly as it does on the Closing Matrix sheet — the raw `isDirect` flag is true
      // for both, and reading it renamed Dakahlia 1 to "Direct orders (company)" on this sheet.
      push(region.regionName, isSyntheticDirectArea(area) ? "Direct orders (company)" : area.areaName, area.rowTotal);
    });
    push(region.regionName, `${region.regionName} — REGION TOTAL`, region.subtotal.rowTotal);
  });

  const totals: CellValue[] = [
    "NATIONAL",
    "Grand Total",
    matrix.grandTotal.rowTotal.salesUnits,
    matrix.grandTotal.rowTotal.targetUnits,
    matrix.grandTotal.rowTotal.salesValue,
    matrix.grandTotal.rowTotal.targetValue,
    // The line total's share of itself: 100% whenever any target exists, blank otherwise.
    contributionCell(grandRow, grandTargetValue),
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
        "if a figure is edited. Tgt % of Line is the row's target share of the line's total target " +
        "(REGION TOTAL rows show the whole region's share). A blank target means no target was " +
        "uploaded for that area and product — it is NOT a target of zero, and no achievement or " +
        "share is claimed against it. Region totals divide summed sales by summed targets; they " +
        "are never the average of the area percentages."
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
    note: "Values in EGP · live formulas referencing the hidden Data sheet · recomputed as Qty × factory price · single month (month-over-month N/A until more months are uploaded).",
    rows: c.insights.map((b) => [b.category, b.text]),
    title: "Key Insights",
  });
}

// ── July-2026 direct orders — a deliberate ONE-OFF ───────────────────────────
/**
 * July 2026 is the only month whose direct orders were mapped to areas by hand.
 *
 * The Direct Order module went live in AUGUST, so from 2026-08 approved orders arrive already
 * carrying their own area. July predates that: its 46 sheet rows reached Source of Sales with a
 * region but a blank area, which is why the closing has only ever shown them lumped per region.
 * The owner had them mapped once, by hand, and asked for the result as its own tab.
 *
 * Deliberately a hard-coded snapshot rather than a lookup table:
 *   * it describes ONE closed month whose numbers can no longer move, so there is nothing to keep
 *     in sync — a table would invite edits to a month that is already reported;
 *   * it is inert for every other period (see the period guard at the call site), so it cannot
 *     alter August or anything after it;
 *   * nothing else in the system reads it, so it cannot shift a number on any existing sheet.
 *
 * Units and value are written EXACTLY as submitted and are NEVER recomputed as qty × factory
 * price. Direct deals carry negotiated bonus/discount pricing, so value deliberately does not
 * equal qty × price — recomputing July at factory price would have inflated it by 31,837.35 EGP.
 *
 * The three rows with no area are the National Sales Manager's own direct orders; the owner ruled
 * they are not distributed to any area, so they print as their own band immediately above the
 * total and are counted only in that total.
 */
export function selectJulyDirectRowsForScope(
  matrix: Pick<MonthlyClosingMatrix, "line" | "regions">,
): readonly JulyDirectRow[] {
  // A null line means the workbook is not scoped to one line, so every July direct row belongs in
  // it. Filtering on a null line would silently produce an empty tab instead of the whole month.
  const wanted = (matrix.line ?? "").trim().toLowerCase();
  const forLine = wanted
    ? JULY_2026_DIRECT_ROWS.filter((row) => row.line.trim().toLowerCase() === wanted)
    : JULY_2026_DIRECT_ROWS;

  // FOLLOW THE FILTER. The matrix reaching the builder has already been narrowed by the reader's
  // on-screen region/area/search filter, so its surviving areas ARE the slice this workbook
  // covers. Scoping to them — rather than re-applying the raw filter here — is what guarantees
  // this tab can never list an area the Closing Matrix dropped. (It previously scoped by line
  // only, so a Giza-filtered export still listed Mahalla, Qena, Dakahlia and Sohag.)
  const keptAreas = new Set(
    matrix.regions.flatMap((region) => region.areas.map((area) => (area.areaCode ?? "").trim().toUpperCase())),
  );
  const keptRegions = new Set(matrix.regions.map((region) => (region.regionCode ?? "").trim().toUpperCase()));

  return forLine.filter((row) => {
    const areaCode = (row.areaCode ?? "").trim().toUpperCase();
    // The National Sales Manager's own orders carry no AREA, but they DO belong to a region —
    // Others — by the owner's ruling. So they are scoped by REGION: they appear under an Others
    // filter and under no filter, and never under a Giza or Delta one.
    if (!areaCode) return keptRegions.has((row.regionCode ?? "").trim().toUpperCase());
    return keptAreas.has(areaCode);
  });
}

/**
 * The region the Closing Matrix shows an area under, for a sheet that lists rows the matrix already
 * placed: July's hand-mapped direct orders. Their table was keyed on the map region, so on Anti
 * Infective it said Upper Egypt for areas the matrix files under Upper Egypt 1 and 2 (owner,
 * 2026-09-16: every sheet names the matrix's region). A row with no area, or an area the matrix does
 * not carry, keeps its own region, named from the matrix where the matrix has it.
 */
function matrixRegionForArea(
  matrix: Pick<MonthlyClosingMatrix, "regions">,
): (areaCode: string, fallbackRegionCode: string) => { regionCode: string; regionName: string } {
  const byArea = new Map<string, { regionCode: string; regionName: string }>();
  const nameByRegion = new Map<string, string>();
  matrix.regions.forEach((region) => {
    nameByRegion.set(normalizeCode(region.regionCode), region.regionName);
    region.areas.forEach((area) => {
      if (isSyntheticDirectArea(area)) return;
      const key = normalizeCode(area.areaCode);
      if (key && !byArea.has(key)) byArea.set(key, { regionCode: region.regionCode, regionName: region.regionName });
    });
  });
  return (areaCode, fallbackRegionCode) => {
    const placed = byArea.get(normalizeCode(areaCode));
    if (placed) return placed;
    return {
      regionCode: fallbackRegionCode,
      regionName: nameByRegion.get(normalizeCode(fallbackRegionCode)) ?? fallbackRegionCode,
    };
  };
}

function writeJulyDirectSheet(workbook: ExcelJS.Workbook, matrix: MonthlyClosingMatrix): void {
  const period = matrix.period;
  const rows = selectJulyDirectRowsForScope(matrix);
  if (rows.length === 0) return;
  const line = matrix.line;
  const regionOf = matrixRegionForArea(matrix);

  const sheet = workbook.addWorksheet(sanitizeSheetName("Direct Orders (July)"), {
    views: [{ state: "frozen", ySplit: 5 }],
  });
  const columns: TableColumn[] = [
    { label: "Region", width: 14 },
    { label: "Area", width: 26 },
    { label: "Medical Rep", width: 34 },
    { label: "Pharmacy", width: 40 },
    { label: "Product", width: 26 },
    { label: "Units", numFmt: UNITS_FMT, right: true },
    { dataBar: true, label: "Value (as submitted)", numFmt: VALUE_FMT, right: true, width: 20 },
  ];
  bandHeader(sheet, line, period, "Direct Orders — as submitted", columns.length);

  // Areas first (sorted so a region's rows sit together), then the area-less rows last so they
  // land immediately above the total exactly as the owner asked.
  const withArea = rows.filter((row) => row.areaCode);
  const withoutArea = rows.filter((row) => !row.areaCode);
  const ordered = [
    ...withArea.sort((a, b) =>
      regionOf(a.areaCode, a.regionCode).regionCode.localeCompare(regionOf(b.areaCode, b.regionCode).regionCode) ||
      a.areaCode.localeCompare(b.areaCode) ||
      a.pharmacy.localeCompare(b.pharmacy)),
    ...withoutArea,
  ];

  const body: CellValue[][] = ordered.map((row) => [
    regionOf(row.areaCode, row.regionCode).regionName,
    row.areaName || row.areaCode,
    row.repName || "—",
    row.pharmacy,
    row.product,
    row.qty,
    row.value,
  ]);

  const totalUnits = rows.reduce((sum, row) => sum + row.qty, 0);
  const totalValue = Math.round(rows.reduce((sum, row) => sum + row.value, 0) * 100) / 100;
  body.push(["", "TOTAL DIRECT", "", "", "", totalUnits, totalValue]);

  writeTable(sheet, 4, {
    columns,
    note:
      "July 2026 only. Units and value are exactly as submitted on the direct-order sheet — never recomputed as units × factory price, because direct deals carry their own negotiated bonus and discount. Rows showing no area are the National Sales Manager's own direct orders, counted in the total but not attributed to any area.",
    rows: body,
    title: "Direct orders mapped to areas",
  });
}

/**
 * Store Split — the wholesaler redistribution, shown rather than folded in.
 *
 * A STORE (wholesaler / warehouse / trading company, identified by name — see
 * src/lib/sales/customer-channel.ts) supplies a whole city, not just the area it stands in. So its
 * sell-in is divided evenly across the AREAS of that city and each area's share reaches whoever
 * holds that area's line seat. This sheet is the audit of that move: for every area and line it
 * shows what the area books today, what its own stores sent out to the city, what it received
 * back, and where it lands.
 *
 * It is a SEPARATE sheet on purpose. The owner chose to see the split beside the normal numbers
 * rather than have it disappear into the headline, so the Closing Matrix opposite is untouched and
 * a reader can always see exactly why a rep's number moved. `Net` sums to zero across the areas of
 * any city — the split moves money between areas, it never creates or destroys any.
 */
/**
 * Store Split Detail — which SHOP caused a moved number, on which product, and who received it.
 *
 * The Store Split sheet answers "what did this area gain or lose". By the time it is built every
 * store of a city has been folded together, so it cannot answer the question a reader actually asks
 * of a number that moved: which wholesaler is this, what did they buy, and where did it go. This
 * sheet keeps the store's own identity — code, name, its own area, its city — all the way through
 * (owner request, 2026-08-05).
 *
 * Two sections: one row per store (the headline "which stores are split"), then one row per store
 * AND product with the units, the value, how many areas it was divided across and what each area
 * received. Both are derived from the same eligibility rule the split itself uses, so this sheet
 * can never claim a split that did not happen, nor miss one that did.
 */
function writeStoreSplitDetailSheet(
  workbook: ExcelJS.Workbook,
  line: string | null,
  period: string | null,
  stores: StoreSplitCustomerSummary[],
  details: StoreSplitDetailRow[],
  frozen = false,
  // Area code -> area name, from the matrix. Geography is shown by NAME on every sheet (owner,
  // 2026-10-26: "in bricks and areas and overall never use code always use name").
  areaNames: ReadonlyMap<string, string> = new Map(),
) {
  const areaName = (code: string) => areaNames.get(code.trim().toUpperCase()) || code;
  const sheet = workbook.addWorksheet(sanitizeSheetName("Store Split Detail"), {
    views: [{ state: "frozen", ySplit: 5 }],
  });
  // A published month is frozen, but this per-store detail cannot be (the frozen table keeps no
  // customer grain), so it stays a LIVE recompute for explanation. Name the authoritative number so
  // the live per-store shares here are never mistaken for the published figure.
  const frozenBanner = frozen
    ? "This month is PUBLISHED and frozen. The Closing Matrix, Total sheet and Store Split summary show the "
      + "frozen announced numbers; this per-store detail is recomputed from current data for explanation and its "
      + "totals may differ slightly. The frozen Matrix is the published figure. "
    : "";
  const columns: TableColumn[] = [
    { label: "Customer Code", width: 15 },
    { label: "Store (wholesaler)", width: 38 },
    { label: "Its own area", width: 24 },
    { label: "City", width: 18 },
    { label: "Line", width: 16 },
    { label: "Products split", numFmt: UNITS_FMT, right: true, width: 13 },
    { label: "Units", numFmt: UNITS_FMT, right: true },
    { dataBar: true, label: "Value (EGP)", numFmt: VALUE_FMT, right: true, width: 17 },
    { label: "Shared across areas", numFmt: UNITS_FMT, right: true, width: 16 },
  ];
  bandHeader(sheet, line, period, "Store Split Detail — every store that was split, and what it sent out", columns.length);

  const storeValue = stores.reduce((sum, entry) => sum + entry.value, 0);
  const storeUnits = stores.reduce((sum, entry) => sum + entry.units, 0);
  const row = writeTable(sheet, 4, {
    columns,
    note: stores.length === 0
      ? frozenBanner + "No store customers in this line and month — nothing was split, so there is nothing to detail."
      : frozenBanner
        + `${stores.length} stores were split. "Its own area" is where the shop physically sits — the area that `
        + "booked the sale before the split; the value is then divided evenly across every area of its city. "
        + "Pharmacies are never split, and neither is the Head Office line.",
    rows: stores.map((entry) => [
      entry.clientCode,
      entry.clientName,
      entry.originAreaName || areaName(entry.originAreaCode),
      entry.city,
      entry.line,
      entry.products,
      entry.units,
      entry.value,
      entry.areasSharedWith,
    ]),
    title: "Stores that were split",
    totals: stores.length === 0
      ? undefined
      : ["", "TOTAL — all stores", "", "", "", stores.length, Number(storeUnits.toFixed(2)), Number(storeValue.toFixed(2)), ""],
  });

  const detailColumns: TableColumn[] = [
    { label: "Customer Code", width: 15 },
    { label: "Store (wholesaler)", width: 38 },
    { label: "Its own area", width: 24 },
    { label: "City", width: 18 },
    { label: "Line", width: 16 },
    { label: "Product Code", width: 13 },
    { label: "Product", width: 26 },
    { label: "Units", numFmt: UNITS_FMT, right: true },
    { dataBar: true, label: "Value (EGP)", numFmt: VALUE_FMT, right: true, width: 17 },
    { label: "Areas", numFmt: UNITS_FMT, right: true, width: 9 },
    { label: "Units per area", numFmt: VALUE_FMT, right: true, width: 14 },
    { label: "Value per area", numFmt: VALUE_FMT, right: true, width: 16 },
    { label: "Shared with", width: 46 },
  ];
  const detailUnits = details.reduce((sum, entry) => sum + entry.units, 0);
  const detailValue = details.reduce((sum, entry) => sum + entry.value, 0);
  writeTable(sheet, row, {
    columns: detailColumns,
    note: details.length === 0
      ? "Nothing to detail."
      : "One row per store and product. \"Value per area\" is what EACH area of the city receives, including "
        + "the store's own area — it keeps one share, not the whole sale. The shares add back to the value on "
        + "the same row, so nothing is created or lost; the last share carries any rounding remainder.",
    rows: details.map((entry) => [
      entry.clientCode,
      entry.clientName,
      entry.originAreaName || areaName(entry.originAreaCode),
      entry.city,
      entry.line,
      entry.productCode,
      entry.productName,
      entry.units,
      entry.value,
      entry.sharedWithAreaCodes.length,
      entry.shareUnits,
      entry.shareValue,
      entry.sharedWithAreaCodes.map(areaName).join(", "),
    ]),
    title: "Store × product — what moved, and each area's share",
    totals: details.length === 0
      ? undefined
      : ["", "TOTAL", "", "", "", "", "", Number(detailUnits.toFixed(2)), Number(detailValue.toFixed(2)), "", "", "", ""],
  });
}

/** Area code -> area name: the matrix first, then the rows, for an area that carries no grid row. */
function matrixAreaNames(
  matrix: { regions: readonly { areas: readonly { areaCode: string; areaName: string }[] }[] },
  rows: readonly { areaCode?: string | null; areaName?: string | null }[] = [],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const region of matrix.regions) {
    for (const area of region.areas) {
      const code = String(area.areaCode ?? "").trim().toUpperCase();
      if (code && area.areaName && !names.has(code)) names.set(code, area.areaName);
    }
  }
  for (const row of rows) {
    const code = String(row.areaCode ?? "").trim().toUpperCase();
    const name = String(row.areaName ?? "").trim();
    if (code && name && !names.has(code)) names.set(code, name);
  }
  return names;
}

/**
 * Blank the customer on split entries the viewer may not see the source of.
 *
 * Structural rather than typed to one shape, because the summary and the detail rows are different
 * types that happen to share the two fields this touches.
 */
function maskSplitEntries<T extends { clientCode: string; clientName: string }>(
  entries: readonly T[],
  masked: ReadonlySet<string> | undefined,
): T[] {
  if (!masked || masked.size === 0) return [...entries];
  return entries.map((entry) => (
    masked.has(String(entry.clientCode ?? "").trim())
      ? { ...entry, clientCode: "", clientName: "" }
      : entry
  ));
}

function writeStoreSplitSheet(
  workbook: ExcelJS.Workbook,
  line: string | null,
  period: string | null,
  summary: StoreSplitAreaSummary[],
  // The areas this workbook actually covers. Empty means the whole month is on show. When a place
  // filter IS active the summary deliberately still lists every area of every affected city — that
  // is the only way a reader who filtered to one area can see where the rest of its city's share
  // went — so each row is marked with whether it is inside the export.
  scopeAreaCodes: readonly string[] = [],
) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Store Split"), { views: [{ state: "frozen", ySplit: 5 }] });

  const totalOut = summary.reduce((sum, entry) => sum + entry.movedOutValue, 0);
  const cities = new Set(summary.map((entry) => entry.city)).size;
  const scoped = scopeAreaCodes.length > 0
    ? new Set(scopeAreaCodes.map((code) => code.trim().toUpperCase()))
    : null;
  const inExport = (entry: StoreSplitAreaSummary) => !scoped || scoped.has(entry.areaCode.trim().toUpperCase());
  // What crosses the filter's edge, from the areas' own point of view. Matches the Total sheet's
  // store-split reconciliation line, which is derived independently from the matrix.
  const crossing = summary.reduce((sum, entry) => (inExport(entry) ? sum + entry.netValue : sum), 0);
  const egp = (value: number) => Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 0 });

  // The split is not applied to every month: it starts at August 2026 (owner, 2026-09-04 — July
  // stays as published). This sheet has ALWAYS shown the arithmetic whether or not it was applied,
  // which was harmless while the rule was off everywhere and is a trap now that it is on for some
  // months and not others — a reader opening July would see movements the Closing Matrix does not
  // carry and reasonably conclude July was re-split. Say so on the sheet instead.
  const periodNote = isStoreCitySplitActive(period)
    ? ""
    : " NOT APPLIED to this period: the figures below are what the split WOULD move, shown for"
      + " reference only. The Closing Matrix in this workbook is unsplit — every area carries its"
      + " own wholesalers in full.";

  const scopeNote = !scoped
    ? ""
    : crossing === 0
      ? " This export is filtered, and no store sales cross its edge."
      : crossing < 0
        ? ` This export is filtered: ${egp(crossing)} EGP of its areas' store sales belongs to city areas`
          + " outside the filter, and is listed below as a row marked \"No\"."
        : ` This export is filtered: its areas received ${egp(crossing)} EGP from stores in city areas`
          + " outside the filter, listed below as rows marked \"No\".";

  // Built before the band header so the header spans EXACTLY the table's width. The count is not a
  // constant any more — the "In this export" column only exists on a filtered export — and the
  // hardcoded 11 it replaces was already one wider than the 10 columns of an unfiltered sheet,
  // which painted the black title band a column past the data.
  const columns: TableColumn[] = [
    { label: "Area", width: 24 },
    { label: "City", width: 20 },
    { label: "Line", width: 16 },
    ...(scoped ? [{ label: "In this export", width: 14 } satisfies TableColumn] : []),
    { label: "Sales now", numFmt: VALUE_FMT, right: true },
    { label: "Store sales sent out", numFmt: VALUE_FMT, right: true },
    { label: "City share received", numFmt: VALUE_FMT, right: true },
    { label: "Net store split", numFmt: VALUE_FMT, right: true },
    { label: "Sales after split", numFmt: VALUE_FMT, right: true },
    { label: "Units net", numFmt: UNITS_FMT, right: true },
  ];
  bandHeader(sheet, line, period, "Store Split — wholesaler sales shared across each city's areas", columns.length);

  writeTable(sheet, 4, {
    columns,
    note: summary.length === 0
      ? "No store customers in this period — nothing to redistribute." + periodNote
      : `${totalOut.toLocaleString("en-US", { maximumFractionDigits: 0 })} EGP of store sales redistributed across ${cities} cities. `
        + "Net sums to zero within every city: the split moves money between areas, never creates it. "
        + "Head Office line and pharmacy customers are not touched."
        + periodNote
        + scopeNote,
    rows: summary.map((entry) => [
      entry.areaName || entry.areaCode,
      entry.city,
      entry.line,
      ...(scoped ? [inExport(entry) ? "Yes" : "No"] : []),
      entry.beforeValue,
      entry.movedOutValue,
      entry.receivedValue,
      entry.netValue,
      entry.afterValue,
      entry.netQty,
    ]),
    title: "Store sales redistributed by city",
  });
}

// ── Source Coverage — is this month complete? ────────────────────────────────

function formatCairoTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "numeric", hour: "2-digit", hour12: false, minute: "2-digit", month: "short",
    timeZone: "Africa/Cairo", year: "numeric",
  }).format(date)} Cairo time`;
}

/**
 * The completeness sheet. July 2026 was reported on 4 of June's ~18 source files and nothing in
 * the workbook said so — every tab showed composition, none showed coverage. This sheet is the
 * fix: what is still absent (with its last-month size), the Direct channel per region (a month
 * can carry the Direct file yet miss half its regions), then every source side by side.
 *
 * It always describes the WHOLE month for the line, whatever filter the other sheets carry, so a
 * filtered export still says whether the month itself is complete. Static cached values on
 * purpose: coverage has no Calc block to SUMIFS from, and a static number that is right beats a
 * live formula pointing at data that is not there.
 */
function writeSourceCoverageSheet(workbook: ExcelJS.Workbook, coverage: MonthlySourceCoverage) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Source Coverage"));
  bandHeader(sheet, coverage.line, coverage.period, "Source Coverage — is this month complete?", 6);
  let row = 4;

  if (!coverage.hasPrevData) {
    writeTable(sheet, row, {
      columns: [{ label: "Note", width: 96 }],
      rows: [[
        `${coverage.prevPeriod} has no validated data, so there is nothing to compare ${coverage.period} against. ` +
        "This sheet starts working from the second month with data.",
      ]],
      title: "First month with data",
    });
    return;
  }

  // A source the owner has declared quiet is absent, but it is not OWED — so it must not read
  // MISSING on the one sheet whose job is "is this month complete?" (owner, 2026-10-09). Membership
  // is taken from `quietSources` rather than re-derived, so a masked distributor is matched by the
  // same relabelled key on both sides and cannot leak its real name through this label.
  const quiet = coverage.quietSources ?? [];
  const quietKeys = new Set(quiet.map((entry) => entry.key));
  const statusLabel = (entry: SourceCoverageEntry) =>
    quietKeys.has(entry.key) && entry.status === "missing"
      ? `Not filing in ${coverage.period}`
      : entry.status === "missing"
        ? `MISSING in ${coverage.period}`
        : entry.status === "new"
          ? `New in ${coverage.period}`
          : "Present in both";

  const missing = coverage.missingSources;
  // "Every source that fed last month has also fed this one" would be FALSE on a month whose only
  // absences are declared ones — the sentence has to name them, or the sheet contradicts its own
  // table two rows below.
  const quietNames = quiet.map((entry) => entry.name).join(", ");
  const allPresentNote =
    quiet.length === 0
      ? `Every source that fed ${coverage.prevPeriod} has also fed ${coverage.period}.`
      : `Every source that fed ${coverage.prevPeriod} has also fed ${coverage.period}, except `
        + `${quietNames}, which ${quiet.length === 1 ? "files" : "file"} nothing in ${coverage.period} `
        + "by the owner's instruction. Nothing is owed.";
  row = writeTable(sheet, row, {
    columns: [
      { label: "Source", width: 26 },
      { label: `${coverage.prevPeriod} Units`, numFmt: UNITS_FMT, right: true, width: 15 },
      { dataBar: true, label: `${coverage.prevPeriod} Value (EGP)`, numFmt: VALUE_FMT, right: true, width: 19 },
    ],
    note: missing.length === 0
      ? allPresentNote
      : `These fed ${coverage.prevPeriod} and have contributed nothing to ${coverage.period} yet. Until each ` +
        "arrives — or is confirmed as having no business this month — every total in this workbook is understated.",
    rows: missing.length === 0
      ? [[quiet.length === 0
          ? "None — all of last month's sources are present"
          : `None owed — ${quietNames} ${quiet.length === 1 ? "is" : "are"} not filing this month`, null, null]]
      : missing.map((entry) => [entry.name, entry.prevUnits, entry.prevValue]),
    title: `Missing in ${coverage.period} — fed ${coverage.prevPeriod}, nothing yet this month`,
    totals: missing.length === 0 ? undefined : [
      "TOTAL last month",
      missing.reduce((sum, entry) => sum + entry.prevUnits, 0),
      coverage.missingPrevValue,
    ],
  });

  if (coverage.directRegions.length > 0) {
    row = writeTable(sheet, row, {
      columns: [
        { label: "Direct — Region", width: 26 },
        { label: `${coverage.prevPeriod} Units`, numFmt: UNITS_FMT, right: true, width: 15 },
        { label: `${coverage.prevPeriod} Value`, numFmt: VALUE_FMT, right: true, width: 17 },
        { label: `${coverage.period} Units`, numFmt: UNITS_FMT, right: true, width: 15 },
        { label: `${coverage.period} Value`, numFmt: VALUE_FMT, right: true, width: 17 },
        { label: "Status", width: 22 },
      ],
      note: "The Direct channel arrives as one sheet covering many regions, so a month can carry the file yet miss half its regions — July 2026 carried 3 of 8 for Anti Infective. Rows here are the Direct channel only.",
      rows: coverage.directRegions.map((entry) => [
        entry.name, entry.prevUnits, entry.prevValue, entry.curUnits, entry.curValue, statusLabel(entry),
      ]),
      title: "Direct channel by region",
    });
  }

  const asOf = formatCairoTimestamp(coverage.latestUploadAt);
  writeTable(sheet, row, {
    columns: [
      { label: "Source", width: 26 },
      { label: `${coverage.prevPeriod} Units`, numFmt: UNITS_FMT, right: true, width: 15 },
      { label: `${coverage.prevPeriod} Value`, numFmt: VALUE_FMT, right: true, width: 17 },
      { label: `${coverage.period} Units`, numFmt: UNITS_FMT, right: true, width: 15 },
      { label: `${coverage.period} Value`, numFmt: VALUE_FMT, right: true, width: 17 },
      { label: "Status", width: 22 },
    ],
    note:
      `${asOf ? `Last upload for ${coverage.period}: ${asOf}. ` : ""}` +
      "Presence is decided on rows, not value — a source with only credit notes still counts as present. " +
      "Values follow the closing's own basis (Direct at submitted value, distributor rows at units × factory price, confidential products excluded), so these columns tie to the Closing Matrix.",
    rows: coverage.sources.map((entry) => [
      entry.name, entry.prevUnits, entry.prevValue, entry.curUnits, entry.curValue, statusLabel(entry),
    ]),
    title: `Every source — ${coverage.period} vs ${coverage.prevPeriod}`,
  });
}

// ── Channel tabs — retail on its own, direct on its own ──────────────────────
/**
 * The Closing Matrix is the MASTER: retail + direct in one grid. That is the right headline and it
 * also makes the two businesses impossible to read apart — a rep's area row mixes distributor
 * sell-out with negotiated direct deals. The owner asked (2026-08-05) for each channel on its own
 * tab beside the master.
 *
 * Both sheets are STATIC values, deliberately. The hidden Calc sheet holds distributor invoice
 * lines with no channel dimension and no store-split write-back, so a live SUMIFS would quietly
 * disagree with the master the first time Excel recalculated — the exact failure the store-split
 * fix had to undo.
 *
 * Neither sheet carries targets or achievement. A target is set per area and product for the whole
 * business, not per channel, so dividing retail-only sales by a whole-business target would
 * manufacture a shortfall that does not exist. Achievement lives on the master and on Target vs
 * Achievement, where the denominator is honest. Same rule the filtered export already follows.
 */
function channelTotals(cells: MonthlyClosingCell[]): { units: number; value: number } {
  return {
    units: cells.reduce((sum, cell) => sum + cell.salesUnits, 0),
    value: cells.reduce((sum, cell) => sum + cell.salesValue, 0),
  };
}

/** Header + per-product Units/Value columns shared by both channel sheets. */
function channelColumns(products: MonthlyClosingColumn[], firstLabel: string, secondLabel: string | null): TableColumn[] {
  return [
    // One label column when the row has only one name to show (the Direct tab's region).
    ...(secondLabel === null
      ? [{ label: firstLabel, width: 30 } satisfies TableColumn]
      : [{ label: firstLabel, width: 20 } satisfies TableColumn, { label: secondLabel, width: 26 } satisfies TableColumn]),
    ...products.flatMap((product): TableColumn[] => [
      { label: `${product.productName} — Units`, numFmt: UNITS_FMT, right: true, width: 14 },
      { label: `${product.productName} — Value`, numFmt: VALUE_FMT, right: true, width: 16 },
    ]),
    { label: "Total Units", numFmt: UNITS_FMT, right: true, width: 13 },
    { dataBar: true, label: "Total Value", numFmt: VALUE_FMT, right: true, width: 17 },
    { label: "Target Value", numFmt: VALUE_FMT, right: true, width: 16 },
    { label: "Ach % of Target", numFmt: PCT_FMT, right: true, width: 15 },
    { label: "Contr% of Channel", numFmt: PCT_FMT, right: true, width: 15 },
  ];
}

/**
 * One data row: per-product pairs, the row total, then the achievement pair and the contribution.
 *
 * ACHIEVEMENT ON A CHANNEL TAB IS DELIBERATE AND IT ADDS UP (owner, 2026-08-05). A target is set
 * per area and product for the whole business, so BOTH channel tabs divide by that SAME target.
 * The consequence is the useful one: retail Ach% + direct Ach% = the master's Ach%, exactly as
 * their values add to the master's value. Read a channel's Ach% as "how much of the month's target
 * this channel delivered on its own", never as that channel missing a target of its own — it has
 * none. A row with no target stays blank rather than printing a fabricated 0%.
 */
function channelRow(
  firstCell: string,
  secondCell: string | null,
  cells: MonthlyClosingCell[],
  channelValue: number,
  targetValue: number | null,
): CellValue[] {
  const totals = channelTotals(cells);
  return [
    firstCell,
    ...(secondCell === null ? [] : [secondCell]),
    ...cells.flatMap((cell): CellValue[] => [cell.salesUnits, cell.salesValue]),
    totals.units,
    totals.value,
    targetValue,
    targetValue === null || targetValue === 0 ? null : totals.value / targetValue,
    channelValue === 0 ? null : totals.value / channelValue,
  ];
}

/**
 * Premium finish on the Achievement column — the same amber the master uses for Ach %, plus a
 * red→amber→green scale so a reader sees the shape of the month before reading a single number.
 * Applied after writeTable, which owns the grid; the colour scale is best-effort like the data
 * bars, because a decoration must never be able to fail an export.
 */
function styleAchievementColumn(
  sheet: ExcelJS.Worksheet,
  columnIndex: number,
  firstDataRow: number,
  /**
   * INCLUSIVE, and callers pass the TOTALS row on purpose — the channel's own achievement is the
   * number a reader looks for first, so it carries the same amber and the same colour scale as the
   * rows above it rather than being the one cell left unstyled. writeTable has already written that
   * row; this deliberately restyles its achievement cell only.
   */
  lastRow: number,
) {
  if (lastRow < firstDataRow) return;
  const letter = columnLetter(columnIndex);
  for (let row = firstDataRow; row <= lastRow; row += 1) {
    const cell = sheet.getCell(row, columnIndex);
    cell.fill = { fgColor: { argb: ACH_ORANGE }, pattern: "solid", type: "pattern" };
    cell.font = { bold: true, color: { argb: BLACK }, name: "Calibri", size: 10.5 };
    cell.alignment = { horizontal: "right", vertical: "middle" };
    cell.numFmt = PCT_FMT;
  }
  try {
    sheet.addConditionalFormatting({
      ref: `${letter}${firstDataRow}:${letter}${lastRow}`,
      rules: [{
        cfvo: [{ type: "num", value: 0 }, { type: "num", value: 0.5 }, { type: "num", value: 1 }],
        color: [{ argb: "FFF8B4B4" }, { argb: "FFFDE7C7" }, { argb: "FFB7E4C7" }],
        priority: 2,
        type: "colorScale",
      }],
    });
  } catch {
    // A colour scale is presentation only — never fail an export over it.
  }
}

/** The tie every channel sheet states in its own words: retail + direct = the master. */
function channelReconciliation(
  sheet: ExcelJS.Worksheet,
  row: number,
  thisLabel: string,
  thisValue: number,
  otherLabel: string,
  otherValue: number,
  masterValue: number,
) {
  // On a FILTERED export the master can still carry direct money the filter excluded from this
  // sheet — July's area-less orders live in the master's "Direct – National" row, which
  // filterMonthlyClosingMatrix deliberately carries through. Naming that remainder is what keeps
  // the Difference at zero instead of leaving the reader an unexplained gap.
  const outside = Number((masterValue - thisValue - otherValue).toFixed(2));
  const outsideRows: CellValue[][] = Math.abs(outside) < 0.005
    ? []
    : [[
      "Direct outside this filter, still counted in the master",
      outside,
      "Orders the master carries that belong to no area on show — mostly the National row.",
    ]];
  writeTable(sheet, row, {
    columns: [
      { label: "Reconciliation", width: 44 },
      { label: "Value (EGP)", numFmt: VALUE_FMT, right: true, width: 18 },
      { label: "Note", width: 60 },
    ],
    note:
      "The two channel tabs add up to the Closing Matrix exactly — the master is not a third number, " +
      "it is these two together.",
    rows: [
      [thisLabel, thisValue, "This sheet."],
      [otherLabel, otherValue, "The other channel tab."],
      ...outsideRows,
      [
        "Closing Matrix (master, total sales)",
        masterValue,
        "Retail + Direct. A difference of zero below proves the split loses nothing.",
      ],
      [
        "Difference",
        Number((thisValue + otherValue + outside - masterValue).toFixed(2)),
        "Zero means every EGP on the master is on exactly one of the two channel tabs.",
      ],
    ],
    title: "Does this tie to the master?",
  });
}

function writeRetailChannelSheet(
  workbook: ExcelJS.Workbook,
  retail: MonthlyClosingMatrix,
  directValue: number,
  masterValue: number,
) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Retail Sales (no direct)"), {
    views: [{ state: "frozen", xSplit: 2, ySplit: 5 }],
  });
  const products = retail.columns;
  const columns = channelColumns(products, "Region", "Area");
  bandHeader(sheet, retail.line, retail.period, "Retail Sales only — distributor sell-out, direct orders excluded", columns.length);

  const channel = channelTotals(retail.grandTotal.cells);
  const rows: CellValue[][] = [];
  retail.regions.forEach((region) => {
    region.areas
      // A synthetic "Direct" row cannot exist on the retail matrix (it is pre-injection), but the
      // guard keeps this sheet honest if the caller ever passes an already-injected matrix. It must
      // drop ONLY that pseudo-area: a real area carrying direct is a retail area like any other and
      // dropping it would delete its rows from the sheet.
      .filter((area) => !isSyntheticDirectArea(area))
      .forEach((area) => {
        rows.push(channelRow(region.regionName, area.areaName, area.cells, channel.value, area.rowTotal.targetValue));
      });
    rows.push(channelRow(
      region.regionName,
      `${region.regionName} — REGION TOTAL`,
      region.subtotal.cells,
      channel.value,
      region.subtotal.rowTotal.targetValue,
    ));
  });

  const firstDataRow = 6; // title on 4, header on 5
  const row = writeTable(sheet, 4, {
    columns,
    note:
      "Distributor invoice rows only — every direct order is on the \"Direct Sales\" tab instead. " +
      "The city store split is applied here exactly as on the master, so an area's retail number matches. " +
      "Target Value is the area's WHOLE-month target (it covers both channels — there is no retail-only " +
      "target), so Ach % reads as the share of the target this channel delivered on its own: retail Ach % " +
      "plus direct Ach % equals the master's. A blank target means none was uploaded, never a target of zero.",
    rows,
    title: "Retail sales by area and product",
    totals: channelRow("", "RETAIL TOTAL", retail.grandTotal.cells, channel.value, retail.grandTotal.rowTotal.targetValue),
  });
  // Achievement is the column a reader looks for first — give it the master's amber and a scale.
  styleAchievementColumn(sheet, columns.length - 1, firstDataRow, firstDataRow + rows.length);

  channelReconciliation(sheet, row, "Retail sales (this sheet)", channel.value, "Direct sales", directValue, masterValue);
}

/** One direct order as the customer sees it — the identity the region grid cannot show. */
type DirectCustomerRow = {
  clientCode: string;
  customer: string;
  details: string;
  regionName: string;
  areaName: string;
  repName: string;
  productName: string;
  units: number;
  value: number;
};

/**
 * Who each direct order was actually sold to.
 *
 * Two sources, because the channel has two eras. From 2026-08 the Direct Orders module writes its
 * own Source-of-Sales batch carrying the pharmacy's Phoenix code, name and address, so the invoice
 * rows themselves identify the customer. July 2026 predates that: its uploaded sheet carries NO
 * customer identity at all (client code, name and address are blank on every row — checked against
 * production), and the only identification that exists is the owner-approved hand mapping, which
 * also names the medical rep. Using it here is what lets July show customers at all.
 */
function directCustomerRows(
  matrix: MonthlyClosingMatrix,
  detailRows: readonly ClosingDetailRow[],
): DirectCustomerRow[] {
  const fromInvoices: DirectCustomerRow[] = detailRows
    .filter((row) => row.isDirect && (row.clientCode.trim() !== "" || row.clientName.trim() !== ""))
    .map((row) => ({
      clientCode: row.clientCode.trim() || "—",
      customer: row.clientName.trim() || "(no customer name on the sheet)",
      details: row.clientAddress.trim() || "—",
      // The matrix's region, as on the Data sheet (see RAW_COLUMNS).
      regionName: row.operationalRegionName || row.regionName || row.regionCode,
      areaName: row.areaName || row.areaCode || "—",
      repName: "—",
      productName: row.productName || row.productCode,
      units: row.qty,
      value: row.salesValue,
    }));
  if (fromInvoices.length > 0) return fromInvoices;

  if (matrix.period !== JULY_2026_DIRECT_PERIOD) return [];
  const regionOf = matrixRegionForArea(matrix);
  return selectJulyDirectRowsForScope(matrix).map((row) => ({
    clientCode: "—",
    customer: row.pharmacy,
    details: row.note || "—",
    regionName: regionOf(row.areaCode, row.regionCode).regionName,
    areaName: row.areaName || row.areaCode,
    repName: row.repName || "—",
    productName: row.product,
    units: row.qty,
    value: row.value,
  }));
}

/**
 * Files each direct cell under the region the Closing Matrix shows its money in, so the Direct Sales
 * tab and the Retail tab's direct figure keep every order the matrix counts.
 *
 * A direct order that names its own area is folded into that area's row by `injectDirectIntoMatrix`,
 * but the cell itself still carries the MAP region. Both channel tabs keep only the regions the
 * matrix holds, so wherever the organogram re-owns an area the order vanished from them while the
 * matrix kept it: Anti Infective, August 2026, Minia 2's 20,370.00 was tagged Upper Egypt, a region
 * that matrix no longer has (it holds Upper Egypt 1 and 2), and the Direct tab showed 31,254.10 of
 * 51,624.10. Owner, 2026-09-16: fix the drop.
 *
 * `matrix` must be the WHOLE month's combined matrix, before any on-screen filter, so an area the
 * reader filtered out is still filed under its own region and the tabs' region filter then drops it,
 * exactly as before. The same rules as the injector decide which cells move: only months whose
 * direct rows carry their own area (never July's overlay), and only an area the matrix has a row
 * for. Anything else is returned untouched — it sits in its own region's Direct row on the matrix
 * too. Moves no money, only the region a cell is counted under.
 */
export function fileDirectCellsUnderMatrixRegions(
  directCells: readonly MonthlyClosingDirectCell[],
  matrix: Pick<MonthlyClosingMatrix, "period" | "regions">,
): MonthlyClosingDirectCell[] {
  if (!directRowsCarryOwnArea(matrix.period)) return [...directCells];
  const regionByArea = new Map<string, string>();
  matrix.regions.forEach((region) => {
    region.areas.forEach((area) => {
      if (isSyntheticDirectArea(area)) return;
      const key = normalizeCode(area.areaCode);
      if (key && !regionByArea.has(key)) regionByArea.set(key, region.regionCode);
    });
  });
  return directCells.map((cell) => {
    const regionCode = regionByArea.get(normalizeCode(cell.areaCode ?? ""));
    return regionCode === undefined || regionCode === cell.regionCode ? cell : { ...cell, regionCode };
  });
}

function writeDirectChannelSheet(
  workbook: ExcelJS.Workbook,
  matrix: MonthlyClosingMatrix,
  directCells: MonthlyClosingDirectCell[],
  retailValue: number,
  masterValue: number,
  detailRows: readonly ClosingDetailRow[],
) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Direct Sales (no retail)"), {
    views: [{ state: "frozen", xSplit: 1, ySplit: 5 }],
  });
  // Only the products this line actually SOLD direct get a column. Showing the line's whole
  // catalogue meant CNS — which has no direct channel at all — printed ~30 product headers with
  // nothing beneath them, so a reader had to scroll a wall of blank columns to reach the one line
  // that mattered: "No direct orders reached this line and month." With nothing sold direct there
  // are no product columns at all, and that sentence is the first thing on the sheet.
  const soldDirect = new Set(directCells.filter((cell) => cell.salesUnits !== 0 || cell.salesValue !== 0)
    .map((cell) => normalizeCode(cell.productCode)));
  const products = matrix.columns.filter((column) => soldDirect.has(normalizeCode(column.productCode)));
  const columns = channelColumns(products, "Region", null);
  bandHeader(sheet, matrix.line, matrix.period, "Direct Sales only — company direct orders, distributor sales excluded", columns.length);

  // Direct money is tagged with a region and a product, never an area — that is why it cannot
  // simply live in the area grid. Values are the submitted deal values, never a factory-price
  // recompute, because a direct deal carries its own negotiated discount or bonus.
  const columnIndex = new Map(products.map((product, index) => [normalizeCode(product.productCode), index]));
  const regionNameByCode = new Map(matrix.regions.map((region) => [region.regionCode, region.regionName]));
  // FOLLOW THE FILTER. `directCells` is the whole month's direct, because the direct RPC has no
  // notion of the reader's on-screen filter. The matrix arriving here has already been narrowed,
  // so its surviving regions ARE the slice this workbook covers — anything else would put Giza and
  // Upper Egypt on a sheet the reader filtered to Delta. (Reported live: a Delta-1 export listed
  // every other region on this tab while every other sheet correctly showed only Delta.)
  const keptRegions = new Set(matrix.regions.map((region) => region.regionCode));
  const byRegion = new Map<string, MonthlyClosingCell[]>();
  directCells.forEach((cell) => {
    const index = columnIndex.get(normalizeCode(cell.productCode));
    if (index === undefined) return; // product outside this workbook's columns
    const regionCode = normalizeCode(cell.regionCode) || "NATIONAL";
    if (regionCode !== "NATIONAL" && !keptRegions.has(regionCode)) return;
    let cells = byRegion.get(regionCode);
    if (!cells) {
      cells = products.map(() => emptyClosingCell());
      byRegion.set(regionCode, cells);
    }
    cells[index].salesUnits += cell.salesUnits;
    cells[index].salesValue += cell.salesValue;
  });

  const totalCells = products.map(() => emptyClosingCell());
  byRegion.forEach((cells) => {
    cells.forEach((cell, index) => {
      totalCells[index].salesUnits += cell.salesUnits;
      totalCells[index].salesValue += cell.salesValue;
    });
  });
  const channel = channelTotals(totalCells);

  // A region's target is the whole-month target of every area it contains — the same denominator
  // the retail tab divides by, which is what makes the two achievement columns add up.
  const targetByRegion = new Map(
    matrix.regions.map((region) => [region.regionCode, region.subtotal.rowTotal.targetValue]),
  );

  const ordered = [...byRegion.entries()].sort(
    (left, right) => channelTotals(right[1]).value - channelTotals(left[1]).value,
  );
  const rows: CellValue[][] = ordered.map(([regionCode, cells]) =>
    channelRow(
      regionCode === "NATIONAL" ? "Direct – National (no region)" : regionNameByCode.get(regionCode) ?? regionCode,
      null,
      cells.map(roundedClosingCell),
      channel.value,
      targetByRegion.get(regionCode) ?? null,
    ));

  const firstDataRow = 6; // title on 4, header on 5
  let row = writeTable(sheet, 4, {
    columns,
    note: rows.length === 0
      ? "No direct orders reached this line and month."
      : "Direct orders only — no distributor row is on this sheet. Value is exactly as submitted " +
        "(a direct deal carries its own negotiated discount or bonus and is never re-valued at the " +
        "factory price). Direct is booked to a region and a product, never to an area, which is why " +
        "it is listed by region here. Target Value is the region's whole-month target, so Ach % is the " +
        "share of it this channel delivered on its own — add it to the retail tab's and you get the master's.",
    rows,
    title: "Direct sales by region and product",
    totals: rows.length === 0
      ? undefined
      : channelRow("DIRECT TOTAL", null, totalCells.map(roundedClosingCell), channel.value, matrix.grandTotal.rowTotal.targetValue),
  });
  if (rows.length > 0) styleAchievementColumn(sheet, columns.length - 1, firstDataRow, firstDataRow + rows.length);

  // Who each order was sold to. The region grid answers "how much"; this answers "to whom", which
  // is the question a direct order actually raises.
  const customers = directCustomerRows(matrix, detailRows);
  const customerColumns: TableColumn[] = [
    { label: "Customer Code", width: 15 },
    { label: "Customer", width: 40 },
    { label: "Details", width: 38 },
    { label: "Region", width: 14 },
    { label: "Area", width: 26 },
    { label: "Medical Rep", width: 32 },
    { label: "Product", width: 24 },
    { label: "Units", numFmt: UNITS_FMT, right: true },
    { dataBar: true, label: "Value (as submitted)", numFmt: VALUE_FMT, right: true, width: 20 },
  ];
  const customerTotalUnits = customers.reduce((sum, entry) => sum + entry.units, 0);
  const customerTotalValue = Math.round(customers.reduce((sum, entry) => sum + entry.value, 0) * 100) / 100;
  // TWO different reasons for an empty section, and saying the wrong one is its own defect: a line
  // with no direct business at all was being told its direct sheet had arrived without customer
  // identity, which reads as a data-quality problem where none exists (found on CNS 2026-07).
  const noDirectAtAll = rows.length === 0;
  row = writeTable(sheet, row, {
    columns: customerColumns,
    note: customers.length === 0
      ? (noDirectAtAll
        ? "No direct orders reached this line and month, so there is no customer to name. Nothing is " +
          "missing from this sheet — this channel simply had no business here."
        : "This month's direct sheet carries no customer identity — it arrived with the client code, name " +
          "and address blank on every row, so there is nothing to name here. Orders raised through the " +
          "Direct Orders module carry their pharmacy, so this section fills itself from the month that module went live.")
      : "Every direct order of this line and month, by customer. The total below equals the DIRECT TOTAL " +
        "above — the same money, once by region and once by customer.",
    rows: customers.map((entry) => [
      entry.clientCode, entry.customer, entry.details, entry.regionName,
      entry.areaName, entry.repName, entry.productName, entry.units, entry.value,
    ]),
    title: "Direct orders — customer by customer",
    totals: customers.length === 0
      ? undefined
      : ["", "TOTAL — all customers", "", "", "", "", "", customerTotalUnits, customerTotalValue],
  });

  channelReconciliation(sheet, row, "Direct sales (this sheet)", channel.value, "Retail sales", retailValue, masterValue);
}

// ── Dashboard — the first tab: what is in this file, in Arabic and English ───────────────────
/**
 * A workbook of fourteen tabs is only useful if a reader knows which one answers their question.
 * This is the index (owner request, 2026-08-05): one clickable button per tab, with a one-line
 * description in English AND Arabic, because the people reading this file work in both.
 *
 * Built LAST but created FIRST. Sheet order in a workbook is creation order, so the empty sheet is
 * added before everything else to make it tab 1; its rows are then written from the sheets that
 * were ACTUALLY produced. That way the index can never advertise a tab this particular export did
 * not include — a filtered export, a month with no direct orders and a scoped one all differ.
 */
const SHEET_GUIDE: Record<string, { ar: string; en: string }> = {
  "Closing Matrix": {
    ar: "الشيت الرئيسي: إجمالي المبيعات (موزعين + أوردرات مباشرة) لكل منطقة ومنتج، مع التارجت ونسبة التحقيق.",
    en: "The master sheet: total sales (distributors + direct) per area and product, with target and achievement.",
  },
  [CLOSING_MATRIX_NO_OFFICE_SHEET]: {
    ar: "نفس الشيت الرئيسي بالكامل، لكن بعد خصم مبيعات الأوفيس من كل خانة. التارجت كما هو، فنسبة التحقيق هنا أقل بمقدار نصيب الأوفيس. الشيت الرئيسي هو الإغلاق المعتمد؛ هذا الشيت للقراءة فقط.",
    en: "The master sheet exactly, with the Office channel's units and value taken out of every cell. Targets are unchanged, so the achievement here is lower than the Closing Matrix by exactly the Office share. CNS only — Office is a CNS-only channel.",
  },
  "Office Allocation": {
    ar: "وحدات الأوفيس وحدها: لكل منطقة ولكل منتج. الأوفيس ليس موزعاً — وحداته توزَّع على المناطق بقاعدة المالك حسب مساهمة كل منطقة في قيمة مبيعات الخط.",
    en: "The Office channel on its own, per area and product. Office is not a distributor: its units are spread across areas by the owner's rule, on each area's share of the line's value. The same figures as the “of wh. Office” columns on the Closing Matrix.",
  },
  "Retail Sales (no direct)": {
    ar: "مبيعات الموزعين فقط، بدون أي أوردر مباشر — نفس المناطق والمنتجات.",
    en: "Distributor sell-out only, with every direct order excluded — same areas and products.",
  },
  "Direct Sales (no retail)": {
    ar: "الأوردرات المباشرة فقط لكل منطقة، ومعها كل عميل بالاسم والمنطقة والمندوب.",
    en: "Direct orders only, by region, plus every customer by name, area and medical rep.",
  },
  "Source Coverage": {
    ar: "أي ملفات موردين وصلت هذا الشهر مقارنة بالشهر السابق، وما الذي ما زال ناقصًا وبكم.",
    en: "Which source files fed this month versus last month, and what is still missing and how big it was.",
  },
  "Target vs Achievement": {
    ar: "المبيعات مقابل التارجت لكل منطقة، ونسبة كل منطقة من تارجت الخط.",
    en: "Sales against target per area, and each area's share of the line's total target.",
  },
  "Direct Orders (July)": {
    ar: "أوردرات يوليو المباشرة موزعة على المناطق يدويًا، مع اسم الصيدلية والمندوب.",
    en: "July's hand-mapped direct orders by area, with the pharmacy and the medical rep named.",
  },
  "Store Split": {
    ar: "تقسيم مبيعات المخازن على مناطق نفس المدينة: ماذا خرج من كل منطقة وماذا دخلها.",
    en: "Wholesaler sales shared across the areas of their city: what each area sent out and received.",
  },
  "Store Split Detail": {
    ar: "تفصيل كامل: أي مخزن تم تقسيمه، وأي منتج، والكميات والقيم، ونصيب كل منطقة.",
    en: "The full detail: which store was split, which product, the units and values, and each area's share.",
  },
  "Distributor Comparison": {
    ar: "مقارنة الموزعين: حصة كل موزع بالمنتج والمنطقة والمنطقة الفرعية، وتغطيته.",
    en: "Each distributor's share by product, region and area, plus how much of the map they cover.",
  },
  "Channel Comparison": {
    ar: "المستشفيات والمخازن والصيدليات شهرًا بشهر: القيمة والكميات وعدد العملاء ونسبة كل قناة، ثم إجمالي الشهر مقابل التارجت.",
    en: "Hospitals, wholesalers and pharmacies month by month: value, units, customers and each channel's share, then the month total against target.",
  },
  "Channel Breakdown": {
    ar: "نفس تقسيم القنوات لهذا الشهر فقط، موزعًا على المنتج والمندوب والمنطقة والبريك، مع صف باسمه لكل مبيعات لم تصل لمندوب أو منطقة أو بريك.",
    en: "The same channel split for this month only, cut by product, medical rep, area and brick — with a named row for any sales that reached no rep, area or brick.",
  },
  "Rankings & Mix": {
    ar: "الترتيب: أعلى المنتجات والمناطق والبريكات والعملاء، وتوزيع المبيعات بينهم.",
    en: "Top products, areas, regions, bricks and customers, and how the sales mix is distributed.",
  },
  "Gaps & White-Space": {
    ar: "الفرص الضائعة: مناطق وبريكات بدون أي مبيعات، ومنتجات غائبة عن مناطق كاملة.",
    en: "Areas and bricks with no sales at all, and products missing from whole regions.",
  },
  "Summary & Insights": {
    ar: "ملخص الشهر في أرقام قليلة، مع ملاحظات تلقائية على الأداء.",
    en: "The month in a few headline numbers, with automatic notes on what stands out.",
  },
  Data: {
    ar: "كل سطر فاتورة كما تم استيراده، مع البريك والمنطقة، وسبب استبعاد أي سطر.",
    en: "Every imported invoice line with its brick and area, and why any excluded line was excluded.",
  },
  Total: {
    ar: "شبكة المنطقة×المنتج: شيت Data بالمعادلات، مضافًا إليه توزيع مبيعات المخازن على مناطق المدينة والطلبات المباشرة — فتطابق كل منطقة شيت Closing Matrix.",
    en: "An area × product grid: Data by formula, plus the store split and direct orders, so every area matches the Closing Matrix.",
  },
  Confidential: {
    ar: "منتجات سرية (LA003 / LA004 / SS001) — تظهر فقط عند طلب إظهارها.",
    en: "Confidential products (LA003 / LA004 / SS001) — present only when explicitly revealed.",
  },
};

function writeDashboardSheet(
  sheet: ExcelJS.Worksheet,
  workbook: ExcelJS.Workbook,
  line: string | null,
  period: string | null,
) {
  const columns: TableColumn[] = [
    { label: "#", right: true, width: 5 },
    { label: "Open tab  ·  افتح الشيت", width: 30 },
    { label: "What you will find here", width: 74 },
    { label: "ماذا ستجد هنا", width: 74 },
  ];
  bandHeader(sheet, line, period, "Dashboard — what is in this file  ·  لوحة المحتويات", columns.length);

  // Only the sheets this export actually produced, in the order the reader will see them. The
  // hidden Calc sheet is machinery, not a report, and the Dashboard does not list itself.
  const listed = workbook.worksheets.filter(
    (candidate) => candidate.id !== sheet.id && candidate.name !== CALC_SHEET && candidate.state !== "hidden",
  );

  const startRow = 4;
  writeTable(sheet, startRow, {
    columns,
    note:
      "Click a tab name to jump straight to it. Every number in this workbook comes from the same month and line "
      + "named at the top of each sheet.  ·  اضغط على اسم الشيت للانتقال إليه مباشرة. كل الأرقام في هذا الملف من نفس الشهر والخط.",
    rows: listed.map((candidate, index) => {
      const guide = SHEET_GUIDE[candidate.name];
      return [
        index + 1,
        candidate.name,
        guide?.en ?? "—",
        guide?.ar ?? "—",
      ];
    }),
    title: "Tabs in this workbook  ·  الشيتات الموجودة في هذا الملف",
  });

  // Turn the name cells into real buttons: an internal hyperlink, styled so it reads as clickable.
  // Written after writeTable so the table's own styling cannot overwrite them.
  const firstDataRow = startRow + 2;
  listed.forEach((candidate, index) => {
    const cell = sheet.getCell(firstDataRow + index, 2);
    cell.value = {
      hyperlink: `#'${candidate.name.replace(/'/g, "''")}'!A1`,
      text: candidate.name,
      tooltip: `Go to ${candidate.name}`,
    };
    cell.font = { bold: true, color: { argb: DIRECT_TEXT }, name: "Calibri", size: 11, underline: true };
    cell.fill = { fgColor: { argb: DIRECT_FILL }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
    cell.border = gridBorder();
    sheet.getRow(firstDataRow + index).height = 30;
  });

  // Arabic reads right-to-left; the column is otherwise indistinguishable from the English one.
  sheet.getColumn(4).alignment = { horizontal: "right", readingOrder: "rtl", vertical: "middle", wrapText: true };
  sheet.getColumn(3).alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
}


// ── Office Allocation ─────────────────────────────────────────────────────────
// The Office channel on its own: area x product, units and value, plus each area's share of the
// line's Office units. Office is not a distributor — its units carry no customer and no geography,
// and land in an area only because the owner's value-share rule put them there
// (src/lib/sales/office-allocation.ts). On CNS July 2026 it is 42,838 of 105,152 units.
//
// Written as plain VALUES, not SUMIFS. Every xlsx this repo writes is recalculated by Excel on
// open, and this sheet's figures come from the same office grid the Closing Matrix's "of wh.
// Office" column was cached with — a live formula here could disagree with it after a single edit.
// The EPDA tab (owner, 2026-11-04) — the grid is closing-epda-sheet.ts's, shared with the premium and
// ranking downloads, so the three files cannot disagree about an area's EPDA units.
function writeEpdaSheet(workbook: ExcelJS.Workbook, matrix: MonthlyClosingMatrix, epdaUnits: ReadonlyMap<string, number> | null | undefined) {
  const spec = closingEpdaSheetSpec({ epdaUnits, matrix, periodLabel: matrix.period ? monthLabel(matrix.period) : null });
  if (spec === null) return;
  const sheet = workbook.addWorksheet(sanitizeSheetName(CLOSING_EPDA_SHEET_NAME), { views: [{ state: "frozen", ySplit: 5 }] });
  bandHeader(sheet, matrix.line, matrix.period, spec.caption, spec.headers.length);
  const body = spec.records.slice(0, -1);
  const startRow = 4;
  writeTable(sheet, startRow, {
    columns: spec.headers.map((label, index) => ({
      label,
      ...(index >= 2 ? { numFmt: "#,##0", right: true } : {}),
      width: spec.widths[index],
    })),
    rows: body,
    title: "EPDA units by area",
    totals: spec.records[spec.records.length - 1],
  });
  // Region bars in bold, so a region's own line reads as the sum of the areas under it.
  spec.rowKinds.slice(0, -1).forEach((kind, index) => {
    if (kind !== "group") return;
    sheet.getRow(startRow + 2 + index).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: BLACK }, name: "Calibri", size: 10.5 };
    });
  });
}

function writeOfficeSheet(workbook: ExcelJS.Workbook, office: MonthlyClosingMatrix, note?: string) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Office Allocation"), { views: [{ state: "frozen", xSplit: 2, ySplit: 4 }] });
  const products = office.columns;
  const nationalUnits = office.grandTotal.cells.reduce((sum, cell) => sum + (cell.salesUnits ?? 0), 0);

  const columns: TableColumn[] = [
    // By name, never by code (owner, 2026-10-26).
    { label: "Region", width: 18 },
    { label: "Area", width: 30 },
    ...products.map((product) => ({
      label: `${product.productName} (${product.productCode})`,
      numFmt: UNITS_FMT,
      right: true,
      width: 15,
    })),
    { dataBar: true, label: "Office Units", numFmt: UNITS_FMT, right: true, width: 14 },
    { label: "Office Value", numFmt: VALUE_FMT, right: true, width: 16 },
    { label: "% of Line Office Units", numFmt: PCT_FMT, right: true, width: 18 },
  ];

  const rowFor = (regionName: string, name: string, cells: MonthlyClosingCell[], total: MonthlyClosingCell): CellValue[] => {
    const units = cells.reduce((sum, cell) => sum + (cell.salesUnits ?? 0), 0);
    return [
      regionName,
      name,
      ...cells.map((cell) => cell.salesUnits ?? 0),
      units,
      total.salesValue ?? 0,
      nationalUnits > 0 ? units / nationalUnits : 0,
    ];
  };

  const rows: CellValue[][] = [];
  for (const region of office.regions) {
    for (const area of region.areas) rows.push(rowFor(region.regionName, area.areaName, area.cells, area.rowTotal));
    rows.push(rowFor(region.regionName, `${region.regionName} (Region)`, region.subtotal.cells, region.subtotal.rowTotal));
  }

  bandHeader(sheet, office.line, office.period, "Office Allocation", columns.length);
  writeTable(sheet, 4, {
    columns,
    note:
      "Office units are not sold by a distributor. They are allocated to areas by the owner's rule: each area's "
      + "share of the line's non-Office VALUE (units x master factory price) is applied to every product's units, "
      + "and the value is worked out afterwards. These are the same figures as the \u201cof wh. Office\u201d columns on the "
      + "Closing Matrix."
      + (note ? `  ·  ${note}` : ""),
    rows,
    title: "Office allocation by area and product",
    totals: rowFor("", "National Grand Total", office.grandTotal.cells, office.grandTotal.rowTotal),
  });
}

export async function buildMonthlyClosingWorkbook(
  matrix: MonthlyClosingMatrix,
  comparison: MonthlyClosingComparison,
  details?: ClosingDetailsResult,
  options?: {
    /**
     * Human-readable summary of the on-screen filter (names, never codes), stamped on the
     * Closing Matrix sheet and reflected in the Total sheet's reconciliation labels. Present
     * whenever the workbook covers a slice rather than the whole month — a forwarded file must
     * say so itself.
     */
    filterNote?: string;
    /**
     * False when a row-level filter (distributor, Included/Excluded, free-text search) is
     * active: targets are set per area & product for the whole company, so an achievement
     * sheet against a row-level slice would compare one distributor's sales to a target that
     * was never set for it. Omitting the sheet is honest; showing a fake % is not.
     */
    includeTargetSheet?: boolean;
    /**
     * The month's completeness picture (which of last month's sources are absent). Written as
     * the sheet right after the matrix; omitted when unavailable rather than ever blocking the
     * export.
     */
    coverage?: MonthlySourceCoverage | null;
    /**
     * Net store split that landed on `matrix` (from applyStoreSplitToMatrix). Zero for a
     * whole-month export. On a filtered one it is the part of the city allocation that belongs to
     * areas the filter excluded — named on the Total sheet so the Difference row still reads zero.
     */
    storeSplitApplied?: { qty: number; value: number };
    /**
     * The WHOLE month's detail rows, before place narrowing. The Store Split sheet is built from
     * these rather than from `details.rows` so a reader who filtered to one area can still see the
     * rest of that area's city. Falls back to `details.rows` when absent.
     */
    storeSplitRows?: ClosingDetailRow[];
    /** The areas this workbook covers, for marking Store Split rows as inside or outside it. */
    storeSplitScopeAreaCodes?: readonly string[];
    /**
     * Areas the line's organogram parks in Others, which take NO share of an El Qema split —
     * owner, 2026-09-08. Resolved by the caller because it is live organogram data, per line and
     * per month; omitted, these sheets split across every area exactly as they did before.
     */
    storeSplitRegions?: SplitRegions;
    /**
     * Customer codes whose identity must not reach the Store Split sheets.
     *
     * 🔒 The split is computed from the REAL rows and the answer is masked, because a split entry
     * carries no distributor to recognise. See closing-source-mask.ts.
     */
    storeSplitMaskedClients?: ReadonlySet<string>;
    /**
     * The split movements to fold into the Store Split SUMMARY sheet, instead of recomputing them
     * from `storeSplitRows`. For a PUBLISHED month the caller passes the FROZEN movements
     * (loadClosingStoreSplit), so the summary's net ties to the frozen Closing Matrix rather than to a
     * live recompute that drifted after publish. Omitted for a live month (the sheet recomputes as
     * before). Only the single-month summary uses it; the consolidated fold keeps its own per-month path.
     */
    storeSplitMovements?: readonly StoreSplitAreaMovement[];
    /**
     * True when this month is published and its split is FROZEN. Adds a banner to the Store Split
     * Detail sheet, which is per-customer and cannot be frozen (the frozen table has no customer
     * grain): it stays a LIVE recompute for explanation while the Matrix, Total and Store Split
     * summary show the frozen announced numbers. Names which number is authoritative so the live
     * per-store detail cannot be mistaken for the published figure.
     */
    storeSplitFrozen?: boolean;
    /**
     * Per area|product, the EPDA units rule 2 landed on each area (owner, 2026-11-04), whole month.
     * Written as the EPDA tab after the matrix; absent or empty, there is no tab.
     */
    epdaUnits?: ReadonlyMap<string, number> | null;
    /**
     * The two halves of `matrix`, for the channel tabs: `retail` is the same grid before direct is
     * injected (with the identical store split applied), `directCells` the direct money by region
     * and product. Omitted under a row-level filter, where the matrix is rebuilt from invoice rows
     * and the direct channel has no equivalent slice.
     */
    channels?: { retail: MonthlyClosingMatrix; directCells: MonthlyClosingDirectCell[] } | null;
    /**
     * Hospitals / Stores / Pharmacies across every month of the line, for the Channel Comparison
     * sheet. Loaded by the caller (it is the one sheet that reaches outside the exported month)
     * and omitted rather than empty when unavailable — a missing sheet is honest, a sheet of
     * zeroes is not. Also omitted under a row-level filter, where the rest of the workbook covers
     * a slice this whole-line, whole-history comparison could not be narrowed to.
     */
    channelComparison?: ChannelComparison | null;
    /**
     * The SAME channel split cut by product, rep, area and brick for the exported month only.
     * Loaded by the caller alongside `channelComparison` and omitted on the same terms — a grid of
     * whole-line figures beside a filtered workbook would describe a different population.
     */
    channelBreakdown?: ChannelBreakdown | null;
    /**
     * The direct money already inside `matrix`, when there is no `channels` pair to derive it from.
     * Only a row-level filter (distributor, Included/Excluded, free-text search) hits this: the
     * matrix is rebuilt from the filtered rows, so the retail half has no equivalent slice — but
     * the slice can still CONTAIN direct, because `DIRECT` is itself a selectable distributor and
     * a search or an Excluded filter can match direct rows too. Without this the Total sheet's
     * bridge stayed at zero and the Difference opened by exactly the direct amount.
     *
     * Supply it derived as (matrix with direct) minus (the same matrix without), never by summing
     * the direct rows: a direct row naming an area or product outside this matrix is never placed
     * in a cell, so counting it would bridge money that is not on the sheet.
     */
    directPlaced?: { units: number; value: number };
    /**
     * `directPlaced` cell by cell, from directByTotalCell(matrix with direct, the same without), so
     * the Total sheet can add each area's own direct. Needed on the same terms as `directPlaced`;
     * with `channels` present it is derived from the retail half instead.
     */
    directPlacedCells?: ReadonlyMap<string, { units: number; value: number }>;
    /**
     * `storeSplitApplied` cell by cell — applyStoreSplitToMatrix's `cells`, summed across the months
     * on a consolidated export. The Total sheet adds each to that area's Data rows, so every area
     * there agrees with the Closing Matrix (owner, 2026-09-18). Omitted, no area is adjusted.
     */
    storeSplitCells?: ReadonlyMap<string, { qty: number; value: number }>;
    /**
     * The Office slice of `matrix`, on the same grid (MonthlyClosingParts.office). Adds an
     * "of wh. Office" column to every product block and to the Grand Total on the Closing Matrix,
     * and an "Office Allocation" sheet carrying the whole area x product breakdown.
     *
     * Omitted (or null) simply leaves the workbook exactly as it was — a missing breakdown is
     * honest, a column of zeroes would claim no area took Office units.
     */
    office?: MonthlyClosingMatrix | null;
    /**
     * True when `office` was narrowed by the SAME filter as `matrix`, so the Office slice can be
     * taken out of it cell by cell — which is what the "Closing Matrix (No Office)" tab is.
     *
     * 🔴 OFF BY DEFAULT, AND THE DEFAULT IS THE SAFE ANSWER. Under a ROW-LEVEL filter (distributor,
     * Included/Excluded, free-text search) the admin route deliberately passes the WHOLE month's
     * Office grid, because `loadMonthlyClosingParts` builds it from an aggregate carrying no
     * customer and no distributor and there is nothing in it for such a filter to match — the sheet
     * says so in words. Subtracting that from a narrowed matrix would remove money the matrix never
     * held and print NEGATIVE sales, so the tab is simply absent there instead.
     */
    officeNarrowedWithMatrix?: boolean;
    /**
     * OFF BY DEFAULT. Present only on the CONSOLIDATED export — several months of one line added
     * together, Super Admin and CEO only (owner, 2026-09-14). Absent, this workbook is exactly the
     * single-month file it has always been.
     *
     * The store split belongs to ONE month: every warehouse band is judged on that month's own total.
     * Pooling several months' rows into one call would re-judge the bands on the combined total — 150
     * packs in each of two months would cross 200 and split, which the closing never did. So the two
     * Store Split sheets are computed per month from `months` and then added (owner: "split each
     * month, then add"). See closing-store-split-months.ts.
     *
     * It also leaves out the July 2026 Direct Orders sheet, which is one month's hand-mapped list and
     * would read as the whole span's. `filtered` says whether the reader narrowed the screen, because
     * a consolidated file always carries a note on `filterNote` whether or not it was filtered.
     */
    consolidatedMonths?: {
      filtered: boolean;
      months: readonly StoreSplitMonth<ClosingDetailRow>[];
    } | null;
  },
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();

  // The Dashboard is created FIRST so it is tab 1 — sheet order is creation order — but it is
  // written LAST, from the sheets that actually got produced. See writeDashboardSheet.
  const dashboard = workbook.addWorksheet(sanitizeSheetName("Dashboard"), { views: [{ showGridLines: false }] });

  // Plan the Calc layout first (for the formula ranges), write the visible report sheets,
  // then add the hidden Calc sheet LAST so a report sheet stays the active tab.
  const { blocks, ref } = planDataLayout(comparison.data);
  // Owner's rule, 2026-08-25: Office is a CNS-only channel, so the "of wh. Office" columns and the
  // Office Allocation sheet appear on CNS and nowhere else. Resolved once here so the column and
  // the sheet can never disagree about whether this workbook has an Office layer.
  const office = lineHasOfficeChannel(matrix.line) ? (options?.office ?? null) : null;
  writeMatrixSheet(workbook, matrix, options?.filterNote, office);
  // 🔴 THE SAME GRID WITH OFFICE TAKEN OUT, IMMEDIATELY AFTER IT — owner, 2026-10-05: "a new tab is
  // added without the office sales ... then the closing matrix as it is". CNS only, because Office
  // is a CNS-only channel (`lineHasOfficeChannel` above), and `office` is already null everywhere
  // else — so no other line gains a tab that would be a byte-identical copy of the one before it.
  //
  // It carries NO "of wh. Office" columns, deliberately: the whole grid is the non-Office half, so a
  // column of zeroes would be the one number on the sheet that says nothing. That also makes it
  // narrower than the Closing Matrix by one column per product, which is the visible signal that
  // the reader is on the twin rather than on the published grid.
  //
  // Only when the Office grid is comparable with this matrix — see `officeNarrowedWithMatrix`.
  if (office && options?.officeNarrowedWithMatrix) {
    writeMatrixSheet(
      workbook,
      matrixWithoutOffice(matrix, office),
      [CLOSING_MATRIX_NO_OFFICE_NOTE, options?.filterNote].filter(Boolean).join(" "),
      null,
      CLOSING_MATRIX_NO_OFFICE_SHEET,
    );
  }
  // Straight after the master, so the Office layer reads as a lens ON the closing rather than as a
  // separate report buried at the back.
  //
  // Guarded, where the original fell back to `options?.office ?? matrix`. Every column on that sheet
  // is labelled "Office Units" / "Office Value" / "% of Line Office Units", so handing it the full
  // matrix when there is no Office data would present the ENTIRE closing as Office — 105,152 units
  // read as 42,838. Omitting the sheet says "not available"; the fallback said something false. The
  // portal path below already guarded it this way, so this also makes the two agree.
  if (office) writeOfficeSheet(workbook, office, options?.filterNote);
  writeEpdaSheet(workbook, matrix, options?.epdaUnits);
  // The master's two halves, immediately beside it: the same money split by channel so the retail
  // business and the direct business can each be read on their own. Both tie back to the master.
  if (options?.channels) {
    const masterValue = (options.channels.directCells.length > 0 && matrix.companyTotal
      ? matrix.companyTotal
      : matrix.grandTotal).rowTotal.salesValue;
    const retailValue = options.channels.retail.grandTotal.rowTotal.salesValue;
    // The direct BOTH tabs quote must be the direct the Direct tab actually shows — i.e. the
    // regions that survived the reader's filter. Summing every cell here while that sheet lists
    // only the filtered ones would make the Retail tab cite a number nothing on the Direct tab adds
    // up to. Same rule, stated once.
    const keptRegions = new Set(matrix.regions.map((region) => region.regionCode));
    const directValue = options.channels.directCells.reduce(
      (sum, cell) => {
        const region = normalizeCode(cell.regionCode) || "NATIONAL";
        return region === "NATIONAL" || keptRegions.has(region) ? sum + cell.salesValue : sum;
      },
      0,
    );
    writeRetailChannelSheet(workbook, options.channels.retail, directValue, masterValue);
    writeDirectChannelSheet(
      workbook,
      matrix,
      options.channels.directCells,
      retailValue,
      masterValue,
      // The whole month's rows when the caller has them — a direct order's customer must not
      // disappear because the reader filtered the screen to one area.
      options.storeSplitRows ?? details?.rows ?? [],
    );
  }
  // Then: whether the month is COMPLETE, before how it performed — July 2026 was reported on 4 of
  // ~18 source files and nothing in the file said so.
  if (options?.coverage) {
    writeSourceCoverageSheet(workbook, options.coverage);
  }
  // Directly after the matrix: the same numbers judged against their targets. It sits here rather
  // than at the end because "did we hit the number" is the second question a reader asks.
  // Omitted for row-level filtered exports — see the option's own comment.
  if (options?.includeTargetSheet !== false) {
    writeTargetAchievementSheet(workbook, matrix);
  }
  // One-off: July 2026's hand-mapped direct orders. The period guard is what keeps this from
  // ever appearing in another month — August onwards the module supplies the area itself.
  if (matrix.period === JULY_2026_DIRECT_PERIOD && !options?.consolidatedMonths) {
    writeJulyDirectSheet(workbook, matrix);
  }
  // Right after the matrix and its targets: why a rep's number differs from the raw area total.
  // Built from the SAME detail rows the Data sheet shows, so the two can never disagree.
  if (details) {
    const splitSourceRows = options?.storeSplitRows ?? details.rows;
    // Several months: each split on its own and then added — see the option's own comment.
    const consolidated = options?.consolidatedMonths;
    writeStoreSplitSheet(
      workbook,
      matrix.line,
      matrix.period,
      consolidated
        ? foldStoreSplitByArea(consolidated.months)
        : summariseStoreSplitByArea(
          options?.storeSplitRows ?? details.rows,
          matrix.period,
          options?.storeSplitRegions,
          // A published month passes its FROZEN movements so the summary net ties to the frozen
          // Matrix; a live month passes none and the split is recomputed from the rows, unchanged.
          options?.storeSplitMovements,
        ),
      options?.storeSplitScopeAreaCodes ?? [],
    );
    // Straight after it: which shop caused each moved number, on which product — the detail the
    // area summary cannot hold, because by then every store of a city is folded together.
    writeStoreSplitDetailSheet(
      workbook,
      matrix.line,
      matrix.period,
      maskSplitEntries(
        consolidated
          ? foldStoreSplitByCustomer(consolidated.months)
          : summariseStoreSplitByCustomer(splitSourceRows, matrix.period, options?.storeSplitRegions),
        options?.storeSplitMaskedClients,
      ),
      maskSplitEntries(
        consolidated
          ? foldStoreSplitDetail(consolidated.months)
          : detailStoreSplitByCustomer(splitSourceRows, matrix.period, options?.storeSplitRegions),
        options?.storeSplitMaskedClients,
      ),
      options?.storeSplitFrozen ?? false,
      matrixAreaNames(matrix, splitSourceRows),
    );
  }
  writeComparisonSheet(workbook, comparison, ref);
  // Straight after "who sold it" comes "who bought it" — the same money split by customer channel,
  // and the only sheet in the book that looks at the months either side of this one.
  if (options?.channelComparison) {
    // The workbook's OWN headline, so the exported month's extra tie-back line compares the channel
    // sheet to the Closing Matrix a reader can see on sheet 1 — the same figure the Total sheet
    // reconciles to, not a second derivation of it.
    //
    // companyTotal, NOT grandTotal, whenever the month has one. grandTotal is the area grid; the
    // Direct National row sits OUTSIDE it and companyTotal is the "Grand Total (incl. Direct)" row
    // the Matrix sheet actually prints. Tying to grandTotal made Pedia 2026-07 read a 13,732.00
    // MISMATCH against a cell nobody publishes — that is direct money belonging to no area, which
    // is real and is on the sheet, just not in the grid.
    writeChannelComparisonSheet(
      workbook,
      options.channelComparison,
      matrix.period,
      (matrix.companyTotal ?? matrix.grandTotal).rowTotal.salesValue,
    );
  }
  // Then the same month cut four ways. Its own sheet: the brick grid alone runs to hundreds of rows
  // and would bury the month-by-month blocks above.
  if (options?.channelBreakdown) {
    writeChannelBreakdownSheet(workbook, options.channelBreakdown, matrix, comparison);
  }
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
    // The headline is the matrix IN THIS WORKBOOK — filtered or not. Under a row-level filter
    // the route rebuilds the matrix from the same rows Data will show, so the tie holds by
    // construction on every path; `filtered` only changes how the tie is labelled.
    const headline: ClosingHeadline = {
      salesUnits: matrix.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0),
      salesValue: matrix.grandTotal.rowTotal.salesValue,
    };
    // The direct money the headline already contains. `placed` is every Direct row inside the grand
    // total (and, in July, the direct merged into the area rows themselves — which is why it is
    // derived as grand total minus the retail matrix rather than by walking the Direct rows).
    // `national` sits above the grand total and is counted only in the company total.
    // Under a row-level filter there is no retail half to subtract, so the caller states the figure
    // instead (`directPlaced`). Falling back to zero there was the bug: `DIRECT` is a selectable
    // distributor, so "Distributor = DIRECT" produced a workbook whose Difference tied only because
    // the headline was as empty as the bridge.
    const retailValue = options?.channels?.retail?.grandTotal.rowTotal.salesValue;
    const retailUnits = options?.channels?.retail?.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0);
    const placedUnits = retailUnits === undefined
      ? options?.directPlaced?.units ?? 0
      : headline.salesUnits - retailUnits;
    const placedValue = retailValue === undefined
      ? options?.directPlaced?.value ?? 0
      : headline.salesValue - retailValue;
    const directInMatrix = {
      national: {
        units: matrix.directNational?.rowTotal.salesUnits ?? 0,
        value: matrix.directNational?.rowTotal.salesValue ?? 0,
      },
      placed: {
        units: Number(placedUnits.toFixed(6)),
        value: Number(placedValue.toFixed(2)),
      },
    };
    writeTotalSheet(
      workbook,
      headline,
      { ...details, rows: visible },
      "Data",
      options?.consolidatedMonths ? options.consolidatedMonths.filtered : Boolean(options?.filterNote),
      options?.storeSplitApplied,
      directInMatrix,
      {
        // The same derivation as `placed` above, cell by cell: the master minus its retail half, or
        // the caller's own (with direct) minus (without) under a row-level filter.
        direct: options?.channels?.retail
          ? directByTotalCell(matrix, options.channels.retail)
          : options?.directPlacedCells ?? new Map(),
        matrix,
        storeSplit: options?.storeSplitCells ?? new Map(),
      },
    );
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

  // Last, now that every sheet exists: fill tab 1 with what this particular export contains.
  writeDashboardSheet(dashboard, workbook, matrix.line, matrix.period);

  // Not protected: every tab, hidden ones included, opens for editing (owner, 2026-10-26).

  unprotectExcelWorkbook(workbook);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * The Data sheet's title in both scoped builders below. It used to say "every invoice line in your
 * scope", and since 2026-09-16 that is not what the sheet holds: the rows are the viewer's own
 * Details tab, where a store's sale sits in the areas it is credited to and Main Stores stands in
 * for El Qema's warehouses. A title calling those invoice lines would send a reader looking for
 * invoices that do not exist.
 */
const SCOPED_DATA_SUBTITLE = "Data — every row of your closing, as your Details tab shows it";

/**
 * Details-only export: just "Data" (+ "Total" + "Confidential" when applicable) — no Matrix,
 * Comparison, Rankings, Gaps, or Summary. For a viewer whose access is scoped to part of the
 * company (a single line, region, or product allowlist), the full Closing Matrix + distributor
 * comparison are company-wide reads that answer to nobody's access (loadMonthlyClosing /
 * loadMonthlyClosingComparison narrow only by the caller's on-screen filter, which is a
 * convenience and not a permission check) — sending them to a scoped viewer would leak data
 * outside their access. `loadMonthlyClosingDetails`, by contrast, is properly scoped (region,
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

  writeRawDataSheet(workbook, "Data", visible, SCOPED_DATA_SUBTITLE, details.line, details.period);
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

  // Not protected: every tab, hidden ones included, opens for editing (owner, 2026-10-26).

  unprotectExcelWorkbook(workbook);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Employee-portal export: Dashboard, Closing Matrix, Target vs Achievement, Distributor
 * Comparison, Rankings & Mix, Gaps & White-Space, Summary & Insights, Data, Total (+ Confidential
 * when applicable) — for a viewer whose access is scoped to part of the company: a
 * District/Regional/National Sales Manager, a Product/Group Product Manager's product allowlist,
 * or a Marketing Manager's 3-line department oversight (MARKETING_OVERSIGHT_LINE_ROLES). Every
 * sheet here is built from data ALREADY narrowed to that viewer, never a company-wide read:
 *
 * - `matrix` is this viewer's OWN scoped Closing Matrix skeleton — loadPortalMonthlyClosing for a
 *   territory/product role, or (for Marketing Manager, whose 3-line oversight the single-line
 *   portal model can't represent) the whole-line company matrix for just the one requested line,
 *   which is safe because her only boundary is WHICH lines, not areas/regions/products within
 *   one. Either way its cells are REBUILT from `details.rows` (rebuildMatrixFromRows) — the same
 *   already-scoped rows the Data sheet lists — so a row outside this viewer's access simply cannot
 *   appear: the skeleton's SHAPE carries no figures, and the rebuild never adds a row the caller's
 *   own access wouldn't have populated.
 * - `comparison` is built by the caller from those SAME rows (loadMonthlyClosingComparisonFromRows),
 *   so Distributor Comparison / Rankings / Gaps / Summary inherit the identical boundary — they
 *   can only ever describe customers, bricks and products this viewer's own rows contain.
 * - Target vs Achievement reads targets straight off the scoped matrix's own cells, so a target
 *   for an area outside scope never appears either.
 *
 * Deliberately NOT included, even scoped: Retail/Direct channel split (needs a scoped "retail
 * before direct" half the portal loader doesn't expose yet), Store Split/Store Split Detail (the
 * split's redistribution math needs the WHOLE month's rows to be correct — computing it from
 * already-narrowed rows would silently underweight it, not just narrow it), and Channel
 * Comparison/Breakdown (their RPCs are line-wide with no product/area scoping today). Omitted
 * rather than guessed at. The split's EFFECT is here all the same: `details.rows` are the viewer's
 * own Details tab, whose shares the loader worked out over the whole month before scoping them.
 */
export async function buildPortalClosingWorkbook(
  matrix: MonthlyClosingMatrix,
  comparison: MonthlyClosingComparison,
  details: ClosingDetailsResult,
  /** This viewer's own Office grid, scoped exactly as `matrix` is. Null omits the breakdown. */
  office?: MonthlyClosingMatrix | null,
  /**
   * The whole month's EPDA units per area|product (owner, 2026-11-04). The tab is drawn on this
   * viewer's own matrix, so only his own areas and products appear. Null or empty, no tab.
   */
  epdaUnits?: ReadonlyMap<string, number> | null,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();

  const visible = details.rows.filter((row) => !row.isConfidential);
  const confidential = details.rows.filter((row) => row.isConfidential);

  // Created first so it lands as tab 1 (sheet order is creation order) but written LAST, once
  // every other sheet exists — same two-step as buildMonthlyClosingWorkbook's Dashboard.
  const dashboard = workbook.addWorksheet(sanitizeSheetName("Dashboard"), { views: [{ showGridLines: false }] });

  // Rebuild the cells from the rows so the Matrix ties to the Data sheet. The rows are the viewer's
  // own Details tab — the store split's shares already credited to the areas that earn them and
  // Main Stores in place of El Qema — so the rebuilt cells are the screen's cells as well. They used
  // to be the rows as invoiced, which tied this sheet to Data and to nothing the viewer could see:
  // a Medical Rep's file read 23,007 EGP against a screen of 82,981 (owner, 2026-09-16, "Fix every
  // scoped file now"). A Main Stores row carries no factory price, and nothing here needs one: the
  // rebuild, the Data sheet, Total's SUMIFS and the Calc leaves all add up the value ON the row,
  // never units × price.
  //
  // `preserveTargets` keeps the scoped matrix's per-area/product targets — the whole
  // of the viewer's scope is present here, so the achievement is honest — without which the
  // exported Closing Matrix and Target vs Achievement sheets came out with every target blank.
  // `includeDirect` because this workbook's job is to hand the reader their own Monthly Closing
  // screen, and that screen has direct folded into the area rows. Without it the Closing Matrix,
  // Target vs Achievement and the headline were all invoice-only while the screen was not, so a
  // manager's export was short its whole share of the month's direct sales and said nothing.
  // The folded money cannot be recalculated away: writeMatrixSheet renders every sales cell as a
  // VALUE and can no longer reach the Calc sheet at all. This used to depend on the rows happening
  // to arrive flagged `isDirect` — one entry in a hand-maintained static list that the organogram
  // region grouping was never added to. See the note above that function's row-writing loop.
  const rebuiltMatrix = rebuildMatrixFromRows(matrix, visible, {
    includeDirect: true,
    preserveTargets: true,
  });
  const { blocks, ref } = planDataLayout(comparison.data);

  // Owner's rule, 2026-08-25 — Office is CNS-only. Same gate, same reason as the admin workbook.
  const officeLayer = lineHasOfficeChannel(rebuiltMatrix.line) ? (office ?? null) : null;
  writeMatrixSheet(workbook, rebuiltMatrix, "Scoped to your own areas, region and products — never company-wide.", officeLayer);
  if (officeLayer) writeOfficeSheet(workbook, officeLayer, "Scoped to your own areas, region and products — never company-wide.");
  writeEpdaSheet(workbook, rebuiltMatrix, epdaUnits);
  writeTargetAchievementSheet(workbook, rebuiltMatrix);
  writeComparisonSheet(workbook, comparison, ref);
  writeRankingsSheet(workbook, comparison, ref);
  writeGapsSheet(workbook, comparison, ref);
  writeSummarySheet(workbook, comparison, ref);
  writeRawDataSheet(workbook, "Data", visible, SCOPED_DATA_SUBTITLE, details.line, details.period);
  const headline: ClosingHeadline = {
    salesUnits: rebuiltMatrix.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0),
    salesValue: rebuiltMatrix.grandTotal.rowTotal.salesValue,
  };
  // The direct now folded into the headline above. The Data sheet cannot show it — direct reaches
  // the closing from the Direct Orders module, never as a distributor invoice line — so without
  // this the Total sheet's Difference would open up by exactly the direct amount and read as an
  // unexplained gap. `national` stays zero: a portal viewer is geography-scoped and
  // scopeMatrixToAreaCodes/RegionNames null `directNational`, so no un-placed direct reaches them.
  // Derived as (with direct) minus (without), NOT by summing the direct rows: a direct row whose
  // area or product is absent from this viewer's skeleton is never placed in a cell, so counting it
  // here would open the Difference by exactly the money that never made it onto the sheet. Same
  // reasoning as the admin path, which derives `placed` as grand total minus the retail channel.
  const invoiceOnly = rebuildMatrixFromRows(matrix, visible, { preserveTargets: true });
  const placedDirect = {
    units: headline.salesUnits
      - invoiceOnly.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0),
    value: headline.salesValue - invoiceOnly.grandTotal.rowTotal.salesValue,
  };
  writeTotalSheet(
    workbook,
    headline,
    { ...details, rows: visible },
    "Data",
    false,
    { qty: 0, value: 0 },
    {
      national: { units: 0, value: 0 },
      placed: {
        units: Number(placedDirect.units.toFixed(6)),
        value: Number(placedDirect.value.toFixed(2)),
      },
    },
    // No store split column: these rows already carry each area's share (see above), so Data is
    // already after the split. Only the folded direct separates an area here from its matrix row.
    { direct: directByTotalCell(rebuiltMatrix, invoiceOnly), matrix: rebuiltMatrix, storeSplit: new Map() },
  );
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

  // Hidden Calc sheet next (writeMatrixSheet/writeTotalSheet's live formulas already reference it
  // by name) — Excel refuses to hide the active sheet, so a visible report sheet must already
  // exist as the active tab.
  writeDataSheet(workbook, blocks);

  // Last, now that every sheet exists: fill tab 1 with what this export actually contains — same
  // order as buildMonthlyClosingWorkbook.
  writeDashboardSheet(dashboard, workbook, details.line, details.period);

  // Not protected: every tab, hidden ones included, opens for editing (owner, 2026-10-26).

  unprotectExcelWorkbook(workbook);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
