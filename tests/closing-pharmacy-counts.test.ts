import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  buildClosingPharmacyCounts,
  type PharmacyCountPeriod,
  type PharmacyCountRow,
} from "../src/lib/sales/closing-pharmacy-counts.ts";
import { buildPharmacyLookup, pharmacyBrickRows } from "../src/lib/sales/closing-pharmacy-lookup.ts";
import type { MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import { buildMonthlyClosingWorkbook, PHARMACIES_BY_BRICK_SHEET } from "../src/lib/sales/monthly-closing-export.ts";
import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// The Pharmacies column of the Monthly Closing sales sheet (owner, 24 Nov 2026: "add the pharmacy
// count inside the monthly closing sales sheet", "the same what we did for Ibtisam").
//
// The rule is the one his Ebtissam Alaa sheet used: ONE pharmacy = one distributor customer
// (distributor + its customer code), it BOUGHT when its net units in that area, product and month
// are above zero, and direct orders, Office, Main Stores and a wholesaler's city share are not
// pharmacies. A region, the nation and a row's all-products total count DISTINCT pharmacies.

function row(overrides: Partial<PharmacyCountRow> & { clientCode: string; productCode: string }): PharmacyCountRow {
  return {
    distributorCode: "UCP",
    clientName: `Pharmacy ${overrides.clientCode}`,
    clientAddress: "",
    areaCode: "D16",
    sheetAreaCode: "D16",
    areaName: "Kafr El-Sheikh 1",
    sheetAreaName: "Kafr El-Sheikh 1",
    brickId: "B1",
    brickName: "Desouk",
    productName: overrides.productCode,
    salesValue: 100,
    effectiveUnits: overrides.qty ?? 2,
    qty: 2,
    isDirect: false,
    evenSplitApplied: false,
    includedInClosing: true,
    ...overrides,
  };
}

const AUG = "2026-08";
const SEP = "2026-09";

function cell(salesUnits = 0, salesValue = 0): MonthlyClosingCell {
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

function area(areaCode: string, areaName: string, regionCode: string, regionName: string, extra: Partial<MonthlyClosingAreaRow> = {}): MonthlyClosingAreaRow {
  return { areaCode, areaName, cells: [cell(10, 100), cell(5, 50)], kind: "area", regionCode, regionName, rowTotal: cell(15, 150), ...extra };
}

/** Two regions: Delta holds D16 and D17, Cairo holds CA1. Columns are GU then IV. */
function matrix(): MonthlyClosingMatrix {
  const subtotal = (regionCode: string, regionName: string) => ({
    cells: [cell(20, 200), cell(10, 100)],
    kind: "regionSubtotal" as const,
    regionCode,
    regionName,
    rowTotal: cell(30, 300),
  });
  return {
    availableLines: ["Pedia"],
    availablePeriods: [AUG],
    columns: [
      { family: "Gutalax", productCode: "GU", productName: "Gutalax" },
      { family: "Ivyronc", productCode: "IV", productName: "Ivyronc" },
    ],
    grandTotal: { cells: [cell(30, 300), cell(15, 150)], kind: "grandTotal", rowTotal: cell(45, 450) },
    line: "Pedia",
    period: AUG,
    regions: [
      {
        areas: [area("D16", "Kafr El-Sheikh 1", "D", "Delta"), area("D17", "Kafr El-Sheikh 2", "D", "Delta")],
        regionCode: "D",
        regionName: "Delta",
        subtotal: subtotal("D", "Delta"),
      },
      {
        areas: [area("CA1", "Cairo 1", "CA", "Cairo")],
        regionCode: "CA",
        regionName: "Cairo",
        subtotal: subtotal("CA", "Cairo"),
      },
    ],
  };
}

function comparison(): MonthlyClosingComparison {
  return {
    areaByDistributor: [],
    avgPrice: [],
    byDistributor: [],
    coverage: [],
    data: { areaByDist: [], bricks: [], customers: [], distProduct: [], masterAreas: [], masterBricks: [], productByDist: [] },
    distributors: [],
    insights: [],
    line: "Pedia",
    mix: { distributor: [], product: [], region: [] },
    national: { areaCount: 3, customerCount: 0, productCount: 2, units: 45, value: 450 },
    pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
    period: AUG,
    productByDistributor: [],
    rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
    regionByDistributor: [],
    totalAreas: 3,
    totalBricks: 0,
    whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
  };
}

/** The August month every case below reads, one line per rule. */
function augustRows(): PharmacyCountRow[] {
  return [
    // P1 — nine invoice lines of Ivyronc are ONE pharmacy, and it also bought Gutalax.
    ...Array.from({ length: 9 }, () => row({ clientCode: "P1", productCode: "IV" })),
    row({ clientCode: "P1", productCode: "GU" }),
    // P2 — a +2 then -2 return is two lines and NO purchase.
    row({ clientCode: "P2", productCode: "IV", qty: 2 }),
    row({ clientCode: "P2", productCode: "IV", qty: -2 }),
    // P3 under two distributors is TWO pharmacies: one distributor's code is not another's.
    row({ clientCode: "P3", productCode: "IV" }),
    row({ clientCode: "P3", productCode: "IV", distributorCode: "IBN" }),
    // A direct order is not a distributor pharmacy that bought.
    row({ clientCode: "P4", productCode: "IV", isDirect: true, includedInClosing: false }),
    // Office / a row with no customer code.
    row({ clientCode: "", clientName: "", productCode: "IV" }),
    // A confidential row that is not in the closing.
    row({ clientCode: "P5", productCode: "IV", includedInClosing: false }),
    // A wholesaler the closing shares across two areas is a share, not a pharmacy — in both.
    row({ clientCode: "W1", productCode: "GU", qty: 3, effectiveUnits: 1.5 }),
    row({ clientCode: "W1", productCode: "GU", qty: 3, effectiveUnits: 1.5, areaCode: "D17", sheetAreaCode: "D17" }),
    // D17 and Cairo each have their own pharmacy; P6 bought in a second brick of D16.
    row({ clientCode: "P6", productCode: "GU", brickId: "B2", brickName: "Fuwwah" }),
    row({ clientCode: "Q1", productCode: "IV", areaCode: "D17", sheetAreaCode: "D17" }),
    row({ clientCode: "C1", productCode: "GU", areaCode: "CA1", sheetAreaCode: "CA1" }),
    row({ clientCode: "C1", productCode: "IV", areaCode: "CA1", sheetAreaCode: "CA1" }),
  ];
}

function counts(periods: PharmacyCountPeriod[]) {
  return buildClosingPharmacyCounts({ line: "Pedia", periods });
}

function runCountingRuleTests() {
  const result = counts([{ period: AUG, rows: augustRows() }]);
  const d16 = result.areas.D16;
  assert.equal(d16.IV.length, 3, "D16 Ivyronc: P1 (nine lines = one) + P3 at UCP + P3 at IBN = 3; the return, direct, Office and confidential rows are not pharmacies");
  assert.equal(d16.GU.length, 2, "D16 Gutalax: P1 and P6 — the shared wholesaler is a share, not a pharmacy");
  assert.equal(result.areas.D17.IV.length, 1);
  assert.equal(result.areas.D17.GU, undefined, "the wholesaler's D17 share is not counted either");
  assert.deepEqual(result.periods, [AUG]);
}

function runSeveralMonthsTests() {
  // Each month on its own net, then joined: P2's August return does not cancel its September buy,
  // and P1 buying in both months is one pharmacy.
  const result = counts([
    { period: SEP, rows: [row({ clientCode: "P1", productCode: "IV" }), row({ clientCode: "P2", productCode: "IV" })] },
    { period: AUG, rows: augustRows() },
  ]);
  assert.equal(result.areas.D16.IV.length, 4, "P1, P3 (UCP), P3 (IBN) and P2 — who bought in ANY of the months");
  assert.deepEqual(result.periods, [AUG, SEP], "months are listed oldest first whatever order they came in");
}

function runLookupTests() {
  const result = counts([{ period: AUG, rows: augustRows() }]);
  const grid = matrix();
  const lookup = buildPharmacyLookup(result, grid);
  assert.equal(lookup.shown, true);
  assert.equal(lookup.cellFor("A:D16", "IV"), 3);
  assert.equal(lookup.totalFor("A:D16"), 4, "D16 any product: P1, P3, P3 (IBN), P6 — P1 bought two products and counts ONCE");
  assert.equal(lookup.cellFor("R:D", "IV"), 4, "Delta Ivyronc: D16's three plus D17's one");
  assert.equal(lookup.totalFor("R:D"), 5);
  assert.equal(lookup.cellFor("A:CA1", "GU"), 1);
  assert.equal(lookup.totalFor("A:CA1"), 1, "C1 bought both products and is one pharmacy");
  assert.equal(lookup.totalFor("NAT"), 6);
  assert.equal(lookup.cellFor("NAT", "GU"), 3);
  assert.equal(lookup.cellFor("A:D16", "XX"), 0, "a product with no buyer is a real zero");

  // A filtered grid (one product, one region) reads the same payload correctly.
  const filtered: MonthlyClosingMatrix = {
    ...grid,
    columns: [grid.columns[1]],
    regions: [{ ...grid.regions[0], areas: [grid.regions[0].areas[0]] }],
  };
  const narrow = buildPharmacyLookup(result, filtered);
  assert.equal(narrow.totalFor("NAT"), 3, "only D16's Ivyronc buyers are on a grid filtered to D16 and Ivyronc");
  assert.equal(narrow.totalFor("R:D"), 3);

  // The synthetic Direct pseudo-area has no pharmacies to show: "—", never a zero.
  const withDirect: MonthlyClosingMatrix = {
    ...grid,
    regions: [{ ...grid.regions[0], areas: [...grid.regions[0].areas, area("DIRECT", "Direct", "D", "Delta", { isDirect: true })] }, grid.regions[1]],
  };
  const direct = buildPharmacyLookup(result, withDirect);
  assert.equal(direct.cellFor("A:DIRECT", "IV"), null);
  assert.equal(direct.totalFor("A:DIRECT"), null);
  assert.equal(direct.totalFor("NAT"), 6, "the Direct row adds nobody to the national count");

  // Three states, kept apart.
  assert.equal(buildPharmacyLookup(undefined, grid).shown, false, "undefined: this surface has no column");
  const unknown = buildPharmacyLookup(null, grid);
  assert.equal(unknown.shown, true);
  assert.equal(unknown.cellFor("A:D16", "IV"), null, "null: loading or unreadable reads —, never 0");
  assert.equal(unknown.totalFor("NAT"), null);
}

function runBrickTests() {
  const result = counts([{ period: AUG, rows: augustRows() }]);
  const rows = pharmacyBrickRows(result, matrix());
  assert.deepEqual(
    rows.map((entry) => [entry.regionName, entry.areaName, entry.brickName, ...entry.counts, entry.total]),
    [
      ["Delta", "Kafr El-Sheikh 1", "Desouk", 1, 3, 3],
      ["Delta", "Kafr El-Sheikh 1", "Fuwwah", 1, 0, 1],
      ["Delta", "Kafr El-Sheikh 2", "Desouk", 0, 1, 1],
      ["Cairo", "Cairo 1", "Desouk", 1, 1, 1],
    ],
    "one row per brick, by name, in the grid's region and area order; the last column counts each pharmacy once",
  );
}

async function runWorkbookTests() {
  const result = counts([{ period: AUG, rows: augustRows() }]);
  const load = async (buffer: Buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    return workbook;
  };

  const withCount = await load(await buildMonthlyClosingWorkbook(matrix(), comparison(), undefined, { pharmacies: result }));
  const sheet = withCount.getWorksheet("Closing Matrix");
  assert.ok(sheet, "the Closing Matrix sheet is written");
  const metricRow = sheet!.getRow(5);
  const labels = Array.from({ length: 30 }, (_, index) => String(metricRow.getCell(index + 1).value ?? ""));
  // Product block: Units, Pharmacies, Value, … (8 columns, no Office on Pedia); Grand Total after both.
  assert.equal(labels[2], "Units");
  assert.equal(labels[3], "Pharmacies", "Pharmacies sits straight after Units");
  assert.equal(labels[4], "Value");
  assert.equal(labels[11], "Pharmacies", "and in the second product block");
  const grandStart = 3 + 2 * 8;
  assert.equal(labels[grandStart - 1], "Value");
  assert.equal(labels[grandStart], "Pharmacies", "and in the Grand Total block, after Value");

  // Row 6 is D16, row 7 D17, row 8 the Delta subtotal; Cairo's area and subtotal follow, then NAT.
  const valueAt = (rowIndex: number, col: number) => sheet!.getRow(rowIndex).getCell(col).value;
  assert.equal(valueAt(6, 4), 2, "D16 Gutalax pharmacies");
  assert.equal(valueAt(6, 12), 3, "D16 Ivyronc pharmacies");
  assert.equal(valueAt(6, grandStart + 1), 4, "D16 any product, each pharmacy once");
  assert.equal(valueAt(8, 12), 4, "Delta Ivyronc");
  assert.equal(valueAt(11, grandStart + 1), 6, "National Grand Total");

  const bricks = withCount.getWorksheet(PHARMACIES_BY_BRICK_SHEET);
  assert.ok(bricks, "the Pharmacies by Brick sheet is written beside the matrix");

  // Without the count the workbook is exactly what it was: no column, no sheet.
  const without = await load(await buildMonthlyClosingWorkbook(matrix(), comparison(), undefined, {}));
  const plain = without.getWorksheet("Closing Matrix")!.getRow(5);
  assert.equal(String(plain.getCell(4).value ?? ""), "Value", "no Pharmacies column when the caller did not supply the count");
  assert.equal(without.getWorksheet(PHARMACIES_BY_BRICK_SHEET), undefined);
}

function runWiringTests() {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  // Managers see their own team only, published months only, and a Medical Rep is not given it.
  const loader = read("src/lib/sales/closing-pharmacy-counts-loader.ts");
  assert.ok(loader.includes("resolvePortalClosingScope(access)"), "the portal count reads the viewer's own closing scope");
  assert.ok(loader.includes("listPublishedPeriodsForLine(line)"), "and only a published month");
  assert.ok(loader.includes('access.role === "Medical Rep"'), "and refuses a Medical Rep");
  assert.ok(!loader.includes("revealSource"), "never revealed: El Qema stays Main Stores, which is not a pharmacy");
  // The admin feed carries the same gate as the matrix it sits in.
  const adminRoute = read("app/api/sales/monthly-closing/pharmacies/route.ts");
  assert.ok(adminRoute.includes('access.role !== "SFE Manager" && access.role !== "CEO"'));
  assert.ok(adminRoute.includes('assertPermission(access, "sales", access.role === "CEO" ? "read" : "import")'));
  const portalRoute = read("app/api/employee-portals/monthly-closing/pharmacies/route.ts");
  assert.ok(portalRoute.includes("canAccessPortalClosing(access)"));
  assert.ok(portalRoute.includes('assertPermission(access, "sales", "read")'));
  // Both screens and both workbooks carry it.
  assert.ok(read("src/components/sales/monthly-closing-workspace.tsx").includes("pharmacies={pharmacies.counts}"));
  assert.ok(read("src/components/sales/portal-monthly-closing-view.tsx").includes("pharmacies={pharmacies.counts}"));
  const exportRoute = read("app/api/sales/monthly-closing/export/route.ts");
  assert.ok(exportRoute.includes("pharmacies: await pharmaciesPromise"), "the admin workbook gets the count");
  assert.ok(exportRoute.includes("loadPortalClosingPharmacyCounts("), "and so does a manager's own workbook");
}

export async function runClosingPharmacyCountsTests() {
  runCountingRuleTests();
  runSeveralMonthsTests();
  runLookupTests();
  runBrickTests();
  await runWorkbookTests();
  runWiringTests();
}
