/**
 * The proof that a report on /api/errors/client was forwarded by instrumentation.ts, this server's own
 * onRequestError hook, and not typed by whoever can reach the URL.
 *
 * WHY. The route is open to guests (a crash on the login page must still report), so it cannot tell a real
 * uncaught server error from a made-up one by who sent it: a cron-job.org hit or a webhook has no cookie,
 * and any employee login can post `source: "server"` with words of their own. Gating the new-error Telegram
 * on "signed in" therefore silenced the real cookie-less errors and still let an employee write the Super
 * Admin's alert. This header is the one thing only the server can produce.
 *
 * It is an HMAC over a short expiry, never the secret itself: instrumentation.ts builds its target from the
 * request's own Host header, and a secret must not travel to an address a caller could influence. Web Crypto
 * only, because instrumentation.ts is bundled for the Edge runtime as well. With no signing secret nothing
 * signs and nothing verifies, so the alert simply does not send — the direction to fail.
 */

export const SERVER_FORWARD_PROOF_HEADER = "x-phoenix-error-forward";
const SERVER_FORWARD_PROOF_TTL_SECONDS = 60;
const DOMAIN = "error-forward.v1";

function signingSecret(): string | null {
  return process.env.PHOENIX_AUTH_SECRET?.trim() || null;
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** `<expiry>.<signature>`, or null when there is no secret to sign with. */
export async function signServerErrorForward(nowSeconds?: number): Promise<string | null> {
  const secret = signingSecret();
  if (!secret) return null;
  const expires = (nowSeconds ?? Math.floor(Date.now() / 1000)) + SERVER_FORWARD_PROOF_TTL_SECONDS;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(`${DOMAIN}\n${expires}`));
  return `${expires}.${bytesToHex(new Uint8Array(signature))}`;
}

/** True only for a live proof this server signed. Anything else, a missing secret included, is false. */
export async function verifyServerErrorForward(proof: string | null | undefined, nowSeconds?: number): Promise<boolean> {
  const secret = signingSecret();
  if (!secret || !proof || typeof proof !== "string") return false;
  const [expiresText, signatureHex] = proof.split(".");
  if (!expiresText || !signatureHex || !/^\d{1,12}$/.test(expiresText)) return false;
  const expires = Number(expiresText);
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  // Live, and not further ahead than a fresh proof could be (a far-future expiry would be a forever token).
  if (expires < now || expires > now + SERVER_FORWARD_PROOF_TTL_SECONDS) return false;
  const signature = hexToBytes(signatureHex);
  if (!signature) return false;
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, new TextEncoder().encode(`${DOMAIN}\n${expires}`));
  } catch {
    return false;
  }
}
