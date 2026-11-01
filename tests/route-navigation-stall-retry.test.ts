import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  ROUTE_STALL_DEADLINE_MS,
  ROUTE_STALL_DISMISS_LABEL,
  ROUTE_STALL_MESSAGE,
  ROUTE_STALL_RETRY_LABEL,
  routeStallRetry,
} from "../src/lib/navigation/route-stall.ts";

/**
 * A page navigation that died, and the retry the rep can press.
 *
 * 🔴 OWNER, 2026-10-23: "add the same retry when a CRM page navigation dies" — the second half of
 * the same morning's measurement. The first half gave every SAVE a Try again
 * (`tests/phoenix-crm-tap-to-retry.test.ts`); this is the bigger half. Of the 1,161 network-failure
 * rows in `app_error_events` over 14 days, most carried no caller context at all — they were the
 * router's own page fetch, which no screen catches because nothing had rendered yet. 905 of them
 * fired with the tab in the FOREGROUND: the rep tapped, and the tap did nothing.
 *
 * What made it invisible: `RouteTransitionProvider` showed its progress bar, waited out a 9-second
 * deadline, and then simply took the bar away again.
 *
 * What this pins:
 *   1. The notice and the bar share ONE deadline, so the moment the bar gives up is the moment
 *      something is said.
 *   2. The page arriving clears it — including a navigation slower than the deadline that then
 *      lands, which must correct itself with no tap.
 *   3. A transition the provider only GUESSED at (a capture-phase click on a control that opens a
 *      panel) never grows the notice, and neither does one whose URL did move.
 *   4. Try again is a FULL DOCUMENT LOAD of the href that was wanted — never another router push,
 *      which is the thing that just failed — and a back/forward, which has no href, reloads.
 *   5. The bar is square, wraps at phone width, announces itself, and can be dismissed.
 */

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

const PROVIDER_PATH = "src/components/layout/route-transition-provider.tsx";

export function runRouteNavigationStallRetryTests(): void {
  // ── 1 · The retry target ─────────────────────────────────────────────────────────────────────
  assert.deepEqual(
    routeStallRetry("/employee-portals/field-crm/visits"),
    { href: "/employee-portals/field-crm/visits", kind: "navigate" },
    "a navigation Phoenix started knows where it was going",
  );
  assert.deepEqual(
    routeStallRetry("/employee-portals/field-crm/list?tab=pending"),
    { href: "/employee-portals/field-crm/list?tab=pending", kind: "navigate" },
    "the query is part of the destination — a tab is a different page to the rep",
  );
  assert.deepEqual(routeStallRetry(null), { kind: "reload" }, "a back/forward has no href: reload what is on screen");
  assert.deepEqual(routeStallRetry(""), { kind: "reload" }, "an empty href is no href");
  assert.deepEqual(routeStallRetry("   "), { kind: "reload" }, "whitespace is no href either");

  // The sentence is the rep's, not the browser's: "Load failed" names nothing he can act on.
  assert.ok(!/load failed|network error|fetch/i.test(ROUTE_STALL_MESSAGE), `the notice must not quote the browser: ${ROUTE_STALL_MESSAGE}`);
  assert.ok(ROUTE_STALL_MESSAGE.includes("did not open"), "the notice says what happened in the rep's words");
  assert.equal(ROUTE_STALL_RETRY_LABEL, "Try again", "the same words the save and the read sides already use");

  // ── 2 · One deadline, shared ─────────────────────────────────────────────────────────────────
  const provider = source(PROVIDER_PATH);
  assert.equal(ROUTE_STALL_DEADLINE_MS, 9_000, "the deadline is the one the progress bar already used");
  assert.ok(provider.includes("ROUTE_STALL_DEADLINE_MS)"), "the provider must use the shared deadline, never its own number");
  assert.ok(
    !/setTimeout\([^)]*\)\s*,\s*9000\)/.test(provider) && !provider.includes(", 9000)"),
    "the old literal 9000 must be gone, so the bar and the notice cannot drift apart",
  );

  // ── 3 · Arrival clears it, with nothing pressed ──────────────────────────────────────────────
  const clearBody = provider.slice(provider.indexOf("function clearPendingSoon()"), provider.indexOf("function startTransition("));
  assert.ok(clearBody.includes("setStalled(false)"), "the page arriving must clear the notice");
  assert.ok(clearBody.includes("wantedHrefRef.current = null"), "and must forget where it was going");
  const startBody = provider.slice(provider.indexOf("function startTransition("), provider.indexOf("function retryStalledNavigation()"));
  assert.ok(startBody.includes("setStalled(false)"), "a new navigation must clear a notice left from the last one");

  // ── 4 · Only a real navigation is judged ─────────────────────────────────────────────────────
  assert.ok(startBody.includes("if (!eligibleRef.current) return;"), "a transition the provider only guessed at must never announce a stall");
  assert.ok(
    startBody.includes("if (fromUrlRef.current !== null && fromUrlRef.current !== now) return;"),
    "a URL that did move means the page went somewhere — never a notice over it",
  );
  assert.ok(
    // A block since 1 Nov 2026: the same re-read also forgets the soft-navigation start (Layer E).
    /if \(event\.defaultPrevented && intentSeqRef\.current === seqAtClick\) \{?\s*eligibleRef\.current = false;/.test(provider),
    "defaultPrevented must be re-read AFTER the event, because this listener is in the capture phase",
  );
  assert.ok(
    provider.includes("intentSeqRef.current += 1;"),
    "an announced route after a prevented click keeps the transition eligible — every portal rail link does that",
  );

  // ── 5 · The retry is a document load ─────────────────────────────────────────────────────────
  const retryBody = provider.slice(provider.indexOf("function retryStalledNavigation()"), provider.indexOf("useEffect(() => {\n    if (previousRouteKey"));
  assert.ok(retryBody.includes("hardNavigate(retry.href)"), "Try again must be a full document load — the router's own fetch is what failed");
  assert.ok(retryBody.includes("window.location.reload()"), "a back/forward with no href reloads instead");
  assert.ok(!retryBody.includes("router.push") && !retryBody.includes("startTransition("), "never retry through the router that just failed");

  // ── 6 · The bar itself ───────────────────────────────────────────────────────────────────────
  const bar = provider.slice(provider.indexOf("{stalled ? ("), provider.indexOf("{children}"));
  assert.ok(bar.includes('role="alert"'), "the notice must announce itself — a rep who cannot see it is back where he started");
  assert.ok(!bar.includes('aria-hidden="true"'), "it is interactive, unlike the progress bar above it");
  assert.ok(!/rounded-(?:sm|md|lg|xl|full)/.test(bar), "the square-edge rule: no rounded corners on the bar or its buttons");
  assert.ok(bar.includes("rounded-none"), "both buttons declare square corners against any inherited radius");
  assert.ok(bar.includes("flex-wrap") && bar.includes("min-w-0") && bar.includes("break-words"), "it must wrap at phone width — the fits-the-screen rule");
  assert.ok(!/\bw-\[\d|min-w-\[\d/.test(bar), "no fixed or minimum width: that is how a horizontal scroll arrives");
  assert.ok(bar.includes("min-h-[36px]"), "a tap target a thumb can hit");
  assert.ok(bar.includes("{ROUTE_STALL_DISMISS_LABEL}") && bar.includes("aria-label"), "a fixed bar the rep cannot dismiss is its own defect");
  assert.ok(bar.includes("{ROUTE_STALL_MESSAGE}") && bar.includes("{ROUTE_STALL_RETRY_LABEL}"), "the words come from the one module, never retyped in the JSX");
  // The three strings are imported, never retyped — so the test's own copies are the shipped ones.
  for (const word of [ROUTE_STALL_MESSAGE, ROUTE_STALL_RETRY_LABEL, ROUTE_STALL_DISMISS_LABEL]) {
    assert.ok(word.trim().length > 0, "every word the bar shows must be a real sentence");
    assert.ok(!bar.includes(`"${word}"`), `the JSX must reference the constant, not repeat "${word}"`);
  }
}
