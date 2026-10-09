import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ATTRIBUTION_FRESHNESS_PERIODS_PER_RUN } from "../src/lib/sales/attribution-freshness.ts";

const ROOT = process.cwd();
const MIGRATION = join(ROOT, "supabase/migrations/20260912013000_attribution_freshness_sweep.sql");
const MODULE = join(ROOT, "src/lib/sales/attribution-freshness.ts");
const ROUTE = join(ROOT, "app/api/cron/mapping-guard-notify/route.ts");

/**
 * `au.f_monthly_achievement` serves its precomputed rollup only while the configuration fingerprint
 * stored beside a period still matches, and falls back to the live computation otherwise. That
 * fallback is the safe half of the design — it cannot serve a stale number — which is precisely why
 * the drift was invisible: measured on production 2026-09-11, all nine periods of 2026 had drifted
 * and every achievement screen was recomputing on every read, with no error and nothing in the logs.
 *
 * These assertions pin the three properties that make the sweep worth having, each of which a
 * plausible refactor would quietly remove.
 */

/** 1. The sweep must decide staleness by the fingerprint, and must read it exactly once. */
function stalenessIsDecidedByTheFingerprintReadOnce() {
  const sql = readFileSync(MIGRATION, "utf8");

  assert.ok(
    /v_fp\s+text\s*:=\s*au\.f_attribution_config_fingerprint\(\)/.test(sql),
    "the sweep must read the configuration fingerprint ONCE into a variable — calling it per "
      + "candidate compares each period against a surface another session may have moved mid-loop, "
      + "which refreshes a period and leaves it still looking stale",
  );
  assert.ok(
    /m\.config_fp is null or m\.config_fp <> v_fp/.test(sql),
    "a period with no meta row has never been refreshed and must count as stale — treating absent "
      + "as fresh is how a brand-new period never enters the rollup at all",
  );
  // The fingerprint call must not appear inside the candidate query itself.
  const loopStart = sql.indexOf("for r in");
  const loopEnd = sql.indexOf("end loop;");
  assert.ok(loopStart > -1 && loopEnd > loopStart, "the sweep must still loop over candidate periods");
  assert.ok(
    !sql.slice(loopStart, loopEnd).includes("f_attribution_config_fingerprint()"),
    "the fingerprint must not be re-evaluated inside the candidate query — read it once, above",
  );
  assert.ok(
    /order by p\.period desc/.test(sql) && /limit v_limit/.test(sql),
    "the sweep must take the newest periods first and cap the run — an uncapped sweep after a large "
      + "config change becomes one long transaction in front of cron-job.org's 30-second cut",
  );
}

/**
 * 2. It must not be able to restate a published month. The sweep writes the attribution rollup and
 *    nothing else: never `source_of_sales_import_rows`, never `source_of_sales_fact_rollup`. Those
 *    two carry `monthly_closing_locks`, and a published-and-announced month is never corrected.
 */
function theSweepCannotReachAPublishedMonthsSalesRows() {
  const sql = readFileSync(MIGRATION, "utf8");
  const writes = /\b(insert\s+into|update|delete\s+from)\s+(public\.)?source_of_sales_(import_rows|fact_rollup)\b/i;
  assert.ok(
    !writes.test(sql),
    "the freshness sweep must never write to the sales rows or the fact rollup — those are what "
      + "monthly_closing_locks protects, and a published month is never corrected",
  );
  assert.ok(
    /source_of_sales_import_batches b on b\.id = f\.batch_id and b\.status = 'validated'/.test(sql),
    "candidate periods must come from the same validated-batch source as "
      + "au.f_rebuild_monthly_attribution_all, so the two can never disagree about which periods exist",
  );
}

/** 3. The public wrapper is reachable over RPC, so its EXECUTE must not be left with PUBLIC. */
function theRpcWrapperIsNotExecutableByABrowserRole() {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.ok(
    /revoke execute on function public\.phx_refresh_stale_attribution_periods\(integer\) from public, anon, authenticated;/.test(sql),
    "a new public SECURITY DEFINER function inherits EXECUTE for PUBLIC — revoke it, or anon and "
      + "authenticated can drive a server-side refresh",
  );
  assert.ok(
    /grant execute on function public\.phx_refresh_stale_attribution_periods\(integer\) to service_role;/.test(sql),
    "the wrapper must be granted to service_role, which is the only caller",
  );
}

/**
 * 4. The route is the sweep's clock, and its liveness ping sits on the sweep itself. The Mapping Guard
 *    alert that used to share this route is retired, so nothing may queue behind or ahead of the sweep.
 */
function theRouteWrapsOnlyTheSweepAndNamesWhatItRefreshed() {
  const route = readFileSync(ROUTE, "utf8");

  const switchAt = route.indexOf("withDeadMansSwitch(");
  const sweepAt = route.indexOf("refreshStaleAttributionPeriods()");
  assert.notEqual(switchAt, -1, "the route must still ping the dead man's switch");
  assert.notEqual(sweepAt, -1, "the route must run the attribution freshness sweep");
  assert.ok(sweepAt > switchAt, "the sweep is the work the dead man's switch wraps");
  assert.ok(!route.includes("runMappingGuardNotify"), "the retired Mapping Guard alert must not come back");
  assert.ok(
    /attributionPeriodsRefreshed: freshness.refreshed/.test(route),
    "the response must name the periods refreshed — a sweep nobody can see is indistinguishable "
      + "from one that never ran",
  );
}

/** 5. A failed refresh must never turn the clock's run into a 500. */
function aFailedSweepCannotFailTheAlert() {
  const sweepSource = readFileSync(MODULE, "utf8");
  assert.ok(
    /catch \(error\) \{/.test(sweepSource) && /failed: true/.test(sweepSource),
    "refreshStaleAttributionPeriods must catch its own failure and report it — its caller's job is "
      + "telling the owner his map is refusing writes, which must not depend on a rollup refresh",
  );
  assert.ok(
    !/throw error/.test(sweepSource),
    "the sweep must not re-throw: the route has no way to tell a failed refresh from a failed alert",
  );
  assert.ok(
    ATTRIBUTION_FRESHNESS_PERIODS_PER_RUN > 0 && ATTRIBUTION_FRESHNESS_PERIODS_PER_RUN <= 12,
    "the per-run cap must stay small enough for a ten-minute clock in front of a 30-second cut",
  );
}

export function runAttributionFreshnessSweepTests() {
  stalenessIsDecidedByTheFingerprintReadOnce();
  theSweepCannotReachAPublishedMonthsSalesRows();
  theRpcWrapperIsNotExecutableByABrowserRole();
  theRouteWrapsOnlyTheSweepAndNamesWhatItRefreshed();
  aFailedSweepCannotFailTheAlert();
}
