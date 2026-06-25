// Null-safe percentage helpers + reconciliation diagnostics for analytics
// dashboards. Pure functions only, unit-tested in tests/analytics-validation.test.ts.

/**
 * Percentage of numerator/denominator, null-safe on a zero or missing
 * denominator. Matches the convention already used by the SQL views'
 * `achievement_pct` columns (`case when target_value > 0 then ... else null end`)
 * so the TypeScript layer's own aggregations (e.g. share-of-total) stay
 * consistent with what the database already returns.
 */
export function safeDividePct(numerator: number, denominator: number | null | undefined): number | null {
  if (denominator == null || denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

/** Renders a null percentage as an em dash instead of a misleading "0.0%". */
export function formatPctOrDash(value: number | null | undefined, opts?: { decimals?: number }): string {
  if (value == null) return "—";
  return `${value.toFixed(opts?.decimals ?? 1)}%`;
}

export type ReconciliationRow = {
  period: string;
  line: string;
  sosValue: number | null;
  closingValue: number | null;
};

export type ReconciliationCheckResult = {
  period: string;
  line: string;
  matches: boolean;
  diff: number;
};

/**
 * Diagnostic only — NOT an assertion that SoS and Closing must always equal
 * each other. The two pipelines measure different grains (distributor invoice
 * vs employee-attributed closing sheet) and a gap is expected and documented
 * in docs/analytics/sales-analytics-model.md. This flags rows where one
 * pipeline has a value and the other doesn't (coverage gaps), or where both
 * exist but differ by more than `toleranceAbs`, so it's useful for spotting
 * pipeline coverage issues — not for enforcing equality.
 */
export function checkReconciliationTotalsMatch(
  rows: ReconciliationRow[],
  toleranceAbs = 1,
): ReconciliationCheckResult[] {
  return rows.map((row) => {
    const sos = row.sosValue ?? 0;
    const closing = row.closingValue ?? 0;
    const diff = closing - sos;
    return {
      period: row.period,
      line: row.line,
      matches: Math.abs(diff) <= toleranceAbs,
      diff,
    };
  });
}
