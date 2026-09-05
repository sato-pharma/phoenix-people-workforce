// The deduction exports print words, not stored values.
//
// The detail sheets rendered `days` and `requires_review` straight out of the database, beside
// columns already written for a person. Same defect class as a raw HR code on a screen — and
// `requires_review` is exactly the row a reviewer most needs to notice, so it is the worst one to
// leave looking like a column name.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertEveryDeductionsEnumIsLabelled,
  deductionsCalculationStatusLabel,
  deductionsUnitLabel,
} from "../src/lib/deductions/calculations.ts";
import { deductionsCalculationStatuses, deductionsUnits } from "../src/lib/deductions/types.ts";

const EXPORT_BUILDERS = [
  "src/lib/deductions/exports/category-workbook.ts",
  "src/lib/deductions/exports/master-workbook.ts",
];

export function runDeductionEnumLabelTests() {
  // ── the labels themselves ──────────────────────────────────────────────────────────────────────
  assert.equal(deductionsUnitLabel("days"), "Days");
  assert.equal(deductionsUnitLabel("amount"), "Amount");
  assert.equal(deductionsCalculationStatusLabel("calculated"), "Calculated");
  assert.equal(
    deductionsCalculationStatusLabel("requires_review"),
    "Requires review",
    "The status a reviewer must not skim past reads as a sentence, not as an identifier.",
  );

  // ── every member is covered ────────────────────────────────────────────────────────────────────
  // An exhaustive `Record` does not gate the build here: `ignoreBuildErrors` lets a missing key
  // compile, build and deploy, and the cell would print `undefined` on a payroll document. This is
  // the runtime check that stops that, and it walks the enum arrays rather than a copy of them, so
  // a value added to `types.ts` fails here until it is labelled.
  assert.doesNotThrow(assertEveryDeductionsEnumIsLabelled, "Every enum member must have a label.");
  for (const unit of deductionsUnits) {
    const label = deductionsUnitLabel(unit);
    assert.notEqual(label, unit, `"${unit}" must be labelled, not passed through.`);
    assert.doesNotMatch(label, /_/, `"${label}" still reads as a stored value.`);
  }
  for (const status of deductionsCalculationStatuses) {
    const label = deductionsCalculationStatusLabel(status);
    assert.notEqual(label, status, `"${status}" must be labelled, not passed through.`);
    assert.doesNotMatch(label, /_/, `"${label}" still reads as a stored value.`);
  }

  // ── and the sheets actually use them ───────────────────────────────────────────────────────────
  // The labels existing is not the fix; the exports calling them is. This is what catches a helper
  // added and then never wired in — which is the shape a "fixed" enum defect usually takes.
  for (const rel of EXPORT_BUILDERS) {
    const source = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.match(source, /deductionsUnitLabel\(candidate\.unit\)/, `${rel} must label the unit column.`);
    assert.match(
      source,
      /deductionsCalculationStatusLabel\(candidate\.calculationStatus\)/,
      `${rel} must label the calculation status column.`,
    );
    assert.doesNotMatch(
      source,
      /^\s{4}candidate\.(unit|calculationStatus),$/m,
      `${rel} must not emit a stored enum value as a cell.`,
    );
  }

  // ── what is deliberately NOT labelled ──────────────────────────────────────────────────────────
  // `sourceSystem` carries provenance identifiers — `crm_visits_mirror`, `holiday_bridge` — and an
  // audit reader wants the exact recorded string. This asserts the omission is a decision rather
  // than something missed, so a later sweep for snake_case does not "finish the job" and quietly
  // break the trace back to whatever produced the row.
  for (const rel of EXPORT_BUILDERS) {
    const source = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.match(
      source,
      /candidate\.sourceSystem,/,
      `${rel} must print sourceSystem verbatim — it is an identifier, not a label.`,
    );
  }
}
