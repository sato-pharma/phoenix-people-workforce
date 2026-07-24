// Recruitment / ATS — WhatsApp Cloud API webhook signature verification.
//
// Mirrors src/lib/email/resend-webhook-events.ts's verifyResendWebhookSignature shape, adapted
// to Meta's actual contract: a single X-Hub-Signature-256 header, hex-encoded HMAC-SHA256 over
// the raw request body — no Svix triple, no timestamp tolerance window (Meta doesn't send one).

import crypto from "crypto";

const SIGNATURE_PREFIX = "sha256=";

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyWhatsAppWebhookSignature(input: { body: string; header: string | null; secret: string }): boolean {
  if (!input.header || !input.header.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = input.header.slice(SIGNATURE_PREFIX.length).trim();
  if (!provided) return false;

  const expected = crypto.createHmac("sha256", input.secret).update(input.body, "utf8").digest("hex");
  return timingSafeEqual(provided, expected);
}

/**
 * Meta's one-time webhook verification handshake: GET with hub.mode=subscribe,
 * hub.verify_token=<your configured token>, hub.challenge=<a value to echo back verbatim>.
 */
export function verifyWhatsAppWebhookHandshake(input: {
  mode: string | null;
  token: string | null;
  challenge: string | null;
  verifyToken: string;
}): string | null {
  if (input.mode !== "subscribe") return null;
  if (!input.token || !input.challenge) return null;
  if (!timingSafeEqual(input.token, input.verifyToken)) return null;
  return input.challenge;
}
