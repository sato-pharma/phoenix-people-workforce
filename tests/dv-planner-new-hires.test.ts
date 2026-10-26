import assert from "node:assert/strict";

import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { buildDvPlannerRosterEntries, repHasStarted } from "../src/lib/double-visit-analytics/service.ts";
import { summarizeRosterCoverage } from "../src/lib/double-visit-analytics/roster-summary.ts";

// The DV Planner counts a rep only from their hire date, and a rep who has never been double-visited
// is overdue only once the days since hire pass the 30/60 band (owner, 2026-10-26). Before this, a
// rep hired for next month sat on the roster dragging coverage down, and a rep who started two days
// ago read "critical" because a null last-visit was treated as the worst case.

const TODAY = "2026-10-26";

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rep(hrId: string, name: string, hireDate: string | null) {
  return {
    areaName: "Giza",
    displayName: name,
    fullName: name,
    hireDate,
    hrId,
    lineName: "CNS",
    managerHrId: "PD-0001",
    managerName: "Sahar El Gallad",
  } as EmployeeDirectoryRow;
}

function roster(reps: EmployeeDirectoryRow[], visits: { hrId: string; date: string }[] = []) {
  return buildDvPlannerRosterEntries({
    activeMedicalReps: reps,
    inWindowRows: visits.map((visit) => ({ activityDate: visit.date, visitedHrId: visit.hrId })),
    cadenceLastVisitByKey: new Map(),
    probation: [],
    dateTo: TODAY,
    today: TODAY,
  });
}

export function runDvPlannerNewHiresTests() {
  // ── The shared "has started" predicate ──────────────────────────────────────
  assert.equal(repHasStarted(addDays(TODAY, 1), TODAY), false, "a hire date after today has not started");
  assert.equal(repHasStarted(TODAY, TODAY), true, "a rep whose hire date is today has started");
  assert.equal(repHasStarted(null, TODAY), true, "no hire date on record counts as started");

  // ── 1. A future hire is not in the roster, nor in any header count ──────────
  const withFuture = roster([rep("PD-0100", "Already Here", "2025-01-01"), rep("PD-0101", "Starts Next Month", addDays(TODAY, 20))]);
  assert.deepEqual(
    withFuture.map((entry) => entry.hrId),
    ["PD-0100"],
    "a rep hired for a date after today must not be on the DV Planner roster",
  );
  const summary = summarizeRosterCoverage(withFuture);
  assert.equal(summary.total, 1, "the future hire must not count in 'in scope'");
  assert.equal(summary.neverVisited, 1, "the future hire must not count in 'never visited'");

  // ── 2. Hired 2 days ago, no visit: not overdue ──────────────────────────────
  const [fresh] = roster([rep("PD-0102", "Two Days In", addDays(TODAY, -2))]);
  assert.equal(fresh.visited, false);
  assert.equal(fresh.cadenceBand, "healthy", "a rep hired 2 days ago with no visit is not late for anything");
  assert.equal(fresh.cadenceOverdue, false, "a rep hired 2 days ago with no visit must not count as overdue");

  // ── 3. Hired 61 days ago, no visit: critical ────────────────────────────────
  const [stale] = roster([rep("PD-0103", "Sixty One Days In", addDays(TODAY, -61))]);
  assert.equal(stale.cadenceBand, "critical", "a rep hired 61 days ago with no visit is critical");
  assert.equal(stale.cadenceOverdue, true);

  // The band in between, and the visited logic left exactly as it was.
  const [middle] = roster([rep("PD-0104", "Forty Days In", addDays(TODAY, -40))]);
  assert.equal(middle.cadenceBand, "warning", "a rep hired 40 days ago with no visit is a warning");
  const [visited] = roster([rep("PD-0105", "Visited Long Ago Hire", "2024-01-01")], [{ date: addDays(TODAY, -5), hrId: "PD-0105" }]);
  assert.equal(visited.cadenceBand, "healthy", "a visited rep is still banded on days since the last visit");
}
