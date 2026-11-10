import type { OfferRecord, OfferStatus } from "@/lib/offers/types";

/**
 * HR's own message in the offer email, and the updated offer — the rules, with no database and no mail
 * in them (owner, 2026-11-10: "add a field for the HR to write whatever he wants and this goes in the
 * job offer email body ... also make an option for the updated job offer, i may need to update a job
 * offer").
 *
 * ── The message ──
 * Plain text, printed at the top of the EMAIL body, under the letterhead. Never on the PDF: the letter
 * is a signed document in a frozen design, and the message is a covering note. It travels with the offer
 * row, so it is part of what the HR Manager reads and approves, and a Resend carries it again.
 *
 * ── The updated offer ──
 * The SAME offer row, not a new letter: the reference, the seat, the candidate link and the hire bridge
 * all stay pointed at it. "Update offer" freezes the version that went out into `revision_history`,
 * returns the row to draft for editing and bumps `revision`; it is then sent through the ordinary Send,
 * so Talent Acquisition's update waits for the HR Manager exactly like a first send. The candidate's
 * email says it is an updated offer and which one it replaces. Until the update goes, the candidate's
 * old link says the offer is being updated rather than letting old terms be accepted.
 */

/** The longest message HR may write. The database refuses 4,000; the screen and the routes hold 2,000. */
export const OFFER_EMAIL_MESSAGE_MAX = 2000;

/**
 * The message as it is stored: line breaks unified, outer blank lines removed, more than one empty line
 * in a row folded to one. Empty answers null, which is "no message".
 */
export function normalizeOfferEmailMessage(value: unknown): { message: string | null; problem: string | null } {
  const text = typeof value === "string" ? value : "";
  const tidy = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!tidy) return { message: null, problem: null };
  if (tidy.length > OFFER_EMAIL_MESSAGE_MAX) {
    return {
      message: null,
      problem: `The message to the candidate is ${tidy.length} characters; the most it can be is ${OFFER_EMAIL_MESSAGE_MAX}.`,
    };
  }
  return { message: tidy, problem: null };
}

/** The answers an offer can carry and still be updated after negotiation (owner, 2026-11-10). */
const ANSWERED_STATUSES: readonly OfferStatus[] = ["accepted", "declined", "withdrawn"];

/** Whether the candidate has answered this offer, or HR took it back. */
export function offerIsAnswered(status: OfferStatus): boolean {
  return ANSWERED_STATUSES.includes(status);
}

/**
 * Why this offer cannot be updated, or null when it can.
 *
 * Any offer that went out: sent, accepted, declined or withdrawn (owner, 2026-11-10: "accepted or
 * declined or withdrawn may be i want after negtioation i want to update something with accepted
 * offer"). Once the update is sent it is back to Sent and the candidate answers it again — he chose
 * "Back to Sent" for an accepted one. A draft or an offer waiting for approval is simply edited.
 */
export function offerRevisionRefusal(
  offer: Pick<OfferRecord, "candidateEmail" | "status" | "templateSnapshot">,
): string | null {
  switch (offer.status) {
    case "draft":
      return "This offer has not been sent yet, so it can simply be edited.";
    case "pending_approval":
      return "This offer is waiting for the HR Manager's approval. It can be edited there, or rejected back to draft.";
    case "sent":
    case "accepted":
    case "declined":
    case "withdrawn":
      break;
    default:
      return "Only an offer that was sent can be updated.";
  }
  if (!offer.candidateEmail.trim()) return "This offer has no candidate email address, so an update could not reach anybody.";
  // The version being replaced is kept as it went out; without its letter there is nothing to keep.
  if (!offer.templateSnapshot) return "This offer has no copy of the letter it was sent with, so it cannot be updated. Withdraw it and create a new one.";
  return null;
}

/**
 * Why an update in progress cannot be cancelled, or null when it can. Cancelling puts the version that
 * went out back exactly as it was, and the candidate's link opens it again.
 */
export function offerRevisionCancelRefusal(
  offer: Pick<OfferRecord, "status"> & { revision?: number; revisionHistory?: readonly unknown[] },
): string | null {
  if (!(offer.revision && offer.revision > 0) || !offer.revisionHistory || offer.revisionHistory.length === 0) {
    return "This offer is not being updated.";
  }
  if (offer.status === "pending_approval") {
    return "This update is waiting for the HR Manager's approval. Reject it back to draft first, then cancel the update.";
  }
  if (offer.status !== "draft") return "This update has already been sent, so it cannot be cancelled.";
  return null;
}

/** Whether an offer is an update in progress: being edited, or waiting for approval, after it went out once. */
export function offerIsBeingUpdated(offer: { revision?: number; status: OfferStatus }): boolean {
  return Boolean(offer.revision && offer.revision > 0) && (offer.status === "draft" || offer.status === "pending_approval");
}

/** The email's subject. An update says so first, so it is never read as a duplicate of the first letter. */
export function offerSubjectFor(title: string, revision = 0): string {
  const clean = title.trim();
  const base = clean ? `Offer of Employment — ${clean}` : "Offer of Employment";
  return revision > 0 ? `Updated ${base}` : base;
}

/**
 * A stable idempotency key: the offer id, and the version number once it has been updated.
 *
 * Revision 0 keeps the exact key every first send has always used. An update needs its own, or the
 * provider would recognise the key and hand back the FIRST letter instead of sending the updated one.
 */
export function offerIdempotencyKeyFor(offerId: string, revision = 0): string {
  return revision > 0 ? `offer-letter:${offerId}:rev:${revision}` : `offer-letter:${offerId}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** "3 November 2026", read on Cairo's calendar. Empty for anything that is not a date. */
export function cairoLongDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "numeric",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  const month = MONTHS[part("month") - 1];
  return month ? `${part("day")} ${month} ${part("year")}` : "";
}

/**
 * Whether an updated offer is accepted by replying rather than through the joining form: the candidate
 * is already on the Employee Master (an accepted offer updated after negotiation), so the form would
 * only say it was completed, and a second record must never be made. HR marks it Accepted by hand.
 */
export function offerAcceptsByReply(offer: { employeeHrId?: string | null; revision?: number }): boolean {
  return Boolean(offer.employeeHrId) && Boolean(offer.revision && offer.revision > 0);
}

/** The sentence that tells such a candidate how to accept. */
export const OFFER_ACCEPT_BY_REPLY_TEXT = "To accept this updated offer, please reply to this email.";

/** The line an updated offer's email opens with: that it is an update, and which letter it replaces. */
export function offerUpdateNote(previousSentAt: string | null | undefined, options: { acceptByReply?: boolean } = {}): string {
  const when = cairoLongDate(previousSentAt);
  const note = when
    ? `This is an updated offer. It replaces the offer we sent you on ${when}; please read it in full. The attached PDF is your current offer letter.`
    : "This is an updated offer. It replaces the offer we sent you earlier; please read it in full. The attached PDF is your current offer letter.";
  return options.acceptByReply ? `${note} ${OFFER_ACCEPT_BY_REPLY_TEXT}` : note;
}

/** "2nd version", "3rd version" — how the Offers list names an updated offer. */
export function offerVersionLabel(revision: number): string {
  const n = revision + 1;
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix} version`;
}
