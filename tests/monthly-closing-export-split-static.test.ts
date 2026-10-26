import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { ClosingExportData, MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";
import { areaProductKey } from "../src/lib/sales/store-sales-city-split.ts";
import { applyStoreSplitToMatrix } from "../src/lib/sales/store-split-matrix.ts";

// The store city split moves wholesaler sales between the areas of one city. The hidden Calc sheet
// holds the UNSPLIT distributor rows, so while the Closing Matrix sheet wrote its cells as live
// SUMIFS over that sheet, any Excel recalculation reverted every split-touched area to its
// pre-split value while the Store Split tab kept telling the post-split story.
//
// That was originally patched per row, by flagging the touched ones `storeSplitAdjusted` and
// rendering only those static. This file used to pin that behaviour — including the assertion that
// UNTOUCHED rows keep their live formulas. That design was withdrawn on 2026-08-11: it is a
// hand-maintained list of exceptions, and the organogram region grouping was never added to it, so
// 18 of 22 region subtotals exported wrong. See closing-export-matches-screen.test.ts for the
// invariant that replaced it.
//
// What this file pins now, from the store split's own angle:
//
//   1. `applyStoreSplitToMatrix` still flags exactly the rows it moves — the flag is no longer what
//      drives rendering, but it is still the module's contract and other callers read it.
//   2. Every row on the exported sheet carries its POST-split figure, whether or not it was
//      flagged. Static-but-stale would be the same bug in new clothes.
//   3. No cell on the sheet reaches the Calc sheet, so no recalculation can revert any of it.

const PRODUCT = { family: "Milk", productCode: "LA001", productName: "Lacto Advanced 1" };

function cell(salesUnits: number, salesValue: number, targetValue: number | null = null): MonthlyClosingCell {
  return {
    achievement: targetValue === null || targetValue === 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits: targetValue === null ? null : targetValue / 100,
    targetValue,
  };
}

function areaRow(regionCode: string, regionName: string, areaCode: string, areaName: string, cells: MonthlyClosingCell[]) {
  return {
    areaCode,
    areaName,
    cells,
    kind: "area" as const,
    regionCode,
    regionName,
    rowTotal: cell(
      cells.reduce((sum, c) => sum + c.salesUnits, 0),
      cells.reduce((sum, c) => sum + c.salesValue, 0),
    ),
  };
}

// Three areas of one Menoufia city plus an untouched Cairo region, one product, June 2026. Two
// regions matter: a single-region matrix renames its bottom line "<Region> — Region Total", and the
// untouched region proves a split in one region never disturbs another.
function buildMatrix(): MonthlyClosingMatrix {
  return {
    availableLines: ["Pedia"],
    availablePeriods: ["2026-06"],
    columns: [PRODUCT],
    grandTotal: { cells: [cell(190, 58_000, 60_000)], kind: "grandTotal", rowTotal: cell(190, 58_000, 60_000) },
    line: "Pedia",
    period: "2026-06",
    regions: [
      {
        areas: [
          areaRow("D1", "Delta (1)", "D12", "Menoufia 1", [cell(100, 30_000, 40_000)]),
          areaRow("D1", "Delta (1)", "D13", "Menoufia 2", [cell(40, 12_000, 20_000)]),
          areaRow("D1", "Delta (1)", "D14", "Menoufia 3", [cell(20, 6_000)]),
        ],
        regionCode: "D1",
        regionName: "Delta (1)",
        subtotal: {
          cells: [cell(160, 48_000, 60_000)],
          kind: "regionSubtotal",
          regionCode: "D1",
          regionName: "Delta (1)",
          rowTotal: cell(160, 48_000, 60_000),
        },
      },
      {
        areas: [areaRow("CA", "Cairo", "CA3", "Cairo Centers", [cell(30, 10_000)])],
        regionCode: "CA",
        regionName: "Cairo",
        subtotal: {
          cells: [cell(30, 10_000)],
          kind: "regionSubtotal",
          regionCode: "CA",
          regionName: "Cairo",
          rowTotal: cell(30, 10_000),
        },
      },
    ],
  };
}

// The UNSPLIT truth the hidden Calc sheet is built from — one distributor row per area, summing
// exactly to the pre-split matrix cells, which is how production builds the comparison data.
const DIST_PRODUCT: ClosingExportData["distProduct"] = [
  { areaCode: "D12", areaName: "Menoufia 1", distributorCode: "UCP", distributorName: "UCP", productCode: "LA001", productName: "Lacto Advanced 1", regionCode: "D1", regionName: "Delta (1)", units: 100, value: 30_000 },
  { areaCode: "D13", areaName: "Menoufia 2", distributorCode: "UCP", distributorName: "UCP", productCode: "LA001", productName: "Lacto Advanced 1", regionCode: "D1", regionName: "Delta (1)", units: 40, value: 12_000 },
  { areaCode: "D14", areaName: "Menoufia 3", distributorCode: "UCP", distributorName: "UCP", productCode: "LA001", productName: "Lacto Advanced 1", regionCode: "D1", regionName: "Delta (1)", units: 20, value: 6_000 },
  { areaCode: "CA3", areaName: "Cairo Centers", distributorCode: "UCP", distributorName: "UCP", productCode: "LA001", productName: "Lacto Advanced 1", regionCode: "CA", regionName: "Cairo", units: 30, value: 10_000 },
];

function buildComparison(): MonthlyClosingComparison {
  return {
    areaByDistributor: [],
    avgPrice: [],
    byDistributor: [],
    coverage: [],
    data: {
      areaByDist: [],
      bricks: [],
      customers: [],
      distProduct: DIST_PRODUCT,
      masterAreas: [
        { areaCode: "D12", areaName: "Menoufia 1", regionName: "Delta (1)" },
        { areaCode: "D13", areaName: "Menoufia 2", regionName: "Delta (1)" },
        { areaCode: "D14", areaName: "Menoufia 3", regionName: "Delta (1)" },
        { areaCode: "CA3", areaName: "Cairo Centers", regionName: "Cairo" },
      ],
      masterBricks: [],
      productByDist: [],
    },
    distributors: [{ code: "UCP", name: "UCP" }],
    insights: [],
    line: "Pedia",
    mix: { distributor: [], product: [], region: [] },
    national: { areaCount: 4, customerCount: 0, productCount: 1, units: 190, value: 58_000 },
    pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
    period: "2026-06",
    productByDistributor: [],
    rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
    regionByDistributor: [],
    totalAreas: 4,
    totalBricks: 0,
    whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
  };
}

function isFormulaValue(value: ExcelJS.CellValue): value is ExcelJS.CellFormulaValue {
  return typeof value === "object" && value !== null && "formula" in value;
}

async function auditWorkbook(matrix: MonthlyClosingMatrix) {
  const buffer = await buildMonthlyClosingWorkbook(matrix, buildComparison());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Closing Matrix");
  assert.ok(sheet, "the workbook must contain the Closing Matrix sheet");

  const calcBacked: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cellRef) => {
      const value = cellRef.value;
      if (!isFormulaValue(value)) return;
      if (String(value.formula ?? "").includes("Calc!")) calcBacked.push(`${cellRef.address}: =${value.formula}`);
    });
  });
  return { calcBacked, sheet };
}

// Layout of writeMatrixSheet with exactly ONE product: cols 1-2 are Area / Area Name, the product
// block spans 3-9 (Units, Value, Tgt Units, Tgt Value, Ach %, two shares), Grand Total opens at 10.
const UNITS_COL = 3;
const VALUE_COL = 4;
const ROW_TOTAL_COL = 10;

function findRow(sheet: ExcelJS.Worksheet, column: number, text: string): ExcelJS.Row {
  let found: ExcelJS.Row | null = null;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (!found && String(row.getCell(column).value ?? "") === text) found = row;
  });
  assert.ok(found, `the Closing Matrix sheet must contain a row labelled "${text}"`);
  return found;
}

// The matrix shows geography by NAME (owner, 2026-10-26: "never use code always use name"), so a
// row is found by the area name, or "<Region> (Region)" for a subtotal, in the Area column.
const MATRIX_LABEL: Record<string, string> = { D12: "Menoufia 1", D13: "Menoufia 2", D14: "Menoufia 3", CA3: "Cairo Centers", D1: "Delta (1) (Region)", CA: "Cairo (Region)" };
function findMatrixRow(sheet: ExcelJS.Worksheet, code: string): ExcelJS.Row {
  return findRow(sheet, 2, MATRIX_LABEL[code] ?? code);
}

const NO_CALC = "no Closing Matrix cell may reference the hidden Calc sheet — it holds the UNSPLIT "
  + "distributor rows, so any SUMIFS over it recalculates the split away";

export async function runMonthlyClosingExportSplitStaticTests() {
  // ── Scenario A: the classic split — one city, two areas, net zero for the region ────────────
  const base = buildMatrix();
  // applyStoreSplitToMatrix also reports what crossed the matrix's edge (see
  // monthly-closing-export-store-split-filtered.test.ts); only the matrix matters here.
  const { matrix: split } = applyStoreSplitToMatrix(
    base,
    new Map([
      [areaProductKey("D12", "LA001"), { qty: -30, value: -9_000 }],
      [areaProductKey("D13", "LA001"), { qty: 30, value: 9_000 }],
    ]),
  );
  assert.equal(split.regions[0]?.areas[0]?.cells[0]?.salesValue, 21_000, "fixture sanity: the split moved 9,000 out of Menoufia 1");
  assert.equal(split.regions[0]?.areas[0]?.storeSplitAdjusted, true, "a touched area must arrive at the export flagged");
  assert.equal(split.regions[0]?.areas[1]?.storeSplitAdjusted, true, "the receiving area is flagged too");
  assert.equal(split.regions[0]?.areas[2], base.regions[0]?.areas[2], "an untouched area passes through as the same unflagged object");
  assert.equal(split.regions[0]?.subtotal.storeSplitAdjusted, undefined, "a delta that cancels inside the region leaves the subtotal unflagged");
  assert.equal(split.grandTotal.storeSplitAdjusted, undefined, "a whole-month split leaves the grand total unflagged");

  const a = await auditWorkbook(split);
  assert.deepEqual(a.calcBacked, [], NO_CALC);

  // Every row carries its post-split figure — the flagged ones AND the untouched ones, which used
  // to be live formulas and are now values like everything else.
  const rowsA: [string, number, number][] = [
    ["D12", 70, 21_000],
    ["D13", 70, 21_000],
    ["D14", 20, 6_000],
    ["D1", 160, 48_000],
    ["CA", 30, 10_000],
    ["CA3", 30, 10_000],
  ];
  for (const [label, units, value] of rowsA) {
    const row = findMatrixRow(a.sheet, label);
    assert.equal(row.getCell(UNITS_COL).value, units, `${label} Units must be the post-split figure ${units}`);
    assert.equal(row.getCell(VALUE_COL).value, value, `${label} Value must be the post-split figure ${value}`);
    assert.equal(row.getCell(ROW_TOTAL_COL).value, value, `${label} row total must be the post-split figure`);
  }
  assert.equal(
    findRow(a.sheet, 2, "National Grand Total").getCell(ROW_TOTAL_COL).value,
    58_000,
    "a whole-month split conserves the grand total, and the sheet states it as a value",
  );

  // ── Scenario B: a one-sided move — the counterpart areas fell outside the matrix (filtered
  // export, or a city crossing regions), so the region and grand nets do NOT cancel ─────────────
  const { matrix: oneSided } = applyStoreSplitToMatrix(
    buildMatrix(),
    new Map([[areaProductKey("D13", "LA001"), { qty: 5, value: 1_000 }]]),
  );
  assert.equal(oneSided.regions[0]?.subtotal.storeSplitAdjusted, true, "a one-sided move must flag the region subtotal");
  assert.equal(oneSided.grandTotal.storeSplitAdjusted, true, "a one-sided move must flag the grand total");

  const b = await auditWorkbook(oneSided);
  assert.deepEqual(b.calcBacked, [], NO_CALC);
  assert.equal(findMatrixRow(b.sheet, "D13").getCell(VALUE_COL).value, 13_000, "the receiving area carries its post-split value");
  assert.equal(findMatrixRow(b.sheet, "D1").getCell(VALUE_COL).value, 49_000, "the region subtotal carries the post-split figure");
  assert.equal(
    findRow(b.sheet, 2, "National Grand Total").getCell(ROW_TOTAL_COL).value,
    59_000,
    "a one-sided move moves the grand total, and the sheet states the moved figure",
  );
  assert.equal(findMatrixRow(b.sheet, "D12").getCell(VALUE_COL).value, 30_000, "an area the one-sided move never touched keeps its own figure");
  assert.equal(findMatrixRow(b.sheet, "CA").getCell(VALUE_COL).value, 10_000, "a whole region the split never touched is unchanged");
}
