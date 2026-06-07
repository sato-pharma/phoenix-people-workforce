import assert from "node:assert/strict";

import { roundCurrency } from "../src/lib/payroll/money.ts";

export function runPayrollMoneyTests() {
  // Absorbs IEEE-754 drift from summing floats (the whole point of CB-4).
  assert.equal(roundCurrency(0.1 + 0.2), 0.3);
  assert.equal(roundCurrency(0.1 + 0.2 + 0.3), 0.6);

  // A correct 2-decimal total is unchanged — rounding is a no-op on clean cents.
  assert.equal(roundCurrency(1234.56), 1234.56);
  assert.equal(roundCurrency(0), 0);

  // Negatives (deductions) snap back to clean cents.
  assert.equal(roundCurrency(-19.99 - 0.01), -20);
  assert.equal(roundCurrency(-0.1 - 0.2), -0.3);

  // Large accumulation: 1000 * 0.01 drifts off 10 as a raw float; rounding fixes it.
  let sum = 0;
  for (let i = 0; i < 1000; i += 1) sum += 0.01;
  assert.equal(roundCurrency(sum), 10);

  // Non-finite inputs are coerced to 0 per the helper's contract.
  assert.equal(roundCurrency(Number.NaN), 0);
  assert.equal(roundCurrency(Number.POSITIVE_INFINITY), 0);
}
