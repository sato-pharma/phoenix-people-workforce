import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A failed sales load used to render as a confident EGP 0 — indistinguishable from "we sold
// nothing" — and on the SoS dashboard that zero was then cached for 300 seconds.
//
// This file was analytics-failure-not-zero.test.ts. The Sales Analytics module it mostly covered was
// retired on 2026-09-17 (owner), so its dashboard and load-result checks went with the module; the
// two checks below are on code that stayed, and are kept word for word.

export async function runSosDashboardFailureNotZeroTests() {
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
  // loadLatestAnalyticsPeriod moved into its one surviving reader, the SFE Manager's IMS contribution.
  {
    const sfe = readFileSync(join(process.cwd(), "src/lib/sales/sfe-performance.ts"), "utf8");
    assert.ok(
      !/function currentCalendarPeriod/.test(sfe),
      "the current-calendar-month fallback must be gone — it rendered EGP 0 for any unloaded month",
    );
    assert.match(
      sfe,
      /const period = await loadLatestAnalyticsPeriod\(\);/,
      "the unfiltered fallback must resolve the newest period that actually has data",
    );
  }
}
