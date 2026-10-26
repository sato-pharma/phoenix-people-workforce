import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { ClosingExportData, MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import { applyClosingAreaMerges, markMergedAreaRowsStatic } from "../src/lib/sales/closing-area-merges.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import { buildMonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";
import type { MonthlyClosingMatrix, SalesAreaReference } from "../src/lib/sales/monthly-distributor-import.ts";

// closing-area-merges.ts folds Fayoum (GZ6) and Beni Suef (UE9) into one "Fayoum - Beni Suef" row
// on Pedia (CNS was un-merged 2026-08-30). A CI review bot (P1) caught the failure mode: the Closing Matrix sheet wrote
// every area's Units/Value as a live SUMIFS keyed to ITS OWN area code over the hidden Calc sheet —
// which still holds GZ6's and UE9's raw invoice rows SEPARATELY, under their own codes. The merged
// row's SUMIFS(area="GZ6") therefore recalculated straight back down to Fayoum's half alone,
// silently dropping Beni Suef's sales the moment Excel reopened the file.
//
// That was patched by stamping the merged row with the same `storeSplitAdjusted` flag the store
// split already used, so the export writer rendered that ONE row as a static value. This file used
// to pin that per-row scoping, including the assertion that untouched rows keep live formulas.
//
// The per-row design was withdrawn on 2026-08-11. It was a hand-maintained list of exceptions, and
// the organogram region grouping was never added to it — 18 of 22 region subtotals exported wrong
// across the three lines. writeMatrixSheet can no longer reach the Calc sheet at all. See
// closing-export-matches-screen.test.ts for the invariant that replaced it.
//
// What this file pins now, from the area merge's own angle:
//
//   1. `applyClosingAreaMerges` folds GZ6 + UE9 into one row on Pedia, and leaves Anti Infective
//      AND CNS (which have no merge rule) completely untouched.
//   2. `markMergedAreaRowsStatic` still stamps the merged row — the flag no longer drives
//      rendering, but it remains the module's contract and other callers read it.
//   3. The merged row exports the CORRECT combined total (24,000), with its combined display name,
//      whether or not it was flagged — the fold can no longer be recalculated away.
//   4. No cell on the sheet reaches the Calc sheet, so the P1 failure mode is structurally closed.

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

// The matrix shows geography by NAME (owner, 2026-10-26: "never use code always use name"), so a
// row is found by the area name, or "<Region> (Region)" for a subtotal, in the Area column.
const MATRIX_LABEL: Record<string, string> = { GZ6: "Fayoum - Beni Suef", UE9: "Beni Suef", GZ1: "Giza - Giza Centers", CA3: "Cairo Centers", GZ: "Giza (Region)", CA: "Cairo (Region)" };
function findMatrixRow(sheet: ExcelJS.Worksheet, code: string): ExcelJS.Row {
  return findRow(sheet, 2, MATRIX_LABEL[code] ?? code);
}

// Region order is a fixed rank inside buildMonthlyClosingMatrix, not alphabetical -- never assume
// Giza lands at regions[0]. Find the merged row by area code across every region instead.
function findAreaRowInMatrix(matrix: MonthlyClosingMatrix, areaCode: string) {
  for (const region of matrix.regions) {
    const found = region.areas.find((area) => area.areaCode === areaCode);
    if (found) return found;
  }
  return undefined;
}

function buildMergedMatrix(lineCode: "pedia", protect: boolean): MonthlyClosingMatrix {
  const merged = applyClosingAreaMerges(lineCode, AREAS, CELLS, [], "2026-06");
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
  return protect ? markMergedAreaRowsStatic(matrix, lineCode, "2026-06") : matrix;
}

const NO_CALC = "no Closing Matrix cell may reference the hidden Calc sheet — it carries GZ6 and "
  + "UE9 as SEPARATE rows, so a SUMIFS keyed to GZ6 recalculates the fold away";

export async function runMonthlyClosingExportAreaMergeStaticTests() {
  // ── applyClosingAreaMerges fixture sanity, and Anti Infective stays untouched ────────────────
  const merged = applyClosingAreaMerges("pedia", AREAS, CELLS, [], "2026-06");
  assert.equal(merged.areas.length, 3, "GZ6 and UE9 collapse to one area; GZ1 and CA3 are untouched -> 3 areas remain");
  const survivor = merged.areas.find((a) => a.areaCode === "GZ6");
  assert.equal(survivor?.areaName, "Fayoum - Beni Suef", "the surviving row is renamed");
  const survivorCell = merged.cells.find((c) => c.areaCode === "GZ6" && c.productCode === "AF001");
  assert.equal(survivorCell?.salesValue, 24_000, "GZ6 + UE9 = 15,000 + 9,000 = 24,000");

  const untouched = applyClosingAreaMerges("anti_infective", AREAS, CELLS, [], "2026-06");
  assert.equal(untouched.areas.length, 4, "anti_infective has no merge rule -- all 4 areas stay separate");
  assert.ok(
    untouched.areas.some((a) => a.areaCode === "UE9" && a.areaName === "Beni Suef"),
    "anti_infective: Beni Suef keeps its own name -- never merged",
  );

  // ── The fixture still reproduces the P1 bug, so the assertions below mean something ──────────
  // Replay what the withdrawn formula computed: sum the Calc sheet where its area column equals the
  // merged row's own code. It comes back as Fayoum's half alone. If this ever equals the merged
  // total, the fixture stopped reproducing the bug and this file is proving nothing.
  const oldSumifsForMergedRow = DIST_PRODUCT
    .filter((r) => r.areaCode.toUpperCase() === "GZ6")
    .reduce((sum, r) => sum + r.value, 0);
  assert.equal(oldSumifsForMergedRow, 15_000, "fixture sanity: a SUMIFS keyed to GZ6 sees Fayoum's half only");
  assert.notEqual(oldSumifsForMergedRow, 24_000, "fixture sanity: that half must disagree with the merged total");

  // ── Unflagged and flagged both export the correct merged total ───────────────────────────────
  // Two matrices, one stamped by markMergedAreaRowsStatic and one not, because rendering no longer
  // depends on the flag. Both must produce the same, correct sheet.
  const unprotected = buildMergedMatrix("pedia", false);
  assert.equal(findAreaRowInMatrix(unprotected, "GZ6")?.storeSplitAdjusted, undefined, "fixture sanity: not flagged");
  const bare = await auditWorkbook(unprotected);
  assert.deepEqual(bare.calcBacked, [], NO_CALC);
  assert.equal(
    findMatrixRow(bare.sheet, "GZ6").getCell(VALUE_COL).value,
    24_000,
    "the merged row exports the CORRECT combined total even unflagged — rendering no longer depends on a hand-set flag",
  );

  const protectedMatrix = buildMergedMatrix("pedia", true);
  assert.equal(findAreaRowInMatrix(protectedMatrix, "GZ6")?.storeSplitAdjusted, true, "markMergedAreaRowsStatic still flags the merged row");

  const fixed = await auditWorkbook(protectedMatrix);
  assert.deepEqual(fixed.calcBacked, [], NO_CALC);

  const fixedRow = findMatrixRow(fixed.sheet, "GZ6");
  assert.equal(fixedRow.getCell(2).value, "Fayoum - Beni Suef", "the merged row keeps its combined display name in the export");
  assert.equal(fixedRow.getCell(UNITS_COL).value, 80, "merged row Units = 50 + 30");
  assert.equal(fixedRow.getCell(VALUE_COL).value, 24_000, "the cell carries the CORRECT merged total, not Fayoum's half alone");

  // The rows around it are unchanged, and the Giza subtotal still adds up.
  assert.equal(findMatrixRow(fixed.sheet, "GZ1").getCell(VALUE_COL).value, 6_000, "an untouched area in the SAME region is unchanged");
  assert.equal(findMatrixRow(fixed.sheet, "CA3").getCell(VALUE_COL).value, 3_000, "an untouched area in a DIFFERENT region is unchanged");
  assert.equal(
    findMatrixRow(fixed.sheet, "GZ").getCell(VALUE_COL).value,
    30_000,
    "region subtotal = GZ6 15,000 + UE9 9,000 + GZ1 6,000 = 30,000",
  );

  // ── CNS: separate through July, ONE area from August ────────────────────────────────────────
  // The owner split CNS back into two areas on 2026-08-30, then reversed it on 2026-09-07 — "in
  // pedia and cns fayoum and bani suef are one area" — asking that August onward merge and July
  // stay as published. July 2026 CNS is locked (105,152 units), so both halves are pinned here:
  // the month he has already sent out must keep rendering as the two rows it was sent as.
  const cnsJuly = applyClosingAreaMerges("cns", AREAS, CELLS, [], "2026-07");
  assert.equal(cnsJuly.areas.length, 4, "cns July: published as two rows, and it stays that way");
  assert.ok(
    cnsJuly.areas.some((a) => a.areaCode === "UE9" && a.areaName === "Beni Suef"),
    "cns July: Beni Suef keeps its own name and its own row",
  );

  const cnsAugust = applyClosingAreaMerges("cns", AREAS, CELLS, [], "2026-08");
  assert.equal(cnsAugust.areas.length, 3, "cns August: GZ6 and UE9 fold into one row");
  assert.equal(
    cnsAugust.areas.find((a) => a.areaCode === "GZ6")?.areaName,
    "Fayoum - Beni Suef",
    "cns August: the surviving row carries the combined name",
  );
  assert.equal(
    cnsAugust.cells.find((c) => c.areaCode === "GZ6" && c.productCode === "AF001")?.salesValue,
    24_000,
    "cns August: the folded row carries both areas' sales, 15,000 + 9,000",
  );
  assert.ok(
    !cnsAugust.areas.some((a) => a.areaCode === "UE9"),
    "cns August: Beni Suef no longer stands as its own row",
  );

  // A MALFORMED period must not merge a dated rule: failing to merge shows two rows that were always
  // real, while merging early rewrites a month somebody has been sent.
  for (const bad of ["2026", "not-a-period", "2026-13-01"]) {
    assert.equal(
      applyClosingAreaMerges("cns", AREAS, CELLS, [], bad).areas.length,
      4,
      `cns: an unreadable period (${bad}) must fall back to two separate rows`,
    );
  }

  // An ABSENT period is a different thing entirely, and the distinction is load-bearing. A picker,
  // an organogram or the pre-month closing skeleton is not "as of" anything — it shows the state
  // NOW — so null means today, and today is past the August start. Reading null as "unknown" would
  // leave every one of those surfaces showing CNS as two areas forever.
  for (const now of [null, ""]) {
    assert.equal(
      applyClosingAreaMerges("cns", AREAS, CELLS, [], now).areas.length,
      3,
      `cns: no period means now, and now merges (${JSON.stringify(now)})`,
    );
  }

  // Pedia carries no start date, so it merges in every period — including the ones before CNS did.
  assert.equal(
    applyClosingAreaMerges("pedia", AREAS, CELLS, [], "2026-05").areas.length,
    3,
    "pedia has always merged, and the CNS start date must not have dated Pedia by accident",
  );

  const cnsUnmerged = cnsJuly;
  assert.ok(
    cnsUnmerged.areas.some((a) => a.areaCode === "UE9" && a.areaName === "Beni Suef"),
    "cns: Beni Suef keeps its own name and its own row",
  );
  assert.ok(
    cnsUnmerged.areas.some((a) => a.areaCode === "GZ6" && a.areaName === "Fayoum"),
    "cns: Fayoum keeps its own name — not the combined label",
  );
}
