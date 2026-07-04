import { strict as assert } from "node:assert";

import {
  monthsInDateRange,
  summarizeFieldWorkforceMirrorFreshness,
} from "../src/lib/field-workforce-compliance/live-snapshots.ts";

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

  // --- Mirror freshness (Tier 0.3) ---
  const now = "2026-07-04T12:00:00.000Z";

  // Fresh: a successful sync 3h ago, on a closed past month -> not stale, not open.
  const fresh = summarizeFieldWorkforceMirrorFreshness({
    monthKey: "2026-06",
    nowIso: now,
    runs: [{ completedAt: "2026-07-04T09:00:00.000Z", startedAt: "2026-07-04T08:55:00.000Z", status: "success" }],
  });
  assert.equal(fresh.isStale, false, "3h-old successful sync is not stale");
  assert.equal(fresh.isOpenMonth, false, "June (past) is not the open month on Jul 4");
  assert.equal(fresh.ageHours, 3, "age is measured from the successful sync's completedAt");
  assert.equal(fresh.latestStatus, "success");

  // Stale: last success 40h ago -> stale.
  const stale = summarizeFieldWorkforceMirrorFreshness({
    monthKey: "2026-06",
    nowIso: now,
    runs: [{ completedAt: "2026-07-02T20:00:00.000Z", startedAt: "2026-07-02T19:55:00.000Z", status: "success" }],
  });
  assert.equal(stale.isStale, true, "40h since last successful sync is stale");

  // Most-recent run failed but a success exists within threshold -> not stale, latestStatus surfaces the failure.
  const recentFailure = summarizeFieldWorkforceMirrorFreshness({
    monthKey: "2026-07",
    nowIso: now,
    runs: [
      { completedAt: null, startedAt: "2026-07-04T11:30:00.000Z", status: "failed" },
      { completedAt: "2026-07-04T08:00:00.000Z", startedAt: "2026-07-04T07:55:00.000Z", status: "success" },
    ],
  });
  assert.equal(recentFailure.isStale, false, "a recent successful sync keeps it fresh despite a later failure");
  assert.equal(recentFailure.latestStatus, "failed", "latestStatus reflects the most recent run");
  assert.equal(recentFailure.isOpenMonth, true, "July is the open month on Jul 4");

  // No runs at all -> stale with null age (never synced).
  const never = summarizeFieldWorkforceMirrorFreshness({ monthKey: "2026-07", nowIso: now, runs: [] });
  assert.equal(never.isStale, true, "no successful sync ever -> stale");
  assert.equal(never.ageHours, null);
  assert.equal(never.lastSyncedAt, null);
}
