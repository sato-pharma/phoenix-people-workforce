import { strict as assert } from "node:assert";

import {
  buildEmployeeRollup,
  computeEmployeeTrendFromRows,
  listRecentFieldWorkforceComplianceMonths,
  summarizeFieldWorkforceMirrorFreshness,
  type FieldWorkforceEmployeeMonthRollup,
} from "../src/lib/field-workforce-compliance/live-snapshots.ts";

export function runFieldWorkforceComplianceLiveSnapshotsTests() {
  // --- listRecentFieldWorkforceComplianceMonths: pure calendar math, newest first ---
  const months = listRecentFieldWorkforceComplianceMonths({ monthsBack: 3, todayIso: "2026-07-18" });
  assert.deepEqual(months, [
    { month: 7, monthKey: "2026-07", year: 2026 },
    { month: 6, monthKey: "2026-06", year: 2026 },
    { month: 5, monthKey: "2026-05", year: 2026 },
    { month: 4, monthKey: "2026-04", year: 2026 },
  ], "current month first, then monthsBack previous months, in order");

  // Year-boundary wraparound: January rolls back into the prior December.
  const wrap = listRecentFieldWorkforceComplianceMonths({ monthsBack: 2, todayIso: "2026-01-15" });
  assert.deepEqual(wrap, [
    { month: 1, monthKey: "2026-01", year: 2026 },
    { month: 12, monthKey: "2025-12", year: 2025 },
    { month: 11, monthKey: "2025-11", year: 2025 },
  ], "crossing a year boundary decrements the year, not just wraps the month number");

  // Default monthsBack (12) plus the current month = 13 entries, no duplicates.
  const defaultMonths = listRecentFieldWorkforceComplianceMonths({ todayIso: "2026-07-18" });
  assert.equal(defaultMonths.length, 13, "default monthsBack is 12 previous months plus the current one");
  assert.equal(new Set(defaultMonths.map((m) => m.monthKey)).size, 13, "no duplicate month keys");

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

  // --- 2.1 Cross-month trend view: employee rollup + trend extraction ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rollupEmployee = (overrides: Record<string, unknown>): any => ({
    areaName: null, campaignDays: 0, compliancePercent: 80, employeeName: "Rollup Test",
    employmentStatus: "active", eligibleWorkingDays: 20, fridays: 4, hiringDateIso: "2024-01-01",
    hiringDateSource: "employee_directory", holidayWarnings: 0, hrId: "R-1", lineName: null,
    managerHrId: null, managerName: null, matchedEmployeeName: "Rollup Test", matchedHrId: "R-1",
    matchStatus: "matched", noActivityCandidates: 2,
    noActivityPattern: { adjacentToFridayDates: [], adjacentToPublicHolidayDates: [], consecutiveSignalCount: 0, hasThreeDayStreak: false, hasTwoDayStreak: false, highMonthlyCount: false, longestStreak: 0, summary: "" },
    preHireIgnoredValues: 0, roleName: null, severityCounts: { High: 0, Low: 0, Medium: 0, Review: 0 },
    sourceRowNumber: 1, teamName: null, timeline: [], totalVisits: 5, unknownValues: 0,
    vacationSignalDays: 0, workedDays: 12,
    ...overrides,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rollupPreview: any = {
    employees: [
      rollupEmployee({ hrId: "R-1", employeeName: "Rollup One", compliancePercent: 80, noActivityCandidates: 2, severityCounts: { High: 0, Low: 0, Medium: 1, Review: 0 } }),
      rollupEmployee({ hrId: "R-2", employeeName: "Rollup Two", compliancePercent: 40, noActivityCandidates: 8, matchStatus: "unmatched", severityCounts: { High: 1, Low: 0, Medium: 0, Review: 0 } }),
    ],
  };
  const rollup = buildEmployeeRollup(rollupPreview);
  assert.deepEqual(rollup, [
    { compliancePercent: 80, employeeName: "Rollup One", highSeverityCount: 0, hrId: "R-1", matchStatus: "matched", noActivityCandidates: 2 },
    { compliancePercent: 40, employeeName: "Rollup Two", highSeverityCount: 1, hrId: "R-2", matchStatus: "unmatched", noActivityCandidates: 8 },
  ], "buildEmployeeRollup projects exactly the compact fields, pulling highSeverityCount from severityCounts.High");

  const rollupFor = (hrId: string, compliancePercent: number, highSeverityCount: number): FieldWorkforceEmployeeMonthRollup => ({
    compliancePercent, employeeName: "x", highSeverityCount, hrId, matchStatus: "matched", noActivityCandidates: 0,
  });
  // DB returns newest-first; May has no entry for R-1 at all (not yet backfilled) -> skipped, not zero-filled.
  const trendRows = [
    { month_key: "2026-07", employee_rollup: [rollupFor("R-1", 90, 0), rollupFor("R-2", 10, 1)] },
    { month_key: "2026-06", employee_rollup: [rollupFor("r-1", 60, 1), rollupFor("R-2", 20, 1)] }, // lowercase hrId still matches via canonicalHrIdKey
    { month_key: "2026-05", employee_rollup: [rollupFor("R-2", 30, 0)] },
  ];
  const trendR1 = computeEmployeeTrendFromRows(trendRows, "R-1");
  assert.equal(trendR1.monthsConsidered, 2, "R-1 has an entry in 2 of the 3 rows (May's row lacks R-1 entirely)");
  assert.deepEqual(trendR1.points.map((point) => point.monthKey), ["2026-06", "2026-07"], "points are reversed to oldest -> newest");
  assert.equal(trendR1.points[0].compliancePercent, 60, "June point resolves despite the rollup's lowercase hrId");
  assert.equal(trendR1.highSeverityMonthCount, 1, "only June had a High-severity day for R-1");

  const trendR2 = computeEmployeeTrendFromRows(trendRows, "R-2");
  assert.equal(trendR2.monthsConsidered, 3, "R-2 has an entry in all 3 rows");
  assert.equal(trendR2.highSeverityMonthCount, 2, "July and June both had a High-severity day for R-2");

  const trendMissing = computeEmployeeTrendFromRows(trendRows, "R-999");
  assert.deepEqual(trendMissing, { highSeverityMonthCount: 0, monthsConsidered: 0, points: [] }, "an employee absent from every row's rollup gets the empty shape");
}
