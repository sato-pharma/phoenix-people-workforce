import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { ClosingExportData, MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";
import { areaProductKey } from "../src/lib/sales/store-sales-city-split.ts";
import { applyStoreSplitToMatrix } from "../src/lib/sales/store-split-matrix.ts";

// The Closing Matrix sheet writes every number as a live SUMIFS over the hidden Calc sheet, with
// the cached result showing until Excel recalculates. The Calc sheet holds the RAW distributor
// rows — it knows nothing of the store split — so before the per-row static fix, any
// recalculation (F9, or simply editing a cell) silently reverted every split-touched area to its
// pre-split value while the Store Split tab and the subtotals kept telling the post-split story.
//
// What this file pins, by rebuilding the workbook and replaying its own formulas:
//
//   1. Every live Calc-backed formula on the Closing Matrix sheet recalculates to EXACTLY the
//      value it was cached with. This is the invariant the bug broke, and it holds whatever the
//      layout: a formula whose recalculation disagrees with its cached value is a number that
//      changes the moment the reader touches the file.
//   2. A split-touched row (area / region subtotal / grand total) is written as static values.
//   3. The fix is PER-ROW, never sheet-wide: untouched areas, a subtotal whose city split
//      cancelled to zero, and the whole-month grand total all KEEP their live formulas — the
//      workbook's recalculate-me property is preserved everywhere it is still truthful.

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

// Three areas of one Menoufia city plus an untouched Cairo region, one product, June 2026 —
// deliberately NOT July 2026, whose merged direct orders force the whole sheet static and would
// mask the per-row behavior. Two regions matter: a single-region matrix renames its bottom line
// "<Region> — Region Total", and the untouched region proves the fix never leaks across regions.
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

// ── Replaying the sheet's own formulas against the Calc sheet it references ──
// A deliberately tiny evaluator for exactly the two shapes writeMatrixSheet emits against Calc:
// SUMIFS(range, critRange, "text", ...) and SUM(range). Anything else that claims to read Calc is
// reported as a failure rather than skipped — silently skipping is how an audit goes blind.

const CALC_RANGE = /^Calc!\$([A-Z]+)\$(\d+):\$([A-Z]+)\$(\d+)$/;

function splitTopLevelArgs(list: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of list) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === "," && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function rangeValues(calc: ExcelJS.Worksheet, token: string): ExcelJS.CellValue[] | null {
  const match = token.match(CALC_RANGE);
  if (!match || match[1] !== match[3]) return null;
  const values: ExcelJS.CellValue[] = [];
  for (let row = Number(match[2]); row <= Number(match[4]); row += 1) {
    values.push(calc.getCell(`${match[1]}${row}`).value);
  }
  return values;
}

function recomputeAgainstCalc(formula: string, calc: ExcelJS.Worksheet): number | null {
  const sumOnly = formula.match(/^SUM\((Calc!\$[A-Z]+\$\d+:\$[A-Z]+\$\d+)\)$/);
  if (sumOnly) {
    const values = rangeValues(calc, sumOnly[1]);
    if (!values) return null;
    return values.reduce((total: number, value) => total + (typeof value === "number" ? value : 0), 0);
  }
  const sumifs = formula.match(/^SUMIFS\((.+)\)$/);
  if (!sumifs) return null;
  const args = splitTopLevelArgs(sumifs[1]);
  if (args.length < 3 || args.length % 2 === 0) return null;
  const sumValues = rangeValues(calc, args[0]);
  if (!sumValues) return null;
  const criteria: { values: ExcelJS.CellValue[]; wanted: string }[] = [];
  for (let index = 1; index < args.length; index += 2) {
    const values = rangeValues(calc, args[index]);
    const wanted = args[index + 1].match(/^"(.*)"$/);
    if (!values || !wanted || values.length !== sumValues.length) return null;
    criteria.push({ values, wanted: wanted[1] });
  }
  let total = 0;
  for (let index = 0; index < sumValues.length; index += 1) {
    const row = sumValues[index];
    // SUMIFS text criteria are case-insensitive equality — the only criterion shape the matrix
    // sheet emits (always a quoted area / region / product code).
    const hit = criteria.every(
      (criterion) => String(criterion.values[index] ?? "").trim().toUpperCase() === criterion.wanted.trim().toUpperCase(),
    );
    if (hit) total += typeof row === "number" ? row : 0;
  }
  return total;
}

function isFormulaValue(value: ExcelJS.CellValue): value is ExcelJS.CellFormulaValue {
  return typeof value === "object" && value !== null && "formula" in value;
}

async function auditWorkbook(matrix: MonthlyClosingMatrix) {
  const buffer = await buildMonthlyClosingWorkbook(matrix, buildComparison());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Closing Matrix");
  const calc = workbook.getWorksheet("Calc");
  assert.ok(sheet, "the workbook must contain the Closing Matrix sheet");
  assert.ok(calc, "the workbook must contain the hidden Calc sheet the formulas reference");

  const mismatches: string[] = [];
  let liveChecked = 0;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cellRef) => {
      const value = cellRef.value;
      if (!isFormulaValue(value)) return;
      const formula = String(value.formula ?? "");
      if (!formula.includes("Calc!")) return; // shares/achievement reference the sheet itself
      liveChecked += 1;
      const cached = typeof value.result === "number" ? value.result : Number.NaN;
      const recomputed = recomputeAgainstCalc(formula, calc);
      if (recomputed === null) {
        mismatches.push(`${cellRef.address}: unparseable Calc formula =${formula}`);
        return;
      }
      if (!(Math.abs(recomputed - cached) < 1e-6)) {
        mismatches.push(`${cellRef.address}: =${formula} recalculates to ${recomputed}, cached ${cached}`);
      }
    });
  });
  return { liveChecked, mismatches, sheet };
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

const isStaticNumber = (cellRef: ExcelJS.Cell) => typeof cellRef.value === "number";
const isCalcFormula = (cellRef: ExcelJS.Cell) =>
  isFormulaValue(cellRef.value) && String(cellRef.value.formula ?? "").includes("Calc!");

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
  assert.deepEqual(
    a.mismatches,
    [],
    "every live Closing Matrix formula must recalculate to exactly its cached value — a mismatch means any Excel recalculation silently rewrites the closing to pre-split numbers (the store-split revert bug)",
  );
  assert.ok(
    a.liveChecked >= 8,
    `the sheet must still carry live Calc formulas to audit (saw ${a.liveChecked}) — zero live formulas would mean the whole sheet went static and this audit proves nothing`,
  );

  const d12 = findRow(a.sheet, 1, "D12");
  const d13 = findRow(a.sheet, 1, "D13");
  for (const [label, row] of [["D12", d12], ["D13", d13]] as const) {
    assert.ok(isStaticNumber(row.getCell(UNITS_COL)), `${label} Units must be static — its SUMIFS would recalculate to the pre-split figure`);
    assert.ok(isStaticNumber(row.getCell(VALUE_COL)), `${label} Value must be static`);
    assert.ok(isStaticNumber(row.getCell(ROW_TOTAL_COL)), `${label} row-total Value must be static`);
  }
  assert.equal(d12.getCell(VALUE_COL).value, 21_000, "the static cell carries the POST-split value — static-but-stale would be the same bug in new clothes");
  assert.equal(d13.getCell(VALUE_COL).value, 21_000, "the receiving area's static cell carries its post-split value");
  assert.ok(isCalcFormula(findRow(a.sheet, 1, "D14").getCell(VALUE_COL)), "an untouched area KEEPS its live formula — the fix is per-row, never sheet-wide");
  assert.ok(isCalcFormula(findRow(a.sheet, 1, "D1").getCell(VALUE_COL)), "a region subtotal whose city split cancelled to zero keeps its live formula");
  assert.ok(isCalcFormula(findRow(a.sheet, 2, "National Grand Total").getCell(ROW_TOTAL_COL)), "the whole-month grand total keeps its live SUM");

  // ── Scenario B: a one-sided move — the counterpart areas fell outside the matrix (filtered
  // export, or a city crossing regions), so the region and grand nets do NOT cancel ─────────────
  const { matrix: oneSided } = applyStoreSplitToMatrix(
    buildMatrix(),
    new Map([[areaProductKey("D13", "LA001"), { qty: 5, value: 1_000 }]]),
  );
  assert.equal(oneSided.regions[0]?.subtotal.storeSplitAdjusted, true, "a one-sided move must flag the region subtotal");
  assert.equal(oneSided.grandTotal.storeSplitAdjusted, true, "a one-sided move must flag the grand total");

  const b = await auditWorkbook(oneSided);
  assert.deepEqual(
    b.mismatches,
    [],
    "with the touched subtotal and grand total static, every surviving live formula must still recalculate to its cached value",
  );
  const bSubtotal = findRow(b.sheet, 1, "D1");
  assert.ok(isStaticNumber(bSubtotal.getCell(VALUE_COL)), "a split-touched region subtotal renders static");
  assert.equal(bSubtotal.getCell(VALUE_COL).value, 49_000, "the static subtotal carries the post-split figure");
  assert.ok(isStaticNumber(findRow(b.sheet, 2, "National Grand Total").getCell(ROW_TOTAL_COL)), "a split-touched grand total renders static");
  assert.ok(isCalcFormula(findRow(b.sheet, 1, "D12").getCell(VALUE_COL)), "areas the one-sided move never touched still keep their live formulas");
  assert.ok(isCalcFormula(findRow(b.sheet, 1, "CA").getCell(VALUE_COL)), "a whole region the split never touched keeps its live subtotal — the flag never leaks across regions");
}
