import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { PhoenixRole } from "./permissions.ts";
import { createSessionToken, verifySessionToken } from "./session-token.ts";

/**
 * Opening a production portal module from inside the native app, already signed in.
 *
 * WHY THIS EXISTS. The app carries its session as a bearer token (`native-session.ts`); the web
 * portal carries the SAME signed token in the HttpOnly `phoenix_session` cookie. Most of the portal
 * — 60-odd modules — has no native screen and is opened as the real production page, so that page
 * has to arrive signed in. A browser cannot be handed an `Authorization` header, and asking a rep to
 * type his password a second time to read his own plan is not a design, it is a support call.
 *
 * So the app asks this server for a one-trip ticket, and opens
 * `/api/auth/web-session?ticket=…&next=/employee-portals/plans`. The route redeems the ticket, sets
 * the ordinary session cookie, and redirects to the module. From that second onward the browser is
 * an ordinary signed-in browser and the page is the production page, unmodified.
 *
 * 🔴 THE COOKIE MUST NEVER REACH THE APP'S OWN FETCH. This is not a style point: React Native's
 * Android networking persists Set-Cookie and replays it, and a `phoenix_session` cookie riding the
 * app's requests makes the CSRF guard read them as a browser session and refuse every mutation
 * (`csrf_blocked`, measured against production 2026-09-23 — which is why `/api/auth/login` actively
 * CLEARS all three cookies for a native caller). Two things keep that from happening again:
 *
 *   - Minting is a POST the app makes with its bearer token, and that response carries NO cookie.
 *   - Redeeming is a GET the BROWSER makes, never the app — an in-app Chrome tab with its own cookie
 *     jar. The app's fetch never touches this route, so there is nothing for it to keep.
 *
 * An embedded `react-native-webview` would break exactly that separation on Android, where the
 * WebView's `CookieManager` is the same jar React Native's own networking reads. That is a hard
 * reason to render these modules in the system browser tab rather than a WebView, not a preference.
 *
 * WHAT THE TICKET IS. An AES-256-GCM sealed blob, keyed from `PHOENIX_AUTH_SECRET` — the primitive
 * the session, unsubscribe and payroll-acknowledgement signers already use — carrying the session's
 * `sid`, `ver`, identity and its ORIGINAL expiry, valid for sixty seconds. Sealed rather than merely
 * signed so no name, HR id or role ever appears in a URL, a browser history row or a server log.
 *
 * WHAT IT GRANTS. Nothing new. Redeeming mints a cookie for the SAME `sid` and `ver` the app already
 * holds, expiring at the same second, so:
 *
 *   - no second `app_sessions` row exists, and none is created;
 *   - "Log out everywhere" kills the browser tab and the app together, as it does today;
 *   - the cookie cannot outlive the app's own token — the remaining lifetime is carried in the
 *     ticket and used verbatim, never recalculated from the role's full timeout.
 *
 * Stateless on purpose, like `acknowledgment-token.ts`: no table, no migration, nothing to clean up.
 * The cost of statelessness is that a ticket is not single-use — it is redeemable for its sixty
 * seconds. That is bounded by encryption (it cannot be forged or read), by the TTL, and by where it
 * lives: the device that already holds the full session token in its own keystore.
 */

/** Sixty seconds: long enough for a cold browser tab to open, too short to be worth capturing. */
export const NATIVE_WEB_HANDOFF_TTL_SECONDS = 60;

/** Domain separation — this key derivation is used for nothing else, so a blob cannot be replayed elsewhere. */
const KEY_PURPOSE = "phoenix.native-web-handoff.v1";

/** Only the employee portal is reachable this way. Admin-shell routes are not offered by the app. */
export const NATIVE_WEB_HANDOFF_HOME = "/employee-portals";

/**
 * Marks a browser context as the native app's WebView, so the portal renders in "app mode" — its own
 * fixed header and bottom nav suppressed, because the native shell provides that navigation itself.
 *
 * 🔴 THIS IS A DISPLAY HINT, NOT A CREDENTIAL, AND IT GRANTS NOTHING. Set only by the GET half of the
 * hand-off, which is the one path the app enters the portal through, so an ordinary browser never
 * carries it and the web portal is byte-identical without it. It is deliberately NOT HttpOnly — no
 * secret rides in it, the value is the literal `1` — and it is read server-side by the portal shell
 * to decide chrome only. A forged cookie changes only whether one browser sees the portal's own top
 * bar; it moves no data and reaches no route the session could not already reach.
 */
export const NATIVE_WEB_APP_SHELL_COOKIE = "phoenix_app_shell";

export type NativeWebHandoffClaims = {
  /** Seconds since the epoch at which the APP's own token expires — the cookie inherits it exactly. */
  sessionExpiresAt: number;
  hrId: string | null;
  loginId: string;
  role: PhoenixRole;
  sessionId: string;
  sessionVersion: number;
};

type SealedPayload = NativeWebHandoffClaims & {
  /** Seconds since the epoch at which the TICKET stops being redeemable. */
  exp: number;
};

function sealingKey(): Buffer {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("PHOENIX_AUTH_SECRET is required to open a portal module from the app.");
  }
  return createHash("sha256").update(`${KEY_PURPOSE}\n${secret}`).digest();
}

/**
 * Turn the app's own bearer token into a ticket.
 *
 * Returns null when the token is not a valid, unexpired Phoenix session. It deliberately does NOT
 * check the `app_sessions` row: the caller has already resolved a full access context to get here,
 * and the cookie this ticket becomes is checked against that row on its very first page load — a
 * revoked session's tab is refused there, by the same code that refuses the app.
 */
export function issueNativeWebHandoffTicket(sessionToken: string | null | undefined): string | null {
  const payload = verifySessionToken(sessionToken);
  if (!payload) return null;

  const now = Math.floor(Date.now() / 1000);
  const sealed: SealedPayload = {
    exp: now + NATIVE_WEB_HANDOFF_TTL_SECONDS,
    hrId: payload.hrId,
    loginId: payload.loginId,
    role: payload.role,
    sessionExpiresAt: payload.exp,
    sessionId: payload.sid,
    sessionVersion: payload.ver,
  };

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(sealed), "utf8")),
    cipher.final(),
  ]);

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/** Open a ticket. Returns null for anything tampered with, malformed, or past either expiry. */
export function redeemNativeWebHandoffTicket(ticket: string | null | undefined): NativeWebHandoffClaims | null {
  if (typeof ticket !== "string" || ticket.trim().length === 0) return null;

  let sealed: SealedPayload;
  try {
    const raw = Buffer.from(ticket.trim(), "base64url");
    // 12-byte IV + 16-byte GCM tag + at least one byte of ciphertext.
    if (raw.length < 29) return null;

    // authTagLength pins the tag at the full 16 bytes, so a shortened tag is refused rather than checked.
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(), raw.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    sealed = JSON.parse(plaintext.toString("utf8")) as SealedPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    typeof sealed.exp !== "number" ||
    typeof sealed.sessionExpiresAt !== "number" ||
    typeof sealed.sessionId !== "string" ||
    sealed.sessionId.length === 0 ||
    typeof sealed.sessionVersion !== "number" ||
    typeof sealed.loginId !== "string" ||
    sealed.loginId.length === 0 ||
    !sealed.role ||
    sealed.exp <= now ||
    // The app's own session has run out: there is nothing left to hand over.
    sealed.sessionExpiresAt <= now
  ) {
    return null;
  }

  return {
    hrId: sealed.hrId ?? null,
    loginId: sealed.loginId,
    role: sealed.role,
    sessionExpiresAt: sealed.sessionExpiresAt,
    sessionId: sealed.sessionId,
    sessionVersion: sealed.sessionVersion,
  };
}

/**
 * The cookie the browser tab gets: the same session, expiring at the same second.
 *
 * Never `sessionIdleTimeoutSecondsForRole` — that would hand the tab a FRESH full lifetime and let a
 * browser outlive the app session it was opened from.
 */
export function nativeWebHandoffCookie(claims: NativeWebHandoffClaims): {
  maxAgeSeconds: number;
  token: string;
} {
  const maxAgeSeconds = Math.max(1, claims.sessionExpiresAt - Math.floor(Date.now() / 1000));

  return {
    maxAgeSeconds,
    token: createSessionToken({
      hrId: claims.hrId,
      loginId: claims.loginId,
      maxAgeSeconds,
      role: claims.role,
      sessionId: claims.sessionId,
      sessionVersion: claims.sessionVersion,
    }),
  };
}

/**
 * The destination, or the portal home when it is anything else.
 *
 * Strict by design, and the strictness is the point: this value arrives in a query string, and the
 * response is a redirect carrying a freshly set session cookie. An open redirect here would be a
 * session-handoff to somebody else's host. So: one leading slash (two would name an authority),
 * under `/employee-portals`, and nothing a browser would reinterpret — no backslash, whitespace or
 * control character, and no `..` segment.
 */
export function safeNativeWebHandoffNext(next: string | null | undefined): string {
  if (typeof next !== "string") return NATIVE_WEB_HANDOFF_HOME;

  const value = next.trim();
  if (value.length === 0 || value.length > 512) return NATIVE_WEB_HANDOFF_HOME;
  if (!value.startsWith("/") || value.startsWith("//")) return NATIVE_WEB_HANDOFF_HOME;
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return NATIVE_WEB_HANDOFF_HOME;

  const [path] = value.split(/[?#]/, 1);
  if (!path) return NATIVE_WEB_HANDOFF_HOME;
  if (path !== NATIVE_WEB_HANDOFF_HOME && !path.startsWith(`${NATIVE_WEB_HANDOFF_HOME}/`)) {
    return NATIVE_WEB_HANDOFF_HOME;
  }
  if (path.split("/").includes("..")) return NATIVE_WEB_HANDOFF_HOME;

  return value;
}
