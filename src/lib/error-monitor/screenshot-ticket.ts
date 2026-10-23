import { createHmac, timingSafeEqual } from "node:crypto";

import { previousAuthSecret } from "@/lib/auth/previous-secret";
import { ERROR_SCREENSHOT_TICKET_TTL_SECONDS } from "@/lib/error-monitor/screenshot-intake";

/**
 * A short-lived capability to attach ONE picture to ONE `app_error_events` row.
 *
 * WHY A TICKET. `/api/errors/client` has to stay unauthenticated — a crash on the login page must
 * still report, and the person it happened to is often not signed in. The picture endpoint inherits
 * that, which would otherwise leave a public, unauthenticated image upload on the production domain.
 * The ticket closes it: the only place a ticket is ever minted is the response to a report that
 * actually wrote a row, so an uploader must first have filed a real error, and the ticket names the
 * exact row the bytes may be attached to. It carries no secret and nothing about the error, so
 * handing it back to the browser that just crashed tells that browser nothing it did not send.
 *
 * Stateless, like the session and share-card signers, and domain-separated from both so a ticket can
 * never be replayed as one of theirs. With no signing secret nothing mints and nothing verifies — the
 * upload simply refuses, which is the correct direction to fail.
 */

type TicketPayload = { v: 1; id: string; exp: number };

function signingSecret(): string | null {
  return process.env.PHOENIX_AUTH_SECRET?.trim() || null;
}

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(`error-screenshot.v1\n${encoded}`).digest("base64url");
}

function signatureMatches(signature: string, expected: string): boolean {
  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
}

/** Mint a ticket for one error row, or null when there is no secret to sign it with. */
export function issueErrorScreenshotTicket(eventId: string, nowSeconds?: number): string | null {
  const secret = signingSecret();
  if (!secret || !eventId) return null;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: TicketPayload = { v: 1, id: eventId, exp: now + ERROR_SCREENSHOT_TICKET_TTL_SECONDS };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

/** The error row id a live ticket names, or null for anything that is not one. */
export function readErrorScreenshotTicket(ticket: string | null | undefined, nowSeconds?: number): string | null {
  if (!ticket || typeof ticket !== "string") return null;
  const [encoded, signature] = ticket.split(".");
  if (!encoded || !signature) return null;

  const secret = signingSecret();
  if (!secret) return null;

  if (!signatureMatches(signature, sign(encoded, secret))) {
    // A ticket minted seconds before a secret rotation is still honoured, on the same terms as every
    // other signer here — its own two-minute expiry bounds it either way.
    const previous = previousAuthSecret(nowSeconds === undefined ? undefined : new Date(nowSeconds * 1000));
    if (!previous || !signatureMatches(signature, sign(encoded, previous))) return null;
  }

  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TicketPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1 || typeof payload.id !== "string" || payload.id.length === 0) return null;
  if (typeof payload.exp !== "number" || payload.exp < (nowSeconds ?? Math.floor(Date.now() / 1000))) return null;
  return payload.id;
}
