import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { ClosingExportData, MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import { applyClosingAreaMerges, markMergedAreaRowsStatic } from "../src/lib/sales/closing-area-merges.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import { buildMonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";
import type { MonthlyClosingMatrix, SalesAreaReference } from "../src/lib/sales/monthly-distributor-import.ts";

// closing-area-merges.ts folds Fayoum (GZ6) and Beni Suef (UE9) into one "Fayoum - Beni Suef" row
// on Pedia and CNS. A CI review bot (P1) caught the same failure mode this file's sibling
// (monthly-closing-export-split-static.test.ts) already guards for the store split: the Closing
// Matrix sheet writes every area's Units/Value as a live SUMIFS keyed to ITS OWN area code over
// the hidden Calc sheet — which still holds GZ6's and UE9's raw invoice rows SEPARATELY, under
// their own codes. Without protection, the merged row's SUMIFS(area="GZ6") would recalculate
// straight back down to Fayoum's half alone, silently dropping Beni Suef's sales the moment Excel
// reopens the file. markMergedAreaRowsStatic stamps the SAME storeSplitAdjusted flag the store
// split already relies on, so the export writer renders that one row as a static cached value.
//
// What this file pins, reusing the sibling test's own Calc-replay audit:
//
//   1. WITHOUT markMergedAreaRowsStatic, the merged row's live SUMIFS recalculates to Fayoum's
//      raw half (15,000), not the merged total (24,000) — the audit must catch this as a
//      mismatch. This proves the bug the review bot found is real, not hypothetical.
//   2. WITH markMergedAreaRowsStatic (the actual production wiring), that same row renders
//      static, carrying the correct merged total, and the audit reports zero mismatches.
//   3. The fix is per-row: an untouched area in the SAME region (Giza) and one in a DIFFERENT
//      region (Cairo) both keep live formulas — and the Giza region SUBTOTAL keeps its live
//      formula too, because GZ6 and UE9 already share one real geographic region, so a
//      region-level SUMIFS genuinely still catches both areas' raw rows without help.
//   4. Anti Infective, which has no merge rule, passes areas through completely unchanged.

const PRODUCT = {
  factoryPrice: 300,
  family: "Anti-Fungal",
  familyCode: "AF",
  line: "Pedia",
  productCode: "AF001",
  productName: "Fayolin",
  source: "Sato",
};

const AREAS: SalesAreaReference[] = [
  { areaCode: "GZ6", areaName: "Fayoum", regionCode: "GZ", regionName: "Giza" },
  { areaCode: "UE9", areaName: "Beni Suef", regionCode: "GZ", regionName: "Giza" },
  { areaCode: "GZ1", areaName: "Giza - Giza Centers", regionCode: "GZ", regionName: "Giza" },
  { areaCode: "CA3", areaName: "Cairo Centers", regionCode: "CA", regionName: "Cairo" },
];

// Pre-merge sales, straight off phx_monthly_closing_matrix. GZ6 + UE9 = 80 units / 24,000 EGP —
// the merged row's correct total; GZ6 alone is 50 / 15,000 — the wrong total a keyed-to-GZ6-only
// SUMIFS would recompute if the row were left live.
const CELLS = [
  { areaCode: "GZ6", productCode: "AF001", salesUnits: 50, salesValue: 15_000 },
  { areaCode: "UE9", productCode: "AF001", salesUnits: 30, salesValue: 9_000 },
  { areaCode: "GZ1", productCode: "AF001", salesUnits: 20, salesValue: 6_000 },
  { areaCode: "CA3", productCode: "AF001", salesUnits: 10, salesValue: 3_000 },
];

// The UNMERGED truth the hidden Calc sheet is built from — GZ6 and UE9 as two separate distributor
// rows, exactly how production's Data sheet actually carries them regardless of how the Closing
// Matrix chooses to group them for display.
const DIST_PRODUCT: ClosingExportData["distProduct"] = [
  { areaCode: "GZ6", areaName: "Fayoum", distributorCode: "IS-S", distributorName: "IS-S", productCode: "AF001", productName: "Fayolin", regionCode: "GZ", regionName: "Giza", units: 50, value: 15_000 },
  { areaCode: "UE9", areaName: "Beni Suef", distributorCode: "IS-S", distributorName: "IS-S", productCode: "AF001", productName: "Fayolin", regionCode: "GZ", regionName: "Giza", units: 30, value: 9_000 },
  { areaCode: "GZ1", areaName: "Giza - Giza Centers", distributorCode: "IS-S", distributorName: "IS-S", productCode: "AF001", productName: "Fayolin", regionCode: "GZ", regionName: "Giza", units: 20, value: 6_000 },
  { areaCode: "CA3", areaName: "Cairo Centers", distributorCode: "IS-S", distributorName: "IS-S", productCode: "AF001", productName: "Fayolin", regionCode: "CA", regionName: "Cairo", units: 10, value: 3_000 },
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
        { areaCode: "GZ6", areaName: "Fayoum", regionName: "Giza" },
        { areaCode: "UE9", areaName: "Beni Suef", regionName: "Giza" },
        { areaCode: "GZ1", areaName: "Giza - Giza Centers", regionName: "Giza" },
        { areaCode: "CA3", areaName: "Cairo Centers", regionName: "Cairo" },
      ],
      masterBricks: [],
      productByDist: [],
    },
    distributors: [{ code: "IS-S", name: "IS-S" }],
    insights: [],
    line: "Pedia",
    mix: { distributor: [], product: [], region: [] },
    national: { areaCount: 4, customerCount: 0, productCount: 1, units: 110, value: 33_000 },
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

// ── Replaying the sheet's own formulas against the Calc sheet (copied from the sibling test,
// which owns this technique) — a deliberately tiny evaluator for exactly the two shapes
// writeMatrixSheet emits against Calc: SUMIFS(range, critRange, "text", ...) and SUM(range).

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
      if (!formula.includes("Calc!")) return;
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
// block spans 3-9 (Units, Value, Tgt Units, Tgt Value, Ach %, two shares), Grand Total at 10.
const UNITS_COL = 3;
const VALUE_COL = 4;

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

// Region order is a fixed rank inside buildMonthlyClosingMatrix, not alphabetical -- never assume
// Giza lands at regions[0]. Find the merged row by area code across every region instead.
function findAreaRowInMatrix(matrix: MonthlyClosingMatrix, areaCode: string) {
  for (const region of matrix.regions) {
    const found = region.areas.find((area) => area.areaCode === areaCode);
    if (found) return found;
  }
  return undefined;
}

function buildMergedMatrix(lineCode: "pedia" | "cns", protect: boolean): MonthlyClosingMatrix {
  const merged = applyClosingAreaMerges(lineCode, AREAS, CELLS, []);
  const matrix = buildMonthlyClosingMatrix({
    areas: merged.areas,
    availableLines: ["Pedia"],
    availablePeriods: ["2026-06"],
    cells: merged.cells,
    line: "Pedia",
    period: "2026-06",
    products: [PRODUCT],
    targets: merged.targets,
  });
  return protect ? markMergedAreaRowsStatic(matrix, lineCode) : matrix;
}

export async function runMonthlyClosingExportAreaMergeStaticTests() {
  // ── applyClosingAreaMerges fixture sanity, and Anti Infective stays untouched ────────────────
  const merged = applyClosingAreaMerges("pedia", AREAS, CELLS, []);
  assert.equal(merged.areas.length, 3, "GZ6 and UE9 collapse to one area; GZ1 and CA3 are untouched -> 3 areas remain");
  const survivor = merged.areas.find((a) => a.areaCode === "GZ6");
  assert.equal(survivor?.areaName, "Fayoum - Beni Suef", "the surviving row is renamed");
  const survivorCell = merged.cells.find((c) => c.areaCode === "GZ6" && c.productCode === "AF001");
  assert.equal(survivorCell?.salesValue, 24_000, "GZ6 + UE9 = 15,000 + 9,000 = 24,000");

  const untouched = applyClosingAreaMerges("anti_infective", AREAS, CELLS, []);
  assert.equal(untouched.areas.length, 4, "anti_infective has no merge rule -- all 4 areas stay separate");
  assert.ok(
    untouched.areas.some((a) => a.areaCode === "UE9" && a.areaName === "Beni Suef"),
    "anti_infective: Beni Suef keeps its own name -- never merged",
  );

  // ── Scenario A: the bug, unprotected -- prove the headline assertion actually fires ──────────
  const unprotected = buildMergedMatrix("pedia", false);
  assert.equal(findAreaRowInMatrix(unprotected, "GZ6")?.storeSplitAdjusted, undefined, "fixture sanity: not yet flagged");

  const bug = await auditWorkbook(unprotected);
  const bugRow = findRow(bug.sheet, 1, "GZ6");
  assert.ok(isCalcFormula(bugRow.getCell(VALUE_COL)), "unprotected: the merged row is still a live formula -- this is exactly the bug");
  assert.equal(
    bug.mismatches.some((m) => m.startsWith(`${bugRow.getCell(VALUE_COL).address}:`)),
    true,
    `unprotected merged row must be caught as a mismatch by the Calc audit (saw: ${JSON.stringify(bug.mismatches)})`,
  );
  assert.ok(
    bug.mismatches.some((m) => m.includes("recalculates to 15000")),
    `the live SUMIFS keyed only to GZ6 must recompute to Fayoum's raw half (15,000), silently dropping Beni Suef's 9,000 (saw: ${JSON.stringify(bug.mismatches)})`,
  );

  // ── Scenario B: the fix, as production actually wires it ─────────────────────────────────────
  const protectedMatrix = buildMergedMatrix("pedia", true);
  assert.equal(findAreaRowInMatrix(protectedMatrix, "GZ6")?.storeSplitAdjusted, true, "markMergedAreaRowsStatic flags the merged row");

  const fixed = await auditWorkbook(protectedMatrix);
  assert.deepEqual(
    fixed.mismatches,
    [],
    "with the merged row static, every remaining live formula must recalculate to exactly its cached value",
  );
  assert.ok(fixed.liveChecked >= 4, `the sheet must still carry live Calc formulas elsewhere (saw ${fixed.liveChecked}) -- zero would mean the whole sheet went static and this proves nothing`);

  const fixedRow = findRow(fixed.sheet, 1, "GZ6");
  assert.equal(fixedRow.getCell(2).value, "Fayoum - Beni Suef", "the merged row keeps its combined display name in the export");
  assert.ok(isStaticNumber(fixedRow.getCell(UNITS_COL)), "protected: merged row Units is static");
  assert.ok(isStaticNumber(fixedRow.getCell(VALUE_COL)), "protected: merged row Value is static");
  assert.equal(fixedRow.getCell(VALUE_COL).value, 24_000, "the static cell carries the CORRECT merged total, not Fayoum's half alone");

  // Per-row scoping: an untouched area in the SAME region, one in a DIFFERENT region, and the
  // Giza region subtotal itself (whose SUMIFS is keyed by REGION, and GZ6/UE9 already share one
  // real region) all keep their live formulas -- the fix never leaks beyond the one merged row.
  assert.ok(isCalcFormula(findRow(fixed.sheet, 1, "GZ1").getCell(VALUE_COL)), "an untouched area in the SAME region keeps its live formula");
  assert.ok(isCalcFormula(findRow(fixed.sheet, 1, "CA3").getCell(VALUE_COL)), "an untouched area in a DIFFERENT region keeps its live formula");
  const gzSubtotalRow = findRow(fixed.sheet, 1, "GZ");
  assert.ok(isCalcFormula(gzSubtotalRow.getCell(VALUE_COL)), "the Giza region subtotal stays live -- a region-level SUMIFS already catches both merged areas' raw rows without help");
  const gzSubtotalValue = gzSubtotalRow.getCell(VALUE_COL).value;
  assert.equal(
    isFormulaValue(gzSubtotalValue) ? gzSubtotalValue.result : gzSubtotalValue,
    30_000,
    "region subtotal = GZ6 15,000 + UE9 9,000 + GZ1 6,000 = 30,000, correct with or without the row-level fix",
  );

  // ── CNS uses the same merge rule -- confirm the fix is not Pedia-specific ────────────────────
  const cnsProtected = buildMergedMatrix("cns", true);
  assert.equal(findAreaRowInMatrix(cnsProtected, "GZ6")?.storeSplitAdjusted, true, "the same protection applies for cns");
  const cnsFixed = await auditWorkbook(cnsProtected);
  assert.deepEqual(cnsFixed.mismatches, [], "cns: zero mismatches with the fix in place");
}
