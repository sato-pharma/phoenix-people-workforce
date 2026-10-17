import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";
import ts from "typescript";

import type { PortalWeeklyScopeView } from "../src/lib/sales/weekly/portal-weekly-dashboard.ts";
import { buildPortalWeeklyWorkbook } from "../src/lib/sales/weekly/portal-weekly-export.ts";
import type { WeeklyDashboard } from "../src/lib/sales/weekly/types.ts";
import {
  weeklyBreakdownUnitsAreOneProduct,
  weeklyKpiUnitsAreOneProduct,
  weeklyWeekComparisonUnitsAreOneProduct,
} from "../src/lib/sales/weekly/unit-totals.ts";
import { sampleDashboard } from "./weekly-export-workbook.test.ts";

// UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED (owner rule, 2026-08-27), on the managers' Weekly Sales.
//
// The Distribution tab showed "Sales Units" and "Stock Units" tiles that added every product in the
// selection, and its Breakdown table and Export did the same by region and by distributor. Asked on
// 2026-09-16, the owner chose to keep the unit figures ONLY while the numbers on screen cover exactly
// one product, with the Export following the same rule. This file pins that three ways:
//
//   1. THE RULE ITSELF (unit-totals.ts) — when a total is one product's, for each kind of total.
//   2. THE EMITTED WORKBOOK — reloaded from its bytes, never read off the builder's inputs.
//   3. THE SCREEN — the dashboard is a client component this runner cannot render, so its JSX tree is
//      parsed and every place a unit figure is drawn must be the rule's own supply.
//
// The SCREEN changed on 2026-09-19 (owner): it no longer dashes a unit figure that would add products, it
// shows that figure for ONE product — the "Units for" pick, else the top product by value — and names it
// beside the figure. Units are still never added; the Export above keeps the one-product rule, and the
// helpers behind the new screen are pinned in weekly-units-for-picker.test.ts.

const SCOPE: PortalWeeklyScopeView = {
  role: "National Sales Manager",
  visibility: { month: true, weekNumber: true, line: false, region: true, product: true, distributor: true },
  scopeSummary: "Anti Infective · every region",
  isSingleRegion: false,
  canDownloadNsmDsmExport: true,
};

/** The sample dashboard (two products) narrowed to ONE product, as the service returns it. */
function oneProduct(options: { filtered: boolean }): WeeklyDashboard {
  const base = sampleDashboard();
  return {
    ...base,
    kpis: { ...base.kpis, productCount: 1, salesUnits: 110, stockUnits: 7 },
    products: base.products.slice(0, 1),
    appliedFilters: {
      ...base.appliedFilters,
      productCode: options.filtered ? "SAG" : null,
      productCodes: options.filtered ? ["SAG"] : [],
    },
  };
}

async function reload(data: WeeklyDashboard): Promise<ExcelJS.Workbook> {
  const buffer = await buildPortalWeeklyWorkbook(data, SCOPE).xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer as unknown as Parameters<typeof loaded.xlsx.load>[0]);
  return loaded;
}

function sheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const found = workbook.getWorksheet(name);
  assert.ok(found, `the export has a "${name}" sheet`);
  return found;
}

/** The header row (row 3 on a Phoenix table sheet). */
function headers(worksheet: ExcelJS.Worksheet): string[] {
  const values = worksheet.getRow(3).values as unknown[];
  return values.filter((value): value is string => typeof value === "string");
}

/** Every Summary metric label, column A from the first data row down. */
function metrics(worksheet: ExcelJS.Worksheet): string[] {
  const labels: string[] = [];
  for (let row = 4; row <= worksheet.rowCount; row += 1) {
    const value = worksheet.getCell(row, 1).value;
    if (typeof value === "string" && value.trim()) labels.push(value.trim());
  }
  return labels;
}

function metricValue(worksheet: ExcelJS.Worksheet, label: string): unknown {
  for (let row = 4; row <= worksheet.rowCount; row += 1) {
    if (worksheet.getCell(row, 1).value === label) return worksheet.getCell(row, 2).value;
  }
  return undefined;
}

// ── 3. the screen, read as a JSX tree ─────────────────────────────────────────────────────────────

const DASHBOARD = "src/components/sales/weekly/portal-weekly-dashboard-impl.tsx";

export function parse(rel: string): ts.SourceFile {
  const text = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** The conditions a node renders under: every `cond ? node : …` and `cond && node` above it. */
export function guardsOf(node: ts.Node): string[] {
  const guards: string[] = [];
  let child: ts.Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isConditionalExpression(parent) && parent.whenTrue === child) guards.push(parent.condition.getText());
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === child
    ) {
      guards.push(parent.left.getText());
    }
  }
  return guards;
}

function enclosingDeclaration(node: ts.Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return parent.name.getText();
    if (ts.isJsxElement(parent) || ts.isJsxSelfClosingElement(parent)) return null;
  }
  return null;
}

/** The first `const <name> = …` under a node, as its source text. */
export function initializerOf(root: ts.Node, name: string): string | null {
  if (ts.isVariableDeclaration(root) && root.name.getText() === name && root.initializer) {
    return root.initializer.getText();
  }
  return ts.forEachChild(root, (child) => initializerOf(child, name) ?? undefined) ?? null;
}

/**
 * Every template a unit label is built from: `Units${unitsOf}`, `Sales Units${unitTiles.of}`. The text
 * before the first substitution is the label the screen prints, and the substitution names the product.
 */
function unitLabelTemplates(source: ts.SourceFile): { head: string; of: string; node: ts.TemplateExpression }[] {
  const found: { head: string; of: string; node: ts.TemplateExpression }[] = [];
  walk(source, (node) => {
    if (!ts.isTemplateExpression(node)) return;
    const head = node.head.text;
    if (head !== "Sales Units" && head !== "Stock Units" && head !== "Units") return;
    found.push({ head, of: node.templateSpans.map((span) => span.expression.getText()).join(","), node });
  });
  return found;
}

function assertDashboardDrawsUnitsOnlyUnderTheRule() {
  const source = parse(DASHBOARD);

  // Each figure's source is the rule's own answer, not a copy of it (unit-totals.ts).
  const initializers: [string, string][] = [
    ["showUnitTiles", "weeklyKpiUnitsAreOneProduct(data)"],
    ["unitTiles", "weeklyUnitTiles(data)"],
    ["unitView", "showUnitTiles ? null : (data.unitView ?? null)"],
    ["unitColumn", "useMemo(() => weeklyCutUnits(data, view), [data, view])"],
    ["showUnits", "unitColumn != null"],
    ["unitsOf", `unitColumn?.of ?? ""`],
  ];
  for (const [name, expected] of initializers) {
    assert.equal(initializerOf(source, name), expected, `the dashboard's ${name} is the rule's own answer, not a copy of it`);
  }

  // Every unit figure the file reads. The selection's own totals are read for "is this selection empty" and
  // nothing else; a figure that is drawn is the tile's (unitTiles) or a Breakdown row's (unitColumn).
  const seen = new Map<string, number>();
  walk(source, (node) => {
    if (!ts.isPropertyAccessExpression(node)) return;
    const text = node.getText();
    const name = node.name.text;
    if (name !== "salesUnits" && name !== "stockUnits" && text !== "row.units") return;
    if (enclosingDeclaration(node) === "isEmpty") return; // compares the totals to zero and draws nothing
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const guards = guardsOf(node);
    let kind: string;
    let guard: string;
    if (text.startsWith("unitTiles.")) {
      kind = "tile";
      guard = "unitTiles";
    } else if (text === "row.units") {
      kind = "row";
      guard = "showUnits";
    } else if (text.startsWith("weeklyCutUnitsOf(unitColumn,")) {
      kind = "rowSource";
      guard = "unitColumn";
    } else {
      assert.fail(`${text} is read at line ${line}: a unit figure the rule does not supply, which adds products together`);
    }
    assert.ok(guards.includes(guard), `${text} is drawn at line ${line} without the ${guard} guard`);
    seen.set(kind, (seen.get(kind) ?? 0) + 1);
  });
  for (const kind of ["tile", "row", "rowSource"]) {
    assert.ok(seen.get(kind), `positive control: the dashboard still reads a ${kind} unit figure, so the checks above are not vacuous`);
  }

  // The labels name the product the figure counts: `Sales Units${unitTiles.of}` under the tile guard,
  // `Units${unitsOf}` under the Breakdown's. A plain "Units" label would print a figure with no product.
  const templates = unitLabelTemplates(source);
  for (const { head, of, node } of templates) {
    const tile = head !== "Units";
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    assert.equal(of, tile ? "unitTiles.of" : "unitsOf", `"${head}" at line ${line} names the product it counts`);
    assert.ok(guardsOf(node).includes(tile ? "unitTiles" : "showUnits"), `"${head}" at line ${line} is drawn without its guard`);
  }
  const count = (head: string) => templates.filter((template) => template.head === head).length;
  assert.equal(count("Sales Units"), 1, "positive control: the Sales Units tile is found");
  assert.equal(count("Stock Units"), 1, "positive control: the Stock Units tile is found");
  assert.equal(count("Units"), 2, "positive control: the Breakdown's column head and its phone card are found");
  walk(source, (node) => {
    let label: string | null = null;
    if (ts.isJsxAttribute(node) && node.name.getText() === "label" && node.initializer && ts.isStringLiteral(node.initializer)) {
      label = node.initializer.text;
    } else if (ts.isJsxText(node)) {
      label = node.getText().trim();
    }
    if (label === "Sales Units" || label === "Stock Units" || label === "Units") {
      assert.fail(`a plain "${label}" label at line ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} names no product`);
    }
  });

  // The picker: drawn only when there is a product to show and more than one to pick from, and the pick
  // rides on the feed request only — never on the exports, which keep the one-product rule.
  const pickers: ts.Node[] = [];
  walk(source, (node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === "WeeklyUnitProductPicker") {
      pickers.push(node);
    }
  });
  assert.equal(pickers.length, 1, "the Distribution tab carries exactly one Units for picker");
  const picker = pickers[0] as ts.JsxSelfClosingElement;
  assert.ok(guardsOf(picker).includes("unitView && data.products.length > 1"), "the picker shows only when the selection holds several products");
  const props = new Map<string, string>();
  for (const property of picker.attributes.properties) {
    if (ts.isJsxAttribute(property) && property.initializer && ts.isJsxExpression(property.initializer) && property.initializer.expression) {
      props.set(property.name.getText(), property.initializer.expression.getText());
    }
  }
  assert.equal(props.get("value"), "unitView.productCode", "the picker holds the product the server used");
  assert.equal(props.get("onChange"), "setUnitProduct", "the picker's pick is what the next request carries");
  assert.equal(
    source.text.split(`params.set("unitProduct", unitProduct)`).length - 1,
    1,
    "the pick is added to the feed request once, and to no other request",
  );
}

export async function runWeeklyUnitsOneProductTests() {
  // ── 1. the rule ──
  const several = sampleDashboard();
  assert.equal(several.kpis.productCount, 2, "fixture: the sample dashboard holds two products");

  assert.equal(weeklyKpiUnitsAreOneProduct(several), false, "two products: the unit totals add them together");
  assert.equal(weeklyKpiUnitsAreOneProduct(oneProduct({ filtered: false })), true, "one product: its own units");
  assert.equal(
    weeklyKpiUnitsAreOneProduct({ kpis: { ...several.kpis, productCount: 0 } }),
    false,
    "no product at all is not one product",
  );

  assert.equal(weeklyBreakdownUnitsAreOneProduct(several, "product"), true, "a product row is always one product");
  assert.equal(weeklyBreakdownUnitsAreOneProduct(several, "region"), false, "a region row adds its products");
  assert.equal(weeklyBreakdownUnitsAreOneProduct(several, "distributor"), false, "a distributor row adds its products");
  assert.equal(
    weeklyBreakdownUnitsAreOneProduct(oneProduct({ filtered: false }), "region"),
    true,
    "a region row of a one-product selection is that product's units",
  );

  assert.equal(
    weeklyWeekComparisonUnitsAreOneProduct(oneProduct({ filtered: false })),
    false,
    "one product THIS week proves nothing about the weeks beside it: no filter, no unit column",
  );
  assert.equal(
    weeklyWeekComparisonUnitsAreOneProduct(oneProduct({ filtered: true })),
    true,
    "a filter pinned to one product makes every week in the comparison that product",
  );

  // ── 2. the emitted workbook ──
  const severalBook = await reload(several);
  const severalSummary = metrics(sheet(severalBook, "Summary"));
  assert.ok(severalSummary.includes("Total Sales Value"), "positive control: the Summary still reads its metrics");
  assert.ok(
    !severalSummary.includes("Total Sales Units") && !severalSummary.includes("Total Stock Units"),
    `two products: the Summary prints no unit total (found: ${severalSummary.join(" | ")})`,
  );
  const severalWeeks = headers(sheet(severalBook, "Week Comparison"));
  assert.ok(severalWeeks.includes("Sales Value (EGP)"), "positive control: the comparison still reads its heads");
  assert.deepEqual(
    severalWeeks.filter((head) => /units/i.test(head)),
    [],
    "two products: the Week Comparison has no unit column, so no unit SUM either",
  );

  const pinnedBook = await reload(oneProduct({ filtered: true }));
  const pinnedSummary = sheet(pinnedBook, "Summary");
  assert.equal(metricValue(pinnedSummary, "Total Sales Units"), "110", "one product: its sales units are printed");
  assert.equal(metricValue(pinnedSummary, "Total Stock Units"), "7", "one product: its stock units are printed");
  const pinnedWeeks = headers(sheet(pinnedBook, "Week Comparison"));
  assert.ok(
    pinnedWeeks.includes("Sales Units") && pinnedWeeks.includes("Stock Units"),
    "a filter pinned to one product keeps the Week Comparison's unit columns",
  );

  const unfilteredBook = await reload(oneProduct({ filtered: false }));
  assert.equal(
    metricValue(sheet(unfilteredBook, "Summary"), "Total Sales Units"),
    "110",
    "one product in the selected weeks: the Summary matches the screen's tile",
  );
  assert.deepEqual(
    headers(sheet(unfilteredBook, "Week Comparison")).filter((head) => /units/i.test(head)),
    [],
    "one product in the selected weeks but no product filter: the other weeks may hold other products",
  );

  // ── 3. the screen ──
  assertDashboardDrawsUnitsOnlyUnderTheRule();
}
