import { writeAuditLog } from "@/lib/admin/audit";
import { announceOfferApprovalDecision } from "@/lib/offers/approval";
import { offerSendRefusal } from "@/lib/offers/approval-rules";
import { offerExpiryRefusal } from "@/lib/offers/expiry-notice";
import { offerRetryFingerprint } from "@/lib/offers/offer-fingerprint";
import { offerResendRefusal } from "@/lib/offers/resend-rules";
import { getOffer, markOfferSent, setOfferStatus } from "@/lib/offers/service";
import type { OfferRecord, OfferTemplate } from "@/lib/offers/types";
import type {
  FollowUpGate,
  OfferExpiryFollowUp,
  OfferLetterResendFollowUp,
  OfferLetterSendFollowUp,
} from "@/lib/notifications/durable-email-follow-up";
import { logError } from "@/lib/observability/log";

/**
 * A JOB OFFER EMAIL THE OUTBOX SENDS LATE (REC-048 phase 2, 19 Nov 2026).
 *
 * The offer letter, its resend and its expiry notice are written to the outbox at the press. When the
 * press's own send fails, HR is told at once (the offer stays a draft, or stays sent and not withdrawn)
 * and the drain retries the stored email. These two steps keep the offer's record true around that
 * late send — see durable-email-follow-up.ts for where they run.
 *
 * ── Before the retry: is it still the letter to send? ──
 * The stored letter was rendered at the press. If anybody touched the offer since — edited it, sent it
 * themselves, returned it, withdrew it, moved it to a new revision — the stored letter is out of date
 * (the offer's fingerprint at the press, offer-fingerprint.ts, no longer matches) and is NOT sent (the row closes unsent, and the Offers screen is where it is sent again). The rules
 * are pure (`offerLetterRetryVerdict`, `offerExpiryRetryVerdict`) so they are tested without a database.
 *
 * ── After the retry: what the press would have done ──
 *  - a SEND marks the offer sent with the design and copies frozen at the press (`markOfferSent`, whose
 *    own draft precondition refuses a second stamp), writes the audit row the Send route writes, and —
 *    when the press approved an offer that was waiting — tells the requester exactly as the route does;
 *  - a RESEND changes nothing on the offer and writes the route's audit row;
 *  - an EXPIRY withdraws the offer, still only if it is still out with the candidate, and audits it.
 * Nobody is told anything the press would not have told them.
 */

/** Before a late SEND or RESEND: the offer must still be the version, and in the state, of the press. */
export function offerLetterRetryVerdict(
  offer: OfferRecord,
  followUp: OfferLetterSendFollowUp | OfferLetterResendFollowUp,
): FollowUpGate {
  if ((offer.revision ?? 0) !== followUp.revision) {
    return { decision: "skip", reason: "The offer was updated to a new version after this email failed, so the older letter was not sent." };
  }
  if (followUp.mode === "send") {
    const refusal = offerSendRefusal(offer.status, true);
    if (refusal) {
      return { decision: "skip", reason: `The offer is no longer waiting to be sent (${offer.status}), so this letter was not sent again.` };
    }
    if (offerRetryFingerprint(offer) !== followUp.offerFingerprint) {
      return { decision: "skip", reason: "The offer was changed after this email failed, so the older letter was not sent. Send it again from the Offers screen." };
    }
    return { decision: "proceed" };
  }
  const refusal = offerResendRefusal(offer);
  if (refusal) return { decision: "skip", reason: `${refusal} The resend was not made.` };
  return { decision: "proceed" };
}

/** Before a late EXPIRY notice: the offer must still be out with the candidate. */
export function offerExpiryRetryVerdict(offer: Pick<OfferRecord, "candidateEmail" | "status">): FollowUpGate {
  const refusal = offerExpiryRefusal(offer);
  if (refusal) return { decision: "skip", reason: `${refusal} The expiry notice was not sent.` };
  return { decision: "proceed" };
}

export async function checkOfferEmailRetry(
  followUp: OfferLetterSendFollowUp | OfferLetterResendFollowUp | OfferExpiryFollowUp,
): Promise<FollowUpGate> {
  // A read that fails throws, and the caller leaves the row queued — never a guess.
  const offer = await getOffer(followUp.offerId);
  if (followUp.kind === "offer_expiry") return offerExpiryRetryVerdict(offer);
  return offerLetterRetryVerdict(offer, followUp);
}

export async function completeOfferEmailRetry(
  followUp: OfferLetterSendFollowUp | OfferLetterResendFollowUp | OfferExpiryFollowUp,
  providerMessageId: string | null,
): Promise<void> {
  if (followUp.kind === "offer_expiry") {
    const offer = await getOffer(followUp.offerId);
    // Still out with the candidate? Withdraw it, exactly as expireOfferEmail does after its notice.
    if (offerExpiryRefusal(offer)) return;
    const withdrawn = await setOfferStatus(offer.id, "withdrawn");
    await writeAuditLog({
      actorLoginId: null,
      entityId: offer.id,
      entityType: "job_offer",
      newValues: { candidateName: withdrawn.candidateName, expired: true, providerMessageId, recipient: withdrawn.candidateEmail, status: withdrawn.status },
      summary: `Offer ${withdrawn.reference} to ${withdrawn.candidateName} marked expired and withdrawn; the expiry notice was sent by the outbox after the first try failed`,
    });
    return;
  }

  if (followUp.mode === "resend") {
    const offer = await getOffer(followUp.offerId);
    await writeAuditLog({
      actorLoginId: null,
      entityId: offer.id,
      entityType: "job_offer",
      newValues: { candidateName: offer.candidateName, jobTitle: offer.title, providerMessageId, recipient: offer.candidateEmail, resend: true },
      summary: `Offer of employment re-sent to ${offer.candidateName} for ${offer.title} by the outbox after the first try failed`,
    });
    return;
  }

  // A SEND: stamp the offer as the press would have, with the design and copies frozen at the press.
  const stamped = await markOfferSent(
    followUp.offerId,
    followUp.design as Pick<OfferTemplate, "blocks" | "fontFamily" | "fontSizePt" | "theme" | "variant">,
    followUp.sentBy,
    followUp.copies,
  );
  await writeAuditLog({
    actorLoginId: null,
    entityId: stamped.id,
    entityType: "job_offer",
    newValues: {
      bcc: followUp.copies.bcc,
      candidateName: stamped.candidateName,
      cc: followUp.copies.cc,
      jobTitle: stamped.title,
      providerMessageId,
      recipient: stamped.candidateEmail,
      sentBy: followUp.sentBy,
      startDate: stamped.startDate,
      totalMonthly: stamped.totalMonthly,
    },
    summary:
      `Offer of employment sent to ${stamped.candidateName} for ${stamped.title} by the outbox after the first try failed` +
      (followUp.approvedFromPending ? "; approved by the HR Manager" : ""),
  });
  if (followUp.approvedFromPending) {
    try {
      await announceOfferApprovalDecision(stamped, { by: followUp.sentBy, outcome: "approved", requestedBy: followUp.requestedBy });
    } catch (error) {
      logError("Offer approval notice failed after the outbox sent the letter", {
        error,
        labels: { event: "offer_outbox_approval_notice_failed", offerId: stamped.id },
      });
    }
  }
}
