import assert from "node:assert/strict";

import { stepTemplateColumns } from "../src/lib/automated-payroll/exports/step-template.ts";
import { STEP_DEFINITIONS } from "../src/lib/automated-payroll/step-definitions.ts";
import type { StepKey } from "../src/lib/automated-payroll/types.ts";

/**
 * NO TWO COLUMNS IN A STEP TEMPLATE MAY READ AS THE SAME HEADING.
 *
 * FINDING 33. The Part 1 Unpaid Vacation step carried two columns headed, byte for byte, "Unpaid
 * Vacation Days": a read-only context column showing a leaver's reference day count, and the
 * editable field that auto-calculates the money.
 *
 * That is not an untidy sheet, it is a corrupting one. `pickCell` in step-parser.ts finds a column
 * by its NORMALISED HEADING TEXT and returns the FIRST match, and `sheet_to_json` renames a
 * duplicate header rather than dropping it. So on re-upload the parser read the read-only reference
 * and wrote it into `p1odVacationDays` — which carries `autoCalcMoneyKey`, so the money was then
 * recomputed as Base/30 x days. For a leaver that replaced a balance-aware settlement with a flat
 * day rate, and the figure HR actually typed was discarded. Silently, in both directions.
 *
 * THE COMMENT WAS PART OF THE DEFECT. step-template.ts asserted that context columns "are never
 * parsed back on re-upload", which is true only while their headings are unique — and nothing was
 * checking that. A belief stated as a fact in a comment gets defended rather than looked up.
 *
 * So this pins the INVARIANT rather than the one instance: every editable field's heading is unique
 * among all the columns of its own template, for every step. That is exactly what the parser needs
 * to resolve a column correctly, and it is the property that was quietly false.
 */

const norm = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "");

export async function runAutomatedPayrollTemplateHeadingTests() {
  const stepKeys = Object.keys(STEP_DEFINITIONS) as StepKey[];
  assert.ok(stepKeys.length >= 10, `every step must be surveyed (found ${stepKeys.length})`);

  // ---- HEADLINE: no step's template has two columns reading as one heading ----------------------
  const collisions: string[] = [];
  for (const stepKey of stepKeys) {
    const seen = new Map<string, string>();
    for (const column of stepTemplateColumns(stepKey)) {
      const key = norm(column.label);
      const first = seen.get(key);
      if (first !== undefined) collisions.push(`${stepKey}: "${first}" vs "${column.label}"`);
      else seen.set(key, column.label);
    }
  }
  assert.deepEqual(
    collisions,
    [],
    "two columns reading as one heading make the template corrupting rather than untidy: the " +
      "parser reads the FIRST and writes it into the other's field, which on the Unpaid Vacation " +
      "step replaced a leaver's real settlement with a flat day rate",
  );

  // ---- The property the parser actually depends on ------------------------------------------------
  // An editable field is resolved by heading. If anything else in the template shares that heading,
  // the field cannot be addressed at all.
  for (const stepKey of stepKeys) {
    const columns = stepTemplateColumns(stepKey);
    for (const column of columns.filter((one) => one.editable)) {
      const sameHeading = columns.filter((one) => norm(one.label) === norm(column.label));
      assert.equal(
        sameHeading.length,
        1,
        `${stepKey}: the editable column "${column.label}" must be the only one with that heading, ` +
          "or a re-upload cannot address it",
      );
    }
  }

  // ---- The step that carried the defect, named -----------------------------------------------------
  const unpaidVacation = stepTemplateColumns("p1_unpaid_vacation").map((one) => one.label);
  assert.ok(
    unpaidVacation.includes("Unpaid Vacation Days"),
    "the editable day field keeps its heading — it is the one HR types into",
  );
  assert.ok(
    unpaidVacation.includes("Unpaid Vacation Days (reference)"),
    "and the read-only reference is the one that moved, because renaming the editable column would " +
      "change what HR is asked to fill in",
  );

  // ---- The builder REFUSES a colliding definition --------------------------------------------------
  // A template with two identical headings is already booby-trapped; handing it over to be filled
  // in and re-uploaded is worse than refusing the download.
  const definitions = STEP_DEFINITIONS as Record<string, { contextColumns: Array<{ key: string; label: string }> }>;
  const target = definitions.p1_unpaid_vacation;
  const original = target.contextColumns;
  target.contextColumns = [...original.slice(0, -1), { key: "Unpaid Vacation Days", label: "Unpaid Vacation Days" }];
  try {
    assert.throws(
      () => stepTemplateColumns("p1_unpaid_vacation"),
      /two columns reading as the same heading/,
      "reintroducing the collision must refuse the template rather than emit it",
    );
  } finally {
    target.contextColumns = original;
  }

  // And the restore worked, so the survey above still means something.
  assert.deepEqual(
    stepTemplateColumns("p1_unpaid_vacation").map((one) => one.label),
    unpaidVacation,
    "the definition must be left exactly as it was found",
  );
}
