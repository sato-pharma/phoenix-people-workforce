import { createHmac, timingSafeEqual } from "crypto";

import { createAccessContext, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";

export const phoenixSessionCookieName = "phoenix_session";

export type SessionPayload = {
  authUserId: string | null;
  exp: number;
  hrId: string | null;
  iat: number;
  loginId: string;
  maxExp: number;
  role: PhoenixRole;
  sid: string;
  ver: number;
};

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
  authUserId: string | null;
  hrId: string | null;
  loginId: string;
  maxAgeSeconds: number;
  role: PhoenixRole;
  sessionId: string;
  sessionVersion: number;
}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    authUserId: input.authUserId,
    exp: issuedAt + input.maxAgeSeconds,
    hrId: input.hrId,
    iat: issuedAt,
    loginId: input.loginId,
    maxExp: issuedAt + input.maxAgeSeconds,
    role: input.role,
    sid: input.sessionId,
    ver: input.sessionVersion,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload)}`;
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
      typeof payload.maxExp !== "number" ||
      !payload.role ||
      !payload.sid ||
      typeof payload.ver !== "number" ||
      payload.exp < Math.floor(Date.now() / 1000) ||
      payload.maxExp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function accessContextFromSessionToken(token: string | null | undefined): AccessContext | null {
  const payload = verifySessionToken(token);
  if (!payload) return null;

  return createAccessContext({
    hrId: payload.hrId,
    loginId: payload.loginId,
    role: payload.role,
    source: "session",
  });
}

export function getCookieValue(cookieHeader: string | null | undefined, name: string) {
  if (!cookieHeader) return null;

  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
