import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { CrmRequestError, isRetryableFailure } from "../src/components/phoenix-crm/api.ts";
import {
  runWakeRead,
  waitForNetwork,
  WAKE_ONLINE_WAIT_MS,
  WAKE_RETRY_SETTLE_MS,
  WAKE_SETTLE_MS,
  type WakeNetwork,
} from "../src/lib/phoenix-crm/wake-refresh.ts";

/**
 * Phoenix CRM — the read the page makes on its own when a phone wakes up survives a network still waking.
 *
 * System Audit, 17 Nov 2026: `GET /api/phoenix-crm/overview` getting no answer was the board's largest
 * failed-request class — 223 screenshots from 62 reps since 24 Oct (168 on Visits, 41 on the List), still
 * 13–14 reps a day on 14–16 Nov. `phoenix-crm-app.tsx` read the overview the instant the page came back into
 * sight after a minute away; a waking phone had no network yet, the fetch rejected, and the rep met the
 * refresh warning over a screen that was fine, for a read he never asked for.
 *
 * What this pins:
 *   1. `waitForNetwork` waits the settle, then for `online` or the cap when the browser is offline, and
 *      leaves nothing listening.
 *   2. `runWakeRead` retries a dropped connection ONCE, never a refusal, and never throws.
 *   3. The page's visibility handler uses the wake-up path, the wake-up path never puts up the refresh
 *      notice, and the rep's own Try again still reports (golden rule #1's EASY half: no warning for a read
 *      he did not ask for; the read he did ask for still says why it failed).
 */

const APP_PATH = "src/components/phoenix-crm/phoenix-crm-app.tsx";

/** A hand-driven clock: timers fire only when `advance` passes them. */
function fakeNetwork(initiallyOnline: boolean) {
  let now = 0;
  let online = initiallyOnline;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const onlineListeners = new Set<() => void>();
  const network: WakeNetwork = {
    isOnline: () => online,
    onOnline: (listener) => {
      onlineListeners.add(listener);
      return () => onlineListeners.delete(listener);
    },
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return () => timers.delete(id);
    },
  };
  async function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
      await Promise.resolve();
    }
    now = until;
    await Promise.resolve();
  }
  function goOnline() {
    online = true;
    for (const listener of [...onlineListeners]) listener();
  }
  return { advance, goOnline, network, pending: () => timers.size, listening: () => onlineListeners.size };
}

function tracked(promise: Promise<void>) {
  const state = { done: false };
  void promise.then(() => {
    state.done = true;
  });
  return state;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function offline(): CrmRequestError {
  return new CrmRequestError("No connection. Check the phone's internet and try again.", "offline", 0);
}

/** The body of one `const name = useCallback(...)` in the page, up to the next top-level const. */
function callbackBody(text: string, name: string): string {
  const start = text.indexOf(`const ${name} = useCallback(`);
  assert.ok(start >= 0, `${APP_PATH}: ${name} must exist`);
  const end = text.indexOf("}, []);", start);
  assert.ok(end > start, `${APP_PATH}: ${name} must end in a stable useCallback`);
  return text.slice(start, end);
}

export async function runPhoenixCrmWakeRefreshTests(): Promise<void> {
  // ── 1 · waitForNetwork ───────────────────────────────────────────────────────────────────────
  assert.ok(WAKE_SETTLE_MS >= 1_000 && WAKE_SETTLE_MS <= 3_000, "the settle is a short moment, not a delay a person notices");
  assert.ok(WAKE_ONLINE_WAIT_MS <= 10_000, "the wait for the network is capped");
  assert.ok(WAKE_RETRY_SETTLE_MS >= 1_000, "the retry is not sent straight after the failure");

  {
    // Online: only the settle.
    const clock = fakeNetwork(true);
    const wait = tracked(waitForNetwork(clock.network, WAKE_SETTLE_MS, WAKE_ONLINE_WAIT_MS));
    await clock.advance(WAKE_SETTLE_MS - 1);
    assert.equal(wait.done, false, "the wake-up read never goes out the instant the screen turns on");
    await clock.advance(1);
    await flush();
    assert.equal(wait.done, true, "online after the settle: the read goes");
    assert.equal(clock.pending() + clock.listening(), 0, "nothing left waiting");
  }
  {
    // Offline: the online event ends the wait.
    const clock = fakeNetwork(false);
    const wait = tracked(waitForNetwork(clock.network, WAKE_SETTLE_MS, WAKE_ONLINE_WAIT_MS));
    await clock.advance(WAKE_SETTLE_MS + 2_000);
    assert.equal(wait.done, false, "offline: still waiting for the network");
    clock.goOnline();
    await flush();
    assert.equal(wait.done, true, "the online event ends the wait");
    assert.equal(clock.pending() + clock.listening(), 0, "the cap timer and the listener are both let go");
  }
  {
    // Offline, no event: the cap ends the wait.
    const clock = fakeNetwork(false);
    const wait = tracked(waitForNetwork(clock.network, WAKE_SETTLE_MS, WAKE_ONLINE_WAIT_MS));
    await clock.advance(WAKE_SETTLE_MS + WAKE_ONLINE_WAIT_MS - 1);
    assert.equal(wait.done, false);
    await clock.advance(1);
    await flush();
    assert.equal(wait.done, true, "a network that never says online is waited for only up to the cap");
    assert.equal(clock.listening(), 0, "the online listener is removed");
  }
  {
    // Cancelled (page hidden again): no wait for the network at all.
    const clock = fakeNetwork(false);
    const wait = tracked(waitForNetwork(clock.network, WAKE_SETTLE_MS, WAKE_ONLINE_WAIT_MS, () => true));
    await clock.advance(WAKE_SETTLE_MS);
    await flush();
    assert.equal(wait.done, true, "a cancelled wait ends at the settle");
    assert.equal(clock.listening(), 0);
  }

  // ── 2 · runWakeRead ──────────────────────────────────────────────────────────────────────────
  {
    // The phone's network comes back between the two tries.
    const waits: number[] = [];
    let reads = 0;
    const outcome = await runWakeRead({
      current: () => true,
      read: async () => {
        reads += 1;
        if (reads === 1) throw offline();
        return "fresh";
      },
      retryable: isRetryableFailure,
      wait: async (attempt) => {
        waits.push(attempt);
      },
    });
    assert.deepEqual(outcome, { kind: "landed", value: "fresh" }, "a dropped first try is retried and the fresh answer lands");
    assert.equal(reads, 2);
    assert.deepEqual(waits, [0, 1], "it waits for the network before EACH try, the retry included");
  }
  {
    // Still no network: exactly one retry, then quiet.
    let reads = 0;
    const outcome = await runWakeRead({
      current: () => true,
      read: async () => {
        reads += 1;
        throw offline();
      },
      retryable: isRetryableFailure,
      wait: async () => undefined,
    });
    assert.equal(outcome.kind, "quiet", "a read that never answers ends quiet, never thrown");
    assert.equal(reads, 2, "retried ONCE — not a loop of requests on a dead network");
  }
  {
    // A refusal is never retried.
    let reads = 0;
    const outcome = await runWakeRead({
      current: () => true,
      read: async () => {
        reads += 1;
        throw new CrmRequestError("Not allowed.", "forbidden", 403);
      },
      retryable: isRetryableFailure,
      wait: async () => undefined,
    });
    assert.equal(outcome.kind, "quiet");
    assert.equal(reads, 1, "a refusal answers the same however often it is asked");
  }
  {
    // A newer read, or the page going out of sight, takes over.
    let live = true;
    let reads = 0;
    const outcome = await runWakeRead({
      current: () => live,
      read: async () => {
        reads += 1;
        live = false;
        return "late";
      },
      retryable: isRetryableFailure,
      wait: async () => undefined,
    });
    assert.deepEqual(outcome, { kind: "superseded" }, "an answer nobody wants any more never lands");
    const unsent = await runWakeRead({
      current: () => false,
      read: async () => {
        reads += 1;
        return "never";
      },
      retryable: isRetryableFailure,
      wait: async () => undefined,
    });
    assert.deepEqual(unsent, { kind: "superseded" });
    assert.equal(reads, 1, "a read superseded during its wait is never sent");
  }

  // ── 3 · The page ─────────────────────────────────────────────────────────────────────────────
  const app = stripComments(readFileSync(APP_PATH, "utf8"));
  const visibility = app.slice(app.indexOf("function onVisibilityChange()"), app.indexOf('document.addEventListener("visibilitychange"'));
  assert.ok(visibility.length > 0, `${APP_PATH}: the page still reads again when it comes back into sight`);
  assert.ok(
    visibility.includes("refreshOverviewOnWake()"),
    `${APP_PATH}: coming back into sight must use the wake-up read, which waits for the network and retries once`,
  );
  assert.ok(
    !/refreshOverview\(\)/.test(visibility),
    `${APP_PATH}: coming back into sight must NOT fire the reporting refresh — on a waking phone it fails and warns the rep over a screen that is fine`,
  );

  const wake = callbackBody(app, "refreshOverviewOnWake");
  assert.ok(wake.includes("runWakeRead("), "the wake-up read goes through runWakeRead (one retry, refusals never)");
  assert.ok(wake.includes("waitForNetwork("), "the wake-up read waits for the network before each try");
  assert.ok(wake.includes("retryable: isRetryableFailure"), "only a dropped connection is retried — the same split as the save retry");
  assert.ok(
    !/setRefreshError\((?!null\))/.test(wake),
    "a wake-up read never puts up the refresh notice while an overview is on screen — it may only clear one",
  );
  assert.ok(!wake.includes("setRefreshing("), "a wake-up read never makes the rep's Try again look busy");

  const asked = callbackBody(app, "refreshOverview");
  assert.ok(
    asked.includes("setRefreshError(messageOf(error))"),
    "a read the rep asked for (Try again, Check again, a tab's change) still says why it failed",
  );
  assert.ok(
    /onClick=\{refreshOverview\}/.test(app),
    "Try again and Check again stay on the reporting refresh",
  );
}
