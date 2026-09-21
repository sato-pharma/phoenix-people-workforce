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

export function createDevPreviewSessionToken(input: {
  hrId: string | null;
  loginId: string;
  role: PhoenixRole;
}) {
  return createSessionToken({
    hrId: input.hrId,
    loginId: input.loginId,
    maxAgeSeconds: devPreviewSessionSeconds,
    role: input.role,
    sessionId: `${devPreviewSessionPrefix}${randomUUID()}`,
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
  const personKey = (value: string | null | undefined) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const key = personKey(hrId);
  if (!key) return null;
  const held = activeLogins.filter((login) => personKey(login.hrId) === key).map((login) => login.role);
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

  return createAccessContext({
    hrId: payload.hrId,
    loginId: payload.loginId,
    role: parseRoleStrict(payload.role),
    source: "dev-header",
  });
}
