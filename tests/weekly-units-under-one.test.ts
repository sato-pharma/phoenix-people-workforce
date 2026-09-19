import assert from "node:assert/strict";

import ts from "typescript";

import { WEEKLY_UNITS_UNDER_ONE, weeklyUnitsUnderOne } from "../src/lib/sales/weekly/unit-totals.ts";
import { parse, walk } from "./weekly-units-one-product.test.ts";

// A SHARE UNDER ONE UNIT READS "<1", NEVER A DASH OR A "0" BESIDE ITS MONEY (owner, 2026-09-19).
//
// On the employee portal's Weekly Sales, a rep's units are an allocation of depot shipments, so a product's
// slice can be a fraction of a unit while its money is real. Guamusin showed EGP 20 next to a "0" total and
// dashes in weeks 1 to 3, because every unit figure was rounded to a whole number and a rounded zero prints
// as a dash. The rep's own screen and the manager's field-force tab share the table, so both are pinned:
//
//   1. THE RULE (unit-totals.ts) — which figures are "under one unit", and which are not.
//   2. THE PRINTED TEXT — each screen's own wrappers, lifted out of its source and run, so the check reads
//      what the screen would print rather than a copy of it.
//   3. THE WIRING — every unit figure the two screens draw goes through those wrappers, and nowhere else.

const SCREENS = [
  { name: "the rep's own screen", rel: "src/components/sales/weekly/portal-weekly-rep-view.tsx" },
  { name: "the manager's field-force tab", rel: "src/components/sales/weekly/portal-weekly-field-force-view.tsx" },
] as const;

const WRAPPERS = ["unitsCell", "unitsTotal"] as const;

/** The name of the function or const a node sits inside, or null at the top of the file. */
function enclosingName(node: ts.Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
  }
  return null;
}

/**
 * The screen's own `formatNumber`, `isNil`, `unitsCell` and `unitsTotal`, lifted from its source text,
 * compiled and run against the real rule. Nothing here is a copy: an edit to a wrapper changes the answer.
 */
function printedTextOf(rel: string): { unitsCell: (units: number) => string; unitsTotal: (units: number) => string } {
  const wanted = new Set(["formatNumber", "isNil", ...WRAPPERS]);
  const pieces: string[] = [];
  for (const statement of parse(rel).statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && wanted.has(statement.name.text)) {
      pieces.push(statement.getText());
    } else if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && wanted.has(declaration.name.text))
    ) {
      pieces.push(statement.getText());
    }
  }
  assert.ok(
    WRAPPERS.every((wrapper) => pieces.some((piece) => piece.includes(wrapper))),
    `${rel}: positive control: both wrappers are found at the top of the screen's source`,
  );
  const compiled = ts.transpileModule(
    [
      "function build(weeklyUnitsUnderOne: (units: number) => boolean, WEEKLY_UNITS_UNDER_ONE: string) {",
      ...pieces,
      "  return { unitsCell, unitsTotal };",
      "}",
    ].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
  ).outputText;
  const build = new Function(`${compiled}\nreturn build;`)() as (
    under: typeof weeklyUnitsUnderOne,
    label: string,
  ) => { unitsCell: (units: number) => string; unitsTotal: (units: number) => string };
  return build(weeklyUnitsUnderOne, WEEKLY_UNITS_UNDER_ONE);
}

function assertTheRule() {
  assert.equal(WEEKLY_UNITS_UNDER_ONE, "<1", "the label is \"<1\"");

  assert.equal(weeklyUnitsUnderOne(0.3), true, "a third of a unit is a share under one unit");
  assert.equal(weeklyUnitsUnderOne(0.49), true, "up to the rounding edge, a share is under one unit");
  assert.equal(weeklyUnitsUnderOne(0.5), false, "half a unit rounds to one, and prints as one");
  assert.equal(weeklyUnitsUnderOne(1.4), false, "one and a bit is a whole-number figure");
  assert.equal(weeklyUnitsUnderOne(120), false, "a whole figure is not a share");

  assert.equal(weeklyUnitsUnderOne(0), false, "zero units is an empty week, not a share: it keeps its dash");
  assert.equal(weeklyUnitsUnderOne(-0.3), false, "a net of returns is not a share");
  assert.equal(weeklyUnitsUnderOne(Number.NaN), false, "a figure that is not a number is never a share");
  assert.equal(weeklyUnitsUnderOne(Number.POSITIVE_INFINITY), false, "and neither is an infinite one");
}

function assertThePrintedText() {
  for (const { name, rel } of SCREENS) {
    const { unitsCell, unitsTotal } = printedTextOf(rel);

    assert.equal(unitsCell(0.3), "<1", `${name}: a week cell holding a share under one unit reads "<1"`);
    assert.equal(unitsTotal(0.3), "<1", `${name}: a product total holding a share under one unit reads "<1", not "0"`);

    assert.equal(unitsCell(0), "—", `${name}: a week the product never reached stays a dash`);
    assert.equal(unitsTotal(0), "0", `${name}: a product total of nothing stays 0`);

    assert.equal(unitsCell(0.5), "1", `${name}: half a unit rounds to one, as it always did`);
    assert.equal(unitsCell(46), "46", `${name}: a whole figure prints as itself`);
    assert.equal(unitsCell(1234), "1,234", `${name}: a thousand separator is kept`);
    assert.equal(unitsTotal(191), "191", `${name}: a whole total prints as itself`);
    assert.equal(unitsTotal(1234.4), "1,234", `${name}: a total past one unit still rounds to whole units`);
  }
}

function assertTheWiring() {
  for (const { name, rel } of SCREENS) {
    const source = parse(rel);

    const imported = source.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        statement.moduleSpecifier.getText() === '"@/lib/sales/weekly/unit-totals"' &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some((element) => element.name.text === "weeklyUnitsUnderOne"),
    );
    assert.ok(imported, `${name}: the rule is the domain's own (unit-totals.ts), not a copy in the screen`);

    const calls = new Map<string, number>(WRAPPERS.map((wrapper) => [wrapper, 0]));
    const raw: { text: string; line: number }[] = [];
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression.getText();
      if (calls.has(callee)) calls.set(callee, (calls.get(callee) ?? 0) + 1);
      if (callee !== "formatNumber") return;
      const argument = node.arguments[0]?.getText();
      if (argument !== "units" && argument !== "product.units") return;
      // A raw rounding of a unit figure is allowed in exactly one place: inside the wrapper that guards it.
      if (WRAPPERS.some((wrapper) => wrapper === enclosingName(node))) return;
      raw.push({ text: node.getText(), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    });

    assert.deepEqual(
      raw,
      [],
      `${name}: a unit figure is drawn without the under-one guard: ${raw.map((call) => `${call.text} at line ${call.line}`).join(", ")}`,
    );
    for (const wrapper of WRAPPERS) {
      assert.ok(
        (calls.get(wrapper) ?? 0) >= 2,
        `${name}: positive control: ${wrapper} is used by the table AND the phone cards (found ${calls.get(wrapper)})`,
      );
    }
  }
}

export async function runWeeklyUnitsUnderOneTests() {
  assertTheRule();
  assertThePrintedText();
  assertTheWiring();
}
