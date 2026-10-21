import { createHmac, timingSafeEqual } from "node:crypto";

import { systemDeployment } from "@/config/system-settings";
import { previousAuthSecret } from "@/lib/auth/previous-secret";
import { parseLetterDate, isIsoDate } from "@/lib/offers/dates";

/**
 * The link behind the offer email's ONE button — "Accept the offer — complete your joining form"
 * (owner, 2026-10-08).
 *
 * The candidate has no Phoenix login and never will before his first day, so the capability is a
 * stateless HMAC over `{offer id, expiry}`, the same shape as the share-card and unsubscribe signers
 * (`PHOENIX_AUTH_SECRET`, domain-separated so no other token can be replayed as this one).
 *
 * ── The token is NOT the authority, the offer row is ──
 * A valid signature only says "this offer's email carried this link". Whether the form may still be
 * filled is read from the offer itself every time: a withdrawn, declined or already-submitted offer
 * refuses whatever the token says (`joiningFormState` in ./joining-form.ts). The expiry is a backstop
 * so an old email cannot open a form forever.
 *
 * ── Opening the link changes NOTHING ──
 * Outlook and Gmail safety scanners open every link in a message by themselves. So a GET only
 * shows the form; acceptance is the candidate pressing Submit (owner ruling: "the acceptance is
 * considered acceptance when he filled the data and submit"). A scanner can never accept an offer.
 */

export type OfferAcceptPayload = { v: 1; o: string; exp: number };

/** How long after the offer's own "valid until" date the link keeps opening. */
export const OFFER_ACCEPT_GRACE_DAYS = 14;
/** When the letter carries no readable validity date: this long after the link was minted. */
export const OFFER_ACCEPT_FALLBACK_DAYS = 60;

const DAY_SECONDS = 24 * 60 * 60;

function signingSecret(): string {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!secret) throw new Error("PHOENIX_AUTH_SECRET is required to issue an offer acceptance link.");
  return secret;
}

function sign(encoded: string, secret: string = signingSecret()): string {
  return createHmac("sha256", secret).update(`offer-accept.v1\n${encoded}`).digest("base64url");
}

function signatureMatches(signature: string, expected: string): boolean {
  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
}

/**
 * When the link stops opening, in epoch seconds.
 *
 * The letter's `valid until` is stored the way the letter prints it ("15 October 2026"), so it is
 * read back with the same parser the hire bridge uses. End of that day in Cairo, plus the grace.
 */
export function offerAcceptExpiry(validUntil: string | null | undefined, nowSeconds: number): number {
  const raw = String(validUntil ?? "").trim();
  const iso = raw ? (isIsoDate(raw) ? raw : parseLetterDate(raw)) : null;
  if (iso) {
    // 23:59:59 Cairo (UTC+2/+3) is never later than 21:59:59 UTC of the same day + 1h; using the
    // UTC end of day is at most three hours generous, and the grace dwarfs it.
    const endOfDay = Math.floor(Date.parse(`${iso}T23:59:59Z`) / 1000);
    if (Number.isFinite(endOfDay)) {
      return Math.max(endOfDay + OFFER_ACCEPT_GRACE_DAYS * DAY_SECONDS, nowSeconds + DAY_SECONDS);
    }
  }
  return nowSeconds + OFFER_ACCEPT_FALLBACK_DAYS * DAY_SECONDS;
}

export function issueOfferAcceptToken(input: {
  offerId: string;
  validUntil?: string | null;
  nowSeconds?: number;
}): string {
  const offerId = String(input.offerId ?? "").trim();
  if (!offerId) throw new Error("An offer acceptance link needs an offer id.");
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: OfferAcceptPayload = { v: 1, o: offerId, exp: offerAcceptExpiry(input.validUntil, now) };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

/** The offer id a live token names, or null for anything tampered, expired, malformed or unsigned. */
export function readOfferAcceptToken(token: string | null | undefined, nowSeconds?: number): string | null {
  if (!token || typeof token !== "string") return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;

  let expected: string;
  try {
    expected = sign(encoded);
  } catch {
    return null; // no secret → nothing verifies, the page answers "this link is not valid"
  }
  if (!signatureMatches(signature, expected)) {
    // An offer emailed before the secret rotation keeps opening until the end date in
    // src/lib/auth/previous-secret.ts. A new link is always signed with the current secret.
    const previous = previousAuthSecret(nowSeconds === undefined ? undefined : new Date(nowSeconds * 1000));
    if (!previous || !signatureMatches(signature, sign(encoded, previous))) return null;
  }

  let payload: OfferAcceptPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OfferAcceptPayload;
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || typeof payload.o !== "string" || !payload.o) return null;
  if (typeof payload.exp !== "number" || payload.exp < (nowSeconds ?? Math.floor(Date.now() / 1000))) return null;
  return payload.o;
}

/**
 * The public URL the button opens — the app's own configured URL, the way the CEO email builds its
 * links, so a staging test offer opens the staging form (where that offer exists) and production
 * opens production. Only a public https URL is used; anything else falls back to production.
 */
export function offerAcceptUrl(token: string): string {
  const configured = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  const base = /^https:\/\//i.test(configured) && !/localhost|127\.0\.0\.1/i.test(configured)
    ? configured
    : systemDeployment.productionUrl;
  return `${base}/join/${token}`;
}
