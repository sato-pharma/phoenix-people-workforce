import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BADGES_GAP_MS,
  HEARTBEAT_GAP_MS,
  HEARTBEAT_GATHER_MS,
  NOTICES_GAP_MS,
  PULSE_RETURN_GAP_MS,
  notePulseActivity,
  subscribePulseBadges,
  subscribePulseNotices,
  subscribePulseSessionEnded,
  _resetSessionPulse,
  type PulseBadges,
  type PulseNotices,
} from "../src/lib/session-pulse-store.ts";
import { stripComments } from "./support/comment-strip.ts";

// The session pulse (/api/auth/pulse): ONE request where an open tab used to send three — the sidebar
// badges, the notification bell and the session heartbeat. 36,926 phx_auth_session_bundle calls a day
// (87 ms each, the heaviest function in the system, 23 Oct 2026); a visible tab now pays two session
// reads a minute instead of four. The client store is driven by hand here: fetch, setInterval,
// Date.now and the visibility listener are all faked.

const visibilityListeners: Array<() => void> = [];
const mockDocument = {
  addEventListener(_evt: string, fn: () => void) {
    visibilityListeners.push(fn);
  },
  removeEventListener(_evt: string, fn: () => void) {
    const i = visibilityListeners.indexOf(fn);
    if (i >= 0) visibilityListeners.splice(i, 1);
  },
  visibilityState: "visible" as string,
};
const g = globalThis as unknown as Record<string, unknown>;
// The window/document/fetch fakes are installed INSIDE runSessionPulseTests and restored after it:
// tests/run-tests.ts imports every file up front, so a global set at import time would replace the mock
// an earlier-imported file (nav-badge-store) installed, and its visibility test would fail in the full run.

interface Call {
  url: string;
  method: string;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const BADGES: PulseBadges = { vacation: { count: 3, overdue: true }, hub: { count: 8 } };
const NOTICES: PulseNotices = { data: [{ id: "n1" }], success: true };

function read(path: string) {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export async function runSessionPulseTests() {
  const realNow = Date.now;
  const hadWindow = "window" in g;
  const hadDocument = "document" in g;
  const realWindow = g["window"];
  const realDocument = g["document"];
  const realFetch = g["fetch"];
  g["window"] = {};
  g["document"] = mockDocument;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  // The bare heartbeat's wait (HEARTBEAT_GATHER_MS) runs on setTimeout; the fake keeps each pending
  // wait with its delay so a test fires it by hand.
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  let nextTimeoutId = 1;

  let now = 5_000_000;
  const ticks: Array<() => void> = [];
  const calls: Call[] = [];
  let status = 200;
  let deferred: ((v: Response) => void) | null = null;

  function install(options: { defer?: boolean } = {}): void {
    calls.length = 0;
    ticks.length = 0;
    status = 200;
    deferred = null;
    Date.now = () => now;
    g["setInterval"] = (fn: () => void) => {
      ticks.push(fn);
      return ticks.length as unknown as ReturnType<typeof setInterval>;
    };
    g["clearInterval"] = () => {};
    timeouts.clear();
    g["setTimeout"] = (fn: () => void, ms: number) => {
      const id = nextTimeoutId++;
      timeouts.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    };
    g["clearTimeout"] = (id: number) => {
      timeouts.delete(id);
    };
    g["fetch"] = (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? "GET" });
      // Like the route: each half is in the answer only when the request asked for it.
      const body = {
        ...(url.includes("badges=1") ? { badges: BADGES } : {}),
        ...(url.includes("notices=1") ? { notices: NOTICES } : {}),
      };
      const response = { status, json: () => Promise.resolve(body) } as unknown as Response;
      if (options.defer) return new Promise<Response>((resolve) => (deferred = resolve));
      return Promise.resolve(response);
    };
  }

  function reset(): void {
    _resetSessionPulse();
    mockDocument.visibilityState = "visible";
    visibilityListeners.length = 0;
  }

  try {
    // ── 1. One badge subscriber: one GET carrying the badges only, delivered to it ──────────────────
    {
      install();
      reset();
      const got: PulseBadges[] = [];
      const unsub = subscribePulseBadges((b) => got.push(b));
      await flush();
      assert.deepEqual(calls, [{ url: "/api/auth/pulse?badges=1", method: "GET" }], "1: a badge subscriber must trigger one read-only request for the badges");
      assert.deepEqual(got, [BADGES], "1: the badges must reach the subscriber");
      assert.equal(ticks.length, 1, "1: exactly one 30 s interval must be running");
      unsub();
      reset();
    }

    // ── 2. Badges and the bell mounting together share ONE request ───────────────────────────────────
    {
      install();
      reset();
      const unsubBadges = subscribePulseBadges(() => {});
      const noticesGot: PulseNotices[] = [];
      const unsubNotices = subscribePulseNotices((n) => noticesGot.push(n));
      await flush();
      assert.equal(calls.length, 1, "2: a badge and a bell mounting together must send one request, not two");
      assert.equal(calls[0].url, "/api/auth/pulse?badges=1&notices=1", "2: the one request must ask for both halves");
      assert.deepEqual(noticesGot, [NOTICES], "2: the notices must reach the bell");
      assert.equal(ticks.length, 1, "2: still one interval for both subscribers");
      unsubBadges();
      unsubNotices();
      reset();
    }

    // ── 3. A subscriber arriving mid-request is answered by that request, not by a second one ───────────
    {
      install({ defer: true });
      reset();
      const first: PulseBadges[] = [];
      const second: PulseBadges[] = [];
      const unsub1 = subscribePulseBadges((b) => first.push(b));
      const unsub2 = subscribePulseBadges((b) => second.push(b));
      await flush();
      assert.equal(calls.length, 1, "3: two badge subscribers mounting together must share one request");
      const unsub3 = subscribePulseBadges(() => {});
      await flush();
      assert.equal(calls.length, 1, "3: a subscriber arriving while that request is in flight must not start a second one");
      (deferred as unknown as (v: Response) => void)({ status: 200, json: () => Promise.resolve({ badges: BADGES }) } as unknown as Response);
      await flush();
      assert.equal(calls.length, 1, "3: and none may follow the first one's answer");
      assert.deepEqual(first, [BADGES], "3: the first subscriber gets the answer");
      assert.deepEqual(second, [BADGES], "3: the late subscriber is covered by the same answer");
      unsub1();
      unsub2();
      unsub3();
      reset();
    }

    // ── 4. A cached answer is delivered at once, with no new request ───────────────────────────────────
    {
      install();
      reset();
      const unsub1 = subscribePulseBadges(() => {});
      await flush();
      assert.equal(calls.length, 1);
      const late: PulseBadges[] = [];
      const unsub2 = subscribePulseBadges((b) => late.push(b));
      assert.deepEqual(late, [BADGES], "4: a badge mounting after the first answer must get it synchronously");
      await flush();
      assert.equal(calls.length, 1, "4: and must cost no request");
      unsub1();
      unsub2();
      reset();
    }

    // ── 5. The 30 s tick: nothing wanted → nothing sent; hidden tab → nothing sent ─────────────────────
    {
      install();
      reset();
      const unsubEnded = subscribePulseSessionEnded(() => {});
      assert.equal(ticks.length, 1, "5: a session-ended subscriber keeps the loop alive");
      ticks[0]();
      await flush();
      assert.equal(calls.length, 0, "5: a tick with no badge, no bell and no activity must send nothing at all");
      unsubEnded();

      install();
      reset();
      const unsub = subscribePulseBadges(() => {});
      await flush();
      const afterBoot = calls.length;
      // The badges are due again, so only the tab's visibility decides.
      now += BADGES_GAP_MS;
      mockDocument.visibilityState = "hidden";
      ticks[0]();
      await flush();
      assert.equal(calls.length, afterBoot, "5: a hidden tab's tick must not send");
      mockDocument.visibilityState = "visible";
      ticks[0]();
      await flush();
      assert.equal(calls.length, afterBoot + 1, "5: a visible tab's tick must send");
      unsub();
      reset();
    }

    // ── 6. Badges and notices are each refreshed on a tick only when 55 s old: ONE request a minute ────
    // Production, Wednesday 28 Oct 2026: a badge read on every 30 s tick was about 2,700 reads and
    // 50,000-57,000 Supabase requests a day. The owner chose "badges up to 1 minute old" (31 Oct 2026).
    {
      install();
      reset();
      now = 5_000_000;
      const unsubBadges = subscribePulseBadges(() => {});
      const unsubNotices = subscribePulseNotices(() => {});
      await flush();
      assert.equal(calls.length, 1);

      now += 30_000;
      ticks[0]();
      await flush();
      assert.equal(calls.length, 1, "6: a tick 30 s after the badges and notices came must send nothing at all");

      now += 30_000;
      ticks[0]();
      await flush();
      assert.equal(calls[1].url, "/api/auth/pulse?badges=1&notices=1", "6: a tick 60 s after they came must ask for both again, in one request");

      now += 30_000;
      ticks[0]();
      await flush();
      now += 30_000;
      ticks[0]();
      await flush();
      assert.equal(calls.length, 3, "6: a quiet tab with a badge and the bell sends one request a minute, not two");
      assert.ok(NOTICES_GAP_MS <= 60_000 && NOTICES_GAP_MS > 30_000, "6: the notice gap sits between the second and third 30 s tick");
      unsubBadges();
      unsubNotices();
      reset();
    }

    // ── 7. The heartbeat: a POST only on activity with the 60 s floor; a 401 ends the session ───────────
    {
      install();
      reset();
      now = 6_000_000;
      let ended = 0;
      const unsubBadges = subscribePulseBadges(() => {});
      const unsubEnded = subscribePulseSessionEnded(() => ended++);
      await flush();
      assert.equal(calls[0].method, "GET", "7: no activity yet — the first request is a read");

      now += BADGES_GAP_MS;
      notePulseActivity();
      await flush();
      assert.equal(calls.length, 2, "7: activity with no heartbeat on record sends one at once");
      assert.deepEqual(calls[1], { url: "/api/auth/pulse?badges=1", method: "POST" }, "7: the heartbeat is a POST that still carries the badges");

      now += 1_000;
      notePulseActivity();
      await flush();
      assert.equal(calls.length, 2, "7: a second activity inside the 60 s floor must not send another heartbeat");

      now += HEARTBEAT_GAP_MS;
      ticks[0]();
      await flush();
      assert.equal(calls[calls.length - 1].method, "POST", "7: once the floor has passed, the pending activity makes the next tick a POST");

      now += BADGES_GAP_MS;
      ticks[0]();
      await flush();
      assert.equal(calls[calls.length - 1].method, "GET", "7: with no new activity, the next tick is a read again");

      assert.equal(ended, 0, "7: no 401 yet — the session has not ended");
      status = 401;
      now += HEARTBEAT_GAP_MS;
      notePulseActivity();
      await flush();
      assert.equal(ended, 1, "7: a 401 on the heartbeat must fire the session-ended event");
      unsubBadges();
      unsubEnded();
      reset();
    }

    // ── 8. Network failure and 429/503 are ignored; the next tick retries ───────────────────────────────
    {
      install();
      reset();
      let ended = 0;
      const unsubEnded = subscribePulseSessionEnded(() => ended++);
      const unsub = subscribePulseBadges(() => {});
      await flush();
      now += BADGES_GAP_MS;
      g["fetch"] = () => Promise.reject(new Error("offline"));
      ticks[0]();
      await flush();
      g["fetch"] = (url: string, init?: { method?: string }) => {
        calls.push({ url, method: init?.method ?? "GET" });
        return Promise.resolve({ status: 503, json: () => Promise.resolve({}) } as unknown as Response);
      };
      const before = calls.length;
      ticks[0]();
      await flush();
      assert.equal(calls.length, before + 1, "8: after a network failure the next tick must still send — a failed read leaves the badges due");
      assert.equal(ended, 0, "8: a failed or 503 request must never end the session");
      unsub();
      unsubEnded();
      reset();
    }

    // ── 9. A tab shown again inside 15 s of the last request keeps what it has ─────────────────────────
    {
      install();
      reset();
      now = 7_000_000;
      const unsub = subscribePulseBadges(() => {});
      await flush();
      assert.equal(calls.length, 1);
      assert.equal(visibilityListeners.length, 1, "9: one visibilitychange listener however many subscribers");
      now += PULSE_RETURN_GAP_MS - 1;
      visibilityListeners.forEach((fn) => fn());
      await flush();
      assert.equal(calls.length, 1, "9: a return inside 15 s must not recount");
      now += 1;
      visibilityListeners.forEach((fn) => fn());
      await flush();
      assert.equal(calls.length, 2, "9: a return 15 s after the last request must recount, however young the badges are by the one-minute clock");
      unsub();
      assert.equal(visibilityListeners.length, 0, "9: the listener is removed when the last subscriber leaves");
      reset();
    }

    // ── 10. One request in flight at a time ────────────────────────────────────────────────────────────
    {
      install({ defer: true });
      reset();
      const unsub = subscribePulseBadges(() => {});
      ticks[0]();
      visibilityListeners.forEach((fn) => fn());
      notePulseActivity();
      assert.equal(calls.length, 1, "10: a tick, a return and activity while a request is in flight must not start another");
      (deferred as unknown as (v: Response) => void)({ status: 200, json: () => Promise.resolve({ badges: BADGES }) } as unknown as Response);
      await flush();
      unsub();
      reset();
    }

    // ── 11. A heartbeat with nothing to carry waits for the bell, so a page opening sends ONE request ──
    // Production, 31 Oct 14:51-15:00 Cairo: 14 of 67 pulse requests were a bare heartbeat POST sent the
    // moment the session guard mounted, then the bell's own GET 0.4-2.5 s later from the same phone.
    {
      install();
      reset();
      now = 8_000_000;
      const unsubEnded = subscribePulseSessionEnded(() => {});
      notePulseActivity();
      await flush();
      assert.equal(calls.length, 0, "11: a heartbeat with nothing else to carry must not go out the moment the guard mounts");
      assert.equal(timeouts.size, 1, "11: it waits instead, on one timer");
      assert.equal([...timeouts.values()][0].ms, HEARTBEAT_GATHER_MS, "11: for HEARTBEAT_GATHER_MS");
      assert.ok(HEARTBEAT_GATHER_MS >= 2_500 && HEARTBEAT_GATHER_MS <= 5_000, "11: long enough for the slowest bell seen (2.5 s), short enough to be invisible");

      now += 1_200;
      notePulseActivity();
      await flush();
      assert.equal(timeouts.size, 1, "11: more activity during the wait starts no second timer");

      const noticesGot: PulseNotices[] = [];
      const unsubNotices = subscribePulseNotices((n) => noticesGot.push(n));
      await flush();
      assert.deepEqual(
        calls,
        [{ url: "/api/auth/pulse?notices=1", method: "POST" }],
        "11: the bell arriving during the wait must make ONE request that is both the heartbeat and the notices",
      );
      assert.deepEqual(noticesGot, [NOTICES], "11: and the bell gets its notices from it");
      assert.equal(timeouts.size, 0, "11: the wait is cancelled once the heartbeat has gone");
      unsubNotices();
      unsubEnded();
      reset();
    }
    {
      install();
      reset();
      now = 9_000_000;
      const unsubEnded = subscribePulseSessionEnded(() => {});
      notePulseActivity();
      await flush();
      assert.equal(calls.length, 0);
      const [[waitId, wait]] = [...timeouts.entries()];
      now += HEARTBEAT_GATHER_MS;
      // A real timer is gone once it has fired; so is the fake.
      timeouts.delete(waitId);
      wait.fn();
      await flush();
      assert.deepEqual(
        calls,
        [{ url: "/api/auth/pulse", method: "POST" }],
        "11: when nothing rides with it, the heartbeat goes on its own once the wait is over -- a session is never left unrefreshed",
      );
      now += 1_000;
      notePulseActivity();
      await flush();
      assert.equal(calls.length, 1, "11: and the 60 s floor still holds after it");
      assert.equal(timeouts.size, 0, "11: with no wait pending");
      unsubEnded();
      reset();
    }

    // ── 12. The badges are refreshed on a tick only when they are BADGES_GAP_MS old ────────────────────
    {
      install();
      reset();
      now = 10_000_000;
      const got: PulseBadges[] = [];
      const unsub = subscribePulseBadges((b) => got.push(b));
      await flush();
      assert.equal(calls.length, 1);

      now += 30_000;
      ticks[0]();
      await flush();
      assert.equal(calls.length, 1, "12: a tick 30 s after the badges came must not ask for them again");

      now += BADGES_GAP_MS - 30_000 - 1;
      ticks[0]();
      await flush();
      assert.equal(calls.length, 1, "12: nor a tick a moment short of BADGES_GAP_MS");

      now += 1;
      ticks[0]();
      await flush();
      assert.deepEqual(calls[1], { url: "/api/auth/pulse?badges=1", method: "GET" }, "12: a tick BADGES_GAP_MS after they came must ask for them");
      assert.deepEqual(got, [BADGES, BADGES], "12: and deliver them");

      assert.ok(BADGES_GAP_MS <= 60_000 && BADGES_GAP_MS > 30_000, "12: the badges fall due on the second 30 s tick — at most a minute old, the owner's choice");
      assert.equal(BADGES_GAP_MS, NOTICES_GAP_MS, "12: the badges and the bell fall due on the same tick, so they share one request");
      assert.ok(BADGES_GAP_MS < HEARTBEAT_GAP_MS, "12: a heartbeat that falls due finds the badges due too and carries them");
      unsub();
      reset();
    }
  } finally {
    Date.now = realNow;
    g["setInterval"] = realSetInterval;
    g["clearInterval"] = realClearInterval;
    g["setTimeout"] = realSetTimeout;
    g["clearTimeout"] = realClearTimeout;
    mockDocument.visibilityState = "visible";
    _resetSessionPulse();
    g["fetch"] = realFetch;
    if (hadWindow) g["window"] = realWindow;
    else delete g["window"];
    if (hadDocument) g["document"] = realDocument;
    else delete g["document"];
  }

  // ── Source pins: the route, the three clients, the two legacy endpoints ──────────────────────────────
  const route = read("app/api/auth/pulse/route.ts");
  assert.match(route, /export async function GET\(/, "the pulse must answer GET (the read-only tick)");
  assert.match(route, /export async function POST\(/, "the pulse must answer POST (the heartbeat tick)");
  const postBody = route.slice(route.indexOf("export async function POST("));
  assert.match(postBody, /runSessionHeartbeat\(request\)/, "the POST must run the real session heartbeat — only it confirms a session is live");
  assert.doesNotMatch(
    postBody,
    /resolveAccessContext/,
    "the POST must not go through resolveAccessContext — its seat-view and test-account guards refuse a POST and would stop those sessions refreshing",
  );
  assert.match(postBody, /applySeatView\(/, "the POST must layer View as Seat on the heartbeat's own context");
  const getBody = route.slice(route.indexOf("export async function GET("), route.indexOf("export async function POST("));
  assert.match(getBody, /resolveAccessContext\(request\)/, "the GET resolves the viewer like every read route");
  assert.doesNotMatch(getBody, /status:\s*401/, "the GET must never answer 401 — only the POST decides a session has ended");

  assert.match(read("app/api/approvals/badge-counts/route.ts"), /loadBadgeCounts\(/, "the legacy badge-counts endpoint must stay live, on the shared payload");
  assert.match(read("app/api/auth/heartbeat/route.ts"), /runSessionHeartbeat\(/, "the legacy heartbeat endpoint must stay live, on the shared heartbeat");

  assert.match(read("src/lib/nav-badge-store.ts"), /subscribePulseBadges\(/, "the sidebar badges must ride the pulse");
  assert.match(read("src/components/layout/in-app-notifications-bell.tsx"), /subscribePulseNotices\(/, "the notification bell must ride the pulse");
  const guard = read("src/components/auth/session-security-guard.tsx");
  assert.match(guard, /subscribePulseSessionEnded\(/, "the session guard must hear the pulse's session-ended event");
  assert.match(guard, /notePulseActivity\(/, "the session guard must report the viewer's activity to the pulse");
  assert.doesNotMatch(guard, /\/api\/auth\/heartbeat/, "the session guard must no longer call the standalone heartbeat");
}
