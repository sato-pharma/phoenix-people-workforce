import { createHmac, timingSafeEqual } from "crypto";

import { sessionAbsoluteTimeoutSecondsForRole } from "./app-sessions.ts";
import type { PhoenixRole } from "./permissions.ts";

export const phoenixSessionCookieName = "phoenix_session";

export type SessionPayload = {
  exp: number;
  hrId: string | null;
  iat: number;
  loginId: string;
  role: PhoenixRole;
  sid: string;
  ver: number;
};

// Deliberately NO PHOENIX_AUTH_SECRET_PREVIOUS fallback (src/lib/auth/previous-secret.ts): a leaked old secret must never mint or verify a session.
function getSessionSecret() {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();

  if (!secret) {
    throw new Error("PHOENIX_AUTH_SECRET is required for session signing.");
  }

  return secret;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string) {
  return createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
}

export function createSessionToken(input: {
  hrId: string | null;
  loginId: string;
  maxAgeSeconds: number;
  role: PhoenixRole;
  sessionId: string;
  sessionVersion: number;
}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    exp: issuedAt + input.maxAgeSeconds,
    hrId: input.hrId,
    iat: issuedAt,
    loginId: input.loginId,
    role: input.role,
    sid: input.sessionId,
    ver: input.sessionVersion,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

// No separate idle window (owner decision 2026-07-23): a session now stays alive for
// as long as it's open on the same device/browser, bounded only by the absolute
// session lifetime below — not a shorter inactivity cutoff. A prior 15-minute local
// clock was forcing signed-out sessions on anyone who opened a push notification (or
// otherwise returned to the app) more than 15 minutes after their last click. Kept as
// its own function, rather than deleted and inlined, so a future per-role idle policy
// can reintroduce a real distinction here without touching every call site.
export function sessionIdleTimeoutSecondsForRole(role: PhoenixRole) {
  return sessionAbsoluteTimeoutSecondsForRole(role);
}

export function verifySessionToken(token: string | null | undefined): SessionPayload | null {
  if (!token) return null;

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const expected = sign(encodedPayload);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as SessionPayload;
    if (
      !payload.exp ||
      !payload.iat ||
      !payload.loginId ||
      !payload.role ||
      !payload.sid ||
      typeof payload.ver !== "number" ||
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function getCookieValue(cookieHeader: string | null | undefined, name: string) {
  if (!cookieHeader) return null;

  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
