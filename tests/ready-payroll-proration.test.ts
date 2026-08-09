import assert from "node:assert/strict";

import {
  calculateBaseLifecycleProrationDeduction,
  calculateBaseProrationDeduction,
  payrollDaysInMonth,
  prorationEndDay,
} from "../src/lib/payroll/ready-proration.ts";

/**
 * Behavioural cover for Ready-Payroll partial-month proration.
 *
 * The rule (owner-confirmed): the daily rate is always
 * `Base Salary ÷ actual calendar days in the month`, and an employee present
 * for the whole calendar month is deducted nothing.
 *
 * The bug this exists to stop: the arithmetic hardcoded a 30-day month, so the
 * "worked the whole month" guard (`endDay >= 30`) could never be true in a 28-
 * or 29-day February. A leaver dated 28 Feb who worked every single day was
 * deducted 666.67 EGP of a 10,000 EGP base. It survived because the only guard
 * was a source-regex assertion that matched the buggy literal and declared the
 * fixed-30 month correct.
 */
export function runReadyPayrollProrationTests() {
  // ── The headline regression: a full February must cost nothing ──────────────
  assert.equal(
    calculateBaseLifecycleProrationDeduction(10_000, null, "2026-02-28", 2, 2026),
    0,
    "A leaver whose last working day is the final day of a 28-day February worked the whole month and must be deducted nothing.",
  );

  assert.equal(
    calculateBaseLifecycleProrationDeduction(10_000, null, "2024-02-29", 2, 2024),
    0,
    "A leap-year February must also settle to zero on the 29th.",
  );

  // Every month length, joiner and leaver at the boundary, must settle to zero.
  for (const [month, year, lastDay] of [
    [1, 2026, "2026-01-31"],
    [2, 2026, "2026-02-28"],
    [2, 2024, "2024-02-29"],
    [4, 2026, "2026-04-30"],
    [6, 2026, "2026-06-30"],
    [12, 2026, "2026-12-31"],
  ] as Array<[number, number, string]>) {
    assert.equal(
      calculateBaseLifecycleProrationDeduction(10_000, null, lastDay, month, year),
      0,
      `Leaving on the last calendar day of ${year}-${month} is a full month and must deduct nothing.`,
    );
    assert.equal(
      calculateBaseProrationDeduction(10_000, `${lastDay.slice(0, 8)}01`, month, year),
      0,
      `Being hired on day 1 of ${year}-${month} is a full month and must deduct nothing.`,
    );
  }

  // ── The daily rate must follow the real month length ────────────────────────
  assert.equal(payrollDaysInMonth(2, 2026), 28, "February 2026 has 28 days.");
  assert.equal(payrollDaysInMonth(2, 2024), 29, "February 2024 is a leap year.");
  assert.equal(payrollDaysInMonth(4, 2026), 30, "April has 30 days.");
  assert.equal(payrollDaysInMonth(12, 2026), 31, "December has 31 days.");

  // Half a 28-day February: worked 1-14, so 14 unworked days at 10000/28 = 357.14/day.
  assert.equal(
    calculateBaseLifecycleProrationDeduction(10_000, null, "2026-02-14", 2, 2026),
    5_000,
    "Leaving mid-February must charge the unworked half at the February day rate (10000/28), not the 30-day rate.",
  );

  // A 31-day month must use /31, not /30 — the old code's other blind spot.
  assert.equal(
    calculateBaseLifecycleProrationDeduction(3_100, null, "2026-12-30", 12, 2026),
    100,
    "One unworked day in a 31-day month costs exactly one 31st of base.",
  );

  // ── prorationEndDay must clamp to the real month, not to 30 ─────────────────
  assert.equal(
    prorationEndDay("2026-02-28", 2, 2026),
    28,
    "The last working day of February is day 28.",
  );
  assert.equal(
    prorationEndDay("2026-12-31", 12, 2026),
    31,
    "December's 31st must not be clamped down to 30 — clamping it silently charged a day.",
  );
  assert.equal(
    prorationEndDay(null, 2, 2026),
    28,
    "With no last working date the employee is present to the real end of the month.",
  );

  // ── Joiners ────────────────────────────────────────────────────────────────
  // Hired 15 Feb 2026: paid 15-28 = 14 days, so 14 unworked days are deducted.
  assert.equal(
    calculateBaseProrationDeduction(10_000, "2026-02-15", 2, 2026),
    5_000,
    "A mid-February joiner must be charged the unworked days at the February day rate.",
  );

  assert.equal(
    calculateBaseProrationDeduction(10_000, "2026-03-10", 2, 2026),
    0,
    "A hire date outside the payroll month must not prorate at all.",
  );

  // ── Combined joiner+leaver inside one month ────────────────────────────────
  // Hired 2026-02-05, left 2026-02-24: 20 days paid, 8 unworked at 10000/28.
  assert.equal(
    calculateBaseLifecycleProrationDeduction(10_000, "2026-02-05", "2026-02-24", 2, 2026),
    2_857.14,
    "A joiner-and-leaver inside one February must be charged both unworked ends at the February day rate.",
  );

  // ── Degenerate inputs must never produce a negative or NaN charge ──────────
  assert.equal(
    calculateBaseLifecycleProrationDeduction(0, null, "2026-02-10", 2, 2026),
    0,
    "A zero base salary must not produce a charge.",
  );
  assert.ok(
    Number.isFinite(calculateBaseLifecycleProrationDeduction(10_000, null, "not-a-date", 2, 2026)),
    "An unparseable last working date must not produce NaN.",
  );
}
