import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  restampPeriodsOneByOne,
  territorySyncCallWasCut,
  unfinishedSummary,
} from "../src/lib/sales/territory/sync.ts";

/**
 * 🔴 4 OCT 2026: ONE CALL FOR EVERY OPEN PERIOD LOST THE WHOLE NIGHT TO ONE SLOW MINUTE. The nightly
 * re-stamp sent every open period in one call; the gateway in front of the database cut it at about two
 * minutes ("upstream request timeout", 03:20:02 → 03:22:06 Cairo), the single transaction rolled back,
 * and nothing landed until the next night, when the same 2,375 rows took 26 s. Each period now runs in
 * its own transaction, a cut period is tried once more when there is time, and the others still commit.
 */
export async function runTerritoryRestampPerPeriodTests(): Promise<void> {
  // A clock the fake calls advance, so time is measured, never slept.
  let now = 0;
  const remainingFrom = (budget: number) => () => budget - now;

  // The 4 Oct night replayed: 2026-10 is slow once (the gateway cut at ~124 s), every other period is quick.
  now = 0;
  const calls: string[] = [];
  let firstCommits = 0;
  let cutOnce = false;
  const night = await restampPeriodsOneByOne({
    onFirstCommit: async () => {
      firstCommits += 1;
    },
    periods: ["2026-08", "2026-09", "2026-10"],
    remainingMs: remainingFrom(240_000),
    restampPeriod: async (period) => {
      calls.push(period);
      if (period === "2026-10" && !cutOnce) {
        cutOnce = true;
        now += 124_000;
        throw new Error("upstream request timeout");
      }
      now += 1_000;
      return { refreshedBatches: period === "2026-10" ? 1 : 0, restampedRows: period === "2026-10" ? 2_375 : 0 };
    },
  });
  assert.deepEqual(
    night.committedPeriods,
    ["2026-10", "2026-09", "2026-08"],
    "🔴 the period the gateway cut is tried once more and lands the same night, and the others still commit",
  );
  assert.equal(night.restampedRows, 2_375, "the slow period's rows are re-stamped that night, not the next");
  assert.deepEqual(calls, ["2026-10", "2026-10", "2026-09", "2026-08"], "newest first, one period per call, one retry");
  assert.equal(firstCommits, 1, "liveness is reported once, at the first commit");
  assert.deepEqual(night.failedPeriods, [], "nothing failed");

  // A refusal is never retried, and never costs the other periods.
  now = 0;
  const refusedCalls: string[] = [];
  const refused = await restampPeriodsOneByOne({
    periods: ["2026-09", "2026-10"],
    remainingMs: remainingFrom(240_000),
    restampPeriod: async (period) => {
      refusedCalls.push(period);
      if (period === "2026-09") throw new Error("monthly closing 2026-09 is locked");
      return { refreshedBatches: 0, restampedRows: 0 };
    },
  });
  assert.deepEqual(refused.committedPeriods, ["2026-10"], "🔴 one refused period no longer stops the open ones");
  assert.deepEqual(refused.failedPeriods, [{ attempts: 1, message: "monthly closing 2026-09 is locked", period: "2026-09" }]);
  assert.deepEqual(refusedCalls, ["2026-10", "2026-09"], "a refusal is asked once");

  // A cut with no time left for a second try is reported, not retried past the run's own limit.
  now = 0;
  const late = await restampPeriodsOneByOne({
    periods: ["2026-10"],
    remainingMs: remainingFrom(150_000),
    restampPeriod: async () => {
      now += 124_000;
      throw new Error("upstream request timeout");
    },
  });
  assert.deepEqual(late.failedPeriods, [{ attempts: 1, message: "upstream request timeout", period: "2026-10" }]);

  // Periods the run had no time to start wait for the next night, oldest first to be left.
  now = 0;
  const spent = await restampPeriodsOneByOne({
    periods: ["2026-08", "2026-09", "2026-10"],
    remainingMs: remainingFrom(60_000),
    restampPeriod: async () => {
      now += 55_000;
      return { refreshedBatches: 0, restampedRows: 0 };
    },
  });
  assert.deepEqual(spent.committedPeriods, ["2026-10"]);
  assert.deepEqual(spent.notReachedPeriods, ["2026-09", "2026-08"], "the oldest open months are the ones that wait");
  assert.match(unfinishedSummary(spent), /2026-09, 2026-08 not started/);
  assert.equal(unfinishedSummary(night), "", "a clean night has nothing unfinished to say");

  for (const cut of ["upstream request timeout", "canceling statement due to statement timeout", "The operation was aborted.", "fetch failed", "504 Gateway Timeout"]) {
    assert.equal(territorySyncCallWasCut(cut), true, `"${cut}" is a cut, safe to try again`);
  }
  for (const refusal of ["monthly closing 2026-09 is locked", "function public.phx_sync_sos_run(text[]) does not exist"]) {
    assert.equal(territorySyncCallWasCut(refusal), false, `"${refusal}" is a refusal, never retried`);
  }

  // The service really does go one period per call, the nightly run really passes its longer budget,
  // and a partial night still fails the run after the audit row says which periods are left.
  const service = readFileSync("src/lib/sales/territory/sync.ts", "utf8");
  assert.ok(service.includes("p_periods: [period],"), "🔴 phx_sync_sos_run is called with ONE period per call");
  assert.ok(!service.includes("p_periods: periods,\n  });\n  if (runError)"), "the all-periods call is gone");
  assert.ok(
    /if \(restamp\.failedPeriods\.length > 0 \|\| restamp\.notReachedPeriods\.length > 0\) \{\s*throw/.test(service),
    "a night with a period left over still reports failure",
  );
  const scheduled = readFileSync("src/lib/sales/territory/scheduled-sync.ts", "utf8");
  assert.ok(scheduled.includes("budgetMs: TERRITORY_SYNC_SCHEDULED_BUDGET_MS,"), "the nightly run gets its own longer budget");
}
