import type { StepDefinition, StepRow } from "./types.ts";

/**
 * Double-deduction detection for the wizard grid (owner decision 2026-07-25: warn,
 * don't block).
 *
 * Some deductions can legitimately be entered in two different places that BOTH end
 * up in the same total. The live case: a leaver's CRM / unpaid vacation is
 * auto-computed on the Resignations step into the `crm` / `unpaidVacations` draft
 * columns, while the Part 1 manual tabs write `p1od*` columns — and assemble.ts sums
 * both. So a value in both places deducts the same thing twice.
 *
 * A step declares the pairing via `StepDefinition.conflictContextKey`, naming the
 * read-only context column that carries the already-settled amount. A row conflicts
 * when that amount AND at least one of the step's own money fields are non-zero.
 *
 * Pure and dependency-free so the rule is unit-tested rather than only eyeballed in
 * the browser (see tests/automated-payroll-part1-scope.test.ts).
 */

/** The amount already settled elsewhere for this row, or 0 when the step declares no pairing. */
export function settledElsewhereAmount(definition: StepDefinition, row: StepRow): number {
  const key = definition.conflictContextKey;
  if (!key) return 0;
  const raw = Number(row.context[key] ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Total the user has entered on THIS step for the row (money fields only). */
export function enteredOnThisStepAmount(definition: StepDefinition, row: StepRow): number {
  return definition.fields.reduce((sum, field) => {
    if (field.kind !== "money") return sum;
    const value = Number(row.values[field.key] ?? 0);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

/** True when this row would be deducted twice for the same thing. */
export function hasDoubleDeductionConflict(definition: StepDefinition, row: StepRow): boolean {
  if (settledElsewhereAmount(definition, row) <= 0) return false;
  return enteredOnThisStepAmount(definition, row) > 0;
}
