import { createHmac, timingSafeEqual } from "crypto";

import { previousAuthSecret } from "@/lib/auth/previous-secret";

/**
 * Signed, expiring one-click-unsubscribe token. Mirrors the session-token signer
 * (HMAC-SHA256 over a base64url payload using PHOENIX_AUTH_SECRET) so we reuse the same
 * trusted signing primitive. Carries the recipient address + notification type + expiry;
 * a tampered or expired token verifies to null.
 */

export type UnsubscribeTokenPayload = {
  addr: string;
  exp: number;
  type: string;
};

const defaultTtlSeconds = 60 * 60 * 24 * 90; // 90 days

function getSecret() {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!secret) throw new Error("PHOENIX_AUTH_SECRET is required for unsubscribe tokens.");
  return secret;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string, secret: string = getSecret()) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function signatureMatches(signature: string, expected: string) {
  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
}

export function createUnsubscribeToken(address: string, type: string, ttlSeconds = defaultTtlSeconds) {
  const payload: UnsubscribeTokenPayload = {
    addr: address.trim().toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    type,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function verifyUnsubscribeToken(
  token: string | null | undefined,
  now: Date = new Date(),
): UnsubscribeTokenPayload | null {
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  if (!signatureMatches(signature, sign(encoded))) {
    // A link mailed before the secret rotation keeps working until the end date in
    // src/lib/auth/previous-secret.ts. New links are always signed with the current secret.
    const previous = previousAuthSecret(now);
    if (!previous || !signatureMatches(signature, sign(encoded, previous))) return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encoded)) as UnsubscribeTokenPayload;
    if (!payload.addr || !payload.type || !payload.exp || payload.exp < Math.floor(now.getTime() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
