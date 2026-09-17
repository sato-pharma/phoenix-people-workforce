import assert from "node:assert/strict";

import ExcelJS from "exceljs";
import ts from "typescript";

import { buildWeeklyExportWorkbook } from "../src/lib/sales/weekly/export-workbook.ts";
import type { WeeklyDashboard } from "../src/lib/sales/weekly/types.ts";
import {
  weeklyBreakdownUnitsAreOneProduct,
  weeklyFactRowUnitsAreOneProduct,
  weeklyKpiUnitDeltaIsOneProduct,
} from "../src/lib/sales/weekly/unit-totals.ts";
import { GENERATED_AT, sampleDashboard } from "./weekly-export-workbook.test.ts";
import { guardsOf, initializerOf, parse, walk } from "./weekly-units-one-product.test.ts";

// UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED (owner rule, 2026-08-27), on the admin shell's Weekly Sales.
//
// The admin Weekly Sales Dashboard added every product's units into its Sales units and Stock units tiles,
// its region, branch and distributor tables, its Week Comparison, its two unit charts and its watchlist's
// stock, and its Export Excel (the Weekly BI workbook) did the same in formulas. Asked on 2026-09-17, the
// owner chose the managers' portal rule for both: a unit figure appears only while the rows it adds are one
// product's, and By product always keeps its units. The workbook's design is password-locked, so there the
// cell stays and holds a dash. This file pins that three ways, like weekly-units-one-product.test.ts:
//
//   1. THE RULE ITSELF — the cuts and tests only the admin page and the workbook ask.
//   2. THE SCREEN — every unit read and label in the dashboard's JSX tree sits under the rule's guard.
//   3. THE EMITTED WORKBOOK — reloaded from its bytes, never read off the builder's inputs.

/** The sample dashboard (two products) narrowed to ONE product, its Data rows included. */
function oneProduct(options: { filtered: boolean }): WeeklyDashboard {
  const base = sampleDashboard();
  return {
    ...base,
    kpis: { ...base.kpis, productCount: 1 },
    products: base.products.filter((product) => product.code === "SAG"),
    factRows: (base.factRows ?? []).filter((row) => row.productCode === "SAG"),
    appliedFilters: {
      ...base.appliedFilters,
      productCode: options.filtered ? "SAG" : null,
      productCodes: options.filtered ? ["SAG"] : [],
    },
  };
}

// ── 2. the screen, read as a JSX tree ─────────────────────────────────────────────────────────────

const DASHBOARD = "src/components/sales/weekly/weekly-dashboard-view-impl.tsx";

/** The guard each table component draws its unit figures under: its own `showUnits` or `showStock` prop. */
const TABLE_GUARD: Record<string, string> = {
  RankTable: "showUnits",
  BranchComparisonTable: "showUnits",
  WeekComparisonTable: "showUnits",
  ZeroStockTable: "showStock",
};
/** The two charts that draw a branch's units and stock; the page renders each only under `showBranchUnits`. */
const UNIT_CHARTS = ["BranchSalesStockChart", "ZeroSalesStockChart"];
const PAGE = "WeeklyDashboardView";

function enclosingFunction(node: ts.Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
  }
  return null;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function attribute(element: ts.JsxSelfClosingElement | ts.JsxOpeningElement, name: string): string | null {
  for (const property of element.attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name || !property.initializer) continue;
    const initializer = property.initializer;
    if (ts.isStringLiteral(initializer)) return initializer.text;
    if (ts.isJsxExpression(initializer) && initializer.expression) return initializer.expression.getText();
  }
  return null;
}

function assertDashboardDrawsUnitsOnlyUnderTheRule() {
  const source = parse(DASHBOARD);

  // Each guard is the rule's own answer for its cut, not a copy of it.
  const initializers: [string, string][] = [
    ["showUnitTiles", "weeklyKpiUnitsAreOneProduct(data)"],
    ["showUnitDeltas", "weeklyKpiUnitDeltaIsOneProduct(data)"],
    ["regionUnits", `weeklyBreakdownUnitsAreOneProduct(data, "region")`],
    ["productUnits", `weeklyBreakdownUnitsAreOneProduct(data, "product")`],
    ["distributorUnits", `weeklyBreakdownUnitsAreOneProduct(data, "distributor")`],
    ["branchUnits", `weeklyBreakdownUnitsAreOneProduct(data, "branch")`],
    ["weekUnits", "weeklyWeekComparisonUnitsAreOneProduct(data)"],
  ];
  for (const [name, expected] of initializers) {
    assert.equal(initializerOf(source, name), expected, `the page's ${name} is the rule's own test`);
  }

  // Every unit figure the file reads. A read in a function the rule does not guard is a new unit figure.
  const seen = new Map<string, number>();
  walk(source, (node) => {
    if (!ts.isPropertyAccessExpression(node)) return;
    if (node.name.text !== "salesUnits" && node.name.text !== "stockUnits") return;
    const text = node.getText();
    const where = enclosingFunction(node) ?? "(top level)";
    const guards = guardsOf(node);
    const line = lineOf(source, node);
    if (where === PAGE && text.startsWith("data.kpis.")) {
      assert.ok(guards.includes("showUnitTiles"), `${text} is drawn at line ${line} without the showUnitTiles guard`);
    } else if (where === PAGE && text.startsWith("data.compare.")) {
      assert.ok(
        guards.includes("showUnitDeltas") && guards.includes("showUnitTiles"),
        `${text} is drawn at line ${line} without the showUnitDeltas guard: a change against weeks of other products`,
      );
    } else {
      const guard = TABLE_GUARD[where];
      assert.ok(guard, `${text} is read at line ${line} in ${where}, where no unit rule guards it`);
      assert.ok(guards.includes(guard), `${text} is read at line ${line} in ${where} without the ${guard} guard`);
    }
    const key = text.startsWith("data.") ? text : where;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  });
  for (const key of ["data.kpis.salesUnits", "data.kpis.stockUnits", "data.compare.salesUnits", ...Object.keys(TABLE_GUARD)]) {
    assert.ok(seen.get(key), `positive control: the dashboard still reads units in ${key}, so the checks above are not vacuous`);
  }

  // The labels that announce a unit figure sit under the same guards: tiles, column heads, phone cards.
  const UNIT_LABELS = new Set(["Sales units", "Stock units", "Units", "Stock"]);
  let labels = 0;
  walk(source, (node) => {
    let label: string | null = null;
    if (ts.isJsxAttribute(node) && node.name.getText() === "label" && node.initializer && ts.isStringLiteral(node.initializer)) {
      label = node.initializer.text;
    } else if (ts.isJsxText(node)) {
      label = node.getText().trim();
    }
    if (!label || !UNIT_LABELS.has(label)) return;
    const where = enclosingFunction(node) ?? "(top level)";
    if (UNIT_CHARTS.includes(where)) return; // the chart element itself is held below
    const guard = where === PAGE ? "showUnitTiles" : TABLE_GUARD[where];
    const line = lineOf(source, node);
    assert.ok(guard, `"${label}" is drawn at line ${line} in ${where}, where no unit rule guards it`);
    assert.ok(guardsOf(node).includes(guard), `"${label}" is drawn at line ${line} in ${where} without the ${guard} guard`);
    labels += 1;
  });
  assert.ok(labels >= 10, `positive control: the dashboard still labels its unit figures (found ${labels})`);

  // The two unit charts, and each call site passing the answer for its own cut.
  const RANK_CUT: Record<string, string> = {
    "data.regions": "regionUnits",
    "data.products": "productUnits",
    "data.distributorBreakdown": "distributorUnits",
  };
  const CALL_CUT: Record<string, string> = {
    BranchComparisonTable: "branchUnits",
    WeekComparisonTable: "weekUnits",
    ZeroStockTable: "branchUnits",
    DashboardCharts: "branchUnits",
  };
  const expectedGuard = (tag: string, rows: string | null): string | null =>
    (tag === "RankTable" ? RANK_CUT[rows ?? ""] : CALL_CUT[tag]) ?? null;
  const calls: string[] = [];
  walk(source, (node) => {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return;
    const tag = node.tagName.getText();
    if (UNIT_CHARTS.includes(tag)) {
      assert.ok(guardsOf(node).includes("showBranchUnits"), `<${tag}> is drawn at line ${lineOf(source, node)} without the showBranchUnits guard`);
      calls.push(tag);
      return;
    }
    if (!(tag in TABLE_GUARD) && tag !== "DashboardCharts") return;
    const prop = tag === "ZeroStockTable" ? "showStock" : tag === "DashboardCharts" ? "showBranchUnits" : "showUnits";
    const expected = expectedGuard(tag, attribute(node, "rows"));
    assert.ok(expected, `<${tag}> at line ${lineOf(source, node)} draws rows this test does not know: ${attribute(node, "rows")}`);
    assert.equal(attribute(node, prop), expected, `<${tag} rows={${attribute(node, "rows")}}> is told ${prop} by its own cut`);
    // A sortable table remounts when its columns come and go, so no sort survives on a hidden column.
    if (tag !== "WeekComparisonTable" && tag !== "DashboardCharts") {
      assert.ok(
        (attribute(node, "key") ?? "").includes(`\${${expected}}`),
        `<${tag}> at line ${lineOf(source, node)} is keyed on ${expected}, so a hidden column's sort is dropped`,
      );
    }
    calls.push(`${tag}:${expected}`);
  });
  assert.deepEqual(
    [...calls].sort(),
    [
      "BranchComparisonTable:branchUnits",
      "BranchSalesStockChart",
      "DashboardCharts:branchUnits",
      "RankTable:distributorUnits",
      "RankTable:productUnits",
      "RankTable:regionUnits",
      "WeekComparisonTable:weekUnits",
      "ZeroSalesStockChart",
      "ZeroStockTable:branchUnits",
    ],
    "positive control: every table and chart that draws units is found and checked",
  );

  // Said on the screen whenever a unit column is missing, and only then.
  let note = 0;
  walk(source, (node) => {
    if (!ts.isJsxText(node) || !node.getText().includes("Units and stock appear only where")) return;
    note += 1;
    assert.ok(guardsOf(node).some((guard) => guard.includes("!weekUnits")), "the note shows only while units are hidden somewhere");
  });
  assert.equal(note, 1, "the page says why units are missing");
}

// ── 3. the emitted workbook ───────────────────────────────────────────────────────────────────────

const DASH = `"—"`;
const NOTE = "Units and stock read — wherever they would add different products together";

async function reload(data: WeeklyDashboard): Promise<ExcelJS.Workbook> {
  const buffer = await buildWeeklyExportWorkbook(data, GENERATED_AT);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer as unknown as Parameters<typeof loaded.xlsx.load>[0]);
  return loaded;
}

function sheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const found = workbook.getWorksheet(name);
  assert.ok(found, `the workbook has a "${name}" sheet`);
  return found;
}

function textAt(worksheet: ExcelJS.Worksheet, row: number, col: number): string {
  const value = worksheet.getCell(row, col).value;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "richText" in value) return value.richText.map((run) => run.text).join("");
  return "";
}

function formulaAt(worksheet: ExcelJS.Worksheet, row: number, col: number): string {
  const formula = worksheet.getCell(row, col).formula;
  assert.equal(typeof formula, "string", `${worksheet.name}!${worksheet.getCell(row, col).address} is still a formula cell`);
  return formula;
}

function columnOf(worksheet: ExcelJS.Worksheet, row: number, head: string): number {
  for (let col = 1; col <= worksheet.columnCount; col += 1) if (textAt(worksheet, row, col) === head) return col;
  assert.fail(`${worksheet.name} row ${row} has a "${head}" column`);
}

/** A breakdown sheet's body rows and TOTAL row, with its unit and stock columns. */
function breakdown(worksheet: ExcelJS.Worksheet) {
  const units = columnOf(worksheet, 4, "Units Sold");
  const stock = columnOf(worksheet, 4, "Stock Units");
  const body: number[] = [];
  let total = 0;
  for (let row = 5; row <= worksheet.rowCount; row += 1) {
    if (textAt(worksheet, row, 2) === "TOTAL") { total = row; break; }
    body.push(row);
  }
  assert.ok(body.length > 0 && total > 0, `${worksheet.name} still has body rows and a TOTAL row`);
  return { units, stock, body, total };
}

/** The group rows (regions, lines) and their detail rows of a drill sheet, above any lower section. */
function drill(worksheet: ExcelJS.Worksheet, groupNames: string[]) {
  const groups: number[] = [];
  const details: number[] = [];
  for (let row = 5; row <= worksheet.rowCount; row += 1) {
    const name = textAt(worksheet, row, 1);
    if (!worksheet.getCell(row, 3).formula) break; // the lower section starts past a gap
    (groupNames.includes(name) ? groups : details).push(row);
  }
  assert.equal(groups.length, groupNames.length, `${worksheet.name} still has a row for each of ${groupNames.join(", ")}`);
  assert.ok(details.length > 0, `${worksheet.name} still has product rows`);
  return { groups, details };
}

async function assertWorkbookDashesUnitsAcrossProducts() {
  const several = sampleDashboard();
  const regionNames = [...new Set((several.factRows ?? []).map((row) => row.regionName))];
  const lineNames = [...new Set((several.factRows ?? []).map((row) => row.line || "Unspecified"))];
  // A product row's formula ends on its own product code: SUMIFS(…, <ProductCode column>, "SAG").
  const oneProductsRow = new RegExp(`^SUMIFS\\(.*,"(${several.products.map((product) => product.code).join("|")})"\\)$`);
  const book = await reload(several);

  for (const name of ["By Region", "By Distributor", "By Branch"]) {
    const ws = sheet(book, name);
    const { units, stock, body, total } = breakdown(ws);
    for (const row of [...body, total]) {
      assert.equal(formulaAt(ws, row, units), DASH, `two products: ${name} row ${row} holds a dash, not units added across products`);
      assert.equal(formulaAt(ws, row, stock), DASH, `two products: ${name} row ${row} holds a dash, not stock added across products`);
    }
    assert.ok(textAt(ws, 2, 1).includes(NOTE), `two products: ${name} says why its units read a dash`);
  }

  const byProduct = sheet(book, "By Product");
  const products = breakdown(byProduct);
  for (const row of products.body) {
    assert.match(formulaAt(byProduct, row, products.units), /^SUMIFS\(/, `a product row keeps its own units (row ${row})`);
    assert.match(formulaAt(byProduct, row, products.stock), /^SUMIFS\(/, `a product row keeps its own stock (row ${row})`);
  }
  assert.equal(formulaAt(byProduct, products.total, products.units), DASH, "two products: By Product's TOTAL adds no units");
  assert.equal(formulaAt(byProduct, products.total, products.stock), DASH, "two products: By Product's TOTAL adds no stock");

  const regionDrill = sheet(book, "Region Drill");
  const regions = drill(regionDrill, regionNames);
  for (const row of regions.groups) {
    assert.equal(formulaAt(regionDrill, row, 3), DASH, `two products: the region row ${row} adds no units`);
    assert.equal(formulaAt(regionDrill, row, 4), DASH, `two products: the region row ${row} adds no stock`);
  }
  for (const row of regions.details) assert.match(formulaAt(regionDrill, row, 3), oneProductsRow, `a region's product row ${row} keeps its units`);
  assert.ok(textAt(regionDrill, 2, 1).includes(NOTE), "two products: Region Drill says why");

  const byLine = sheet(book, "By Line");
  const lines = drill(byLine, lineNames);
  for (const row of lines.groups) {
    assert.equal(formulaAt(byLine, row, 3), DASH, `two products: the line row ${row} adds no units`);
    assert.equal(formulaAt(byLine, row, 4), DASH, `two products: the line row ${row} adds no stock`);
  }
  for (const row of lines.details) assert.match(formulaAt(byLine, row, 3), oneProductsRow, `a line's product row ${row} keeps its units`);
  assert.ok(textAt(byLine, 2, 1).includes(NOTE), "two products: By Line says why");

  const matrix = sheet(book, "Region x Product");
  const totals: number[] = [];
  let unitsTitle = 0;
  for (let row = 4; row <= matrix.rowCount; row += 1) {
    if (textAt(matrix, row, 2) === "TOTAL") totals.push(row);
    if (textAt(matrix, row, 1) === "Units Sold") unitsTitle = row;
  }
  assert.equal(totals.length, 2, "the matrix still has a Value and a Units TOTAL row");
  assert.ok(totals[0] < unitsTitle && unitsTitle < totals[1], "the Units section is the second one");
  const lastCol = columnOf(matrix, 4, "Total");
  for (let col = 3; col <= lastCol; col += 1) {
    assert.match(formulaAt(matrix, totals[0], col), /^SUM\(/, "the Value matrix keeps its TOTAL row");
    assert.equal(formulaAt(matrix, totals[1], col), DASH, "two products: the Units matrix's TOTAL row adds no units");
  }

  const dashboard = sheet(book, "Dashboard");
  const tile = (label: string) => formulaAt(dashboard, 6, columnOf(dashboard, 5, label));
  assert.match(tile("SALES VALUE (EGP)"), /^SUM\(/, "positive control: the value tile still sums the Data");
  assert.equal(tile("NET UNITS SOLD"), DASH, "two products: the units tile adds no units");
  assert.equal(tile("STOCK ON HAND"), DASH, "two products: the stock tile adds no stock");
  assert.ok(textAt(dashboard, 2, 1).includes(NOTE), "two products: the Dashboard says why");

  // One product in the Data: every unit total is that product's, so nothing is dashed and nothing said.
  const singleData = oneProduct({ filtered: false });
  const single = await reload(singleData);
  for (const name of ["By Region", "By Product", "By Distributor", "By Branch"]) {
    const ws = sheet(single, name);
    const { units, stock, body, total } = breakdown(ws);
    for (const row of body) assert.match(formulaAt(ws, row, units), /^SUMIFS\(/, `one product: ${name} row ${row} keeps its units`);
    assert.match(formulaAt(ws, total, units), /^SUM\(/, `one product: ${name}'s TOTAL keeps its units`);
    assert.match(formulaAt(ws, total, stock), /^SUM\(/, `one product: ${name}'s TOTAL keeps its stock`);
  }
  for (const name of ["Dashboard", "By Region", "By Product", "Region Drill", "By Line", "Region x Product"]) {
    assert.ok(!textAt(sheet(single, name), 2, 1).includes(NOTE), `one product: ${name} carries no note`);
  }
  const singleDrill = sheet(single, "Region Drill");
  const singleRegions = [...new Set((singleData.factRows ?? []).map((row) => row.regionName))];
  for (const row of drill(singleDrill, singleRegions).groups) {
    assert.match(formulaAt(singleDrill, row, 3), /^SUMIFS\(/, `one product: the region row ${row} keeps its units`);
  }
  const singleDashboard = sheet(single, "Dashboard");
  assert.match(formulaAt(singleDashboard, 6, columnOf(singleDashboard, 5, "NET UNITS SOLD")), /^SUM\(/, "one product: the units tile sums");
}

export async function runWeeklyAdminUnitsOneProductTests() {
  // ── 1. the rule ──
  const several = sampleDashboard();
  assert.equal(several.kpis.productCount, 2, "fixture: the sample dashboard holds two products");

  assert.equal(weeklyBreakdownUnitsAreOneProduct(several, "branch"), false, "a branch row adds its products");
  assert.equal(weeklyBreakdownUnitsAreOneProduct(oneProduct({ filtered: false }), "branch"), true, "a branch row of one product");

  assert.equal(weeklyKpiUnitDeltaIsOneProduct(several), false, "two products: no change in units");
  assert.equal(
    weeklyKpiUnitDeltaIsOneProduct(oneProduct({ filtered: false })),
    false,
    "one product this week, but the week it is compared with may hold others: no change in units",
  );
  assert.equal(weeklyKpiUnitDeltaIsOneProduct(oneProduct({ filtered: true })), true, "a product filter: both weeks are that product");

  const rows = several.factRows ?? [];
  assert.equal(weeklyFactRowUnitsAreOneProduct(rows), false, "two products in the Data rows");
  assert.equal(weeklyFactRowUnitsAreOneProduct(rows.filter((row) => row.productCode === "SAG")), true, "one product in the Data rows");
  assert.equal(weeklyFactRowUnitsAreOneProduct([]), false, "no Data rows are not one product");
  assert.equal(
    weeklyFactRowUnitsAreOneProduct([
      { productCode: "SAG", productName: "Saginkgo" },
      { productCode: "SAG", productName: "Saginkgo 100mg" },
    ]),
    true,
    "one product code under two spellings of its name is still one product",
  );
  assert.equal(
    weeklyFactRowUnitsAreOneProduct([
      { productCode: "SAG", productName: "Saginkgo" },
      { productCode: "ROY", productName: "Saginkgo" },
    ]),
    false,
    "two product codes are two products, whatever their names say",
  );

  // ── 2. the screen ──
  assertDashboardDrawsUnitsOnlyUnderTheRule();

  // ── 3. the emitted workbook ──
  await assertWorkbookDashesUnitsAcrossProducts();
}
