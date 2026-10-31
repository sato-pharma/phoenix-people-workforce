/**
 * The filter that decides whether an aborted request reaches app_error_events.
 *
 * On 2026-09-09 the Next 16.2.11 -> 16.3.3 security bump (#3559) started throwing
 * "The destination stream closed early." whenever a client hung up mid-render. The filter in
 * instrumentation.ts keyed only on errno codes, and that Error carries NO `code`, so every one was
 * forwarded. Production went from zero such rows in 13 days to 15 in the first eight hours of the
 * new build, against a platform baseline of roughly 3 to 7 events A DAY across everything.
 * Fourteen were the hourly synthetic-journeys smoke test cancelling the admin sidebar's own link
 * prefetches when Playwright closed the page.
 *
 * Nothing was broken for any employee. The cost is that the error table is read by a human every
 * morning, and one noise class at that rate makes the real rows unfindable — which is the failure
 * this pins against, in BOTH directions:
 *
 *  - the abort wordings must be filtered, or the noise returns;
 *  - "Connection closed." must NOT be, because this repo has seen it as a real Supabase failure,
 *    and a filter that hides a genuine fault is worse than the noise it removed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isBenignClientDisconnect } from "../src/lib/error-monitor/benign-disconnect.ts";
import { reportClientError } from "../src/lib/error-monitor/report-client-error.ts";

export function runBenignClientDisconnectTests() {
  // ── The headline: the exact Error that produced the 15 production rows ─────────────────────
  // Verbatim from app_error_events, and deliberately constructed the way Next throws it — a plain
  // Error with no `code`, which is precisely why the errno-only filter could not see it.
  const nextAbort = new Error("The destination stream closed early.");
  assert.equal(
    (nextAbort as NodeJS.ErrnoException).code,
    undefined,
    "the fixture must carry no code, or it would pass through the OLD filter and prove nothing",
  );
  assert.equal(
    isBenignClientDisconnect(nextAbort),
    true,
    "Next 16.3.3's aborted-render wording is a client disconnect and must never reach the error table",
  );

  // ── The codes the original filter covered must keep working ───────────────────────────────
  for (const code of ["ECONNRESET", "ECONNABORTED", "EPIPE"]) {
    const errno = Object.assign(new Error("socket hang up"), { code });
    assert.equal(isBenignClientDisconnect(errno), true, `${code} is a benign disconnect and was filtered before this change too`);
  }

  // ── The fetch/undici spellings of the same event ───────────────────────────────────────────
  assert.equal(isBenignClientDisconnect(new Error("Aborted")), true, "undici's abort wording is the same event");
  assert.equal(isBenignClientDisconnect(new Error("The user aborted a request.")), true, "the fetch abort wording is the same event");
  assert.equal(
    isBenignClientDisconnect(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
    true,
    "an AbortError carries its identity in the name, not the message",
  );

  // ── THE OTHER DIRECTION, and the reason the match is exact rather than a substring ─────────
  // "Connection closed." appears in production as a REAL failure. A loose includes("closed") would
  // swallow it, and the row that explains an outage would simply stop existing.
  assert.equal(
    isBenignClientDisconnect(new Error("Connection closed.")),
    false,
    "'Connection closed.' is a real Supabase failure in this repo's own history — filtering it hides an outage",
  );
  assert.equal(isBenignClientDisconnect(new Error("The destination stream closed early")), false, "no trailing period is not Next's string; an exact set must stay exact");
  assert.equal(isBenignClientDisconnect(new Error("permission denied for table expense_claims")), false, "a 42501 is the most diagnostic row the table ever holds");
  assert.equal(isBenignClientDisconnect(new Error("Minified React error #418")), false, "a hydration error is ours, however quiet it looks");

  // A Supabase PostgrestError is a plain object, not an Error (see describe-thrown.ts). It must
  // survive the filter, and must not throw it either.
  assert.equal(
    isBenignClientDisconnect({ code: "42501", details: null, hint: null, message: "permission denied" }),
    false,
    "a PostgrestError's code is a Postgres code, never an errno — it must not be mistaken for a disconnect",
  );

  // ── Nothing thrown is off-limits: the catch-all sees whatever a route threw ────────────────
  for (const thrown of [null, undefined, "a bare string", 42, new Error()]) {
    assert.equal(isBenignClientDisconnect(thrown), false, `${String(thrown)} is not a disconnect, and asking must not throw`);
  }

  // ── The wiring: a correct filter nothing calls filters nothing ─────────────────────────────
  // Same reasoning as describe-thrown.test.ts — that test exists because one route was fixed and
  // the app-wide net under all of them was not.
  const instrumentation = readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf-8");
  assert.match(
    instrumentation,
    /import \{ isBenignClientDisconnect \} from "@\/lib\/error-monitor\/benign-disconnect"/,
    "instrumentation.ts must import the shared filter rather than growing a private copy",
  );
  assert.match(
    instrumentation,
    /if \(isBenignClientDisconnect\(error\)\) return;/,
    "onRequestError must actually consult the filter before forwarding",
  );
  assert.doesNotMatch(
    instrumentation,
    /IGNORED_CONNECTION_ERROR_CODES/,
    "the inline errno set is what missed the Next 16.3.3 wording; it must not come back alongside the shared filter",
  );

  // ── The browser's own copy: a read its page cancelled (System Audit, 31 Oct 2026) ──────────
  // Safari on iOS 16 raises a fetch its page aborted as an unhandled rejection, worded "Fetch is
  // aborted". 108 rows from two reps in 30 days, every stack a Phoenix CRM screen's own abort() as it
  // closed. Verbatim from app_error_events — the wording is WebKit's, so it is matched exactly.
  assert.equal(isBenignClientDisconnect(new Error("Fetch is aborted")), true, "WebKit's wording for a fetch its own page cancelled");
  assert.equal(isBenignClientDisconnect(new Error("Fetch is aborted because the server is down")), false, "exact, never a prefix");

  const originalFetch = globalThis.fetch;
  const posted: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    posted.push(String(init?.body ?? ""));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    reportClientError({ error: new Error("Fetch is aborted"), route: "/phoenix-crm" });
    assert.equal(posted.length, 0, "🔴 Safari's cancelled read is not filed as a crash");
    reportClientError({ error: Object.assign(new Error("signal is aborted without reason"), { name: "AbortError" }), route: "/phoenix-crm" });
    assert.equal(posted.length, 0, "nor any browser's AbortError — the name carries it, whatever the message");
    reportClientError({ error: Object.assign(new Error("signal timed out"), { name: "TimeoutError" }), route: "/phoenix-crm" });
    assert.equal(posted.length, 1, "🔴 a read that TIMED OUT is ours to know about — it is still reported");
    reportClientError({ error: new Error("Connection closed."), route: "/weekly-sales" });
    assert.equal(posted.length, 2, "and so is every real fault");
    // The filed row carries the message, so the second post is the real fault, never the abort.
    assert.match(posted[1] ?? "", /Connection closed./);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
