import assert from "node:assert/strict";

import { sumSalesMetricMoney, sumSalesMetricRows } from "../src/lib/sales/metrics.ts";

export function runSalesMoneyRoundingTests() {
  // salesValue rows whose float sum drifts off the true cent total.
  const rows = [
    { salesValue: 0.1 },
    { salesValue: 0.2 },
    { salesValue: 0.1 },
    { salesValue: 0.2 },
    { salesValue: 0.1 },
    { salesValue: 0.2 },
  ];

  // Raw sum is ~0.9 but NOT exactly 0.9 (the drift CB-4-style fix exists to absorb).
  const raw = sumSalesMetricRows(rows, "salesValue");
  assert.ok(Math.abs(raw - 0.9) < 1e-9, "raw sum is approximately 0.9");
  assert.notEqual(raw, 0.9);

  // Money variant snaps the aggregate to cents.
  assert.equal(sumSalesMetricMoney(rows, "salesValue"), 0.9);

  // Correct totals are unchanged; empty/missing-key sums to 0.
  assert.equal(sumSalesMetricMoney([{ salesValue: 100 }, { salesValue: 50 }], "salesValue"), 150);
  assert.equal(sumSalesMetricMoney([], "salesValue"), 0);

  // 1000 * 0.01 drifts off 10 as a raw float; the money variant snaps it.
  const cents = Array.from({ length: 1000 }, () => ({ salesValue: 0.01 }));
  assert.equal(sumSalesMetricMoney(cents, "salesValue"), 10);
}
