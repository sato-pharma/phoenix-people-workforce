import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { previousAuthSecret } from "@/lib/auth/previous-secret";

/**
 * THE ONE-TIME WHATSAPP CONNECT LINK (S01, F-PLT-008, 13 Nov 2026; owner's choice: "One-time link").
 *
 * /whatsapp-connect runs on the handset whose WhatsApp Business number is being connected, and that
 * phone has no Phoenix session. So a Super Admin makes the link from Inbound CV Intake Health, and the
 * link carries this ticket in its #fragment (never sent to a server log). The exchange route finishes a
 * connection only for a live ticket, and spends it there: one link, one connection, within 30 minutes.
 *
 * Stateless and signed with PHOENIX_AUTH_SECRET, domain-separated from every other signer so a ticket
 * can never be replayed as one of theirs. With no secret nothing mints and nothing verifies, so the
 * exchange refuses — the correct direction to fail. Spending is the shared rate-limit store (scope
 * WHATSAPP_CONNECT_LINK_SCOPE, a limit of one per ticket nonce), which fails closed.
 */

export const WHATSAPP_CONNECT_LINK_TTL_SECONDS = 30 * 60;
/** The rate-limit scope a ticket is spent in — one use per nonce. */
export const WHATSAPP_CONNECT_LINK_SCOPE = "whatsapp-connect-link";
/** The fragment key the page reads the ticket from: /whatsapp-connect#link=<ticket>. */
export const WHATSAPP_CONNECT_LINK_FRAGMENT = "link";

type ConnectLinkPayload = { v: 1; n: string; by: string; exp: number };

export type WhatsAppConnectLink = { nonce: string; madeBy: string; expiresAt: number };

function signingSecret(): string | null {
  return process.env.PHOENIX_AUTH_SECRET?.trim() || null;
}

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(`whatsapp-connect-link.v1\n${encoded}`).digest("base64url");
}

function signatureMatches(signature: string, expected: string): boolean {
  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
}

function nowInSeconds(nowSeconds?: number): number {
  return nowSeconds ?? Math.floor(Date.now() / 1000);
}

/** A fresh ticket made by `madeByHrId`, or null when there is no secret to sign it with. */
export function issueWhatsAppConnectLink(
  madeByHrId: string,
  nowSeconds?: number,
): { ticket: string; expiresAt: number } | null {
  const secret = signingSecret();
  if (!secret || !madeByHrId) return null;
  const expiresAt = nowInSeconds(nowSeconds) + WHATSAPP_CONNECT_LINK_TTL_SECONDS;
  const payload: ConnectLinkPayload = { v: 1, n: randomBytes(16).toString("base64url"), by: madeByHrId, exp: expiresAt };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { ticket: `${encoded}.${sign(encoded, secret)}`, expiresAt };
}

/** What a live, genuine ticket names, or null for anything that is not one. */
export function readWhatsAppConnectLink(ticket: unknown, nowSeconds?: number): WhatsAppConnectLink | null {
  if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > 512) return null;
  const [encoded, signature, extra] = ticket.split(".");
  if (!encoded || !signature || extra !== undefined) return null;

  const secret = signingSecret();
  if (!secret) return null;
  if (!signatureMatches(signature, sign(encoded, secret))) {
    // A ticket minted just before a secret rotation is still honoured; its own expiry bounds it.
    const previous = previousAuthSecret(nowSeconds === undefined ? undefined : new Date(nowSeconds * 1000));
    if (!previous || !signatureMatches(signature, sign(encoded, previous))) return null;
  }

  let payload: ConnectLinkPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ConnectLinkPayload;
  } catch {
    return null;
  }
  if (payload?.v !== 1 || typeof payload.n !== "string" || payload.n.length < 16) return null;
  if (typeof payload.by !== "string" || payload.by.length === 0) return null;
  if (typeof payload.exp !== "number" || payload.exp < nowInSeconds(nowSeconds)) return null;
  return { nonce: payload.n, madeBy: payload.by, expiresAt: payload.exp };
}
