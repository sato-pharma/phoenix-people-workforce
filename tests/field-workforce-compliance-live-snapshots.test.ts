import { strict as assert } from "node:assert";

import { monthsInDateRange } from "../src/lib/field-workforce-compliance/live-snapshots.ts";

export function runFieldWorkforceComplianceLiveSnapshotsTests() {
  // Range fully inside one month -> a single month.
  assert.deepEqual(monthsInDateRange("2026-06-05", "2026-06-20"), [{ month: 6, year: 2026 }]);

  // The cron's typical 10-day lookback, entirely within one month.
  assert.deepEqual(monthsInDateRange("2026-06-21", "2026-06-30"), [{ month: 6, year: 2026 }]);

  // A lookback window crossing a month boundary -> both months, in order.
  assert.deepEqual(monthsInDateRange("2026-06-25", "2026-07-03"), [
    { month: 6, year: 2026 },
    { month: 7, year: 2026 },
  ]);

  // A lookback window crossing a year boundary.
  assert.deepEqual(monthsInDateRange("2025-12-28", "2026-01-05"), [
    { month: 12, year: 2025 },
    { month: 1, year: 2026 },
  ]);

  // A single day.
  assert.deepEqual(monthsInDateRange("2026-03-15", "2026-03-15"), [{ month: 3, year: 2026 }]);

  // A large manual backfill range spanning several months.
  assert.deepEqual(monthsInDateRange("2026-01-01", "2026-03-31"), [
    { month: 1, year: 2026 },
    { month: 2, year: 2026 },
    { month: 3, year: 2026 },
  ]);

  // No duplicate entries for the same month even across a wide multi-year range boundary.
  const wideRange = monthsInDateRange("2026-01-15", "2026-02-15");
  const monthKeys = wideRange.map((entry) => `${entry.year}-${entry.month}`);
  assert.equal(new Set(monthKeys).size, monthKeys.length);
}
