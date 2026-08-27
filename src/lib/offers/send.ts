import { defaultOfferTemplate, getOffer, getOfferTemplate, markOfferSent } from "@/lib/offers/service";
import { isOfferPdfAvailable, offerPdfFilename, renderOfferPdf } from "@/lib/offers/pdf";
import { renderOfferEmail } from "@/lib/offers/render-email";
import { resolveOfferSender } from "@/lib/offers/identity";
import { satoLogoUrl } from "@/lib/offers/brand";
import { systemDeployment } from "@/config/system-settings";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import type { OfferFields, OfferRecord, OfferTemplate } from "@/lib/offers/types";

/**
 * Sending an offer.
 *
 * ── One resolve, two renderers ──
 * The template and the fields are resolved ONCE here and handed to both `renderOfferEmail` and
 * `renderOfferPdf`. Neither renderer touches the database. That is what makes it impossible for
 * the body of the email and the attached PDF to quote different salaries for the same person —
 * a failure nobody would notice until a candidate asked which number was real.
 *
 * ── The identity ──
 * From/Reply-To come from `resolveOfferSender()`, i.e. Sato Pharma, never Phoenix. The owner's
 * instruction was explicit and the reason is practical: an offer branded as somebody's internal
 * HR software reads as phishing.
 */

export type OfferSendOutcome = {
  attachmentIncluded: boolean;
  /** Present when the PDF could not be produced — HR is shown this, never a silent omission. */
  attachmentWarning: string | null;
  from: string;
  offer: OfferRecord;
  recipient: string;
  /** True when the send was suppressed upstream (testing mode, unsubscribe, confidence gate). */
  skipped: boolean;
  skippedReason: string | null;
  /** False when JOB_OFFER_EMAIL_FROM is unset and the placeholder address was used. */
  senderConfigured: boolean;
  subject: string;
};

function offerFields(offer: OfferRecord): OfferFields {
  return {
    candidateEmail: offer.candidateEmail,
    candidateName: offer.candidateName,
    contractTerm: offer.contractTerm,
    costOfLiving: offer.costOfLiving,
    dateOfIssue: offer.dateOfIssue,
    reference: offer.reference,
    reportsTo: offer.reportsTo,
    salutationName: offer.salutationName,
    startDate: offer.startDate,
    territory: offer.territory,
    title: offer.title,
    totalMonthly: offer.totalMonthly,
    validUntil: offer.validUntil,
  };
}

export function offerSubject(offer: Pick<OfferRecord, "title">): string {
  const title = offer.title.trim();
  return title ? `Offer of Employment — ${title}` : "Offer of Employment";
}

/**
 * A stable idempotency key.
 *
 * Keyed on the offer id alone, deliberately. Two clicks on Send, or a retry after a browser
 * timeout, must not put two offer letters in a candidate's inbox — and there is no legitimate
 * reason to send the same offer row twice. (`markOfferSent` guards the same thing at the database
 * end with its draft precondition; this guards the mail itself.)
 */
export function offerIdempotencyKey(offerId: string): string {
  return `offer-letter:${offerId}`;
}

export async function sendOfferEmail(
  offerId: string,
  options: { logoUrl?: string; sentBy?: string | null } = {},
): Promise<OfferSendOutcome> {
  const offer = await getOffer(offerId);

  if (offer.status !== "draft") {
    throw new Error("This offer has already been sent. Create a new one rather than resending it.");
  }
  if (!offer.candidateEmail.trim()) {
    throw new Error("This offer has no candidate email address, so it cannot be sent.");
  }

  const template: OfferTemplate = offer.templateId
    ? await getOfferTemplate(offer.templateId)
    : await defaultOfferTemplate();

  const fields = offerFields(offer);
  const sender = resolveOfferSender();
  const subject = offerSubject(offer);

  // The email gets the mark as an absolute URL, not the data URI the PDF uses: Gmail and Outlook
  // both drop `data:` images, and it has to be absolute because the message is read far away from
  // this server. The production host is correct even when sending from staging — the asset is
  // public, and a candidate's mail client must be able to fetch it.
  const { html, text } = renderOfferEmail(
    { blocks: template.blocks, theme: template.theme },
    fields,
    { logoUrl: options.logoUrl ?? satoLogoUrl(systemDeployment.productionUrl) },
  );

  // ── The attachment, and what happens when Chromium is not there ──
  // Degrade rather than fail. A missing Chromium in some environment must not stop HR sending an
  // offer — the whole letter is already in the email body. But it is never silent: the caller
  // gets a warning to show, because an email that says "see the attached PDF" with nothing
  // attached is worse than one that never mentioned an attachment.
  let attachments: { content: string; contentType: string; filename: string }[] | undefined;
  let attachmentWarning: string | null = null;

  if (await isOfferPdfAvailable()) {
    try {
      const pdf = await renderOfferPdf(
        {
          blocks: template.blocks,
          fontFamily: template.fontFamily,
          fontSizePt: template.fontSizePt,
          theme: template.theme,
          variant: template.variant,
        },
        fields,
        { logoUrl: options.logoUrl },
      );
      attachments = [
        {
          content: Buffer.from(pdf).toString("base64"),
          contentType: "application/pdf",
          filename: offerPdfFilename(offer),
        },
      ];
    } catch (error) {
      attachmentWarning =
        "The offer PDF could not be rendered, so the email was sent with the letter in the body only.";
      console.log("Offer PDF render failed; sending body-only", {
        level: "warning",
        tags: { component: "offers" },
        extra: { offerId, message: error instanceof Error ? error.message : String(error) },
      });
    }
  } else {
    attachmentWarning =
      "Headless Chromium is not available in this environment, so the email was sent with the letter in the body only.";
  }

  const result = await sendPhoenixEmail({
    attachments,
    // A candidate has no employee record, so their address is unknown to the Recipient Assurance
    // Guard by definition. Without this declaration every offer would be blocked as an
    // unrecognised recipient.
    externalRecipients: [offer.candidateEmail],
    from: sender.from,
    html,
    idempotencyKey: offerIdempotencyKey(offer.id),
    origin: {
      eventType: "offer_letter",
      module: "offers",
      notificationType: "offer_letter",
    },
    replyTo: sender.replyTo,
    subject,
    text,
    to: [offer.candidateEmail],
  });

  const skipped = result.skipped === true;
  const skippedReason = skipped ? (result as { reason: string }).reason : null;

  // Only stamp the row when the mail actually left. Marking a suppressed send as "sent" would
  // hide, permanently, the one case where a candidate never received their offer — and the row
  // can never be edited or resent afterwards.
  const stamped = skipped
    ? offer
    : await markOfferSent(
        offer.id,
        {
          blocks: template.blocks,
          fontFamily: template.fontFamily,
          fontSizePt: template.fontSizePt,
          theme: template.theme,
          // The skin goes into the snapshot too. Without it a sent executive offer would re-render
          // as the classic letter the next time HR downloaded a copy of it.
          variant: template.variant,
        },
        options.sentBy ?? null,
      );

  return {
    attachmentIncluded: Boolean(attachments),
    attachmentWarning,
    from: sender.from,
    offer: stamped,
    recipient: offer.candidateEmail,
    senderConfigured: sender.isConfigured,
    skipped,
    skippedReason,
    subject,
  };
}
