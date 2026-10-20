/**
 * VIEW AS SEAT — the signed cookie that carries the seat the Super Admin is looking at.
 *
 * Owner, 2026-10-20: "View as seat … finish it and merge for me to use". He picks a seat on the live
 * site and sees exactly what it sees, read only. This file is ONLY the token; who may hold one, what it
 * turns a request into and what it refuses live in seat-view.ts.
 *
 * Server-only (it signs with `crypto`); the plain constants live in seat-view-constants.ts.
 *
 *   - Its own format (`sv1.<payload>.<signature>`) and its own key, derived from PHOENIX_AUTH_SECRET
 *     with a fixed label, so a session token or a dev-preview token can never pass as a seat token and a
 *     seat token can never pass as a session token. The two kinds cannot be confused in either direction.
 *   - It never stands alone. It names the owner's live session (`ownerSid`) and login, and seat-view.ts
 *     honours it only on top of that exact session — sign out, or sign in elsewhere, and it is dead.
 *   - One hour, fixed, never refreshed: a view nobody remembers to leave ends by itself.
 */

import { createHmac, timingSafeEqual } from "crypto";

import { SEAT_VIEW_TTL_SECONDS } from "./seat-view-constants.ts";

const TOKEN_PREFIX = "sv1";
const KEY_LABEL = "phoenix-seat-view-v1";

export type SeatViewTokenPayload = {
  /** The seat being viewed. */
  role: string;
  /** The person being viewed — a portal seat only; null for an office seat viewed by role. */
  hrId: string | null;
  personName: string | null;
  /** The owner's login id and live session id: the view is honoured on top of that session only. */
  ownerLoginId: string;
  ownerSid: string;
  iat: number;
  exp: number;
};

function seatViewKey(): Buffer {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!secret) throw new Error("PHOENIX_AUTH_SECRET is required for seat view signing.");
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

function sign(value: string): string {
  return createHmac("sha256", seatViewKey()).update(value).digest("base64url");
}

export function createSeatViewToken(input: {
  role: string;
  hrId: string | null;
  personName: string | null;
  ownerLoginId: string;
  ownerSid: string;
  nowSeconds?: number;
}): { token: string; payload: SeatViewTokenPayload } {
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: SeatViewTokenPayload = {
    role: input.role,
    hrId: input.hrId,
    personName: input.personName,
    ownerLoginId: input.ownerLoginId,
    ownerSid: input.ownerSid,
    iat,
    exp: iat + SEAT_VIEW_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const body = `${TOKEN_PREFIX}.${encoded}`;
  return { token: `${body}.${sign(body)}`, payload };
}

export function verifySeatViewToken(
  token: string | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SeatViewTokenPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const body = `${parts[0]}.${parts[1]}`;

  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return null;
  }
  const received = Buffer.from(parts[2]);
  const wanted = Buffer.from(expected);
  if (received.length !== wanted.length || !timingSafeEqual(received, wanted)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as SeatViewTokenPayload;
    if (
      typeof payload.role !== "string" || !payload.role ||
      typeof payload.ownerLoginId !== "string" || !payload.ownerLoginId ||
      typeof payload.ownerSid !== "string" || !payload.ownerSid ||
      typeof payload.iat !== "number" || typeof payload.exp !== "number" ||
      payload.exp - payload.iat > SEAT_VIEW_TTL_SECONDS ||
      payload.exp <= nowSeconds
    ) {
      return null;
    }
    return {
      role: payload.role,
      hrId: typeof payload.hrId === "string" && payload.hrId ? payload.hrId : null,
      personName: typeof payload.personName === "string" && payload.personName ? payload.personName : null,
      ownerLoginId: payload.ownerLoginId,
      ownerSid: payload.ownerSid,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}
