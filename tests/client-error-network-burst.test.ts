import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createNetworkBurstCollector,
  isBareBrowserNetworkFailure,
  NETWORK_BURST_MAX_MS,
  NETWORK_BURST_QUIET_MS,
  networkBurstContext,
  stackHasFrame,
} from "../src/lib/error-monitor/network-failure-burst.ts";

/**
 * A rep's phone losing its connection wrote up to 69 bare `Load failed` rows inside one second — 459 on the CRM
 * Visits page and 289 on List in 30 days, each with no stack at all. These pin both halves: a burst of the browser's
 * own network wording is ONE row carrying its count, and anything that can be read — a stack frame, any other
 * message — still reports on its own.
 */

/** A clock the test moves by hand. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
    timers: {
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
      now: () => now,
      setTimeout: (callback: () => void, ms: number) => {
        const id = nextId++;
        pending.set(id, { at: now + ms, callback });
        return id;
      },
    },
  };
}

function bareTypeError(message: string, stack: string | undefined): TypeError {
  const error = new TypeError(message);
  Object.defineProperty(error, "stack", { configurable: true, value: stack });
  return error;
}

export function runClientErrorNetworkBurstTests() {
  // ── What joins a burst: the engine's exact wording AND no frame ────────────
  assert.equal(isBareBrowserNetworkFailure(bareTypeError("Load failed", "")), true, "WebKit's rejection carries an empty stack");
  assert.equal(isBareBrowserNetworkFailure(bareTypeError("Load failed", undefined)), true);
  assert.equal(isBareBrowserNetworkFailure(bareTypeError("network error", "TypeError: network error")), true, "Chrome's is its one header line");
  assert.equal(isBareBrowserNetworkFailure(bareTypeError("Error in input stream", "TypeError: Error in input stream")), true);
  assert.equal(isBareBrowserNetworkFailure("Load failed"), true, "a thrown string carries no frame by construction");

  // A frame means code that can be read — reported on its own, exactly as before.
  const chromeFramed = "TypeError: Failed to fetch\n    at loadVisits (https://phoenix-hr.satopharma.com/_next/static/chunks/app.js:1:2)";
  assert.equal(stackHasFrame(chromeFramed), true);
  assert.equal(isBareBrowserNetworkFailure(bareTypeError("Failed to fetch", chromeFramed)), false);
  const safariFramed = "loadVisits@https://phoenix-hr.satopharma.com/_next/static/chunks/app.js:1:2";
  assert.equal(isBareBrowserNetworkFailure(bareTypeError("Load failed", safariFramed)), false);

  // Any other message is never folded — "Connection closed." was once a real Supabase failure.
  assert.equal(isBareBrowserNetworkFailure(bareTypeError("Connection closed.", "")), false);
  assert.equal(isBareBrowserNetworkFailure(bareTypeError("Load failed because the visit is locked", "")), false);
  assert.equal(isBareBrowserNetworkFailure(new Error("Cannot read properties of null (reading 'parentNode')")), false);
  assert.equal(isBareBrowserNetworkFailure({ message: "Load failed" }), false, "a plain object is not the browser talking");
  assert.equal(isBareBrowserNetworkFailure(null), false);

  // ── A burst is ONE report, carrying its count ───────────────────────────────
  {
    const clock = fakeTimers();
    const reports: Array<{ message: string; count: number }> = [];
    const collector = createNetworkBurstCollector((burst) => reports.push(burst), clock.timers);
    for (let index = 0; index < 17; index += 1) collector.add("Load failed");
    assert.equal(reports.length, 0, "nothing is reported while the burst is still arriving");
    clock.advance(NETWORK_BURST_QUIET_MS);
    assert.deepEqual(reports, [{ count: 17, message: "Load failed" }], "seventeen rejections in a second are one row");
    assert.equal(networkBurstContext(17), "networkBurst=17");

    // A later drop is its own burst, not folded into the first — how often reps lose the connection stays visible.
    clock.advance(60_000);
    collector.add("Load failed");
    clock.advance(NETWORK_BURST_QUIET_MS);
    assert.deepEqual(reports[1], { count: 1, message: "Load failed" });
    assert.equal(reports.length, 2);
  }

  // ── A page that keeps failing still reports by the cap ──────────────────────
  {
    const clock = fakeTimers();
    const reports: Array<{ message: string; count: number }> = [];
    const collector = createNetworkBurstCollector((burst) => reports.push(burst), clock.timers);
    for (let elapsed = 0; elapsed < NETWORK_BURST_MAX_MS; elapsed += 1_000) {
      collector.add("network error");
      clock.advance(1_000);
    }
    assert.equal(reports.length, 1, "a failure every second never goes quiet, so the cap reports it");
    assert.equal(reports[0].count, 10);
  }

  // ── A page going away reports the open burst at once, and only once ─────────
  {
    const clock = fakeTimers();
    const reports: Array<{ message: string; count: number }> = [];
    const collector = createNetworkBurstCollector((burst) => reports.push(burst), clock.timers);
    collector.add("Load failed");
    collector.add("Load failed");
    collector.flush();
    assert.deepEqual(reports, [{ count: 2, message: "Load failed" }]);
    clock.advance(NETWORK_BURST_MAX_MS);
    collector.flush();
    assert.equal(reports.length, 1, "the timer of a flushed burst never reports it a second time");
  }

  // ── The reporter is wired: both listeners fold, and the page leaving flushes ─
  const reporter = readFileSync(new URL("../src/components/layout/global-error-reporter.tsx", import.meta.url), "utf8");
  assert.equal((reporter.match(/isBareBrowserNetworkFailure\(/g) ?? []).length, 2, "window errors and unhandled rejections both fold a bare network failure");
  assert.match(reporter, /addEventListener\("pagehide", networkBursts\.flush\)/);
  assert.match(reporter, /context: networkBurstContext\(count\)/, "the burst's row carries its count");
}
