import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { anyFailed, emptyAnalyticsDimensions, loadOrFail, trackFailure } from "../src/lib/analytics/load-result.ts";

// A failed analytics load used to render as a confident EGP 0 — indistinguishable from "we sold
// nothing" — and on the SoS dashboard that zero was then cached for 300 seconds. Three of the call
// sites were prior-period loads, so a failure produced a fake growth percentage. Separately, a
// failed dimensions load substituted DEMO FIXTURES ("Demo Distributor A") into the filter dropdowns
// of a live dashboard.
//
// This pins both the behaviour and the wiring, because the wiring is what regressed.

const DASHBOARD_DIR = join(process.cwd(), "src/components/analytics/dashboards");

function dashboardFiles(): string[] {
  return readdirSync(DASHBOARD_DIR).filter((f) => f.endsWith(".tsx"));
}

export async function runAnalyticsFailureNotZeroTests() {
  // ── trackFailure records rather than hides ──────────────────────────────────
  {
    const failures: string[] = [];
    const handler = trackFailure(failures, "Sales by area", [] as number[]);
    const fallback = handler(new Error("statement timeout"));
    assert.deepEqual(fallback, [], "returns the fallback so the page still renders");
    assert.deepEqual(failures, ["Sales by area"], "and records WHAT failed so the page can say so");
  }

  // A successful load must leave the sink untouched — an empty result is not a failure.
  {
    const failures: string[] = [];
    trackFailure(failures, "Sales by line", []);
    assert.deepEqual(failures, [], "merely building the handler must not record a failure");
  }

  // ── loadOrFail separates 'no rows' from 'could not load' ────────────────────
  {
    const ok = await loadOrFail("ok", async () => [1, 2, 3], []);
    assert.deepEqual(ok, { data: [1, 2, 3], failed: false });
  }
  {
    const empty = await loadOrFail("empty", async () => [] as number[], []);
    assert.deepEqual(empty, { data: [], failed: false }, "an empty result is NOT a failure");
  }
  {
    const failed = await loadOrFail<number[]>(
      "boom",
      async () => {
        throw new Error("rpc exploded");
      },
      [],
    );
    assert.deepEqual(failed, { data: [], failed: true }, "a throw is a failure carrying the fallback");
  }

  assert.equal(anyFailed({ failed: false }, { failed: true }), true);
  assert.equal(anyFailed({ failed: false }, { failed: false }), false);
  assert.equal(anyFailed(), false, "no loads ⇒ nothing failed");

  // ── Empty dimensions must be genuinely empty, never demo fixtures ───────────
  {
    const dims = emptyAnalyticsDimensions();
    for (const [key, value] of Object.entries(dims)) {
      assert.ok(Array.isArray(value), `dimensions.${key} must be an array`);
      assert.equal((value as unknown[]).length, 0, `dimensions.${key} must be empty, not fabricated`);
    }
    const serialized = JSON.stringify(dims).toLowerCase();
    assert.ok(!serialized.includes("demo"), "the failure fallback must never contain demo data");
  }

  // ── Wiring: no dashboard may silently swallow a failed load ─────────────────
  const offenders: string[] = [];
  const unbanners: string[] = [];
  for (const file of dashboardFiles()) {
    const src = readFileSync(join(DASHBOARD_DIR, file), "utf8");

    // `.catch(() => [])` and `.catch(() => demoAnalyticsDimensions())` are the two shapes that made
    // a failure look like data. Neither may come back.
    if (/\.catch\(\(\)\s*=>\s*\[\]\)/.test(src)) offenders.push(`${file}: .catch(() => [])`);
    if (/\.catch\(\(\)\s*=>\s*demo/.test(src)) offenders.push(`${file}: .catch(() => demo…)`);

    // Any dashboard that tracks failures must also render them.
    if (src.includes("analyticsFailures") && !src.includes("<AnalyticsErrorState")) {
      unbanners.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a failed analytics load must be recorded via trackFailure(), not swallowed into an empty array or demo fixtures",
  );
  assert.deepEqual(unbanners, [], "a dashboard that records failures must render <AnalyticsErrorState>");

  // ── The SoS dashboard must surface, and not cache, a failed aggregate ───────
  {
    const sos = readFileSync(join(process.cwd(), "src/lib/sales/sos-dashboard.ts"), "utf8");
    assert.match(
      sos,
      /failures\.push\(label\)/,
      "safeRpcAll must record the failing RPC rather than returning a bare empty array",
    );
    assert.match(
      sos,
      /incompleteReason/,
      "SosDashboardData must carry the incomplete-load signal to the UI",
    );
    assert.match(
      sos,
      /if \(cached\.failedRpcs\.length === 0\) return cached;/,
      "a cached payload carrying a failure must not be served for the full TTL",
    );
  }

  // ── The period fallback must not be the calendar month ─────────────────────
  {
    const service = readFileSync(join(process.cwd(), "src/lib/analytics/service.ts"), "utf8");
    assert.ok(
      !/function currentCalendarPeriod/.test(service),
      "the current-calendar-month fallback must be gone — it rendered EGP 0 for any unloaded month",
    );
    assert.match(
      service,
      /loadLatestAnalyticsPeriod/,
      "the unfiltered fallback must resolve the newest period that actually has data",
    );
  }
}
