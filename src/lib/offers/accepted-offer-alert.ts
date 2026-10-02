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

/**
 * Announce one accepted offer to the audience. Idempotent per offer id, so re-marking an offer
 * accepted (a correction, a double-save) never fires a second alert. Swallows every failure.
 */
export async function announceAcceptedOffer(offer: OfferRecord): Promise<AcceptedOfferAnnounceResult> {
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
        actionUrl: ACCEPTED_OFFER_PATH,
        actorId: null,
        channels: [...ACCEPTED_OFFER_CHANNELS],
        eventType: ACCEPTED_OFFER_EVENT_TYPE,
        message: acceptedOfferMessage(offer),
        metadata: {
          // Resolved from the admin-editable role policy, never from a request.
          authorizedRecipient: true,
          details: acceptedOfferDetails(offer),
          // No date in the key: one alert per offer, and a later re-save is not a new acceptance.
          idempotencyKey: `accepted-offer:${offerId}`,
        },
        module: ACCEPTED_OFFER_MODULE,
        priority: "high",
        title: acceptedOfferTitle(offer),
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
