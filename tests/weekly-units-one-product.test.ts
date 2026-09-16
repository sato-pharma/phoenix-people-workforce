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
//      parsed and every place a unit figure is drawn must sit under the rule's own guard.

const SCOPE: PortalWeeklyScopeView = {
  role: "National Sales Manager",
  visibility: { month: true, weekNumber: true, line: false, region: true, product: true, distributor: true },
  scopeSummary: "Anti Infective · every region",
  isSingleRegion: false,
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

function parse(rel: string): ts.SourceFile {
  const text = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** The conditions a node renders under: every `cond ? node : …` and `cond && node` above it. */
function guardsOf(node: ts.Node): string[] {
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
function initializerOf(root: ts.Node, name: string): string | null {
  if (ts.isVariableDeclaration(root) && root.name.getText() === name && root.initializer) {
    return root.initializer.getText();
  }
  return ts.forEachChild(root, (child) => initializerOf(child, name) ?? undefined) ?? null;
}

function assertDashboardDrawsUnitsOnlyUnderTheRule() {
  const source = parse(DASHBOARD);

  assert.equal(
    initializerOf(source, "showUnitTiles"),
    "weeklyKpiUnitsAreOneProduct(data)",
    "the unit tiles' guard is the rule's own one-product test, not a copy of it",
  );
  assert.equal(
    initializerOf(source, "showUnits"),
    "weeklyBreakdownUnitsAreOneProduct(data, view)",
    "the Breakdown's Units guard is the rule's own test for that cut",
  );

  // Every unit figure the file reads: the KPI totals and a Breakdown row's units.
  const reads: { text: string; node: ts.Node }[] = [];
  walk(source, (node) => {
    if (!ts.isPropertyAccessExpression(node)) return;
    const text = node.getText();
    if (text === "data.kpis.salesUnits" || text === "data.kpis.stockUnits" || text === "row.units") {
      reads.push({ text, node });
    }
  });
  assert.ok(
    reads.some((read) => read.text === "data.kpis.salesUnits") && reads.some((read) => read.text === "row.units"),
    "positive control: the dashboard still reads the unit totals, so the checks below are not vacuous",
  );
  for (const read of reads) {
    // The one read that draws nothing: "is this selection empty" compares the totals to zero.
    if (enclosingDeclaration(read.node) === "isEmpty") continue;
    const guard = read.text === "row.units" ? "showUnits" : "showUnitTiles";
    assert.ok(
      guardsOf(read.node).includes(guard),
      `${read.text} is drawn at line ${
        source.getLineAndCharacterOfPosition(read.node.getStart()).line + 1
      } without the ${guard} guard: that shows units added across products`,
    );
  }

  // The labels that announce a unit figure sit under the same guards: the tiles, the column head and
  // the phone card's stat.
  const labelled: { label: string; guard: string; seen: number }[] = [
    { label: "Sales Units", guard: "showUnitTiles", seen: 0 },
    { label: "Stock Units", guard: "showUnitTiles", seen: 0 },
    { label: "Units", guard: "showUnits", seen: 0 },
  ];
  walk(source, (node) => {
    let label: string | null = null;
    if (ts.isJsxAttribute(node) && node.name.getText() === "label" && node.initializer && ts.isStringLiteral(node.initializer)) {
      label = node.initializer.text;
    } else if (ts.isJsxText(node)) {
      label = node.getText().trim();
    }
    const entry = labelled.find((candidate) => candidate.label === label);
    if (!entry) return;
    entry.seen += 1;
    assert.ok(
      guardsOf(node).includes(entry.guard),
      `"${entry.label}" is drawn at line ${
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      } without the ${entry.guard} guard`,
    );
  });
  for (const entry of labelled) {
    assert.ok(entry.seen > 0, `positive control: the dashboard still labels "${entry.label}" somewhere`);
  }
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
