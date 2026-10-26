import assert from "node:assert/strict";

import { countsInClosingHeadline } from "../src/lib/sales/closing-headline.ts";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { prepareClosingStoreSplit } from "../src/lib/sales/closing-store-split-export.ts";
import { assembleComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import {
  buildFilterOptions,
  summarize,
  type ClosingDetailRow,
  type ClosingDetailsResult,
} from "../src/lib/sales/monthly-closing-details.ts";
import {
  buildMonthlyClosingWorkbook,
  fileDirectCellsUnderMatrixRegions,
} from "../src/lib/sales/monthly-closing-export.ts";
import {
  filterMonthlyClosingMatrix,
  injectDirectIntoMatrix,
  type MonthlyClosingCell,
  type MonthlyClosingDirectCell,
  type MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";
import { applyStoreSplitToMatrix } from "../src/lib/sales/store-split-matrix.ts";

// THE TOTAL SHEET AGREES WITH THE CLOSING MATRIX, AREA BY AREA.
//
// Owner's ruling, 2026-09-18 ("Make Total match the Matrix", confirmed "Yes, change it"). The admin
// Monthly Closing workbook's Total sheet summed the Data sheet's invoice lines by area and stopped
// there. The Closing Matrix beside it is AFTER the store split (a wholesaler's sales shared across
// its city's areas) and AFTER direct orders fold into their areas. So an area's row on the Total
// sheet disagreed with the same area on the Closing Matrix, and only the grand total tied: Anti
// Infective 2026-07 showed Mahalla D15 25,785.00 away from the matrix on the sheet the Dashboard
// calls the proof. SoS re-measure item #20.
//
// WHAT IS ASSERTED, on the real workbook read back:
//   • every area × product cell of the Closing Matrix has a Total row whose Sales Units and Sales
//     Value equal it — a wholesaler's city split, a direct order folded into an area, and a region's
//     synthetic "Direct" row all included;
//   • Sales is a live formula, Data + Store Split + Direct on its own row, so the file still
//     recalculates from the Data sheet;
//   • the TOTAL row's Sales equals the Closing Matrix grand total, and the reconciliation block
//     below it is untouched;
//   • the same holds on an area-filtered export, where part of the city is not on show;
//   • the export route and the consolidated export hand the per-cell split to the workbook.

const PRODUCT = "AB-01";
const PRODUCT_NAME = "Lacto Advanced 1";
const LINE = "Pedia";
// From August the store split is live and direct orders carry their own area (July's are placed by
// the owner's hand mapping instead), so both halves of the ruling are exercised.
const PERIOD = "2026-08";
// Alexandria is AB1 + AB2 + AB3 in the master city map: a store there splits three ways.
const ALEX = ["AB1", "AB2", "AB3"] as const;
const AREA_NAMES: Record<string, string> = { AB1: "Alex East", AB2: "Alex West", AB3: "Alex Center" };
// مخزن is one of the store keywords (customer-channel.ts), so this customer is split by the city rule.
const STORE = "مخزن الاسكندرية";
const PHARMACY = "صيدلية النور";

function detailRow(id: number, areaCode: string, clientName: string, qty: number, salesValue: number): ClosingDetailRow {
  return {
    areaCode,
    areaMismatch: false,
    areaName: AREA_NAMES[areaCode] ?? areaCode,
    blockCode: "",
    bonusQty: 0,
    brickId: `B-${areaCode}`,
    brickName: `${areaCode} brick`,
    brickUnmapped: false,
    clientAddress: "",
    clientCode: `C${id}`,
    clientName,
    discount: 0,
    distributorCode: "PS",
    effectiveUnits: qty,
    exclusions: [],
    factoryPrice: salesValue / qty,
    family: "Milk",
    id,
    includedInClosing: true,
    invoiceDate: `${PERIOD}-15`,
    invoicePeriod: PERIOD,
    isConfidential: false,
    isDirect: false,
    missingClientCode: false,
    evenSplitApplied: false,
    officialLine: LINE,
    productCode: PRODUCT,
    productName: PRODUCT_NAME,
    qty,
    regionCode: "AB",
    regionName: "Alex-BHR",
    operationalRegionCode: "AB",
    operationalRegionName: "Alex-BHR",
    rowNumber: id,
    salesValue,
    sheetAreaCode: areaCode,
    sheetAreaName: AREA_NAMES[areaCode] ?? areaCode,
    sheetRegionCode: "AB",
    sheetRegionName: "Alex-BHR",
    sheetValue: salesValue,
    validationState: "valid",
  };
}

// One store in Alex East, 750 units / 750,000 EGP, and a pharmacy in each area.
const MONTH_ROWS: ClosingDetailRow[] = [
  detailRow(1, "AB1", STORE, 750, 750_000),
  ...ALEX.map((area, index) => detailRow(10 + index, area, PHARMACY, 100, 100_000)),
];

// A direct order booked on Alex West (folds into that area's row) and one naming only the region
// (becomes the region's synthetic "Direct" row, which has no invoice line at all).
const DIRECT_CELLS: MonthlyClosingDirectCell[] = [
  { areaCode: "AB2", productCode: PRODUCT, regionCode: "AB", salesUnits: 30, salesValue: 20_370 },
  { areaCode: "", productCode: PRODUCT, regionCode: "AB", salesUnits: 7, salesValue: 4_900 },
];

function detailsFor(rows: ClosingDetailRow[]): ClosingDetailsResult {
  return {
    availableLines: [LINE],
    availablePeriods: [PERIOD],
    canRevealConfidential: false,
    confidentialIncluded: false,
    filteredRowCount: rows.length,
    line: LINE,
    options: buildFilterOptions(rows),
    outOfScope: false,
    page: 1,
    pageSize: rows.length,
    period: PERIOD,
    reconciliation: {
      areaMismatches: summarize(rows, (row) => row.areaMismatch),
      closingHeadline: summarize(rows, countsInClosingHeadline),
      excludedConfidential: summarize(rows, (row) => row.isConfidential),
      excludedDirect: summarize(rows, (row) => row.isDirect),
      includedInClosing: summarize(rows, (row) => row.includedInClosing),
      missingClientCode: summarize(rows, (row) => row.missingClientCode),
      unmappedBricks: summarize(rows, (row) => row.brickUnmapped),
    },
    rows,
    totals: summarize(rows, () => true),
  };
}

function cell(salesUnits: number, salesValue: number): MonthlyClosingCell {
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

/** The distributor-only (retail) matrix the closing RPC would return for MONTH_ROWS. */
function retailMatrix(): MonthlyClosingMatrix {
  const areas = ALEX.map((code) => {
    const own = MONTH_ROWS.filter((row) => row.areaCode === code);
    const cells = [cell(
      own.reduce((sum, row) => sum + row.qty, 0),
      own.reduce((sum, row) => sum + row.salesValue, 0),
    )];
    return {
      areaCode: code,
      areaName: AREA_NAMES[code],
      cells,
      kind: "area" as const,
      regionCode: "AB",
      regionName: "Alex-BHR",
      rowTotal: cells[0],
    };
  });
  const grand = cell(
    areas.reduce((sum, area) => sum + area.cells[0].salesUnits, 0),
    areas.reduce((sum, area) => sum + area.cells[0].salesValue, 0),
  );
  return {
    availableLines: [LINE],
    availablePeriods: [PERIOD],
    columns: [{ family: "Milk", productCode: PRODUCT, productName: PRODUCT_NAME }],
    grandTotal: { cells: [grand], kind: "grandTotal", rowTotal: grand },
    line: LINE,
    period: PERIOD,
    regions: [{
      areas,
      regionCode: "AB",
      regionName: "Alex-BHR",
      subtotal: { cells: [grand], kind: "regionSubtotal", regionCode: "AB", regionName: "Alex-BHR", rowTotal: grand },
    }],
  } as unknown as MonthlyClosingMatrix;
}

function comparisonFor(rows: ClosingDetailRow[]) {
  const areaCodes = [...new Set(rows.map((row) => row.areaCode))];
  return assembleComparison({
    brickRows: rows.map((row) => ({
      areaCode: row.areaCode, brickId: row.brickId, distributorCode: "PS",
      regionCode: "AB", units: row.qty, value: row.salesValue,
    })),
    customerRows: rows.map((row) => ({
      areaCode: row.areaCode, brickId: row.brickId, clientCode: row.clientCode, clientName: row.clientName,
      distributorCode: "PS", regionCode: "AB", units: row.qty, value: row.salesValue,
    })),
    distProductRows: rows.map((row) => ({
      areaCode: row.areaCode, distributorCode: "PS", productCode: PRODUCT, productName: PRODUCT_NAME,
      regionCode: "AB", units: row.qty, value: row.salesValue,
    })),
    line: LINE,
    maps: {
      areaName: new Map(ALEX.map((code) => [code, AREA_NAMES[code]])),
      areaRegion: new Map(ALEX.map((code) => [code, "AB"])),
      distributorName: new Map([["PS", "Pharma Serve"]]),
      regionName: new Map([["AB", "Alex-BHR"]]),
    },
    masterAreas: areaCodes.map((code) => ({ areaCode: code, areaName: AREA_NAMES[code] ?? code, regionCode: "AB" })),
    masterBricks: areaCodes.map((code) => ({ areaCode: code, brickId: `B-${code}`, brickName: `${code} brick`, regionCode: "AB" })),
    period: PERIOD,
  });
}

/**
 * What app/api/sales/monthly-closing/export/route.ts does with a whole-month or place-filtered
 * export: the master (retail + direct) and its retail half are filtered alike, the ONE split is
 * written back to both, and the workbook receives the landed split cell by cell.
 */
async function exportWorkbook(areaCodes: string[]) {
  const retailWhole = retailMatrix();
  const masterWhole = injectDirectIntoMatrix(retailWhole, DIRECT_CELLS);
  const narrow = (matrix: MonthlyClosingMatrix) =>
    areaCodes.length > 0 ? filterMonthlyClosingMatrix(matrix, { areaCodes }) : matrix;
  const master = narrow(masterWhole);
  const retail = narrow(retailWhole);
  const scopedAreaCodes = areaCodes.length > 0
    ? master.regions.flatMap((region) => region.areas.map((area) => area.areaCode))
    : [];
  const monthRows = detailsFor(MONTH_ROWS);
  const { details, net } = prepareClosingStoreSplit(monthRows, scopedAreaCodes);
  const { applied, cells, matrix: workbookMatrix } = applyStoreSplitToMatrix(master, net);
  const buffer = await buildMonthlyClosingWorkbook(workbookMatrix, comparisonFor(details.rows), details, {
    channels: {
      directCells: fileDirectCellsUnderMatrixRegions(DIRECT_CELLS, masterWhole),
      retail: applyStoreSplitToMatrix(retail, net).matrix,
    },
    filterNote: areaCodes.length > 0 ? `Filtered export — Area: ${areaCodes.join(", ")}.` : undefined,
    storeSplitApplied: applied,
    storeSplitCells: cells,
    storeSplitRows: monthRows.rows,
    storeSplitScopeAreaCodes: scopedAreaCodes,
  });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  return { applied, book, cells, matrix: workbookMatrix };
}

type SheetCell = ExcelJS.CellValue;

/** A cell's number: a plain number, or a formula's cached result. ExcelJS drops a cached ZERO on
 *  write, so a formula with no result is read as 0. */
function numberIn(value: SheetCell): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "formula" in value) {
    const result = (value as { result?: unknown }).result;
    return typeof result === "number" ? result : 0;
  }
  return Number(value ?? 0) || 0;
}

type TotalRow = { at: number; values: Record<string, SheetCell> };

/** The Total sheet's area × product grid, row by row, stopping at its TOTAL row (also returned). */
function totalGrid(book: ExcelJS.Workbook): { rows: TotalRow[]; total: TotalRow } {
  const sheet = book.getWorksheet("Total");
  assert.ok(sheet, "the workbook has a Total sheet");
  let headers: string[] | null = null;
  const rows: TotalRow[] = [];
  let total: TotalRow | null = null;
  sheet.eachRow((row, at) => {
    if (total) return;
    const first = row.getCell(1).value;
    if (!headers) {
      if (first === "Region") {
        headers = [];
        row.eachCell({ includeEmpty: true }, (entry, column) => { headers![column] = String(entry.value ?? ""); });
      }
      return;
    }
    const values: Record<string, SheetCell> = {};
    headers.forEach((name, column) => { if (name) values[name] = row.getCell(column).value; });
    if (first === "TOTAL") total = { at, values };
    else rows.push({ at, values });
  });
  assert.ok(headers, "the Total sheet has its grid header row");
  assert.ok(total, "the Total sheet's grid ends in a TOTAL row");
  return { rows, total: total! };
}

/** Every area × product cell on the Closing Matrix, keyed region|area|product. */
function matrixCells(matrix: MonthlyClosingMatrix): Map<string, { units: number; value: number }> {
  const cells = new Map<string, { units: number; value: number }>();
  matrix.regions.forEach((region) => region.areas.forEach((area) => area.cells.forEach((entry, index) => {
    const productCode = matrix.columns[index]?.productCode ?? "";
    cells.set(`${region.regionCode}|${area.areaCode}|${productCode}`, { units: entry.salesUnits, value: entry.salesValue });
  })));
  return cells;
}

function assertTotalMatchesMatrix(book: ExcelJS.Workbook, matrix: MonthlyClosingMatrix, label: string) {
  const { rows, total } = totalGrid(book);
  const byKey = new Map(rows.map((row) => [
    `${row.values["Region Code"]}|${row.values["Area Code"]}|${row.values["Product Code"]}`,
    row,
  ]));

  for (const [key, expected] of matrixCells(matrix)) {
    if (expected.units === 0 && expected.value === 0) continue;
    const row = byKey.get(key);
    assert.ok(row, `${label}: the Closing Matrix cell ${key} has a row on the Total sheet`);
    assert.ok(
      Math.abs(numberIn(row.values["Sales Value"]) - expected.value) < 0.005,
      `${label}: ${key} reads ${numberIn(row.values["Sales Value"])} on the Total sheet and ${expected.value} on the `
        + "Closing Matrix — every area must agree, not only the grand total (owner, 2026-09-18)",
    );
    assert.ok(
      Math.abs(numberIn(row.values["Sales Units"]) - expected.units) < 1e-6,
      `${label}: ${key} Sales Units ${numberIn(row.values["Sales Units"])} must equal the matrix's ${expected.units}`,
    );
  }

  // Sales is a formula over its own row, so the file recalculates from the Data sheet.
  for (const row of rows) {
    const salesValue = row.values["Sales Value"] as { formula?: string } | null;
    assert.equal(salesValue?.formula, `H${row.at}+J${row.at}+L${row.at}`, `${label}: Sales Value is Data + Store Split + Direct on row ${row.at}`);
    const salesUnits = row.values["Sales Units"] as { formula?: string } | null;
    assert.equal(salesUnits?.formula, `F${row.at}+I${row.at}+K${row.at}`, `${label}: Sales Units is Data + Store Split + Direct on row ${row.at}`);
    assert.ok(
      Math.abs(
        numberIn(row.values["Data Value"]) + numberIn(row.values["Store Split Value"]) + numberIn(row.values["Direct Value"])
          - numberIn(row.values["Sales Value"]),
      ) < 0.005,
      `${label}: row ${row.at}'s cached Sales Value is its own three parts`,
    );
  }

  assert.ok(
    Math.abs(numberIn(total.values["Sales Value"]) - matrix.grandTotal.rowTotal.salesValue) < 0.005,
    `${label}: the TOTAL row's Sales Value ${numberIn(total.values["Sales Value"])} must equal the Closing Matrix `
      + `grand total ${matrix.grandTotal.rowTotal.salesValue}`,
  );
}

/** The reconciliation row starting `prefix`, value column. */
function reconciliationValue(book: ExcelJS.Workbook, prefix: string): number | null {
  let found: number | null = null;
  book.getWorksheet("Total")?.eachRow((row) => {
    if (String(row.getCell(1).value ?? "").startsWith(prefix)) found = numberIn(row.getCell(3).value);
  });
  return found;
}

async function runWholeMonthTests() {
  const { applied, book, cells, matrix } = await exportWorkbook([]);

  // Fixture sanity: the split and the direct really move area figures, so the old grid disagreed.
  const alexEast = matrixCells(matrix).get(`AB|AB1|${PRODUCT}`);
  assert.equal(alexEast?.value, 350_000, "fixture: Alex East keeps a third of its store's 750,000 plus its pharmacy");
  const alexWest = matrixCells(matrix).get(`AB|AB2|${PRODUCT}`);
  assert.equal(alexWest?.value, 100_000 + 250_000 + 20_370, "fixture: Alex West gains a third of the store and its direct order");
  assert.equal(matrixCells(matrix).get(`AB|DIRECT|${PRODUCT}`)?.value, 4_900, "fixture: the region-only order is the region's Direct row");

  // applyStoreSplitToMatrix reports where the split landed, and it sums to what it applied.
  assert.equal(cells.size, 3, "the split landed on all three Alexandria areas");
  const landed = [...cells.values()].reduce((sum, entry) => sum + entry.value, 0);
  assert.ok(Math.abs(landed - applied.value) < 1e-6, `the landed cells sum to ${landed}, the applied total is ${applied.value}`);
  assert.ok(Math.abs(landed) < 1e-6, "a whole-month split nets to zero");

  // The ruling itself, first, so a regression names it before any column-level detail.
  assertTotalMatchesMatrix(book, matrix, "whole month");

  const { rows } = totalGrid(book);
  const east = rows.find((row) => row.values["Area Code"] === "AB1");
  assert.equal(numberIn(east?.values["Data Value"] ?? null), 850_000, "Data Value is still the Data sheet's own invoice lines");
  assert.equal(numberIn(east?.values["Store Split Value"] ?? null), -500_000, "Alex East gives two thirds of its store away");
  const direct = rows.find((row) => row.values["Area Code"] === "DIRECT");
  assert.ok(direct, "the region's Direct row has its own line on the Total sheet");
  assert.equal(numberIn(direct.values["Data Value"]), 0, "the Direct row sums no Data rows — it has no invoice line");
  assert.ok(
    !(direct.values["Data Value"] && typeof direct.values["Data Value"] === "object"),
    "the Direct row carries no SUMIFS: every region's Direct row shares one area code, so a SUMIFS would sum them all",
  );

  // The reconciliation block is untouched and still ties.
  const data = reconciliationValue(book, "Data sheet —") ?? 0;
  const directBridge = reconciliationValue(book, "+ Direct orders") ?? 0;
  const headline = reconciliationValue(book, "Closing Matrix grand total") ?? 0;
  assert.ok(Math.abs(data + directBridge - headline) < 0.005, "Data + direct still reconciles to the Closing Matrix grand total");
}

async function runFilteredTests() {
  // Alex West alone: its incoming share comes from a store the filter excludes.
  const { book, matrix } = await exportWorkbook(["AB2"]);
  assert.ok(matrixCells(matrix).get(`AB|AB2|${PRODUCT}`), "fixture: the filtered matrix keeps Alex West");
  assertTotalMatchesMatrix(book, matrix, "filtered to Alex West");
}

/** The two callers the tests cannot run must still hand the per-cell split to the workbook. */
function runWiringChecks() {
  const route = readFileSync(new URL("../app/api/sales/monthly-closing/export/route.ts", import.meta.url), "utf8");
  assert.match(route, /cells:\s*storeSplitCells[\s\S]{0,120}applyStoreSplitToMatrix\(rebuiltMatrix,\s*storeSplitNet\)/,
    "the export route keeps the landed split cells from the same applyStoreSplitToMatrix call as the matrix");
  assert.match(route, /\n\s*storeSplitCells,\r?\n/, "the export route passes storeSplitCells to the workbook");
  assert.match(route, /\n\s*directPlacedCells,\r?\n/, "the export route passes directPlacedCells for a row-level filter");

  const consolidated = readFileSync(new URL("../src/lib/sales/monthly-closing-consolidated-export.ts", import.meta.url), "utf8");
  assert.match(consolidated, /\n\s*storeSplitCells,\r?\n/, "the consolidated export passes its summed storeSplitCells to the workbook");
}

export async function runClosingTotalSheetMatchesMatrixTests() {
  await runWholeMonthTests();
  await runFilteredTests();
  runWiringChecks();
  console.log("closing-total-sheet-matches-matrix: ok");
}
