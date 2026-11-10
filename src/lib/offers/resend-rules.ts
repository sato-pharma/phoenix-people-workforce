import type { OfferRecord } from "@/lib/offers/types";

/**
 * Resending an offer — the rules, with no database and no mail in them.
 *
 * Asked for by the owner on 2026-09-28, the night Resend accepted Norhan Gamal's offer and then
 * failed it: the letter was marked "sent", she never received it, and the module had no way to put
 * the SAME letter in front of her again short of withdrawing it and composing a new one.
 *
 * A resend is the same letter, to the same address, again. It never edits the offer, never moves
 * `sent_at`, and never touches its status — the offer was issued once, on the day it says.
 */

/**
 * Why this offer cannot be resent, or null when it can.
 *
 * Only a SENT offer. A draft has never gone out — that is Send, not Resend. An accepted or declined
 * offer has been answered, so the candidate plainly has it. A withdrawn offer is one the company took
 * back, and mailing it again would re-issue terms nobody stands behind.
 */
export function offerResendRefusal(offer: Pick<OfferRecord, "candidateEmail" | "status" | "templateSnapshot">): string | null {
  switch (offer.status) {
    case "draft":
      return "This offer has not been sent yet. Use Send, not Resend.";
    case "pending_approval":
      return "This offer is waiting for the HR Manager's approval and has not been sent yet.";
    case "accepted":
    case "declined":
      return "The candidate has already answered this offer, so it is not resent.";
    case "withdrawn":
      return "This offer was withdrawn and cannot be sent again.";
    case "sent":
      break;
    default:
      return "Only a sent offer can be resent.";
  }
  if (!offer.candidateEmail.trim()) return "This offer has no candidate email address, so it cannot be resent.";
  // The letter as it was frozen at send. Without it the only thing left to render is TODAY's
  // template, which may quote different words — and a resend must be the letter the candidate was
  // already promised, not a new one.
  if (!offer.templateSnapshot) {
    return "This offer has no copy of the letter it was sent with, so it cannot be resent unchanged. Withdraw it and create a new one.";
  }
  return null;
}

/**
 * The key a resend goes out under. NEVER the first send's key.
 *
 * Resend dedupes a repeated idempotency key for 24 hours by handing back the ORIGINAL message. Re-used,
 * the first send's key would answer with the very message that failed and deliver nothing — the one
 * case this button exists for. One key per press of Resend: the browser mints the request id when the
 * button is pressed, so a double-submit of that one press still sends a single letter.
 */
export function offerResendIdempotencyKey(offerId: string, requestId: string): string {
  return `offer-letter:${offerId}:resend:${requestId}`;
}

/** A browser-minted request id we will put in a key: short, and letters, digits and dashes only. */
export function normalizeResendRequestId(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9-]{8,64}$/.test(text) ? text : null;
}
