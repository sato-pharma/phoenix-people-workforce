/**
 * A TEST ACCOUNT'S SAVE RUNS FULLY AND SAVES NOTHING — the decision half (owner, 2026-11-06: "make the
 * test account everything in it as the real … never I see you are blocked … every export, anything, but
 * on the test data", answered "Runs fully, saves nothing").
 *
 * Until this date a test account's save outside Phoenix CRM was refused before the route ran
 * (TEST_ACCOUNT_SAVE_REFUSAL, test-persona.ts). Now it is let through MARKED, and the mark makes every
 * write the route attempts land nowhere: src/lib/auth/test-dry-run.ts answers each database write and
 * each outgoing message in the server itself, so every check the route makes runs on the real data and
 * no row, file, email, Telegram or push leaves as the person the test account mirrors.
 *
 * Three pieces read this file, and all three must agree, so the rule lives here once:
 *   - proxy.ts MARKS the request (`TEST_DRY_RUN_HEADER`) — after deleting whatever copy the browser sent;
 *   - resolveAccessContext (server.ts) LETS a marked test-account write run instead of refusing it;
 *   - the fetch fence (test-dry-run.ts) FAKES every write of a marked request.
 *
 * The mark alone proves nothing — a browser can send any header to a route the proxy does not match —
 * so every reader also verifies the session cookie's signature and its `TEST-` login. A real person
 * who forges the header gets nothing: no test login, no dry run, the ordinary route.
 *
 * Pure: no Next.js import, so the proxy bundle and the unit tests can both load it.
 */

import { phoenixSessionCookieName, getCookieValue, verifySessionToken } from "./session-token.ts";
import { TEST_ACCOUNT_LOGIN_PREFIX, testAccountMayRun } from "./test-persona.ts";
import { TEST_DRY_RUN_HEADER } from "./test-dry-run-words.ts";

export { TEST_DRY_RUN_HEADER, TEST_DRY_RUN_NOTICE, TEST_DRY_RUN_RESPONSE_HEADER } from "./test-dry-run-words.ts";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Where the last mark was set, shared across the proxy and route bundles of one server process. */
const LAST_MARK_KEY = Symbol.for("phoenix.testDryRun.lastMarkAt");

type HeaderBag = { get(name: string): string | null };

/** The signed session cookie names a test account (`TEST-…` login), or it does not. */
export function sessionCookieIsTestAccount(cookieHeader: string | null | undefined): boolean {
  const payload = verifySessionToken(getCookieValue(cookieHeader, phoenixSessionCookieName));
  return Boolean(payload?.loginId && String(payload.loginId).toUpperCase().startsWith(TEST_ACCOUNT_LOGIN_PREFIX));
}

/**
 * Whether proxy.ts marks this request: a write, from a test account's signed session, to a path the
 * test account may NOT write to for real. Phoenix CRM (its own test world), sign-in and the expense
 * dry run keep their own paths and are never marked.
 */
export function proxyMarksTestDryRun(method: string, pathname: string, cookieHeader: string | null | undefined): boolean {
  const verb = String(method || "GET").toUpperCase();
  if (READ_METHODS.has(verb)) return false;
  if (testAccountMayRun(verb, pathname)) return false;
  return sessionCookieIsTestAccount(cookieHeader);
}

/** Whether a request (its headers) is a marked test-account dry run. Both halves are required. */
export function requestIsTestDryRun(requestHeaders: HeaderBag | null | undefined): boolean {
  if (!requestHeaders) return false;
  if (requestHeaders.get(TEST_DRY_RUN_HEADER) !== "1") return false;
  return sessionCookieIsTestAccount(requestHeaders.get("cookie"));
}

/** Recorded on every mark and every grant, so the fence asks for headers only while test work is live. */
export function noteTestDryRunSeen(now = Date.now()): void {
  (globalThis as Record<symbol, unknown>)[LAST_MARK_KEY] = now;
}

/** True while a test-account dry run was marked in this process in the last 30 minutes. */
export function testDryRunRecentlySeen(now = Date.now()): boolean {
  const at = (globalThis as Record<symbol, unknown>)[LAST_MARK_KEY];
  return typeof at === "number" && now - at < 30 * 60 * 1000;
}
