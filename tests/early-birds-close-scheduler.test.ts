import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isIReports360Configured } from "../src/lib/crm/config.ts";
import { resolveInProcessHostRefusal, startLiveCrmPoller } from "../src/lib/crm/live-poller.ts";
import { EARLY_BIRDS_DUE_CHECK_MIN_GAP_MS } from "../src/lib/early-birds/schedule.ts";

const ENV_KEYS = [
  "PHOENIX_PROCESS_ROLE",
  "PHOENIX_LIVE_CRM_POLL",
  "NODE_ENV",
  "RAILWAY_ENVIRONMENT_NAME",
  "IREPORTS360_BASE_URL",
  "IREPORTS360_USERNAME",
  "IREPORTS360_PASSWORD",
] as const;

/**
 * THE EARLY BIRDS CLOSE MUST NOT DIE WITH THE CRM VENDOR CREDENTIALS.
 *
 * The fortnight close ran inside the CRM live poller's tick. The poller only starts when iReports360
 * credentials are present, yet the close never calls the vendor — it reads the mirror. So a missing
 * or rotated vendor credential silently stopped every fortnight from closing. It now runs on its own
 * timer with the poller's HOST guards and without the credential check.
 */
export function runEarlyBirdsCloseSchedulerTests() {
  const pollerSource = readFileSync(new URL("../src/lib/crm/live-poller.ts", import.meta.url), "utf8");
  const schedulerSource = readFileSync(new URL("../src/lib/early-birds/close-scheduler.ts", import.meta.url), "utf8");
  const instrumentationSource = readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8");

  // ── (A) The poller no longer runs the close ──────────────────────────────────────────────
  assert.doesNotMatch(
    pollerSource,
    /runDueEarlyBirdsClose/,
    "the CRM poller must not call runDueEarlyBirdsClose — it only runs with iReports360 credentials",
  );

  // ── (B) instrumentation starts the scheduler, apart from the poller ────────────────────────
  const schedulerStartAt = instrumentationSource.indexOf("startEarlyBirdsCloseScheduler()");
  assert.ok(schedulerStartAt >= 0, "instrumentation.ts must start the Early Birds close scheduler");
  assert.match(
    instrumentationSource,
    /await import\("@\/lib\/early-birds\/close-scheduler"\)/,
    "the scheduler must be imported dynamically, like the poller, to keep the hook edge-safe",
  );
  const pollerCatchAt = instrumentationSource.indexOf('console.error("[crm:live-poll] failed to start:"');
  assert.ok(
    pollerCatchAt >= 0 && schedulerStartAt > pollerCatchAt,
    "the scheduler must start in its own try, after the poller's — a poller that fails to start must not take the close with it",
  );

  // ── (C) The scheduler keeps the host guards and drops the credential check ─────────────────
  assert.match(schedulerSource, /resolveInProcessHostRefusal\(\)/, "the scheduler must apply the poller's host guards");
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
    "the timer must ask more often than the close's own 15-minute gate, or closes arrive later than they did on the poller",
  );

  // Behaviour, not just source: on a production Railway host with NO vendor credentials, the host
  // guards pass (so the close runs) while the poller still refuses. Nothing is started here — the
  // poller refuses before any timer, and the scheduler itself is never called.
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  const env = process.env as Record<string, string | undefined>;
  try {
    delete env.PHOENIX_PROCESS_ROLE;
    env.PHOENIX_LIVE_CRM_POLL = "true";
    env.NODE_ENV = "production";
    env.RAILWAY_ENVIRONMENT_NAME = "production";
    delete env.IREPORTS360_BASE_URL;
    delete env.IREPORTS360_USERNAME;
    delete env.IREPORTS360_PASSWORD;
    assert.equal(isIReports360Configured(), false, "precondition: no vendor credentials in this process");

    assert.equal(
      resolveInProcessHostRefusal(),
      null,
      "a production Railway host without iReports360 credentials must pass the host guards the close runs under",
    );
    const pollerRefusal = startLiveCrmPoller();
    assert.equal(pollerRefusal.started, false, "the poller still refuses without credentials");
    assert.match(pollerRefusal.reason ?? "", /iReports360/, "and it refuses on the credential check, not a host guard");

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
