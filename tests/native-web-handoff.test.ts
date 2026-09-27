import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NATIVE_WEB_HANDOFF_TTL_SECONDS,
  issueNativeWebHandoffTicket,
  nativeWebHandoffCookie,
  redeemNativeWebHandoffTicket,
  safeNativeWebHandoffNext,
} from "../src/lib/auth/native-web-handoff.ts";
import { createSessionToken, verifySessionToken } from "../src/lib/auth/session-token.ts";

/**
 * The hand-off that opens a production portal module from inside the Android app, signed in.
 *
 * The app carries its session as a bearer token; the web carries the same signed token in a cookie. A
 * browser tab cannot be handed a header, so the app mints a sealed sixty-second ticket and the tab
 * redeems it for the ordinary session cookie. Four properties make that safe rather than a second
 * login route, and each is pinned below:
 *
 *   1. It grants NOTHING NEW — the cookie is for the same `sid` and `ver`, expiring at the same
 *      second, so "Log out everywhere" still ends both at once and no second session row exists.
 *   2. It cannot OUTLIVE the app's session. A cookie minted with a fresh role-length lifetime would
 *      leave a signed-in browser behind an app that had already lapsed.
 *   3. It carries NO PERSONAL DATA IN THE URL. Sealed with AES-GCM, not merely signed, so no name, HR
 *      id or role appears in an address bar, a history row or a log.
 *   4. `next` CANNOT LEAVE THE PORTAL. The response is a redirect carrying a freshly set session
 *      cookie, so an open redirect here would be a session hand-off to somebody else's host.
 */

const ROLE = "Medical Rep" as const;

function aSession(overrides: { maxAgeSeconds?: number } = {}) {
  return createSessionToken({
    hrId: "B-10",
    loginId: "b-10",
    maxAgeSeconds: overrides.maxAgeSeconds ?? 12 * 60 * 60,
    role: ROLE,
    sessionId: "session-under-test",
    sessionVersion: 7,
  });
}

/** Run `body` as though the clock had moved on by `seconds`. */
function atFuture<T>(seconds: number, body: () => T): T {
  const realNow = Date.now;
  Date.now = () => realNow() + seconds * 1000;
  try {
    return body();
  } finally {
    Date.now = realNow;
  }
}

export function runNativeWebHandoffTests() {
  // The suite normally has the real secret; a bare checkout should still be able to run this file.
  if (!process.env.PHOENIX_AUTH_SECRET?.trim()) {
    process.env.PHOENIX_AUTH_SECRET = "native-web-handoff-test-secret";
  }

  // ── 1. The ticket round-trips, and grants the same session ─────────────────────────────────────
  const sessionToken = aSession();
  const sessionPayload = verifySessionToken(sessionToken);
  assert.ok(sessionPayload, "the fixture session token must itself be valid");

  const ticket = issueNativeWebHandoffTicket(sessionToken);
  assert.ok(ticket && ticket.length > 0, "a live session mints a ticket");

  const claims = redeemNativeWebHandoffTicket(ticket);
  assert.ok(claims, "the ticket redeems");
  assert.equal(claims.sessionId, sessionPayload.sid, "the SAME session, so nothing new is created");
  assert.equal(claims.sessionVersion, sessionPayload.ver, "and the same version, so a bump still kills it");
  assert.equal(claims.role, ROLE);
  assert.equal(claims.loginId, "b-10");
  assert.equal(claims.hrId, "B-10");
  assert.equal(claims.sessionExpiresAt, sessionPayload.exp, "the app session's own expiry travels with it");

  // No identity in the URL: the ticket is sealed, not merely signed.
  const decoded = Buffer.from(ticket, "base64url").toString("latin1");
  for (const secret of ["B-10", "b-10", ROLE, "session-under-test"]) {
    assert.ok(
      !decoded.includes(secret),
      `the ticket must not carry ${secret} in readable form — it ends up in a browser history row`,
    );
  }

  // ── 2. The cookie inherits the app session's expiry, never a fresh one ─────────────────────────
  const cookie = nativeWebHandoffCookie(claims);
  const remaining = sessionPayload.exp - Math.floor(Date.now() / 1000);
  assert.ok(
    Math.abs(cookie.maxAgeSeconds - remaining) <= 2,
    `the cookie lives as long as the app session has left (${cookie.maxAgeSeconds} vs ${remaining})`,
  );
  const cookiePayload = verifySessionToken(cookie.token);
  assert.ok(cookiePayload, "the cookie carries a valid Phoenix session token");
  assert.equal(cookiePayload.sid, sessionPayload.sid, "one session, two carriers");
  assert.equal(cookiePayload.ver, sessionPayload.ver);
  assert.ok(
    cookiePayload.exp <= sessionPayload.exp,
    "the browser can never outlive the app session it was opened from",
  );

  // ── 3. Nothing else redeems ────────────────────────────────────────────────────────────────────
  for (const nothing of [null, undefined, "", "   ", "not-a-ticket", "a".repeat(64)]) {
    assert.equal(redeemNativeWebHandoffTicket(nothing as string), null, "garbage redeems to nothing");
  }

  // One flipped byte in the ciphertext: GCM's tag refuses it rather than handing back altered claims.
  const raw = Buffer.from(ticket, "base64url");
  const tampered = Buffer.from(raw);
  tampered[tampered.length - 1] ^= 0xff;
  assert.equal(
    redeemNativeWebHandoffTicket(tampered.toString("base64url")),
    null,
    "a tampered ticket is refused, never partially trusted",
  );

  // A ticket past its sixty seconds, and one whose underlying session has since lapsed.
  assert.equal(
    atFuture(NATIVE_WEB_HANDOFF_TTL_SECONDS + 5, () => redeemNativeWebHandoffTicket(ticket)),
    null,
    "a ticket stops being redeemable after its TTL",
  );
  const shortSession = aSession({ maxAgeSeconds: 120 });
  const shortTicket = issueNativeWebHandoffTicket(shortSession);
  assert.ok(shortTicket, "a short-lived session still mints");
  assert.equal(
    atFuture(300, () => redeemNativeWebHandoffTicket(shortTicket)),
    null,
    "and stops redeeming once the app's own session has run out, even inside the ticket's TTL",
  );

  // An expired or forged bearer token mints nothing at all.
  assert.equal(issueNativeWebHandoffTicket(null), null);
  assert.equal(issueNativeWebHandoffTicket("nonsense.signature"), null);
  assert.equal(
    atFuture(300, () => issueNativeWebHandoffTicket(shortSession)),
    null,
    "an expired session cannot mint a ticket",
  );

  // ── 4. `next` cannot leave the portal ──────────────────────────────────────────────────────────
  const HOME = "/employee-portals";
  for (const allowed of [
    "/employee-portals",
    "/employee-portals/plans",
    "/employee-portals/plans/calendar",
    "/employee-portals/reps-list/call-rate/b-10",
    "/employee-portals/marketing-requests/inbox?tab=pending",
    "/employee-portals/kpis#coverage",
  ]) {
    assert.equal(safeNativeWebHandoffNext(allowed), allowed, `${allowed} is a portal destination`);
  }

  for (const refused of [
    "//evil.example/employee-portals",
    "https://evil.example/employee-portals",
    "http://phoenix-hr.satopharma.com/employee-portals",
    "/admin/automated-payroll",
    "/api/auth/login",
    "/login",
    "/employee-portalsnot-a-module",
    "/employee-portals/../admin",
    "\\employee-portals",
    "/employee-portals\\..\\admin",
    "/employee portals",
    `/employee-portals${String.fromCharCode(0)}`,
    `/employee-portals${String.fromCharCode(0x7f)}`,
    "javascript:alert(1)",
    "employee-portals/plans",
    `/employee-portals/${"a".repeat(600)}`,
    "",
    "   ",
  ]) {
    assert.equal(
      safeNativeWebHandoffNext(refused),
      HOME,
      `${JSON.stringify(refused)} must fall back to the portal home rather than being redirected to`,
    );
  }
  for (const nothing of [null, undefined, 42, {}]) {
    assert.equal(safeNativeWebHandoffNext(nothing as unknown as string), HOME);
  }

  // ── 5. Which half sets a cookie, and which must never ──────────────────────────────────────────
  // 🔴 The POST is the half the APP calls. React Native's Android networking persists Set-Cookie and
  // replays it, and a `phoenix_session` cookie riding the app's own requests is read by the CSRF guard
  // as a browser session and refused — every mutation comes back `csrf_blocked` (measured against
  // production 2026-09-23, which is why the login route actively CLEARS cookies for a native caller).
  const route = readFileSync("app/api/auth/web-session/route.ts", "utf8");
  const postHalf = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function GET"));
  const getHalf = route.slice(route.indexOf("export async function GET"));

  assert.ok(postHalf.length > 0 && getHalf.length > 0, "the route still has both halves");
  assert.ok(
    !/cookies\.set/.test(postHalf),
    "the POST half must set NO cookie: the app would keep it and every later mutation would be refused as csrf_blocked",
  );
  assert.match(
    postHalf,
    /assertPermission\(access,\s*"employee_profile",\s*"read"\)/,
    "a caller who cannot open the portal cannot be handed a ticket into it",
  );
  assert.match(
    postHalf,
    /bearerTokenFromRequest\(request\)/,
    "only a bearer caller mints — a browser already has a session, and handing page JavaScript a redeemable credential is what the HttpOnly cookie exists to prevent",
  );
  assert.match(getHalf, /cookies\.set\(\{/, "the GET half sets the session cookie for the browser tab");
  assert.match(getHalf, /httpOnly:\s*true/, "and it stays HttpOnly, as the web login's own cookie is");
  assert.match(getHalf, /cache-control/, "a redirect carrying one person's Set-Cookie is never cached");
  assert.match(
    getHalf,
    /new URL\("\/login", origin\)/,
    "an expired or tampered ticket lands on the ordinary login page, not an API error",
  );

  // The mobile side must keep using a system browser tab. On Android a WebView shares its cookie jar
  // with React Native's own networking, which is the csrf_blocked fault above, by another door.
  const opener = readFileSync("mobile/src/lib/portal/open-module.ts", "utf8");
  assert.match(opener, /expo-web-browser/, "the module opens in a Custom Tab");
  // Comments stripped: that file's header explains at length WHY a WebView is wrong here, and a scan
  // that reads its own explanation as the defect is a check that can only ever fail.
  const openerCode = opener.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(
    !/webview/i.test(openerCode),
    "never a WebView: on Android its cookie jar is the app's own, so the handed-over session cookie would reach the app's fetch and break every mutation",
  );
  assert.match(
    opener,
    /url\.startsWith\(`\$\{apiBaseUrl\}\//,
    "the app opens the hand-off URL only when it is on the server this build talks to",
  );
}
