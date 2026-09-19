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
//   2. THE SCREEN — every unit read and label in the dashboard's JSX tree is the rule's own supply.
//   3. THE EMITTED WORKBOOK — reloaded from its bytes, never read off the builder's inputs.
//
// The SCREEN changed on 2026-09-19 (owner): where its rows add products it no longer hides the unit column,
// it shows the "Units for" product's units at each row and names that product on the table. The workbook
// keeps the 2026-09-17 rule above, dashes and all.

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
/** What may guard a unit read in each function: a table's prop, or the row list a chart is handed (null draws no chart). */
const READ_GUARDS: Record<string, string[]> = {
  ...Object.fromEntries(Object.entries(TABLE_GUARD).map(([name, guard]) => [name, [guard]])),
  DashboardCharts: ["branchUnitRows", "zeroStockUnitRows"],
};
/** The two charts that draw a branch's units and stock; the page renders each only when it has rows to draw. */
const UNIT_CHARTS: Record<string, string> = { BranchSalesStockChart: "branchRows", ZeroSalesStockChart: "stockRiskRows" };
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

  // Each figure's source is the rule's own answer for its cut (unit-totals.ts), not a copy of it: the
  // picked product's units where the rows add products, the rows' own where they are one product's.
  const initializers: [string, string][] = [
    ["unitTiles", "weeklyUnitTiles(data)"],
    ["regionUnits", `weeklyCutUnits(data, "region")`],
    ["productUnits", `weeklyCutUnits(data, "product")`],
    ["distributorUnits", `weeklyCutUnits(data, "distributor")`],
    ["branchUnits", `weeklyCutUnits(data, "branch")`],
    ["weekUnits", "weeklyWeekUnits(data)"],
    ["branchUnitRows", "weeklyRowsWithCutUnits(branchRows, branchUnits, (row) => row.code)"],
    ["zeroStockUnitRows", "weeklyRowsWithCutUnits(zeroStockRows, branchUnits, (row) => row.branchCode)"],
  ];
  for (const [name, expected] of initializers) {
    assert.equal(initializerOf(source, name), expected, `the page's ${name} is the rule's own answer`);
  }

  // Every unit figure the file reads. The page reads none of the selection's own totals — a tile is
  // unitTiles' — and a table or chart reads a row's only under its own guard.
  const seen = new Map<string, number>();
  walk(source, (node) => {
    if (!ts.isPropertyAccessExpression(node)) return;
    if (node.name.text !== "salesUnits" && node.name.text !== "stockUnits") return;
    const text = node.getText();
    const where = enclosingFunction(node) ?? "(top level)";
    const guards = guardsOf(node);
    const line = lineOf(source, node);
    if (where === PAGE) {
      assert.ok(
        text.startsWith("unitTiles."),
        `${text} is read at line ${line} of the page: only the rule's tiles (unitTiles) may be, or units of every product are added`,
      );
      assert.ok(guards.includes("unitTiles"), `${text} is drawn at line ${line} without the unitTiles guard`);
    } else {
      const allowed = READ_GUARDS[where];
      assert.ok(allowed, `${text} is read at line ${line} in ${where}, where no unit rule guards it`);
      assert.ok(
        allowed.some((guard) => guards.includes(guard)),
        `${text} is read at line ${line} in ${where} without a ${allowed.join(" / ")} guard`,
      );
    }
    const key = where === PAGE ? "tiles" : where;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  });
  for (const key of ["tiles", ...Object.keys(READ_GUARDS)]) {
    assert.ok(seen.get(key), `positive control: the dashboard still reads units in ${key}, so the checks above are not vacuous`);
  }

  // The two tiles' labels name the product they count, under the tile guard.
  const tiles: string[] = [];
  walk(source, (node) => {
    if (!ts.isJsxAttribute(node) || node.name.getText() !== "label" || !node.initializer || !ts.isJsxExpression(node.initializer)) return;
    const expression = node.initializer.expression;
    if (!expression || !ts.isTemplateExpression(expression) || !/^(Sales|Stock) units$/.test(expression.head.text)) return;
    const line = lineOf(source, node);
    assert.ok(guardsOf(node).includes("unitTiles"), `the "${expression.head.text}" tile at line ${line} is drawn without the unitTiles guard`);
    assert.deepEqual(
      expression.templateSpans.map((span) => span.expression.getText()),
      ["unitTiles.of"],
      `the "${expression.head.text}" tile at line ${line} names the product it counts`,
    );
    tiles.push(expression.head.text);
  });
  assert.deepEqual(tiles.sort(), ["Sales units", "Stock units"], "positive control: both unit tiles are found");

  // The plain labels that announce a unit figure — column heads and phone cards — sit under their table's guard.
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
    if (where in UNIT_CHARTS) return; // the chart element itself is held below
    const guard = TABLE_GUARD[where];
    const line = lineOf(source, node);
    assert.ok(guard, `"${label}" is drawn at line ${line} in ${where}, where no unit rule guards it`);
    assert.ok(guardsOf(node).includes(guard), `"${label}" is drawn at line ${line} in ${where} without the ${guard} guard`);
    labels += 1;
  });
  assert.ok(labels >= 8, `positive control: the tables still label their unit figures (found ${labels})`);

  // Each table and chart, and each call site passing the answer for its OWN cut: the rows it draws come
  // through the same cut that decides whether its unit column shows.
  const RANK_CUT: Record<string, string> = { "data.regions": "regionUnits", "data.distributorBreakdown": "distributorUnits" };
  const calls: string[] = [];
  walk(source, (node) => {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return;
    const tag = node.tagName.getText();
    const at = lineOf(source, node);
    if (tag in UNIT_CHARTS) {
      assert.ok(guardsOf(node).includes(UNIT_CHARTS[tag]), `<${tag}> is drawn at line ${at} without the ${UNIT_CHARTS[tag]} guard`);
      calls.push(tag);
      return;
    }
    if (tag === "DashboardCharts") {
      assert.equal(attribute(node, "branchUnitRows"), "branchUnits ? branchUnitRows : null", `<DashboardCharts> at line ${at} hands over branch rows only when the cut has units`);
      assert.equal(attribute(node, "zeroStockUnitRows"), "branchUnits ? zeroStockUnitRows : null", `<DashboardCharts> at line ${at} hands over stock rows only when the cut has units`);
      assert.equal(attribute(node, "unitsFor"), "unitsFor(branchUnits)", `<DashboardCharts> at line ${at} names the product its unit charts count`);
      calls.push(tag);
      return;
    }
    if (!(tag in TABLE_GUARD)) return;
    const rows = attribute(node, "rows");
    let cut: string | null = null;
    if (tag === "RankTable") {
      const match = /^weeklyRowsWithCutUnits\((data\.\w+), (\w+), \(row\) => row\.code\)$/.exec(rows ?? "");
      cut = rows === "data.products" ? "productUnits" : match && RANK_CUT[match[1]] === match[2] ? match[2] : null;
    } else if (tag === "BranchComparisonTable") {
      cut = rows === "branchUnitRows" ? "branchUnits" : null;
    } else if (tag === "ZeroStockTable") {
      cut = rows === "zeroStockUnitRows" ? "branchUnits" : null;
    } else {
      cut = rows === "weeklyWeekRowsWithUnits(data.weekComparison, weekUnits)" ? "weekUnits" : null;
    }
    assert.ok(cut, `<${tag}> at line ${at} draws rows that do not come through their own cut: ${rows}`);
    const prop = tag === "ZeroStockTable" ? "showStock" : "showUnits";
    assert.equal(attribute(node, prop), `${cut} != null`, `<${tag} rows={${rows}}> is told ${prop} by its own cut`);
    // A sortable table remounts when its columns come and go, so no sort survives on a hidden column.
    if (tag !== "WeekComparisonTable") {
      assert.ok(
        (attribute(node, "key") ?? "").includes(`\${${cut} != null}`),
        `<${tag}> at line ${at} is keyed on ${cut}, so a hidden column's sort is dropped`,
      );
    }
    // The product a column counts is named on its table: in the props of one, the title of another.
    if (cut !== "productUnits") {
      const named = tag === "RankTable" ? attribute(node, "title") : attribute(node, "unitsFor");
      assert.ok(
        (named ?? "").includes(`unitsFor(${cut})`),
        `<${tag}> at line ${at} names the product its ${cut} column counts`,
      );
    }
    calls.push(`${tag}:${cut}`);
  });
  assert.deepEqual(
    [...calls].sort(),
    [
      "BranchComparisonTable:branchUnits",
      "BranchSalesStockChart",
      "DashboardCharts",
      "RankTable:distributorUnits",
      "RankTable:productUnits",
      "RankTable:regionUnits",
      "WeekComparisonTable:weekUnits",
      "ZeroSalesStockChart",
      "ZeroStockTable:branchUnits",
    ],
    "positive control: every table and chart that draws units is found and checked",
  );

  // The "Units for" picker: drawn only when there is a product to show and several to pick from, holding
  // the product the server used, and the pick rides on the feed request only — never on the Export.
  const pickers: (ts.JsxSelfClosingElement | ts.JsxOpeningElement)[] = [];
  walk(source, (node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === "WeeklyUnitProductPicker") {
      pickers.push(node);
    }
  });
  assert.equal(pickers.length, 1, "the page carries exactly one Units for picker");
  const guards = guardsOf(pickers[0]).join(" | ");
  assert.ok(guards.includes("data.unitView") && guards.includes("data.products.length > 1"), "the picker shows only when there is a product to show and several to pick from");
  assert.equal(attribute(pickers[0], "tone"), "admin", "the picker wears the admin shell's look");
  assert.equal(attribute(pickers[0], "value"), "data.unitView.productCode", "the picker holds the product the server used");
  assert.equal(attribute(pickers[0], "onChange"), "setUnitProduct", "the picker's pick is what the next request carries");
  assert.equal(source.text.split(`params.set("unitProduct", unitProduct)`).length - 1, 1, "the pick is added to the feed request once, and to no other");
  assert.ok(!source.text.includes("Units and stock appear only where"), "the note that explained hidden unit columns is gone: the picker says what the figures are");
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
