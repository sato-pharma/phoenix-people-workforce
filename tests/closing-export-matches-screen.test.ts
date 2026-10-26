import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { ClosingExportData, MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";

// THE EXPORTED CLOSING MATRIX MUST EQUAL THE ONE ON SCREEN. PERMANENTLY.
//
// The bug this pins (found 2026-08-11, /sales/monthly-closing): the Closing Matrix sheet wrote each
// Units/Value cell as a live =SUMIFS over the hidden Calc sheet, keeping the screen's own number
// only as that formula's CACHED result. ExcelJS stamps calcId 171027 and writes no calcChain.xml,
// so Excel fully recalculates ON OPEN and throws the cached values away.
//
// The Calc sheet holds phx_closing_distributor_product — distributor invoice lines keyed by the
// GEOGRAPHIC region_code. The screen's matrix is that SQL plus TypeScript transforms the Calc sheet
// knows nothing about, and one of them re-labels the very key the subtotal SUMIFS matched on:
// applyOperationalRegions groups by the ORGANOGRAM (au.line_area_map.operational_region_code).
// Anti Infective's UE-1 / UE-2 have no geographic equivalent at all, so those subtotals
// recalculated to ZERO. Measured on production for 2026-07, 18 of 22 region subtotals across the
// three lines were wrong the moment the file opened — over 1.1M EGP of misstatement.
//
// Earlier transforms (direct injection, the store city split, the Fayoum/Beni Suef area merge) had
// each been patched with a "render this row static" flag. That is a hand-maintained list which must
// grow with every new closing rule, and the organogram grouping was never added to it. So this file
// does NOT pin "the right rows are flagged". It pins the invariant that makes the list unnecessary:
//
//   1. NO cell on the Closing Matrix sheet may reference the Calc sheet. At all.
//   2. Every sales number on the sheet equals the matrix model exactly.
//   3. The formulas that remain reference only THIS sheet, and recalculate to their cached values.
//
// Assertion 4 proves the fixture is a real reproduction rather than a tautology: it replays the
// SUMIFS the old code emitted and confirms it disagrees with the model. Without that, this test
// would still pass against a fixture where geography and organogram happened to coincide.

const PRODUCT = { family: "Suspension", productCode: "AX001", productName: "Amoxicare" };

function cell(salesUnits: number, salesValue: number, targetValue: number | null = null): MonthlyClosingCell {
  return {
    achievement: targetValue === null || targetValue === 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits: targetValue === null ? null : targetValue / 100,
    targetValue,
  };
}

type AreaExtras = { isDirect?: boolean; storeSplitAdjusted?: boolean };

function areaRow(
  regionCode: string,
  regionName: string,
  areaCode: string,
  areaName: string,
  cells: MonthlyClosingCell[],
  extras: AreaExtras = {},
) {
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
    // Where the area sits GEOGRAPHICALLY — the code the Calc sheet actually carries. Present on
    // every area here precisely because the organogram moved all of them.
    sourceRegionCode: "UE",
    sourceRegionName: "Upper Egypt",
    ...extras,
  };
}

// Anti Infective's real shape: one geographic "UE" grouped into two DM territories, UE-1 and UE-2,
// neither of which exists as a geographic region code anywhere in the Calc sheet.
function buildMatrix(ue1Cell: MonthlyClosingCell, ue1Extras: AreaExtras, ue2Extras: AreaExtras): MonthlyClosingMatrix {
  const ue1 = areaRow("UE-1", "Upper Egypt 1", "UE1", "Minia 1", [ue1Cell], ue1Extras);
  const ue2 = areaRow("UE-1", "Upper Egypt 1", "UE2", "Minia 2", [cell(90, 27_000, 30_000)], ue2Extras);
  const ue3 = areaRow("UE-2", "Upper Egypt 2", "UE3", "Assiut 1", [cell(40, 12_000, 15_000)]);
  const region1Units = ue1Cell.salesUnits + 90;
  const region1Value = ue1Cell.salesValue + 27_000;
  return {
    availableLines: ["Anti Infective"],
    availablePeriods: ["2026-07"],
    columns: [PRODUCT],
    grandTotal: {
      cells: [cell(region1Units + 40, region1Value + 12_000, 85_000)],
      kind: "grandTotal",
      rowTotal: cell(region1Units + 40, region1Value + 12_000, 85_000),
    },
    line: "Anti Infective",
    period: "2026-07",
    regions: [
      {
        areas: [ue1, ue2],
        regionCode: "UE-1",
        regionName: "Upper Egypt 1",
        subtotal: {
          cells: [cell(region1Units, region1Value, 70_000)],
          kind: "regionSubtotal",
          regionCode: "UE-1",
          regionName: "Upper Egypt 1",
          rowTotal: cell(region1Units, region1Value, 70_000),
        },
      },
      {
        areas: [ue3],
        regionCode: "UE-2",
        regionName: "Upper Egypt 2",
        subtotal: {
          cells: [cell(40, 12_000, 15_000)],
          kind: "regionSubtotal",
          regionCode: "UE-2",
          regionName: "Upper Egypt 2",
          rowTotal: cell(40, 12_000, 15_000),
        },
      },
    ],
  };
}

// Scenario A — all three transforms that ever needed a static flag, at once: UE1 carries direct
// merged into a real area (July 2026's hand-mapped orders), UE2 is store-split-adjusted, and the
// whole grid is grouped by the organogram.
const withTransforms = () => buildMatrix(cell(120, 36_000, 40_000), { isDirect: true }, { storeSplitAdjusted: true });

// Scenario B — the CNS shape, and the one that actually shipped wrong. Organogram grouping and
// NOTHING else: every area's value equals its Calc-sheet invoice row exactly, so the AREA rows
// would have survived a SUMIFS untouched. Only the REGION subtotals break. CNS has no direct
// anywhere, so `hasMergedDirect` was false and every one of its subtotals stayed a live formula —
// which is why six CNS subtotals exported wrong while its area rows looked perfect.
const organogramOnly = () => buildMatrix(cell(90, 27_000, 40_000), {}, {});

// The Calc sheet's truth: distributor invoice lines, keyed by the GEOGRAPHIC region. Note there is
// no "UE-1" or "UE-2" anywhere here — that is the whole point. UE1's value is also short of the
// matrix cell by the direct money, which never reaches a distributor invoice line.
const DIST_PRODUCT: ClosingExportData["distProduct"] = [
  { areaCode: "UE1", areaName: "Minia 1", distributorCode: "IS-S", distributorName: "Ibn Sina", productCode: "AX001", productName: "Amoxicare", regionCode: "UE", regionName: "Upper Egypt", units: 90, value: 27_000 },
  { areaCode: "UE2", areaName: "Minia 2", distributorCode: "IS-S", distributorName: "Ibn Sina", productCode: "AX001", productName: "Amoxicare", regionCode: "UE", regionName: "Upper Egypt", units: 90, value: 27_000 },
  { areaCode: "UE3", areaName: "Assiut 1", distributorCode: "IS-S", distributorName: "Ibn Sina", productCode: "AX001", productName: "Amoxicare", regionCode: "UE", regionName: "Upper Egypt", units: 40, value: 12_000 },
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
        { areaCode: "UE1", areaName: "Minia 1", regionName: "Upper Egypt" },
        { areaCode: "UE2", areaName: "Minia 2", regionName: "Upper Egypt" },
        { areaCode: "UE3", areaName: "Assiut 1", regionName: "Upper Egypt" },
      ],
      masterBricks: [],
      productByDist: [],
    },
    distributors: [{ code: "IS-S", name: "Ibn Sina" }],
    insights: [],
    line: "Anti Infective",
    mix: { distributor: [], product: [], region: [] },
    national: { areaCount: 3, customerCount: 0, productCount: 1, units: 220, value: 66_000 },
    pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
    period: "2026-07",
    productByDistributor: [],
    rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
    regionByDistributor: [],
    totalAreas: 3,
    totalBricks: 0,
    whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
  };
}

// Layout of writeMatrixSheet with exactly ONE product: cols 1-2 are Area / Area Name, the product
// block spans 3-9 (Units, Value, Tgt Units, Tgt Value, Ach %, two shares), Grand Total opens at 10.
const UNITS_COL = 3;
const VALUE_COL = 4;
const ROW_TOTAL_COL = 10;

function isFormulaValue(value: ExcelJS.CellValue): value is ExcelJS.CellFormulaValue {
  return typeof value === "object" && value !== null && "formula" in value;
}

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
const MATRIX_LABEL: Record<string, string> = {
  UE1: "Minia 1", UE2: "Minia 2", UE3: "Assiut 1", UE: "Upper Egypt (Region)",
  "UE-1": "Upper Egypt 1 (Region)", "UE-2": "Upper Egypt 2 (Region)",
};
function findMatrixRow(sheet: ExcelJS.Worksheet, code: string): ExcelJS.Row {
  return findRow(sheet, 2, MATRIX_LABEL[code] ?? code);
}

async function auditWorkbook(matrix: MonthlyClosingMatrix) {
  const buffer = await buildMonthlyClosingWorkbook(matrix, buildComparison());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Closing Matrix");
  assert.ok(sheet, "the workbook must contain the Closing Matrix sheet");

  const calcBacked: string[] = [];
  const foreign: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cellRef) => {
      const value = cellRef.value;
      if (!isFormulaValue(value)) return;
      const formula = String(value.formula ?? "");
      if (formula.includes("Calc!")) calcBacked.push(`${cellRef.address}: =${formula}`);
      // A bare A1-style reference is this sheet; anything with a "!" points somewhere else.
      if (formula.includes("!")) foreign.push(`${cellRef.address}: =${formula}`);
    });
  });
  return { calcBacked, foreign, sheet };
}

const NO_CALC = "no Closing Matrix cell may reference the hidden Calc sheet — that sheet holds "
  + "distributor invoice lines keyed by GEOGRAPHIC region, so any SUMIFS over it recalculates past "
  + "direct, the store split, the area merge and the organogram grouping the screen applied";

const NO_FOREIGN = "a surviving formula on the Closing Matrix may reference only cells on the "
  + "Closing Matrix — a cross-sheet reference is a number this workbook can recalculate away from "
  + "the screen";

function assertRows(sheet: ExcelJS.Worksheet, rows: [string, number, number][]) {
  for (const [label, units, value] of rows) {
    const row = findMatrixRow(sheet, label);
    assert.equal(row.getCell(UNITS_COL).value, units, `${label} Units must equal the screen's ${units}`);
    assert.equal(row.getCell(VALUE_COL).value, value, `${label} Value must equal the screen's ${value}`);
    assert.equal(row.getCell(ROW_TOTAL_COL).value, value, `${label} row total must equal the screen's ${value}`);
  }
}

export async function runClosingExportMatchesScreenTests() {
  // ── Fixture sanity FIRST: prove this fixture still reproduces the production bug ────────────
  // Replay the SUMIFS the withdrawn code emitted for a region subtotal: sum the Calc sheet's value
  // column where its region column equals the row's key. The screen's key is the ORGANOGRAM code
  // and the Calc sheet only ever carries GEOGRAPHIC ones, so it comes back 0 while the screen says
  // 54,000. If this ever stops holding, every assertion below is proving nothing.
  const oldSumifsForUE1 = DIST_PRODUCT
    .filter((r) => r.regionCode.toUpperCase() === "UE-1")
    .reduce((sum, r) => sum + r.value, 0);
  assert.equal(
    oldSumifsForUE1,
    0,
    "fixture sanity: the organogram region code UE-1 must not exist in the Calc sheet — that "
      + "absence IS the bug, and without it this test cannot detect a regression",
  );

  // ── Scenario A: direct + store split + organogram grouping, all at once ─────────────────────
  const a = await auditWorkbook(withTransforms());
  assert.deepEqual(a.calcBacked, [], NO_CALC);
  assert.deepEqual(a.foreign, [], NO_FOREIGN);
  assertRows(a.sheet, [
    ["UE1", 120, 36_000],
    ["UE2", 90, 27_000],
    ["UE3", 40, 12_000],
    ["UE-1", 210, 63_000],
    ["UE-2", 40, 12_000],
  ]);
  assert.equal(findRow(a.sheet, 2, "National Grand Total").getCell(ROW_TOTAL_COL).value, 75_000, "the national grand total must equal the screen's");
  // Geography by NAME, never by code (owner, 2026-10-26: "in bricks and areas and overall never use
  // code always use name"). No cell of the Closing Matrix may print an area or region code.
  const geographyCodes = new Set(["UE", "UE1", "UE2", "UE3", "UE-1", "UE-2"]);
  const codeCells: string[] = [];
  a.sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cellRef) => {
      if (typeof cellRef.value === "string" && geographyCodes.has(cellRef.value.trim())) {
        codeCells.push(`${cellRef.address}: ${cellRef.value}`);
      }
    });
  });
  assert.deepEqual(codeCells, [], "the Closing Matrix names every area and region; it never prints a code");

  // The direct money is a second, independent way the Calc sheet falls short: UE1's invoice line is
  // 27,000 while the screen shows 36,000, the difference being direct orders, which never appear as
  // a distributor invoice line at all.
  assert.equal(DIST_PRODUCT.find((r) => r.areaCode === "UE1")?.value, 27_000, "fixture sanity: UE1's Calc-sheet invoice value");
  assert.equal(
    findMatrixRow(a.sheet, "UE1").getCell(VALUE_COL).value,
    36_000,
    "an area carrying merged direct must export the screen's figure, not its invoice-only subset",
  );

  // ── Scenario B: the CNS shape — organogram grouping and nothing else ────────────────────────
  // This is the one that shipped wrong. Every AREA value here equals its Calc row exactly, so the
  // area rows would have survived a SUMIFS and looked perfect; only the region subtotals broke.
  // With no direct anywhere, nothing set hasMergedDirect, so those subtotals stayed live formulas
  // keyed to a region code the Calc sheet has never heard of.
  const matrixB = organogramOnly();
  assert.equal(
    matrixB.regions[0]?.subtotal.rowTotal.salesValue,
    54_000,
    "fixture sanity: the UE-1 subtotal the screen shows",
  );
  assert.notEqual(
    oldSumifsForUE1,
    matrixB.regions[0]?.subtotal.rowTotal.salesValue,
    "fixture sanity: the withdrawn Calc-backed subtotal formula must disagree with the screen — "
      + "0 against 54,000, exactly what Anti Infective's UE-1 and UE-2 exported in production",
  );
  assert.ok(
    matrixB.regions.every((region) => region.areas.every((area) => area.isDirect !== true)),
    "fixture sanity: scenario B must carry NO direct, or hasMergedDirect would have masked the "
      + "subtotal formulas the way it did in scenario A",
  );

  const b = await auditWorkbook(matrixB);
  assert.deepEqual(b.calcBacked, [], NO_CALC);
  assert.deepEqual(b.foreign, [], NO_FOREIGN);
  assertRows(b.sheet, [
    ["UE1", 90, 27_000],
    ["UE2", 90, 27_000],
    ["UE3", 40, 12_000],
    ["UE-1", 180, 54_000],
    ["UE-2", 40, 12_000],
  ]);
  assert.equal(
    findRow(b.sheet, 2, "National Grand Total").getCell(ROW_TOTAL_COL).value,
    66_000,
    "the national grand total must equal the screen's",
  );
}
