/**
 * Money rounding for payroll/expense aggregates.
 *
 * Per-record values are already rounded by the salary/expense calculators, but
 * summing many IEEE-754 floats reintroduces sub-cent drift (e.g. 0.1 + 0.2 =
 * 0.30000000000000004). Aggregate totals that are displayed, stored, or
 * reconciled against a source must be re-rounded to cents at the boundary.
 *
 * (The same `Math.round((v + EPSILON) * 100) / 100` exists inline in policy.ts /
 * salary-import.ts / salary-source.ts for per-value rounding; consolidating those
 * onto this helper is a separate, lower-priority cleanup.)
 */
export function roundCurrency(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
