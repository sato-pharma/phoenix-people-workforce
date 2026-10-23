import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EMPTY_UPLOAD_PAUSE,
  UPLOAD_PAUSE_FIRST_MS,
  UPLOAD_PAUSE_MAX_MS,
  UPLOAD_PAUSE_STORAGE_KEY,
  isServerCannotStore,
  nextUploadPause,
  parseUploadPause,
  retryAfterMs,
  uploadPaused,
  type UploadPauseState,
} from "../src/lib/error-monitor/screen-capture-rules.ts";
import { SCREEN_CAPTURE_ENDPOINT, screenUploadsPaused, uploadScreen } from "../src/lib/error-monitor/screen-capture.ts";
import { stripComments } from "./system-audit-routes-access.test.ts";

/**
 * THE OUTAGE PAUSE (owner, 23 Oct 2026: "pause screenshot uploads while the server cannot store
 * them"). During a database outage every open tab drew and sent pictures the server answered 503 and
 * threw away. Three things are pinned here:
 *
 *   1. the rules — which answers pause (5xx, 429, no answer) and which do not (400, 413, 401, 403),
 *      the 5-minute first pause doubling to an hour, Retry-After honoured up to that hour, a stored
 *      picture ending it, and a pause never cut short;
 *   2. the upload — the answer moves the pause, the pause is shared by every tab through
 *      localStorage, and a tab whose storage is blocked still pauses itself;
 *   3. the order — a paused tab returns before the throttle and before anything is drawn.
 */

const MINUTE = 60 * 1000;

// ─── 1. The rules ─────────────────────────────────────────────────────────────────────────────────

function rulesTests() {
  assert.equal(isServerCannotStore(null), true, "no answer at all: the server is unreachable");
  assert.equal(isServerCannotStore(503), true, "the intake's own 'could not be stored'");
  assert.equal(isServerCannotStore(502), true, "the gateway in front of a server that is down");
  assert.equal(isServerCannotStore(429), true, "the person's 40 an hour are used up");
  for (const status of [204, 400, 401, 403, 413]) assert.equal(isServerCannotStore(status), false, `${status} is about this picture or session, not the server`);

  // The first refusal pauses 5 minutes; each one after doubles it, up to an hour.
  const t0 = 1_800_000_000_000;
  let state: UploadPauseState = EMPTY_UPLOAD_PAUSE;
  const waits: number[] = [];
  for (let strike = 0; strike < 7; strike += 1) {
    const now = t0 + strike * 2 * UPLOAD_PAUSE_MAX_MS;
    state = nextUploadPause(state, { status: 503 }, now);
    waits.push((state.pausedUntil - now) / MINUTE);
  }
  assert.deepEqual(waits, [5, 10, 20, 40, 60, 60, 60], "5, 10, 20, 40, then an hour at most");
  assert.equal(UPLOAD_PAUSE_FIRST_MS, 5 * MINUTE);

  // One picture stored ends it.
  assert.equal(nextUploadPause(state, { status: 204 }, t0), EMPTY_UPLOAD_PAUSE, "a stored picture clears the pause and the run of refusals");

  // An answer about this one picture or this session leaves the pause exactly as it was.
  const running: UploadPauseState = { pausedUntil: t0 + 7 * MINUTE, strikes: 2 };
  for (const status of [400, 401, 403, 413]) assert.equal(nextUploadPause(running, { status }, t0), running, `${status} neither starts nor ends a pause`);
  assert.equal(nextUploadPause(EMPTY_UPLOAD_PAUSE, { status: 413 }, t0), EMPTY_UPLOAD_PAUSE, "a picture too large does not pause the next one");

  // Retry-After is honoured, up to the hour; a shorter one never shortens the back-off.
  assert.equal(nextUploadPause(EMPTY_UPLOAD_PAUSE, { status: 429, retryAfter: "3600" }, t0).pausedUntil, t0 + 60 * MINUTE, "the intake's 429 says an hour, and the tab waits it");
  assert.equal(nextUploadPause(EMPTY_UPLOAD_PAUSE, { status: 503, retryAfter: "30" }, t0).pausedUntil, t0 + 5 * MINUTE, "30 seconds asked is still the 5-minute first step");
  assert.equal(nextUploadPause(EMPTY_UPLOAD_PAUSE, { status: 503, retryAfter: "86400" }, t0).pausedUntil, t0 + UPLOAD_PAUSE_MAX_MS, "a day asked is capped at the hour");
  assert.equal(nextUploadPause(EMPTY_UPLOAD_PAUSE, { status: 503, retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT" }, t0).pausedUntil, t0 + 5 * MINUTE, "an HTTP date is not read");

  // A pause already running longer is never cut short by a later, shorter step.
  const long: UploadPauseState = { pausedUntil: t0 + 50 * MINUTE, strikes: 0 };
  assert.equal(nextUploadPause(long, { status: null }, t0).pausedUntil, t0 + 50 * MINUTE);

  assert.equal(retryAfterMs("120"), 120_000);
  assert.equal(retryAfterMs("0"), null);
  assert.equal(retryAfterMs(" "), null);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs("-5"), null);

  assert.equal(uploadPaused({ pausedUntil: t0 + 1, strikes: 1 }, t0), true);
  assert.equal(uploadPaused({ pausedUntil: t0, strikes: 1 }, t0), false, "the pause ends at its own moment");

  assert.deepEqual(parseUploadPause(JSON.stringify({ pausedUntil: t0, strikes: 3 })), { pausedUntil: t0, strikes: 3 });
  for (const raw of [null, "", "not json", "[]", JSON.stringify({ pausedUntil: "soon", strikes: 1 }), JSON.stringify({ pausedUntil: t0, strikes: -1 })]) {
    assert.deepEqual(parseUploadPause(raw), EMPTY_UPLOAD_PAUSE, `${JSON.stringify(raw)} reads as no pause`);
  }
}

// ─── 2. The upload ────────────────────────────────────────────────────────────────────────────────

function fakeStorage(blocked = false) {
  const items = new Map<string, string>();
  return {
    items,
    getItem(key: string) {
      if (blocked) throw new Error("SecurityError");
      return items.has(key) ? (items.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      if (blocked) throw new Error("SecurityError");
      items.set(key, value);
    },
    removeItem(key: string) {
      if (blocked) throw new Error("SecurityError");
      items.delete(key);
    },
  };
}

async function uploadTests() {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globals.window;
  const sent: string[] = [];
  let reply: () => Promise<Response> = async () => new Response(null, { status: 204 });
  const send = ((url: string) => {
    sent.push(url);
    return reply();
  }) as unknown as typeof fetch;
  try {
    const storage = fakeStorage();
    globals.window = { localStorage: storage };

    // The database is down: the intake answers 503.
    reply = async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    const before = Date.now();
    await uploadScreen(send, "{}");
    assert.deepEqual(sent, [SCREEN_CAPTURE_ENDPOINT], "the picture went to the screen endpoint");
    assert.equal(screenUploadsPaused(Date.now()), true, "a 503 pauses the tab");
    const shared = parseUploadPause(storage.items.get(UPLOAD_PAUSE_STORAGE_KEY));
    assert.equal(shared.strikes, 1);
    assert.ok(shared.pausedUntil >= before + UPLOAD_PAUSE_FIRST_MS && shared.pausedUntil <= Date.now() + UPLOAD_PAUSE_FIRST_MS, "for 5 minutes");

    // Every other tab of the browser reads the same storage, so it is paused too.
    globals.window = { localStorage: storage };
    assert.equal(screenUploadsPaused(Date.now()), true, "the pause one tab met holds in every tab");
    assert.equal(screenUploadsPaused(shared.pausedUntil), false, "and ends when it says");

    // Unreachable: the second refusal in a row doubles it.
    reply = () => Promise.reject(new TypeError("Failed to fetch"));
    await uploadScreen(send, "{}");
    const second = parseUploadPause(storage.items.get(UPLOAD_PAUSE_STORAGE_KEY));
    assert.equal(second.strikes, 2, "no answer at all is a refusal too");
    assert.ok(second.pausedUntil - Date.now() > 9 * MINUTE, "10 minutes the second time");

    // A picture refused for itself changes nothing.
    reply = async () => new Response(JSON.stringify({ error: "too_large" }), { status: 413 });
    await uploadScreen(send, "{}");
    assert.deepEqual(parseUploadPause(storage.items.get(UPLOAD_PAUSE_STORAGE_KEY)), second, "413 leaves the pause as it was");

    // The server is back: one picture stored ends it for every tab.
    reply = async () => new Response(null, { status: 204 });
    await uploadScreen(send, "{}");
    assert.equal(storage.items.has(UPLOAD_PAUSE_STORAGE_KEY), false, "a stored picture removes the shared pause");
    assert.equal(screenUploadsPaused(Date.now()), false);

    // The intake's own rate limit says an hour.
    reply = async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "Retry-After": "3600" } });
    await uploadScreen(send, "{}");
    assert.ok(parseUploadPause(storage.items.get(UPLOAD_PAUSE_STORAGE_KEY)).pausedUntil - Date.now() > 59 * MINUTE, "429 with Retry-After 3600 pauses an hour");
    reply = async () => new Response(null, { status: 204 });
    await uploadScreen(send, "{}");

    // A private window that blocks storage still pauses its own tab, and never throws.
    globals.window = { localStorage: fakeStorage(true) };
    assert.equal(screenUploadsPaused(Date.now()), false);
    reply = async () => new Response(null, { status: 503 });
    await uploadScreen(send, "{}");
    assert.equal(screenUploadsPaused(Date.now()), true, "with storage blocked the tab keeps its own pause");
    reply = async () => new Response(null, { status: 204 });
    await uploadScreen(send, "{}");
    assert.equal(screenUploadsPaused(Date.now()), false);
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
}

// ─── 3. The order ─────────────────────────────────────────────────────────────────────────────────

function orderTests() {
  const source = stripComments(readFileSync(new URL("../src/lib/error-monitor/screen-capture.ts", import.meta.url), "utf8"));
  const start = source.indexOf("async function captureAndSend(");
  assert.ok(start >= 0, "captureAndSend exists");
  const body = source.slice(start, source.indexOf("\nfunction later(", start));
  const paused = body.indexOf("screenUploadsPaused(");
  assert.ok(paused >= 0, "captureAndSend consults the outage pause");
  assert.ok(paused < body.indexOf("decideScreenThrottle("), "a paused tab never spends a throttle slot");
  assert.ok(paused < body.indexOf("drawViewport("), "a paused tab never draws the page");
  assert.ok(body.includes("uploadScreen("), "every picture goes out through uploadScreen, which moves the pause");
  assert.equal(body.includes("SCREEN_CAPTURE_ENDPOINT"), false, "no second send that would skip the pause");
}

export async function runScreenUploadPauseTests() {
  rulesTests();
  await uploadTests();
  orderTests();
}
