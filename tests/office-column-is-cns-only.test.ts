import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import type { ClosingDetailsResult } from "../src/lib/sales/monthly-closing-details.ts";
import type { MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import {
  buildMonthlyClosingWorkbook,
  buildPortalClosingWorkbook,
} from "../src/lib/sales/monthly-closing-export.ts";
import {
  buildMonthlyClosingMatrix,
  type MonthlyClosingAggregateCell,
  type MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";
import {
  lineHasOfficeChannel,
  OFFICE_CHANNEL_LINES,
  OFFICE_DISTRIBUTOR_CODE,
} from "../src/lib/sales/office-distributor.ts";

// ─────────────────────────────────────────────────────────────────────────────
// "the office coloumn should be in cns line only" — the owner, 2026-08-25.
//
// Office is not a distributor. It is the company's own stock, imported last and spread across areas
// by his value-share rule (office-allocation.ts, the locked golden rule). Only CNS is sold that way.
// Every Office import row ever validated, counted on production 2026-08-25:
//
//   CNS    2026-01 → 2026-07    15,564 rows   219,245 units
//   Pedia  2026-01 only             84 rows       556 units   150,119.99 EGP
//
// Anti Infective and Head Office have never had one. So on every line but CNS the "of wh. Office"
// columns and the Office Allocation sheet were a wall of zeroes standing beside each real figure —
// on Pedia and Anti Infective 2026-08 the Office grid's grand total is exactly 0.00.
//
// WHAT MUST NOT HAPPEN WHILE FIXING IT. Two failure modes, and this file exists for both:
//
//   1. A NUMBER MOVES. The Office grid is a lens on the closing, never a source of it — no
//      headline, subtotal or grand total is computed from it. Hiding the columns must leave the
//      Closing Matrix byte-identical. Section 3 asserts that against a real workbook.
//
//   2. THE COLUMNS READ "—" INSTEAD OF DISAPPEARING. The renderer distinguishes "no Office layer"
//      (undefined → no columns) from "the Office layer could not be read" (null → columns kept,
//      cells "—", plus a callout). Passing null for a non-CNS line would print a data-outage
//      warning on every Pedia closing forever. Section 3 asserts the SHEET is absent, which only
//      holds for undefined/omitted.
//
// The gate is one predicate, deliberately: closing-matrix-table.tsx is the single shared render for
// BOTH the admin workspace and the portal view, and monthly-closing-export.ts builds both workbooks.
// Four surfaces, one answer, so none can drift.
// ─────────────────────────────────────────────────────────────────────────────

const AREAS = [
  { areaCode: "A1", areaName: "Area One", regionCode: "R1", regionName: "Region One" },
  { areaCode: "A2", areaName: "Area Two", regionCode: "R1", regionName: "Region One" },
];

const products = (line: string) => [
  { factoryPrice: 10, family: line, familyCode: line, line, productCode: "P1", productName: "Product One", source: "" },
  { factoryPrice: 40, family: line, familyCode: line, line, productCode: "P2", productName: "Product Two", source: "" },
];

const TOTAL_CELLS: MonthlyClosingAggregateCell[] = [
  { areaCode: "A1", productCode: "P1", salesUnits: 1_000, salesValue: 10_000 },
  { areaCode: "A1", productCode: "P2", salesUnits: 200, salesValue: 8_000 },
  { areaCode: "A2", productCode: "P1", salesUnits: 600, salesValue: 6_000 },
];
const OFFICE_CELLS: MonthlyClosingAggregateCell[] = [
  { areaCode: "A1", productCode: "P1", salesUnits: 400, salesValue: 4_000 },
  { areaCode: "A2", productCode: "P1", salesUnits: 150, salesValue: 1_500 },
];

const build = (line: string, cells: MonthlyClosingAggregateCell[]): MonthlyClosingMatrix =>
  buildMonthlyClosingMatrix({
    areas: AREAS,
    availableLines: ["CNS", "Pedia"],
    availablePeriods: ["2026-07"],
    cells,
    line,
    period: "2026-07",
    products: products(line),
  });

// The comparison sheets are not what this test is about — every list is empty so the workbook
// builds with only the sheets under test carrying data.
const emptyComparison = (line: string): MonthlyClosingComparison => ({
  areaByDistributor: [],
  avgPrice: [],
  byDistributor: [],
  coverage: [],
  data: {
    areaByDist: [], bricks: [], customers: [], distProduct: [],
    masterAreas: AREAS.map((a) => ({ areaCode: a.areaCode, areaName: a.areaName, regionName: a.regionName })),
    masterBricks: [], productByDist: [],
  },
  distributors: [{ code: OFFICE_DISTRIBUTOR_CODE, name: OFFICE_DISTRIBUTOR_CODE }],
  insights: [],
  line,
  mix: { distributor: [], product: [], region: [] },
  national: { areaCount: AREAS.length, customerCount: 0, productCount: 2, units: 1_800, value: 24_000 },
  pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
  period: "2026-07",
  productByDistributor: [],
  rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
  regionByDistributor: [],
  totalAreas: AREAS.length,
  totalBricks: 0,
  whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
} as unknown as MonthlyClosingComparison);

async function workbookFor(line: string, office: MonthlyClosingMatrix | undefined) {
  const buffer = await buildMonthlyClosingWorkbook(
    build(line, TOTAL_CELLS),
    emptyComparison(line),
    undefined,
    office ? { office } : {},
  );
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

function matrixHeaders(wb: ExcelJS.Workbook): string[] {
  const headers: string[] = [];
  wb.getWorksheet("Closing Matrix")
    ?.getRow(5)
    .eachCell({ includeEmpty: true }, (cell) => headers.push(String(cell.value ?? "")));
  return headers;
}

/** Every value on the Closing Matrix sheet, so "the numbers did not move" is checked, not assumed. */
function matrixValues(wb: ExcelJS.Workbook): string[] {
  const out: string[] = [];
  wb.getWorksheet("Closing Matrix")?.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => out.push(String(cell.value ?? "")));
  });
  return out;
}

// ── 1. the predicate ──────────────────────────────────────────────────────────
function runPredicateTests() {
  assert.deepEqual(
    [...OFFICE_CHANNEL_LINES],
    ["CNS"],
    "the owner's rule of 2026-08-25 is CNS ONLY. Adding a line here makes the Office columns appear "
    + "on that line's closing everywhere at once — it is his call, not a maintenance decision",
  );

  assert.ok(lineHasOfficeChannel("CNS"));
  assert.ok(lineHasOfficeChannel("cns"), "line keys arrive in mixed case from the URL and the RPC");
  assert.ok(lineHasOfficeChannel(" CNS "), "and with the stray whitespace a hand-edited row carries");

  for (const line of ["Pedia", "Anti Infective", "Head Office", "CNS Extra", "", null, undefined]) {
    assert.equal(
      lineHasOfficeChannel(line),
      false,
      `${JSON.stringify(line)} must not carry the Office breakdown`,
    );
  }
  assert.equal(
    lineHasOfficeChannel("Head Office"),
    false,
    "\"Head Office\" is a LINE whose name contains the word Office. Matching it would put an "
    + "all-zero Office column on the one line most likely to be read as a mistake",
  );
}

// ── 2. CNS still gets everything it had ───────────────────────────────────────
function runCnsUnchangedTests(wb: ExcelJS.Workbook) {
  assert.ok(
    wb.getWorksheet("Office Allocation"),
    "CNS with an Office grid must still carry the Office Allocation sheet",
  );
  const headers = matrixHeaders(wb);
  assert.equal(
    headers.filter((h) => h === "of wh. Office").length,
    3,
    "one \"of wh. Office\" column per product plus one on the Grand Total, exactly as before",
  );
  const unitsAt = headers.indexOf("Units");
  assert.equal(
    headers[unitsAt + 1],
    "of wh. Office",
    "and still immediately after Units, or the sheet reads as two unrelated numbers",
  );
}

// ── 3. every other line gets neither — and no number moves ────────────────────
async function runNonCnsTests() {
  for (const line of ["Pedia", "Anti Infective"]) {
    const gated = await workbookFor(line, build(line, OFFICE_CELLS));

    assert.equal(
      gated.getWorksheet("Office Allocation"),
      undefined,
      `${line} must not carry an Office Allocation sheet. Absent is the assertion that matters: a `
      + "sheet of \"—\" would mean the Office layer was passed as null, and the renderer reads null "
      + "as \"could not be read\" and prints a data-outage callout beside it",
    );
    assert.ok(
      !matrixHeaders(gated).includes("of wh. Office"),
      `${line} must not carry an "of wh. Office" column — production has never had a non-zero one `
      + "on this line",
    );

    // THE HEADLINE ASSERTION. The Office grid is display-only, so gating it must leave the closing
    // itself untouched, cell for cell — including every subtotal and the grand total.
    const plain = await workbookFor(line, undefined);
    assert.deepEqual(
      matrixValues(gated),
      matrixValues(plain),
      `${line}'s Closing Matrix must be identical whether or not an Office grid was supplied. If `
      + "this ever differs, the Office lens has become a source of the closing and the owner's #1 "
      + "rule — one sales truth, no surface with its own maths — is broken",
    );
  }
}

// ── 4. the on-screen table asks the same question ─────────────────────────────
//
// closing-matrix-table.tsx is a client component with no render harness in this suite, so this is a
// wiring check, not a render check: it proves the shared table consults the gate rather than the
// raw `office` prop. A substring, not a byte window — it survives the file moving around.
function runRendererWiringTests() {
  const source = readFileSync(
    new URL("../src/components/sales/closing-matrix-table.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.includes("lineHasOfficeChannel(matrix.line)"),
    "the shared Closing Matrix table must gate its Office columns on lineHasOfficeChannel(matrix.line). "
    + "It is the single render behind BOTH the admin workspace and the portal view, so gating it here "
    + "is what stops one of the two surfaces from keeping the column",
  );
  assert.ok(
    !/buildOfficeLookup\(\s*office\s*\)/.test(source),
    "and it must not fall back to the ungated `office` prop anywhere — that is the exact line that "
    + "put an all-zero column on every Pedia and Anti Infective closing",
  );
}

// ── 5. the PORTAL workbook asks it too ───────────────────────────────────────
//
// ADDED 2026-08-25, and only because a break-verification pass demanded it. Sections 1-4 all passed
// with the portal gate deliberately deleted: no test in this suite had ever CALLED
// buildPortalClosingWorkbook, so the second of the two workbook builders was uncovered and would
// have kept the all-zero Office columns on every manager's own export forever. The admin workbook
// being right is not evidence about this one — they are separate functions with separate gates,
// which is precisely how one of them drifts.
//
// The portal builder does not take the caller's matrix as-is: it rebuilds the cells from
// `details.rows` and reads `rebuiltMatrix.line`, not `matrix.line`. So this also pins that the
// rebuild carries the line through — if it ever stopped, the gate would silently answer for the
// wrong line, which no assertion in sections 1-4 could see.
const emptyTotals = { effectiveUnits: 0, rows: 0, salesValue: 0, units: 0 };

/** The thinnest ClosingDetailsResult the portal builder accepts. No rows: the Office layer is a
 *  lens on the matrix, so whether its SHEET exists never depends on the invoice rows. */
const detailsFor = (line: string): ClosingDetailsResult => ({
  availableLines: [line],
  availablePeriods: ["2026-07"],
  canRevealConfidential: false,
  confidentialIncluded: false,
  filteredRowCount: 0,
  line,
  options: { areas: [], distributors: [], products: [], regions: [] },
  outOfScope: false,
  page: 1,
  pageSize: 1_000,
  period: "2026-07",
  reconciliation: {
    areaMismatches: { ...emptyTotals },
    closingHeadline: { ...emptyTotals },
    excludedConfidential: { ...emptyTotals },
    excludedDirect: { ...emptyTotals },
    includedInClosing: { ...emptyTotals },
    missingClientCode: { ...emptyTotals },
    unmappedBricks: { ...emptyTotals },
  },
  rows: [],
  totals: { ...emptyTotals },
});

async function portalWorkbookFor(line: string, office: MonthlyClosingMatrix | undefined) {
  const buffer = await buildPortalClosingWorkbook(
    build(line, TOTAL_CELLS),
    emptyComparison(line),
    detailsFor(line),
    office,
  );
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

async function runPortalWorkbookTests() {
  // CNS keeps it — otherwise "the gate works" would also be satisfied by a gate stuck closed.
  const cns = await portalWorkbookFor("CNS", build("CNS", OFFICE_CELLS));
  assert.ok(
    cns.getWorksheet("Office Allocation"),
    "a CNS manager's own export must still carry the Office Allocation sheet. Without this "
    + "assertion the section below passes just as well against a gate that hides Office everywhere",
  );
  assert.ok(
    matrixHeaders(cns).includes("of wh. Office"),
    "and still carry the \"of wh. Office\" column on CNS",
  );

  for (const line of ["Pedia", "Anti Infective"]) {
    const gated = await portalWorkbookFor(line, build(line, OFFICE_CELLS));
    assert.equal(
      gated.getWorksheet("Office Allocation"),
      undefined,
      `a ${line} manager's own export must not carry an Office Allocation sheet either. The portal `
      + "builder has its OWN gate on rebuiltMatrix.line — deleting it left every section of this "
      + "file green, which is how it went uncovered",
    );
    assert.ok(
      !matrixHeaders(gated).includes("of wh. Office"),
      `nor an "of wh. Office" column on a ${line} portal export`,
    );

    const plain = await portalWorkbookFor(line, undefined);
    assert.deepEqual(
      matrixValues(gated),
      matrixValues(plain),
      `${line}'s portal Closing Matrix must be identical whether or not an Office grid was supplied `
      + "— same rule as the admin workbook: the Office grid is a lens, never a source",
    );
  }
}

export async function runOfficeColumnIsCnsOnlyTests() {
  runPredicateTests();
  runCnsUnchangedTests(await workbookFor("CNS", build("CNS", OFFICE_CELLS)));
  await runNonCnsTests();
  await runPortalWorkbookTests();
  runRendererWiringTests();
}
