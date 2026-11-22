import { logError } from "@/lib/observability/log";

/**
 * WHAT A LATE SEND STILL HAS TO DO (REC-048 phase 2, 19 Nov 2026).
 *
 * A durable email is sent at the press first. When that send fails, the outbox row the press wrote is
 * retried by the drain minutes later — and for most emails that is the whole story: the leave decision
 * was already saved, the email only tells people about it.
 *
 * Some emails ARE the act. A job offer counts as sent only once its email leaves (`markOfferSent`); an
 * expired offer is withdrawn only once its notice leaves; the interview calendar logs "sent" only for
 * an invitation that went. When the press failed, none of that happened — so if the drain later
 * delivers the email, the record must catch up, or the candidate holds an offer the Offers list still
 * calls a draft, and HR is invited to send it a second time.
 *
 * Each such email carries a `followUp` in its outbox row (serialisable, no function), and the drain —
 * never the press, which does its own bookkeeping — runs two steps around a retry:
 *
 *   1. BEFORE it sends: `checkDurableEmailFollowUp` asks whether the email is still the right one. An
 *      offer edited, re-sent, withdrawn or moved to a new revision since the press, or an interview
 *      that was moved, cancelled or has already begun, closes the row unsent (`skip`). A record that
 *      cannot be read leaves the row queued (`later`): a stale letter is never sent on a guess.
 *   2. AFTER a send: `completeDurableEmailFollowUp` does what the press would have done — the same
 *      calls, the same notices, nobody new told. A failure there is logged, never thrown: the email
 *      went, and the row must say so.
 *
 * The modules own their rules; this file only names the shapes and routes each to its module (loaded
 * on first use, so the outbox never imports the offer or interview code at start-up).
 */

/** The design a letter was rendered from, frozen at the press — markOfferSent stores it as the snapshot. */
type OfferLetterDesignSnapshot = {
  blocks: unknown;
  fontFamily: unknown;
  fontSizePt: unknown;
  theme: unknown;
  variant: unknown;
};

export type OfferLetterSendFollowUp = {
  kind: "offer_letter";
  mode: "send";
  offerId: string;
  /** The version that was pressed — a later revision is a different letter. */
  revision: number;
  /** The offer as read at the press, fingerprinted (offer-fingerprint.ts). Any change since means the stored letter is out of date. */
  offerFingerprint: string;
  /** Whether the press approved an offer that was waiting for the HR Manager. */
  approvedFromPending: boolean;
  requestedBy: string | null;
  sentBy: string | null;
  copies: { bcc: string[]; cc: string[] };
  design: OfferLetterDesignSnapshot;
};

export type OfferLetterResendFollowUp = { kind: "offer_letter"; mode: "resend"; offerId: string; revision: number };

export type OfferExpiryFollowUp = { kind: "offer_expiry"; offerId: string };

export type InterviewInvitationFollowUp = {
  kind: "interview_invitation";
  bookingId: string;
  /** The interview's start at the press — a moved interview makes the stored invitation wrong. */
  startsAt: string;
  interviewerHrId: string | null;
  recipient: string;
  invitationKind: string;
  destination: string;
  sentByHrId: string | null;
};

export type DurableEmailFollowUp =
  | OfferLetterSendFollowUp
  | OfferLetterResendFollowUp
  | OfferExpiryFollowUp
  | InterviewInvitationFollowUp;

/** The answer before a retry: send it, close it unsent, or leave it queued for the next run. */
export type FollowUpGate =
  | { decision: "proceed" }
  | { decision: "skip"; reason: string }
  | { decision: "later"; reason: string };

function isDurableEmailFollowUp(value: unknown): value is DurableEmailFollowUp {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "offer_letter" || kind === "offer_expiry" || kind === "interview_invitation";
}

/** Before the drain retries a durable email: is it still the email to send? No follow-up → yes. */
export async function checkDurableEmailFollowUp(followUp: unknown): Promise<FollowUpGate> {
  if (!isDurableEmailFollowUp(followUp)) return { decision: "proceed" };
  try {
    if (followUp.kind === "interview_invitation") {
      const { checkInterviewInvitationRetry } = await import("@/lib/recruitment/interview-invitation-retry");
      return await checkInterviewInvitationRetry(followUp);
    }
    const { checkOfferEmailRetry } = await import("@/lib/offers/outbox-retry");
    return await checkOfferEmailRetry(followUp);
  } catch (error) {
    // A record that cannot be read is never a "yes": the row waits for the next run.
    logError("Durable email follow-up check failed — the email stays queued", {
      error,
      labels: { event: "durable_email_follow_up_check_failed", kind: followUp.kind },
    });
    return { decision: "later", reason: "The record behind this email could not be read; it will be checked again on the next run." };
  }
}

/** After the drain delivered a durable email the press could not: do what the press would have done. */
export async function completeDurableEmailFollowUp(followUp: unknown, providerMessageId: string | null): Promise<void> {
  if (!isDurableEmailFollowUp(followUp)) return;
  try {
    if (followUp.kind === "interview_invitation") {
      const { completeInterviewInvitationRetry } = await import("@/lib/recruitment/interview-invitation-retry");
      await completeInterviewInvitationRetry(followUp, providerMessageId);
      return;
    }
    const { completeOfferEmailRetry } = await import("@/lib/offers/outbox-retry");
    await completeOfferEmailRetry(followUp, providerMessageId);
  } catch (error) {
    // The email went and its row says sent; only the record behind it is behind. Said, never thrown.
    logError("Durable email was sent by the outbox, but its record could not be brought up to date", {
      error,
      labels: { event: "durable_email_follow_up_failed", kind: followUp.kind },
    });
  }
}
