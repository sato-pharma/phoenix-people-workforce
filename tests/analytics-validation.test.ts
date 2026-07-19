import assert from "node:assert/strict";

import { computePeriodDelta, shiftPeriod, shiftWeek } from "../src/lib/analytics/compare.ts";
import { checkReconciliationTotalsMatch, formatPctOrDash, safeDividePct } from "../src/lib/analytics/validation.ts";

export function runAnalyticsValidationTests() {
  // safeDividePct: null-safe on zero/null/undefined denominator, matches SQL achievement_pct convention.
  assert.equal(safeDividePct(50, 100), 50);
  assert.equal(safeDividePct(33, 0), null);
  assert.equal(safeDividePct(10, null), null);
  assert.equal(safeDividePct(10, undefined), null);
  assert.equal(safeDividePct(1, 3), 33.33);
  // A malformed upstream RPC field (Number(v ?? 0) on a non-numeric value) must never surface as
  // the literal string "NaN%" — it degrades to the same "—" as a missing denominator.
  assert.equal(safeDividePct(NaN, 100), null, "NaN numerator must not silently propagate to NaN%");
  assert.equal(safeDividePct(Infinity, 100), null, "non-finite numerator must not silently propagate");

  // formatPctOrDash renders null as an em dash, not a misleading "0.0%".
  assert.equal(formatPctOrDash(null), "—");
  assert.equal(formatPctOrDash(undefined), "—");
  assert.equal(formatPctOrDash(50), "50.0%");
  assert.equal(formatPctOrDash(33.333, { decimals: 2 }), "33.33%");
  assert.equal(formatPctOrDash(NaN), "—", "NaN must render as an em dash, not the literal string \"NaN%\"");
  assert.equal(formatPctOrDash(Infinity), "—", "non-finite values must render as an em dash");

  // computePeriodDelta: null-safe on missing/zero prior value.
  assert.deepEqual(computePeriodDelta(150, 100), { current: 150, prior: 100, pct: 50 });
  assert.deepEqual(computePeriodDelta(150, null), { current: 150, prior: null, pct: null });
  assert.deepEqual(computePeriodDelta(150, 0), { current: 150, prior: 0, pct: null });
  assert.equal(computePeriodDelta(50, 100).pct, -50);

  // shiftPeriod: month rollback within a year, and year rollover at the boundary.
  assert.equal(shiftPeriod("2026-06", 1), "2026-05");
  assert.equal(shiftPeriod("2026-01", 1), "2025-12");
  assert.equal(shiftPeriod("2026-06", 12), "2025-06");
  assert.equal(shiftPeriod("2026-03", 0), "2026-03");
  assert.equal(shiftPeriod("not-a-period", 1), "not-a-period");

  // shiftWeek: 1-week and multi-week rollback, including month/year boundaries.
  assert.equal(shiftWeek("2026-06-08", 1), "2026-06-01");
  assert.equal(shiftWeek("2026-01-05", 1), "2025-12-29");
  assert.equal(shiftWeek("2026-06-08", 0), "2026-06-08");

  // checkReconciliationTotalsMatch: diagnostic, not an equality assertion — flags
  // coverage gaps (one pipeline missing) and within-tolerance matches both correctly.
  const results = checkReconciliationTotalsMatch(
    [
      { period: "2026-06", line: "Line A", sosValue: 1000, closingValue: 1000 },
      { period: "2026-06", line: "Line B", sosValue: 1000, closingValue: 950 },
      { period: "2026-06", line: "Line C", sosValue: 1000, closingValue: null },
      { period: "2026-06", line: "Line D", sosValue: null, closingValue: 500 },
    ],
    5,
  );
  assert.equal(results[0].matches, true);
  assert.equal(results[0].diff, 0);
  assert.equal(results[1].matches, false);
  assert.equal(results[1].diff, -50);
  assert.equal(results[2].matches, false, "missing closing value is a coverage gap, not a match");
  assert.equal(results[2].diff, -1000);
  assert.equal(results[3].matches, false, "missing SoS value is a coverage gap, not a match");
  assert.equal(results[3].diff, 500);
}
