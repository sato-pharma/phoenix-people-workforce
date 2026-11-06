import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { resolveInProcessHostRefusal } from "../src/lib/platform/in-process-host.ts";
import { EARLY_BIRDS_DUE_CHECK_MIN_GAP_MS } from "../src/lib/early-birds/schedule.ts";

const ENV_KEYS = [
  "PHOENIX_PROCESS_ROLE",
  "PHOENIX_LIVE_CRM_POLL",
  "NODE_ENV",
  "RAILWAY_ENVIRONMENT_NAME",
] as const;

/**
 * THE EARLY BIRDS CLOSE MUST NOT DIE WITH THE CRM VENDOR.
 *
 * The fortnight close once ran inside the iReports360 live poller's tick, so a missing or rotated
 * vendor credential silently stopped every fortnight from closing — yet the close never calls the
 * vendor, it reads the stored CRM record. It moved to its own timer with the HOST guards only, and
 * when the vendor was retired (6 November 2026) the poller was removed and those guards moved to
 * src/lib/platform/in-process-host.ts.
 */
export function runEarlyBirdsCloseSchedulerTests() {
  const hostSource = readFileSync(new URL("../src/lib/platform/in-process-host.ts", import.meta.url), "utf8");
  const schedulerSource = readFileSync(new URL("../src/lib/early-birds/close-scheduler.ts", import.meta.url), "utf8");
  const instrumentationSource = readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8");

  // ── (A) The poller is gone, and the host guards it left behind need no vendor ──────────────
  assert.equal(
    existsSync(new URL("../src/lib/crm/live-poller.ts", import.meta.url)),
    false,
    "the iReports360 live poller was removed with the vendor (6 November 2026)",
  );
  assert.doesNotMatch(hostSource, /isIReports360Configured|IREPORTS360_/, "the host guards must not require iReports360 credentials");

  // ── (B) instrumentation starts the scheduler, in its own try ──────────────────────────────
  const schedulerStartAt = instrumentationSource.indexOf("startEarlyBirdsCloseScheduler()");
  assert.ok(schedulerStartAt >= 0, "instrumentation.ts must start the Early Birds close scheduler");
  assert.match(
    instrumentationSource,
    /await import\("@\/lib\/early-birds\/close-scheduler"\)/,
    "the scheduler must be imported dynamically to keep the hook edge-safe",
  );
  assert.doesNotMatch(instrumentationSource, /live-poller|startLiveCrmPoller/, "instrumentation.ts must not start the retired iReports360 poller");
  const closeCatchAt = instrumentationSource.indexOf('console.error("[early-birds:close] failed to start:"');
  const housekeepingStartAt = instrumentationSource.indexOf("startCrmHousekeepingScheduler()");
  assert.ok(
    closeCatchAt > schedulerStartAt && housekeepingStartAt > closeCatchAt,
    "the close must start in its own try, before the housekeeping timer's — one scheduler that fails to start must not take the other with it",
  );

  // ── (C) The scheduler keeps the host guards and drops the credential check ─────────────────
  assert.match(schedulerSource, /resolveInProcessHostRefusal\(\)/, "the scheduler must apply the in-process host guards");
  assert.doesNotMatch(
    schedulerSource,
    /isIReports360Configured|IREPORTS360_/,
    "the scheduler's guard must not require iReports360 credentials",
  );
  assert.match(
    schedulerSource,
    /await trackJob\("early-birds:close", runDueEarlyBirdsClose\)/,
    "the scheduler must run the self-throttled close, registered as a running job so a server stall names it",
  );
  assert.match(schedulerSource, /if \(started\) return/, "the scheduler must refuse a second start");
  assert.match(schedulerSource, /unrefTimer\(timer\)/, "the scheduler's timer must never hold the process open");
  const tickMs = Number(schedulerSource.match(/EARLY_BIRDS_CLOSE_SCHEDULER_TICK_MS = ([\d_]+);/)?.[1]?.replace(/_/g, ""));
  assert.ok(
    Number.isFinite(tickMs) && tickMs > 0 && tickMs < EARLY_BIRDS_DUE_CHECK_MIN_GAP_MS,
    "the timer must ask more often than the close's own 15-minute gate, or closes arrive later than they did on the old poller",
  );

  // Behaviour, not just source: on a production Railway worker the host guards pass (so the close
  // runs), and every other host is refused. Nothing is started here — the scheduler is never called.
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  const env = process.env as Record<string, string | undefined>;
  try {
    delete env.PHOENIX_PROCESS_ROLE;
    env.PHOENIX_LIVE_CRM_POLL = "true";
    env.NODE_ENV = "production";
    env.RAILWAY_ENVIRONMENT_NAME = "production";

    assert.equal(resolveInProcessHostRefusal(), null, "a production Railway worker must pass the host guards the close runs under");

    env.RAILWAY_ENVIRONMENT_NAME = "staging";
    assert.ok(resolveInProcessHostRefusal(), "a non-production Railway environment is still refused");
    env.RAILWAY_ENVIRONMENT_NAME = "production";
    env.NODE_ENV = "development";
    assert.ok(resolveInProcessHostRefusal(), "a non-production build is still refused");
    env.NODE_ENV = "production";
    delete env.PHOENIX_LIVE_CRM_POLL;
    assert.ok(resolveInProcessHostRefusal(), "the opt-in flag is still required");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}
