import { randomUUID } from "crypto";

import {
  createSessionToken,
  verifySessionToken,
} from "./session-token.ts";
import {
  createAccessContext,
  parseRoleStrict,
  type AccessContext,
  type PhoenixRole,
} from "./permissions.ts";

export const phoenixDevPreviewCookieName = "phoenix_dev_preview";
const devPreviewSessionSeconds = 8 * 60 * 60;
const devPreviewSessionPrefix = "dev-preview:";
// A TEST ACCOUNT opened through the dev sign-in (`/api/dev-auth?testLogin=TEST-…`). The prefix IS the
// test marker: the token is signed, so it cannot be added to an ordinary preview, and it still starts
// with `dev-preview:`, so every place that honours a preview honours this one. The owner, 2026-09-30:
// "open a rep account … test aya" — a dev preview under the real hr id acted as the REAL person.
const devPreviewTestPrefix = "dev-preview:test:";

export function createDevPreviewSessionToken(input: {
  hrId: string | null;
  loginId: string;
  role: PhoenixRole;
  /** True for a test account: `hrId` is then the person it MIRRORS and `loginId` its own `TEST-…` login. */
  testPersona?: boolean;
}) {
  return createSessionToken({
    hrId: input.hrId,
    loginId: input.loginId,
    maxAgeSeconds: devPreviewSessionSeconds,
    role: input.role,
    sessionId: `${input.testPersona ? devPreviewTestPrefix : devPreviewSessionPrefix}${randomUUID()}`,
    sessionVersion: 0,
  });
}

export function devPreviewCookieMaxAgeSeconds() {
  return devPreviewSessionSeconds;
}

function isLoopbackHostname(hostname: string | null | undefined) {
  const normalized = hostname?.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === "localhost" || hostname === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function hostnameFromHeader(value: string | null) {
  const first = value?.split(",")[0]?.trim();
  if (!first) return null;
  const withoutPort = first.startsWith("[")
    ? first.slice(1, first.indexOf("]"))
    : first.split(":")[0];
  return withoutPort || null;
}

/** True only for a request hitting a loopback hostname while NODE_ENV=development — the same gate `/api/dev-auth` uses to stay unreachable outside local dev. Shared here so every dev-preview entry point (the bootstrap route and the Super-Admin "preview as role" picker) enforces the identical rule. */
export function isLocalDevelopmentRequest(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return false;
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  const hostHeader = hostnameFromHeader(request.headers.get("host"));
  const forwardedHost = hostnameFromHeader(request.headers.get("x-forwarded-host"));

  return [hostname, hostHeader, forwardedHost].some(isLoopbackHostname);
}

/** One person, however the HR id is written: `pd-0014`, `PD-0014` and `PD0014` share a key. */
function devPreviewPersonKey(value: string | null | undefined) {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * True when a request to launch a preview asks for the preview this session is ALREADY in — the
 * same role, as the same person. `/api/dev-auth/preview` answers that with the landing page the
 * first launch was heading to, instead of refusing it.
 *
 * Why it exists: on 2026-09-21 the Super Admin launched a Medical Rep preview from
 * `/admin/dev-preview` and landed on a raw `{"error":"forbidden"}` page — twice, in two dev-server
 * runs, with the identical trace each time: preview 307, dev-auth 307, "Compiling /employee-portals"
 * (30 to 60 seconds on this laptop, while the route-transition bar gives up after 9), then the SAME
 * preview address again, answered 403. The launch is three hops, and its first two replace the
 * caller: the preview route deletes the real session, and dev-auth sets the preview cookie. So a
 * second click on the still-visible button, or a reload of the still-pending address, reached the
 * preview route wearing the Medical Rep it had just minted, failed its Super Admin gate, and the 403
 * replaced the portal the first click was loading. The launch was not safe to repeat, and on a slow
 * first compile it is always repeated.
 */
export function isDevPreviewReplay(
  current: { hrId: string | null; role: PhoenixRole },
  requested: { hrId: string; role: PhoenixRole },
): boolean {
  const key = devPreviewPersonKey(requested.hrId);
  return key !== "" && current.role === requested.role && devPreviewPersonKey(current.hrId) === key;
}

/**
 * The role a preview of a REAL person has to wear: the one that person actually signs in with.
 *
 * Returns that role when `requestedRole` is not one of theirs, and null when the preview is fine —
 * either one of the hrId's active logins holds `requestedRole`, or the hrId has no active login at
 * all (a role-only or synthetic preview, such as `PHASE23-DM`, which shows nobody's real account).
 * Keys compare without case or punctuation, so `pd-0014`, `PD-0014` and `PD0014` are one person.
 *
 * Why it exists: on 2026-09-21 a preview opened as a Pedia District Manager with `role=Medical Rep`
 * rendered a medical rep's command center under his real name, with no team on it, and was read as
 * his account being broken — while every one of his real sign-ins had been as a District Manager.
 * A preview under a real name must never show that person a dashboard that is not theirs.
 */
export function devPreviewRoleMismatch(
  requestedRole: PhoenixRole,
  hrId: string,
  activeLogins: ReadonlyArray<{ hrId: string | null; role: PhoenixRole }>,
): PhoenixRole | null {
  const key = devPreviewPersonKey(hrId);
  if (!key) return null;
  const held = activeLogins.filter((login) => devPreviewPersonKey(login.hrId) === key).map((login) => login.role);
  if (held.length === 0 || held.includes(requestedRole)) return null;
  return held[0];
}

export function accessContextFromDevPreviewToken(
  token: string | null | undefined,
): AccessContext | null {
  const payload = verifySessionToken(token);
  if (!payload || !payload.sid.startsWith(devPreviewSessionPrefix) || payload.ver !== 0) {
    return null;
  }

  // A test account reads as the person it mirrors and carries the link every test-account guard reads
  // (src/lib/auth/test-persona.ts), exactly as a real `TEST-…` sign-in does. One with no mirror opens
  // nothing: it would otherwise be a preview as nobody that the guards still treat as a test account.
  const testPersona = payload.sid.startsWith(devPreviewTestPrefix);
  if (testPersona && !payload.hrId) {
    return null;
  }

  return createAccessContext({
    hrId: payload.hrId,
    loginId: payload.loginId,
    role: parseRoleStrict(payload.role),
    source: "dev-header",
    testPersona: testPersona ? { loginId: payload.loginId, mirrorsHrId: payload.hrId as string } : null,
  });
}
