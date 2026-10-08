/**
 * Offer accepted — telling whoever hires, the moment a letter is marked accepted.
 *
 * A job offer flipping to `accepted` used to be silent: the candidate had said yes and nothing told
 * the people who seat new hires, so an accepted offer could sit on a vacant seat for days (the
 * `accepted-offer-overdue-with-seat-still-open` reconciliation check exists precisely because of
 * that). This fires an alert the moment it happens.
 *
 * The audience is the admin-editable `accepted_offer_alert` role policy — Super Admin and HR
 * Operations by default, the owner's choice on 2026-10-02 — and the channels are in-app, push and
 * Telegram (never email: this is an internal "go hire them" nudge, not correspondence).
 *
 * NOTHING HERE THROWS INTO ITS CALLER. It runs after the offer's status has been written, from
 * inside `setOfferStatus`; a notice that could fail would otherwise block a candidate from being
 * marked accepted at all.
 */

import type { OfferRecord } from "@/lib/offers/types";
import { logError } from "@/lib/observability/log";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import {
  createSystemNotificationForRecipients,
  logNotificationSendFailure,
  type SystemNotificationChannel,
} from "@/lib/notifications/system";

/** The admin-editable audience key (see role-recipients.ts). Defaults to Super Admin + HR Operations. */
export const ACCEPTED_OFFER_AUDIENCE = "accepted_offer_alert" as const;
export const ACCEPTED_OFFER_MODULE = "offers" as const;
export const ACCEPTED_OFFER_EVENT_TYPE = "offer_accepted" as const;

/** In-app, push and Telegram — the owner's choice, 2026-10-02. Never email. */
export const ACCEPTED_OFFER_CHANNELS: readonly SystemNotificationChannel[] = ["in_app", "push", "telegram"];

/** The organogram, where an accepted offer's seat shows "Offer accepted — …" and is one press to hire. */
export const ACCEPTED_OFFER_PATH = "/organogram" as const;

const NOT_RECORDED = "Not recorded";
function stated(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : NOT_RECORDED;
}

export function acceptedOfferTitle(offer: Pick<OfferRecord, "candidateName">): string {
  return `Offer accepted — ready to hire: ${stated(offer.candidateName)}`;
}

/** The body, read on a phone: who, which role, when they start, and what to do. */
export function acceptedOfferMessage(offer: Pick<OfferRecord, "candidateName" | "title" | "startDate">): string {
  const start = String(offer.startDate ?? "").trim();
  const starts = start ? `, starting ${start}` : "";
  return `${stated(offer.candidateName)} has accepted the offer for ${stated(offer.title)}${starts}. Open the organogram to seat them — the seat that names them is now one press to hire.`;
}

/** The detail rows the in-app notice carries. */
export function acceptedOfferDetails(
  offer: Pick<OfferRecord, "candidateName" | "title" | "startDate" | "reference">,
): Array<{ label: string; value: string }> {
  return [
    { label: "Candidate", value: stated(offer.candidateName) },
    { label: "Role", value: stated(offer.title) },
    { label: "Start date", value: stated(offer.startDate) },
    { label: "Offer reference", value: stated(offer.reference) },
  ];
}

export type AcceptedOfferAnnounceResult = {
  announced: boolean;
  recipients: number;
  warnings: string[];
};

/** The Employee Master, where the new record now sits (the notice names its HR ID to search for). */
export const JOINED_EMPLOYEE_PATH = "/employees" as const;

/**
 * The joining-form version of the alert (owner, 2026-10-08). The candidate pressed Submit, so the
 * record is ALREADY made and seated — "open the organogram to seat them" would send HR to do work
 * that is done. It says what is left instead: check the record and finish what only HR can.
 */
export function joinedOfferTitle(offer: Pick<OfferRecord, "candidateName">): string {
  return `Offer accepted — joining form completed: ${stated(offer.candidateName)}`;
}

export function joinedOfferMessage(
  offer: Pick<OfferRecord, "candidateName" | "title" | "startDate">,
  hire: { hrId: string; seated?: boolean; workEmail: string | null },
): string {
  const start = String(offer.startDate ?? "").trim();
  const starts = start ? `, starting ${start}` : "";
  const email = hire.workEmail
    ? ` The Sato email ${hire.workEmail} is queued on New Hire Mailboxes.`
    : " No Sato email could be generated — type it on New Hire Mailboxes.";
  // Only a record that got its seat is called seated: a non-sales offer sent with no seat is
  // created with no department, line or manager, and HR must be told to set them.
  const seat = hire.seated === false
    ? " is created WITHOUT a seat — set the department, line and manager on the Employee Master."
    : " is created and seated.";
  return `${stated(offer.candidateName)} accepted the offer for ${stated(offer.title)}${starts} and completed the joining form. Their employee record ${hire.hrId}${seat}${email} Bank, insurance and payment-mode details are still HR's to add.`;
}

/**
 * A candidate tried to submit the joining form and it could not make his record — the seat was
 * filled meanwhile, or his national ID is already on the Employee Master. The page told HIM that HR
 * will contact him; this is what makes that true. Same audience and channels, never email, once per
 * offer and reason. Swallows every failure.
 */
export async function announceJoiningFormBlocked(
  offer: Pick<OfferRecord, "candidateName" | "id" | "reference" | "startDate" | "title">,
  reason: string,
): Promise<void> {
  const offerId = String(offer?.id ?? "").trim();
  if (!offerId) return;
  try {
    const audience = await resolveNotificationPersonRecipients(ACCEPTED_OFFER_AUDIENCE, "Joining form blocked — recipients");
    if (audience.recipients.length === 0) {
      logError("A joining form was blocked but the accepted-offer alert audience resolved to nobody", {
        error: new Error(`offer ${offerId}: ${reason}`),
        labels: { event: "joining_form_blocked_no_recipient" },
      });
      return;
    }
    await createSystemNotificationForRecipients(
      {
        actionUrl: "/offers",
        actorId: null,
        channels: [...ACCEPTED_OFFER_CHANNELS],
        eventType: "offer_joining_form_blocked",
        message: `${stated(offer.candidateName)} tried to accept the offer for ${stated(offer.title)} on the joining form, but it could not be completed: ${reason} Please contact them.`,
        metadata: {
          authorizedRecipient: true,
          details: [...acceptedOfferDetails(offer), { label: "What stopped it", value: reason }],
          idempotencyKey: `joining-form-blocked:${offerId}:${reason.slice(0, 40)}`,
        },
        module: ACCEPTED_OFFER_MODULE,
        priority: "high",
        title: `Joining form needs HR: ${stated(offer.candidateName)}`,
      },
      audience.recipients.map((recipient) => recipient.hrId),
    );
  } catch (error) {
    logNotificationSendFailure("acceptedOffer.announceJoiningFormBlocked", error);
  }
}

/**
 * Announce one accepted offer to the audience. Idempotent per offer id, so re-marking an offer
 * accepted (a correction, a double-save) never fires a second alert. Swallows every failure.
 *
 * `hire` is passed by the joining form only: the record exists, so the notice names it and opens it.
 */
export async function announceAcceptedOffer(
  offer: OfferRecord,
  hire?: { hrId: string; seated?: boolean; workEmail: string | null },
): Promise<AcceptedOfferAnnounceResult> {
  const warnings: string[] = [];
  const offerId = String(offer?.id ?? "").trim();
  if (!offerId) return { announced: false, recipients: 0, warnings: ["the accepted offer carried no id"] };

  try {
    const audience = await resolveNotificationPersonRecipients(
      ACCEPTED_OFFER_AUDIENCE,
      "Accepted offer alert — recipients",
    );
    warnings.push(...audience.warnings);
    if (audience.recipients.length === 0) {
      logError("An offer was accepted but the accepted-offer alert audience resolved to nobody", {
        error: new Error(`offer ${offerId}; warnings: ${warnings.join("; ") || "none"}`),
        labels: { event: "accepted_offer_no_recipient" },
      });
      return { announced: false, recipients: 0, warnings };
    }

    // ForRecipients, never a loop of single sends: it suffixes the idempotency key per recipient.
    await createSystemNotificationForRecipients(
      {
        actionUrl: hire ? JOINED_EMPLOYEE_PATH : ACCEPTED_OFFER_PATH,
        actorId: null,
        channels: [...ACCEPTED_OFFER_CHANNELS],
        eventType: ACCEPTED_OFFER_EVENT_TYPE,
        message: hire ? joinedOfferMessage(offer, hire) : acceptedOfferMessage(offer),
        metadata: {
          // Resolved from the admin-editable role policy, never from a request.
          authorizedRecipient: true,
          details: hire
            ? [...acceptedOfferDetails(offer), { label: "Employee record", value: hire.hrId }]
            : acceptedOfferDetails(offer),
          // No date in the key: one alert per offer, and a later re-save is not a new acceptance.
          // The joining form has its OWN key: HR may already have marked a "yes" reply accepted by
          // hand, and the record being made afterwards is news that alert did not carry.
          idempotencyKey: hire ? `accepted-offer-joined:${offerId}` : `accepted-offer:${offerId}`,
        },
        module: ACCEPTED_OFFER_MODULE,
        priority: "high",
        title: hire ? joinedOfferTitle(offer) : acceptedOfferTitle(offer),
      },
      audience.recipients.map((recipient) => recipient.hrId),
    );
    return { announced: true, recipients: audience.recipients.length, warnings };
  } catch (error) {
    logNotificationSendFailure("acceptedOffer.announceAcceptedOffer", error);
    return {
      announced: false,
      recipients: 0,
      warnings: [...warnings, error instanceof Error ? error.message : String(error)],
    };
  }
}
