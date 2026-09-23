import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The native app can sign in more than once.
 *
 * THE BUG THIS PINS. `POST /api/auth/login` sets `phoenix_session` on every success — the web app
 * needs it. React Native's Android networking persists that Set-Cookie and re-sends it on the NEXT
 * request, so a rep's SECOND sign-in carried the cookie. The proxy's native-client CSRF exemption
 * requires no session cookie (`isNativeClientMutationRequest`, clause 2), so that login fell through
 * to the origin check, which a native app — sending no Origin — fails. The rep saw "Cross-site
 * mutation request blocked." and could not sign in again. Measured against production 2026-09-23.
 *
 * THE FIX, in two halves this file guards:
 *   1. proxy.ts exempts the LOGIN path for any native-declared request, cookie or not. Login
 *      authenticates from the request body, never from a session cookie, so the ambient-authority
 *      risk clause 2 guards against is absent here — and it is scoped to `/api/auth/login` alone, so
 *      every other route keeps the strict no-cookie rule (`native-client-csrf-exemption.test.ts`).
 *   2. the login route CLEARS the three cookies for a native caller instead of setting them, so the
 *      device becomes cookie-free and its later authenticated writes pass the strict rule too.
 */

process.env.PHOENIX_AUTH_SECRET ??= "native-login-csrf-cookie-test-secret";

const { NextRequest } = await import("next/server");
const { proxy } = await import("../proxy.ts");
const { phoenixSessionCookieName } = await import("../src/lib/auth/session-token.ts");
const { phoenixNativeClientHeaderName } = await import("../src/lib/auth/native-session.ts");

const ORIGIN = "https://phoenix-hr.satopharma.com";
const STALE_COOKIE = `${phoenixSessionCookieName}=abc.def.ghi`;

function post(path: string, headers: Record<string, string>) {
  return proxy(new NextRequest(`${ORIGIN}${path}`, { headers: { host: "phoenix-hr.satopharma.com", ...headers }, method: "POST" }));
}

function isBlocked(response: Response) {
  return response.status === 403;
}

function passedThrough(response: Response) {
  return response.headers.get("x-middleware-next") === "1";
}

/** The headline: a native login carrying a stale session cookie is NOT refused. */
function nativeLoginWithCookiePasses() {
  const response = post("/api/auth/login", {
    [phoenixNativeClientHeaderName]: "phoenix-android",
    cookie: STALE_COOKIE,
  });
  assert.equal(
    isBlocked(response),
    false,
    "🔴 a native login carrying the persisted session cookie must reach the route — this is the second-sign-in bug",
  );
  assert.equal(passedThrough(response), true, "and it is let through to the login route, not intervened on");
}

/** A native login with no cookie already worked (the first sign-in) — it must keep working. */
function nativeLoginWithoutCookiePasses() {
  const response = post("/api/auth/login", { [phoenixNativeClientHeaderName]: "phoenix-android" });
  assert.equal(isBlocked(response), false, "a native login with no cookie must pass, as it did before this fix");
  assert.equal(passedThrough(response), true, "and reach the login route");
}

/** The carve-out is login-only: every other native mutation still faces the strict no-cookie rule. */
function nativeNonLoginMutationWithCookieStillBlocked() {
  const response = post("/api/phoenix-crm/plans", {
    [phoenixNativeClientHeaderName]: "phoenix-android",
    cookie: STALE_COOKIE,
  });
  assert.equal(
    isBlocked(response),
    true,
    "🔴 a cookie-bearing native mutation on any route but login must stay refused — the exemption must not widen",
  );
}

/** The carve-out needs the native header: a cookie'd login with no native header and no Origin stays blocked. */
function nonNativeLoginWithCookieStillBlocked() {
  const response = post("/api/auth/login", { cookie: STALE_COOKIE });
  assert.equal(
    isBlocked(response),
    true,
    "a login with a session cookie, no native header and no Origin is a cross-site shape and stays refused",
  );
}

/** Source pins for the two halves of the fix — the behaviour above proves the proxy half only. */
function sourcePinsHold() {
  const proxySource = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(
    proxySource,
    /pathname === "\/api\/auth\/login"\s*&&\s*isNativeClientRequest\(request\.headers\)/,
    "proxy must scope the login CSRF carve-out to the native header",
  );

  const loginRoute = readFileSync(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
  assert.match(
    loginRoute,
    /if \(nativeSession\) \{[\s\S]*?phoenixSessionCookieName[\s\S]*?maxAge: 0[\s\S]*?return response;/,
    "the login route must clear the session cookie (Max-Age=0) for a native caller and return",
  );
  assert.match(
    loginRoute,
    /rejectUntrustedForwardedOrigin\(request\)/,
    "login keeps its own origin check — the defence the proxy carve-out relies on",
  );
}

export function runNativeLoginCsrfCookieTests() {
  nativeLoginWithCookiePasses();
  nativeLoginWithoutCookiePasses();
  nativeNonLoginMutationWithCookieStillBlocked();
  nonNativeLoginWithCookieStillBlocked();
  sourcePinsHold();
}
