import assert from "node:assert/strict";

import ts from "typescript";

import {
  WEEKLY_SALES_DETAIL_UNMAPPED_REGION_LABEL,
  buildWeeklySalesDepotDetail,
  weeklySalesDetailProductUnitsByGroup,
  weeklySalesDetailUnitProduct,
  type WeeklySalesDetailGroupCut,
  type WeeklySalesDetailSourceRow,
  type WeeklySalesDetailUpload,
} from "../src/lib/sales/weekly/sales-depot-detail.ts";
import {
  buildWeeklyStockView,
  weeklyStockProductUnitsByGroup,
  weeklyStockUnitProduct,
  type WeeklyStockGroupCut,
  type WeeklyStockSourceRow,
} from "../src/lib/sales/weekly/stock-dashboard.ts";
import type { WeeklyDashboard, WeeklyDashboardUnitView } from "../src/lib/sales/weekly/types.ts";
import {
  weeklyCutUnits,
  weeklyCutUnitsOf,
  weeklyRowsWithCutUnits,
  weeklyUnitTiles,
  weeklyUnitViewProduct,
  weeklyUnitsOfLabel,
  weeklyWeekKey,
  weeklyWeekRowsWithUnits,
  weeklyWeekUnits,
} from "../src/lib/sales/weekly/unit-totals.ts";
import { sampleDashboard } from "./weekly-export-workbook.test.ts";
import { guardsOf, initializerOf, parse, walk } from "./weekly-units-one-product.test.ts";

// ONE PRODUCT AT A TIME (owner, 2026-09-19). Units of different products are never added (2026-08-27), and
// until this day a screen that would have added them hid the figure or printed a dash — so a sheet holding
// several products left the Weekly Sales and Weekly Stock screens with nothing to read. They now show the
// figure for ONE product, the one picked in a "Units for" bar (default: the top product by value), and name
// that product beside it. The product's units at a row are its own units THERE — never the row's sum.
//
// Four things are pinned, because none is visible when it breaks:
//
//   1. THE HELPERS (unit-totals.ts) — which product a figure counts, and that a place the product never
//      reached reads ZERO, never the row's own added-up figure.
//   2. THE KEYS — a group row is found by its code, so the per-product units are keyed exactly as the group
//      rows are: the same code, else the column silently reads zero on every row.
//   3. THE PICKER'S DEFAULT AND ITS STALE PICK — a product another filter has since removed falls back.
//   4. THE WIRING — the request carries the pick, the server builds the view, and each screen's tables hand
//      the same product's units to every group they draw.

// ── 1. the helpers ────────────────────────────────────────────────────────────────────────────────

const WEEK_1 = weeklyWeekKey("2026-05-01", 1);
const WEEK_2 = weeklyWeekKey("2026-05-01", 2);

function sagUnitView(overrides: Partial<WeeklyDashboardUnitView> = {}): WeeklyDashboardUnitView {
  return {
    productCode: "SAG",
    productName: "Saginkgo",
    kpis: { salesUnits: 110, stockUnits: 7 },
    compare: {
      salesUnits: { current: 110, prior: 100, pct: 0.1 },
      stockUnits: { current: 7, prior: 5, pct: 0.4 },
    },
    regions: { D1: { salesUnits: 80, stockUnits: 5 }, D2: { salesUnits: 30, stockUnits: 2 } },
    distributors: { IS: { salesUnits: 110, stockUnits: 7 } },
    branches: { B1: { salesUnits: 110, stockUnits: 7 } },
    weeks: { [WEEK_1]: { salesUnits: 50, stockUnits: 3 }, [WEEK_2]: { salesUnits: null, stockUnits: 4 } },
    ...overrides,
  };
}

/** The two-product sample dashboard as the service returns it, its selection's own totals ADDED across both. */
function severalProducts(unitView: WeeklyDashboardUnitView | null): WeeklyDashboard {
  const base = sampleDashboard();
  return { ...base, kpis: { ...base.kpis, salesUnits: 999, stockUnits: 88 }, unitView };
}

/** The same dashboard narrowed to ONE product, with or without a product filter pinning it. */
function oneProduct(filtered: boolean, unitView: WeeklyDashboardUnitView | null): WeeklyDashboard {
  const base = severalProducts(unitView);
  return {
    ...base,
    kpis: { ...base.kpis, productCount: 1, salesUnits: 110, stockUnits: 7 },
    products: base.products.slice(0, 1),
    appliedFilters: { ...base.appliedFilters, productCode: filtered ? "SAG" : null, productCodes: filtered ? ["SAG"] : [] },
    compare: {
      ...base.compare,
      salesUnits: { current: 110, prior: 90, pct: 0.22 },
      stockUnits: { current: 7, prior: 6, pct: 0.17 },
    },
  };
}

function assertTheHelpersNameOneProductAndNeverAddTwo() {
  // Which product: the pick while the list still holds it, else the list's first (its top by value).
  const list = [{ code: "SAG" }, { code: "ROY" }];
  assert.equal(weeklyUnitViewProduct(list, null)?.code, "SAG", "no pick: the top product by value");
  assert.equal(weeklyUnitViewProduct(list, " roy ")?.code, "ROY", "a pick is matched without case or padding");
  assert.equal(weeklyUnitViewProduct(list, "GONE")?.code, "SAG", "a pick another filter removed falls back, it never names a product the screen no longer lists");
  assert.equal(weeklyUnitViewProduct([], "SAG"), null, "no product at all: nothing to show");
  assert.equal(weeklyUnitsOfLabel(null), "", "a figure that is its own names no product");
  assert.equal(weeklyUnitsOfLabel(sagUnitView()), " · Saginkgo", "a picked figure names the product beside it");

  // The tiles: the picked product's own units, never the selection's added-up 999 / 88.
  const tiles = weeklyUnitTiles(severalProducts(sagUnitView()));
  assert.equal(tiles?.of, " · Saginkgo");
  assert.equal(tiles?.salesUnits, 110, "several products: the picked product's own sales units, not the 999 the rows add up to");
  assert.equal(tiles?.stockUnits, 7, "several products: the picked product's own stock, not the 88 the rows add up to");
  assert.deepEqual(tiles?.compare, sagUnitView().compare, "several products: the change is the picked product's own change");
  assert.equal(weeklyUnitTiles(severalProducts(null)), null, "several products and no product to show: no tile, never the added-up figure");
  const own = weeklyUnitTiles(oneProduct(false, null));
  assert.deepEqual([own?.of, own?.salesUnits, own?.stockUnits], ["", 110, 7], "one product: its own totals, named by nothing");
  assert.equal(own?.compare, null, "one product with no filter: the prior week may hold other products, so no change is shown without the picked product's own");
  assert.deepEqual(
    weeklyUnitTiles(oneProduct(false, sagUnitView()))?.compare,
    sagUnitView().compare,
    "one product with no filter: the change is the picked product's own",
  );
  assert.deepEqual(
    weeklyUnitTiles(oneProduct(true, null))?.compare?.salesUnits,
    { current: 110, prior: 90, pct: 0.22 },
    "a filter pinned to one product: both weeks are that product, so the selection's own change is right",
  );

  // A table's unit column, by cut.
  const several = severalProducts(sagUnitView());
  assert.deepEqual(weeklyCutUnits(several, "product"), { of: "", byKey: null }, "a product row's units are always its own");
  assert.equal(weeklyCutUnits(several, "region")?.byKey, several.unitView?.regions, "a region row shows the picked product's units at that region");
  assert.equal(weeklyCutUnits(several, "distributor")?.byKey, several.unitView?.distributors);
  assert.equal(weeklyCutUnits(several, "branch")?.byKey, several.unitView?.branches);
  assert.equal(weeklyCutUnits(severalProducts(null), "region"), null, "several products and no product to show: no column");
  assert.deepEqual(weeklyCutUnits(oneProduct(false, null), "region"), { of: "", byKey: null }, "one product: a region row's own units");

  // A row's figures: the picked product's at its key, zero where the product never reached.
  const region = weeklyCutUnits(several, "region");
  assert.ok(region, "fixture: the region cut has units");
  const rowD1 = { salesUnits: 500, stockUnits: 60 };
  assert.deepEqual(weeklyCutUnitsOf(region, "D1", rowD1), { salesUnits: 80, stockUnits: 5 });
  assert.deepEqual(
    weeklyCutUnitsOf(region, "D9", rowD1),
    { salesUnits: 0, stockUnits: 0 },
    "a place the picked product never reached reads zero, NOT the row's own added-up units",
  );
  assert.equal(weeklyCutUnitsOf({ of: "", byKey: null }, "D9", rowD1), rowD1, "a row's own units stay its own when they are one product's");

  const rows = [
    { code: "D1", name: "Delta 1", salesValue: 5000, share: 0.5, ...rowD1 },
    { code: "D9", name: "Delta 9", salesValue: 5000, share: 0.5, salesUnits: 400, stockUnits: 30 },
  ];
  const shown = weeklyRowsWithCutUnits(rows, region, (row) => row.code);
  assert.deepEqual(
    shown.map((row) => [row.code, row.salesUnits, row.stockUnits, row.salesValue, row.share]),
    [
      ["D1", 80, 5, 5000, 0.5],
      ["D9", 0, 0, 5000, 0.5],
    ],
    "the units are the picked product's; the value and share stay the row's own",
  );
  assert.equal(weeklyRowsWithCutUnits(rows, { of: "", byKey: null }, (row) => row.code), rows, "one product: the rows are untouched");
  assert.equal(weeklyRowsWithCutUnits(rows, null, (row) => row.code), rows, "no product to show: the rows are untouched");

  // The week comparison: gap-nulled exactly as the week's own figure is.
  const weeks = [
    { cycleMonth: "2026-05-01", weekNumber: 1, salesUnits: 555 as number | null, stockUnits: 66 },
    { cycleMonth: "2026-05-01", weekNumber: 2, salesUnits: 777 as number | null, stockUnits: 88 },
    { cycleMonth: "2026-05-01", weekNumber: 3, salesUnits: 444 as number | null, stockUnits: 44 },
    { cycleMonth: "2026-05-01", weekNumber: 4, salesUnits: null as number | null, stockUnits: 22 },
  ];
  const weekUnits = weeklyWeekUnits(several);
  assert.equal(weekUnits?.of, " · Saginkgo");
  assert.deepEqual(
    weeklyWeekRowsWithUnits(weeks, weekUnits).map((row) => [row.weekNumber, row.salesUnits, row.stockUnits]),
    [
      [1, 50, 3],
      [2, null, 4],
      [3, 0, 0],
      [4, null, 0],
    ],
    "the picked product's own weekly units; a week spanning an upload gap stays a dash, a week it never reached reads zero",
  );
  assert.equal(weeklyWeekUnits(severalProducts(null)), null, "several products and no product to show: no week columns");
  assert.equal(weeklyWeekRowsWithUnits(weeks, null), weeks, "no week units: the rows are untouched");
  const pinned = oneProduct(true, null);
  assert.deepEqual(weeklyWeekUnits(pinned), { of: "", byWeek: null }, "a product filter makes every week that product's own");
  assert.equal(weeklyWeekRowsWithUnits(weeks, weeklyWeekUnits(pinned)), weeks, "so its weeks are untouched");
}

// ── 2. the keys, and 3. the default and the stale pick — Weekly Stock ─────────────────────────────

function stockRow(partial: Partial<WeeklyStockSourceRow>): WeeklyStockSourceRow {
  return {
    distributorCode: "PS",
    distributorName: "Overseas",
    regionCode: "CA",
    regionName: "Cairo",
    areaCode: "CA1",
    branchCode: "B1",
    branchName: "Nasr City",
    productCode: "CO001",
    productName: "Conviban 50 mg",
    line: "CNS",
    cycleMonth: "2026-09-01",
    weekNumber: 1,
    weekStart: "2026-09-06",
    netUnits: 4,
    stockUnits: 10,
    factoryPrice: 30,
    ...partial,
  };
}

function assertWeeklyStockKeysItsUnitsLikeItsRows() {
  const rows = [
    stockRow({}),
    // A second product at the SAME branch: the branch row's value adds both, its Units for CO001 must not.
    stockRow({ productCode: "CO002", productName: "Other 10 mg", stockUnits: 100, netUnits: 1, factoryPrice: 10 }),
    // A branch with no area mapping, in another region.
    stockRow({ regionCode: "GZ", regionName: "Giza", areaCode: null, branchCode: "B2", branchName: "Giza Store", stockUnits: 6, netUnits: 2 }),
    // A second distributor whose region carries no code, so the region row is keyed by its name.
    stockRow({
      distributorCode: "IS",
      distributorName: "Ibn Sina",
      regionCode: "",
      regionName: "Delta",
      areaCode: "D1",
      branchCode: "B3",
      branchName: "Tanta Store",
      stockUnits: 3,
      netUnits: 1,
    }),
  ];
  const view = buildWeeklyStockView(rows, new Map([["CA1", "Nasr City 1"], ["D1", "Tanta 1"]]));
  assert.equal(view.products.length, 2, "fixture: the view holds two products");
  assert.ok(view.cells.length >= 4, "fixture: the view holds its cells");

  const CUTS: WeeklyStockGroupCut[] = ["depots", "areas", "regions", "distributors"];
  for (const cut of CUTS) {
    const byCode = weeklyStockProductUnitsByGroup(view.cells, "CO001", cut);
    const rowCodes = view[cut].map((group) => group.code).sort();
    assert.deepEqual(
      Object.keys(byCode).sort(),
      rowCodes,
      `${cut}: CO001 reaches every group here, so its units are keyed by exactly the group rows' codes — a different key would read zero on every row`,
    );
  }

  const nasr = view.depots.find((depot) => depot.name === "Nasr City");
  assert.ok(nasr, "fixture: the Nasr City branch row");
  const nasrUnits = weeklyStockProductUnitsByGroup(view.cells, "CO001", "depots")[nasr.code];
  assert.equal(nasrUnits.stockUnits, 10, "CO001's stock at Nasr City is its own 10, not the 110 the branch holds across both products");
  assert.equal(
    nasrUnits.avgWeeklyUnits,
    view.cells.find((cell) => cell.productCode === "CO001" && cell.branchName === "Nasr City")?.avgWeeklyUnits,
    "and its average weekly units are the cell's own",
  );
  const other = weeklyStockProductUnitsByGroup(view.cells, "co002", "depots");
  assert.deepEqual(Object.keys(other), [nasr.code], "a product is matched without case, and only the branches that hold it are keyed");
  assert.equal(other[nasr.code].stockUnits, 100);

  // The default is the top product by stock value; a pick is honoured, a stale one falls back.
  const top = [...view.products].sort((a, b) => b.stockValue - a.stockValue)[0];
  assert.equal(top.productCode, "CO002", "fixture: CO002's 100 units at 10 are the most valuable stock");
  assert.equal(weeklyStockUnitProduct(view.products, null)?.productCode, "CO002", "no pick: the top product by stock value");
  assert.equal(weeklyStockUnitProduct(view.products, "co001")?.productCode, "CO001", "a pick is honoured without case");
  assert.equal(weeklyStockUnitProduct(view.products, "GONE")?.productCode, "CO002", "a stale pick falls back to the top product");
  assert.equal(weeklyStockUnitProduct([], "CO001"), null, "no product at all: nothing to show");
}

// ── 2. the keys, and 3. the default and the stale pick — Weekly Sales, Branch Detail ──────────────

const SEPTEMBER = "2026-09-01";

function detailRow(overrides: Partial<WeeklySalesDetailSourceRow>): WeeklySalesDetailSourceRow {
  return {
    batchId: "pos-w1",
    distributorCode: "POS",
    distributorName: "POS Purchasing Sales",
    regionCode: "UE",
    regionName: "Upper Egypt",
    areaCode: "UE3",
    branchCode: "BR1",
    branchName: "Minia Branch",
    productCode: "P1",
    productName: "Augmentin 1g",
    line: "Anti Infective",
    cycleMonth: SEPTEMBER,
    weekNumber: 1,
    weekStart: "2026-09-06",
    salesValue: 0,
    salesUnits: 0,
    basis: "whole",
    ...overrides,
  };
}

function assertBranchDetailKeysItsUnitsLikeItsRows() {
  const uploads: WeeklySalesDetailUpload[] = [
    { batchId: "pos-w1", distributorCode: "POS", cycleMonth: SEPTEMBER, weekNumber: 1, weekStart: "2026-09-06" },
    { batchId: "is-w1", distributorCode: "IS", cycleMonth: SEPTEMBER, weekNumber: 1, weekStart: "2026-09-06" },
  ];
  const rows = [
    detailRow({ salesUnits: 10, salesValue: 1000 }),
    // A second product at the SAME branch, worth more than the first: the branch row adds both values.
    detailRow({ productCode: "P2", productName: "Flagyl 500mg", salesUnits: 20, salesValue: 9000 }),
    // A branch that serves several areas: no area, in the same region.
    detailRow({ areaCode: null, branchCode: "KA1", branchName: "UE Key Accounts", salesUnits: 5, salesValue: 500 }),
    // Another distributor, region and area-less branch.
    detailRow({
      batchId: "is-w1",
      distributorCode: "IS",
      distributorName: "Ibn Sina",
      regionCode: "CA",
      regionName: "Cairo",
      areaCode: null,
      branchCode: "CW1",
      branchName: "Cairo Wholesale",
      salesUnits: 7,
      salesValue: 700,
    }),
    // A branch in no region: its region row keeps the empty code.
    detailRow({
      batchId: "is-w1",
      distributorCode: "IS",
      distributorName: "Ibn Sina",
      regionCode: "",
      regionName: WEEKLY_SALES_DETAIL_UNMAPPED_REGION_LABEL,
      areaCode: null,
      branchCode: "UN1",
      branchName: "Nowhere Store",
      salesUnits: 1,
      salesValue: 90,
    }),
  ];
  const view = buildWeeklySalesDepotDetail({
    audience: "manager",
    rows,
    areaNames: new Map([["UE3", "Assuit 1"]]),
    uploads,
    period: { cycleMonths: [SEPTEMBER], cycleMonthMode: "include" },
  });
  assert.equal(view.products.length, 2, "fixture: the view holds two products");

  const CUTS: WeeklySalesDetailGroupCut[] = ["depots", "areas", "regions", "distributors"];
  for (const cut of CUTS) {
    const byCode = weeklySalesDetailProductUnitsByGroup(view.cells, "P1", cut);
    assert.deepEqual(
      Object.keys(byCode).sort(),
      view[cut].map((group) => group.code).sort(),
      `${cut}: P1 reaches every group here, so its units are keyed by exactly the group rows' codes — a different key would read zero on every row`,
    );
  }
  assert.ok(
    view.regions.some((region) => region.code === ""),
    "fixture: 'Region not mapped' keeps its empty code, the case a key built another way would get wrong",
  );

  const minia = view.depots.find((depot) => depot.name === "Minia Branch");
  assert.ok(minia, "fixture: the Minia Branch row");
  assert.equal(minia.value, 10000, "the branch row's VALUE adds both products");
  const miniaUnits = weeklySalesDetailProductUnitsByGroup(view.cells, "P1", "depots")[minia.code];
  assert.equal(miniaUnits.units, 10, "P1's units at Minia Branch are its own 10, never the 30 both products sold there");
  const p2 = weeklySalesDetailProductUnitsByGroup(view.cells, "p2", "depots");
  assert.deepEqual(Object.keys(p2), [minia.code], "a product is matched without case, and only the branches that sold it are keyed");
  assert.equal(p2[minia.code].units, 20);

  assert.equal(weeklySalesDetailUnitProduct(view.products, null)?.productCode, "P2", "no pick: the top product by value");
  assert.equal(weeklySalesDetailUnitProduct(view.products, "p1")?.productCode, "P1", "a pick is honoured without case");
  assert.equal(weeklySalesDetailUnitProduct(view.products, "GONE")?.productCode, "P2", "a stale pick falls back to the top product");
  assert.equal(weeklySalesDetailUnitProduct([], "P1"), null, "no product at all: nothing to show");
}

// ── 4. the wiring ─────────────────────────────────────────────────────────────────────────────────

const SERVICE = "src/lib/sales/weekly/service.ts";
const STOCK_SCREEN = "src/components/sales/weekly/weekly-stock-dashboard.tsx";
const DETAIL_SCREEN = "src/components/sales/weekly/weekly-sales-depot-detail.tsx";

function elements(source: ts.SourceFile, tag: string): (ts.JsxSelfClosingElement | ts.JsxOpeningElement)[] {
  const found: (ts.JsxSelfClosingElement | ts.JsxOpeningElement)[] = [];
  walk(source, (node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === tag) found.push(node);
  });
  return found;
}

function attributeOf(element: ts.JsxSelfClosingElement | ts.JsxOpeningElement, name: string): string | null {
  for (const property of element.attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name || !property.initializer) continue;
    if (ts.isStringLiteral(property.initializer)) return property.initializer.text;
    if (ts.isJsxExpression(property.initializer) && property.initializer.expression) return property.initializer.expression.getText();
  }
  return null;
}

function assertTheWiringCarriesOneProductEverywhere() {
  // The server: a product filter pinning one code needs no view; otherwise the pick, else the top product.
  const service = parse(SERVICE);
  assert.equal(
    initializerOf(service, "unitProduct"),
    "appliedFilters.productCode ? null : weeklyUnitViewProduct(productRanking, filters?.unitProductCode)",
    "the server picks the product from the ranking the screen lists, and builds none when a filter already pins one",
  );
  assert.equal(
    initializerOf(service, "productRanking"),
    "rank(weekRowsAdj, (row) => row.productCode, (row) => row.productName)",
    "the ranking behind the pick is the one the By product table draws",
  );
  assert.match(service.text, /\n\s+unitView,\n/, "the dashboard the server returns carries the view");

  // Both routes read the pick off the request under the one name the screens send.
  const routes: [string, RegExp][] = [
    ["app/api/sales/weekly/dashboard/route.ts", /unitProductCode: str\("unitProduct"\)/],
    ["app/api/employee-portals/weekly-sales/route.ts", /unitProductCode: searchParams\.get\("unitProduct"\)\?\.trim\(\) \|\| null/],
    ["src/lib/sales/weekly/portal-weekly-dashboard.ts", /unitProductCode: filters\.unitProductCode/],
  ];
  for (const [rel, pattern] of routes) assert.match(parse(rel).text, pattern, `${rel} carries the Units for pick through`);

  // The two group screens: every table they draw is handed the units of the SAME product the picker shows.
  // Each screen draws its group tables from one component; the count is how many call sites it has (Weekly
  // Stock folds Branch, Area and Region into one, Branch Detail draws one per tab).
  const PICKER_GUARD = "groupCut && unitsProduct && view.products.length > 1 && rowCount > 0";
  const screens: [string, string, string, number][] = [
    [STOCK_SCREEN, "weeklyStockProductUnitsByGroup(view.cells, unitsProduct.productCode, groupCut)", "weeklyStockUnitProduct(view.products, unitProduct)", 2],
    [DETAIL_SCREEN, "weeklySalesDetailProductUnitsByGroup(view.cells, unitsProduct.productCode, groupCut)", "view ? weeklySalesDetailUnitProduct(view.products, unitProduct) : null", 4],
  ];
  for (const [rel, builder, product, tableCount] of screens) {
    const table = "GroupTable";
    const source = parse(rel);
    assert.equal(initializerOf(source, "unitsProduct"), product, `${rel}: the product the units follow is the helper's pick`);
    assert.ok(source.text.includes(builder), `${rel}: the units are the helper's, built from the view's own cells so they follow every filter the rows do`);

    const tables = elements(source, table);
    assert.equal(tables.length, tableCount, `${rel}: positive control: every group table is found, and checked below`);
    for (const element of tables) {
      const line = source.getLineAndCharacterOfPosition(element.getStart()).line + 1;
      assert.equal(attributeOf(element, "units"), "groupUnits", `${rel}: <${table}> at line ${line} is handed the picked product's units`);
    }

    const pickers = elements(source, "WeeklyUnitProductPicker");
    assert.equal(pickers.length, 1, `${rel}: one Units for picker`);
    assert.ok(guardsOf(pickers[0]).includes(PICKER_GUARD), `${rel}: the picker shows only over a group table with rows and several products`);
    assert.equal(attributeOf(pickers[0], "value"), "unitsProduct.productCode", `${rel}: the picker holds the product the units follow`);
    assert.equal(attributeOf(pickers[0], "onChange"), "setUnitProduct", `${rel}: the picker's pick moves the units`);
  }
}

export async function runWeeklyUnitsForPickerTests() {
  assertTheHelpersNameOneProductAndNeverAddTwo();
  assertWeeklyStockKeysItsUnitsLikeItsRows();
  assertBranchDetailKeysItsUnitsLikeItsRows();
  assertTheWiringCarriesOneProductEverywhere();
}
