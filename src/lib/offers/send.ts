import { defaultOfferTemplate, getOffer, getOfferTemplate, markOfferSent, setOfferStatus } from "@/lib/offers/service";
import { isOfferPdfAvailable, offerPdfFilename, renderOfferPdf } from "@/lib/offers/pdf";
import { renderOfferEmail } from "@/lib/offers/render-email";
import { issueOfferAcceptToken, offerAcceptUrl } from "@/lib/offers/accept-token";
import { OFFER_SEAT_REQUIRED_MESSAGE, OFFER_START_DATE_REQUIRED_MESSAGE, offerRequiresSeat } from "@/lib/offers/joining-form";
import { offerHireDate } from "@/lib/offers/hire-draft";
import { resolveOfferSender } from "@/lib/offers/identity";
import { SATO_LOGO_CID_SRC, satoLogoAttachment, satoLogoUrl } from "@/lib/offers/brand";
import { planOfferCopies, type OfferCopyPlan } from "@/lib/offers/copy-recipients";
import { offerBccWithOwnerCopy } from "@/lib/offers/owner-copy";
import { systemDeployment } from "@/config/system-settings";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { jobOfferSmtpDispatch } from "@/lib/email/job-offer-smtp";
import type { SendPhoenixEmailAttachment } from "@/lib/email/send-phoenix-email";
import type { OfferFields, OfferRecord, OfferTemplate } from "@/lib/offers/types";
import { offerResendIdempotencyKey, offerResendRefusal } from "@/lib/offers/resend-rules";
import { offerSendRefusal } from "@/lib/offers/approval-rules";
import { offerAcceptsByReply, offerIdempotencyKeyFor, offerSubjectFor, offerUpdateNote } from "@/lib/offers/revision-rules";
import {
  offerExpiryIdempotencyKey,
  offerExpiryRefusal,
  offerExpirySubject,
  renderOfferExpiryNotice,
} from "@/lib/offers/expiry-notice";

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
  /** Who was copied secretly, exactly as handed to the provider. */
  bcc: string[];
  /** Who was copied openly, exactly as handed to the provider. */
  cc: string[];
  /** Redundant copies left off (the candidate's own address, a CC repeated on BCC) — shown to HR. */
  copyNotes: string[];
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
    roleSummary: offer.roleSummary,
    salutationName: offer.salutationName,
    startDate: offer.startDate,
    territory: offer.territory,
    title: offer.title,
    totalMonthly: offer.totalMonthly,
    validUntil: offer.validUntil,
  };
}

export function offerSubject(offer: Pick<OfferRecord, "revision" | "title">): string {
  // An updated offer says so first (owner, 2026-11-10), so it is never read as a copy of the first one.
  return offerSubjectFor(offer.title, offer.revision ?? 0);
}

/**
 * A stable idempotency key.
 *
 * Keyed on the offer id alone, deliberately. Two clicks on Send, or a retry after a browser
 * timeout, must not put two offer letters in a candidate's inbox — and there is no legitimate
 * reason to send the same offer row twice. (`markOfferSent` guards the same thing at the database
 * end with its draft precondition; this guards the mail itself.)
 */
export function offerIdempotencyKey(offerId: string, revision = 0): string {
  // Each updated version gets its own key (owner, 2026-11-10: "i may need to update a job offer"):
  // re-used, the provider would answer an update with the first letter. Revision 0 is unchanged.
  return offerIdempotencyKeyFor(offerId, revision);
}

/** The five things a letter's look is made of — a live template, or the snapshot frozen at send. */
type OfferLetterDesign = Pick<OfferTemplate, "blocks" | "fontFamily" | "fontSizePt" | "theme" | "variant">;

type OfferLetterDelivery = Omit<OfferSendOutcome, "offer" | "recipient">;

/**
 * `approvedByHrManager: true` is REQUIRED, never defaulted (owner, 2026-11-10: "she never automatic sent. My
 * approval first"). The only caller is the Send route, and it passes it only for a person holding
 * `offers:approve` — everybody else's Send parks the offer with `markOfferPendingApproval` instead.
 * A new caller has to say, in its own code, that an approver pressed the button.
 */
export async function sendOfferEmail(
  offerId: string,
  options: { approvedByHrManager: true; bcc?: unknown; cc?: unknown; logoUrl?: string; sentBy?: string | null },
): Promise<OfferSendOutcome> {
  if (options?.approvedByHrManager !== true) {
    throw new Error("A job offer is emailed only on the HR Manager's approval.");
  }
  const offer = await getOffer(offerId);

  const refusal = offerSendRefusal(offer.status, true);
  if (refusal) {
    throw new Error(refusal);
  }
  if (!offer.candidateEmail.trim()) {
    throw new Error("This offer has no candidate email address, so it cannot be sent.");
  }
  // A sales offer names its organogram seat before it leaves (owner, 2026-10-08), because the
  // candidate's joining form places him in that seat — a Medical Rep or District Manager letter with
  // no seat would produce a record with no line, area, region or manager.
  if (offerRequiresSeat(offer.title) && !offer.vacancyId) {
    throw new Error(OFFER_SEAT_REQUIRED_MESSAGE);
  }
  // Every offer names its start date before it leaves (owner, 2026-10-08): the joining form records
  // it as the first day and makes no record without one, so a dateless letter's button could only
  // ever answer "your start date is being confirmed". Read the way the form reads it.
  if (!offerHireDate(offer.startDate)) {
    throw new Error(OFFER_START_DATE_REQUIRED_MESSAGE);
  }

  // Judged again here, whatever the screen showed: this is the last point before mail leaves, and
  // a bad address refuses the WHOLE send rather than going out to everyone else without it.
  const copies = planOfferCopies({ bcc: options.bcc, candidateEmail: offer.candidateEmail, cc: options.cc });
  if (copies.problems.length > 0) {
    throw new Error(`The offer cannot be sent. ${copies.problems.join(" ")}`);
  }

  const template: OfferTemplate = offer.templateId
    ? await getOfferTemplate(offer.templateId)
    : await defaultOfferTemplate();

  const delivery = await deliverOfferLetter(offer, template, {
    copies,
    idempotencyKey: offerIdempotencyKey(offer.id, offer.revision ?? 0),
    logoUrl: options.logoUrl,
  });

  // Only stamp the row when the mail actually left. Marking a suppressed send as "sent" would
  // hide, permanently, the one case where a candidate never received their offer — and the row
  // can never be edited afterwards.
  const stamped = delivery.skipped
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
        // Exactly what was handed to the provider above, so the Offers list can never name a copy
        // that was not sent, or miss one that was.
        { bcc: copies.bcc, cc: copies.cc },
      );

  return { ...delivery, offer: stamped, recipient: offer.candidateEmail };
}

/**
 * Send a SENT offer's letter again — the same letter, to the same address (owner, 2026-09-28).
 *
 * Rendered from `templateSnapshot`, the design frozen at the first send, never from today's
 * template: a resend must be the letter the candidate was already promised. The offer row is not
 * touched — no status change, no new `sent_at`, no new snapshot. The route writes the audit row.
 */
export async function resendOfferEmail(
  offerId: string,
  options: { logoUrl?: string; requestId: string },
): Promise<OfferSendOutcome> {
  const offer = await getOffer(offerId);
  const refusal = offerResendRefusal(offer);
  if (refusal || !offer.templateSnapshot) {
    throw new Error(refusal ?? "This offer cannot be resent.");
  }

  // A snapshot taken before a second design existed carries no `variant`, and every such offer was
  // classic (types.ts) — so absent means classic, the letter the candidate was actually sent.
  const design: OfferLetterDesign = { ...offer.templateSnapshot, variant: offer.templateSnapshot.variant ?? "classic" };

  const delivery = await deliverOfferLetter(offer, design, {
    // The candidate only. The CC/BCC typed for the first send are not kept on the offer, and a
    // resend is for the person who never received the letter — not a second round of copies.
    copies: planOfferCopies({ candidateEmail: offer.candidateEmail }),
    idempotencyKey: offerResendIdempotencyKey(offer.id, options.requestId),
    logoUrl: options.logoUrl,
  });

  return { ...delivery, offer, recipient: offer.candidateEmail };
}

async function deliverOfferLetter(
  offer: OfferRecord,
  template: OfferLetterDesign,
  options: { copies: OfferCopyPlan; idempotencyKey: string; logoUrl?: string },
): Promise<OfferLetterDelivery> {
  const { copies } = options;
  const fields = offerFields(offer);
  const sender = resolveOfferSender();
  const subject = offerSubject(offer);

  // ── The mark travels INSIDE the message (2026-09-17) ──
  // Not the data URI the PDF uses — Gmail and Outlook really do strip those — and no longer the
  // absolute https URL either. A remote image is drawn only if the reader's client agrees to go
  // and fetch it, and Outlook, Yahoo/Turbify webmail and Gmail all withhold that by default for a
  // sender nobody has whitelisted; the owner's BCC copy of SP-HR-MR-2026-005 showed the torn-page
  // placeholder and the alt text where the Sato mark belongs. An inline `cid:` part is carried by
  // the message itself, so there is nothing to fetch and nothing to withhold.
  //
  // The https URL stays as the fallback, for the one case where the PNG cannot be read off disk
  // (and for Brevo, which has no Content-ID field — see `brevoInlineFallback`). The production
  // host is correct even when sending from staging: the asset is public.
  const mark = satoLogoAttachment(systemDeployment.productionUrl);

  // ── The Accept button (owner, 2026-10-08) ──
  // A signed link to this offer's joining form. A send and a resend each mint their own, and every
  // one of them opens the same form, because the offer row — not the token — decides whether it may
  // still be filled. Without a signing secret the letter still goes, just without the button: the
  // candidate can always reply, and a missing button must never stop an offer.
  let acceptUrl: string | undefined;
  // An accepted offer updated after negotiation (owner, 2026-11-10) goes to somebody already on the
  // Employee Master: the joining form would only say it was completed, so no button — they reply.
  const acceptByReply = offerAcceptsByReply(offer);
  try {
    if (!acceptByReply) acceptUrl = offerAcceptUrl(issueOfferAcceptToken({ offerId: offer.id, validUntil: offer.validUntil }));
  } catch (error) {
    console.log("Offer accept link could not be minted; sending without the button", {
      level: "warning",
      tags: { component: "offers" },
      extra: { offerId: offer.id, message: error instanceof Error ? error.message : String(error) },
    });
  }

  // HR's own words, and — on an updated offer — which letter it replaces (owner, 2026-11-10). Both
  // travel in the EMAIL body only; the PDF is the letter itself and stays exactly as designed.
  const history = offer.revisionHistory ?? [];
  const updateNote = (offer.revision ?? 0) > 0 ? offerUpdateNote(history[history.length - 1]?.sentAt ?? null, { acceptByReply }) : undefined;

  const { html, text } = renderOfferEmail(
    { blocks: template.blocks, theme: template.theme },
    fields,
    {
      acceptUrl,
      message: offer.emailMessage?.trim() || undefined,
      updateNote,
      logoUrl: options.logoUrl ?? (mark ? SATO_LOGO_CID_SRC : satoLogoUrl(systemDeployment.productionUrl)),
    },
  );

  // The letterhead part rides along only when the body actually points at it — an override in
  // `options.logoUrl` means the caller chose its own mark and this one would arrive as a stray
  // file on an offer letter.
  const inlineMark = !options.logoUrl && mark ? [mark] : [];

  // ── The attachment, and what happens when Chromium is not there ──
  // Degrade rather than fail. A missing Chromium in some environment must not stop HR sending an
  // offer — the whole letter is already in the email body. But it is never silent: the caller
  // gets a warning to show, because an email that says "see the attached PDF" with nothing
  // attached is worse than one that never mentioned an attachment.
  let pdfAttachment: SendPhoenixEmailAttachment | undefined;
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
      pdfAttachment = {
        content: Buffer.from(pdf).toString("base64"),
        contentType: "application/pdf",
        filename: offerPdfFilename(offer),
      };
    } catch (error) {
      attachmentWarning =
        "The offer PDF could not be rendered, so the email was sent with the letter in the body only.";
      console.log("Offer PDF render failed; sending body-only", {
        level: "warning",
        tags: { component: "offers" },
        extra: { offerId: offer.id, message: error instanceof Error ? error.message : String(error) },
      });
    }
  } else {
    attachmentWarning =
      "Headless Chromium is not available in this environment, so the email was sent with the letter in the body only.";
  }

  // The letterhead part first, the letter second — the order a reader's client uses to decide
  // which parts are decoration and which are the attachment it lists.
  const attachments = [...inlineMark, ...(pdfAttachment ? [pdfAttachment] : [])];

  // HR's BCC plus the owner's hidden copy of every job offer (owner, 2026-11-10: "Yes, job offers
  // only") — a send, an updated offer and a resent letter alike. Never stored on the offer: see owner-copy.ts.
  const bcc = offerBccWithOwnerCopy({ bcc: copies.bcc, candidateEmail: offer.candidateEmail, cc: copies.cc });

  const result = await sendPhoenixEmail({
    attachments: attachments.length > 0 ? attachments : undefined,
    bcc: bcc.length > 0 ? bcc : undefined,
    cc: copies.cc.length > 0 ? copies.cc : undefined,
    // A candidate has no employee record, so their address is unknown to the Recipient Assurance
    // Guard by definition. Without this declaration every offer would be blocked as an
    // unrecognised recipient.
    //
    // The copies are declared too. HR typed each one for this send a moment ago, and the owner
    // ruled that an offer may be copied to anyone without a reason (2026-09-28) — so an outside
    // address on CC is intended, not a typo the guard should catch. Its shape was already checked
    // by `planOfferCopies` above.
    // Through the real hr@ mailbox on Turbify when its app password is set (owner, 2026-11-06) —
    // undefined otherwise, which keeps the provider chain exactly as it was. No fall back to Resend.
    dispatch: jobOfferSmtpDispatch(),
    externalRecipients: [offer.candidateEmail, ...copies.cc, ...bcc],
    from: sender.from,
    html,
    idempotencyKey: options.idempotencyKey,
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

  return {
    // The PDF, and only the PDF. The letterhead mark is an inline part, not something HR should
    // ever be told "was attached" — reporting it here would turn a failed PDF render into a
    // silently reassuring "attachment included".
    attachmentIncluded: Boolean(pdfAttachment),
    attachmentWarning,
    bcc: copies.bcc,
    cc: copies.cc,
    copyNotes: copies.notes,
    from: sender.from,
    senderConfigured: sender.isConfigured,
    skipped,
    skippedReason,
    subject,
  };
}

/**
 * Tell a SENT offer's candidate it has expired, and withdraw the offer (owner, 2026-10-07).
 *
 * The candidate-facing half that Withdraw never had: `withdrawOffer` flips the row to `withdrawn`
 * silently, and the person who was sent a letter is told nothing. This sends the short Sato-branded
 * notice (`renderOfferExpiryNotice`, never the frozen offer letter) to the same address the offer
 * went to, then — only when the notice actually left — marks the offer withdrawn so it can no longer
 * be accepted or resent.
 *
 * ── Manual, one offer at a time ──
 * Reached only from a confirmed button press on a single sent offer. It is deliberately NOT a batch,
 * a planner or a cron, which is what keeps it inside the standing rule that a rejection-style notice
 * is never sent automatically.
 *
 * The admin Telegram mirror and the Sato From/Reply-To come from the shared send path and
 * `resolveOfferSender()`, exactly as the offer letter's do. The route writes the audit row.
 */
export async function expireOfferEmail(offerId: string): Promise<OfferSendOutcome> {
  const offer = await getOffer(offerId);
  const refusal = offerExpiryRefusal(offer);
  if (refusal) throw new Error(refusal);

  const sender = resolveOfferSender();
  const subject = offerExpirySubject(offer);

  // The Sato mark as an inline `cid:` part, exactly as the letter carries it — a remote image a
  // reader's client declines to fetch leaves a torn-page placeholder (2026-09-17). The https URL is
  // the fallback for the one case where the PNG cannot be read off disk.
  const mark = satoLogoAttachment(systemDeployment.productionUrl);
  const { html, text } = renderOfferExpiryNotice(offer, {
    logoSrc: mark ? SATO_LOGO_CID_SRC : satoLogoUrl(systemDeployment.productionUrl),
  });

  const result = await sendPhoenixEmail({
    attachments: mark ? [mark] : undefined,
    // A candidate has no employee record, so their address is unknown to the Recipient Assurance
    // Guard — it must be declared here or the notice is blocked as an unrecognised recipient, the
    // same declaration the offer letter makes.
    // The same hr@ mailbox the letter left from, when its app password is set (owner, 2026-11-06).
    dispatch: jobOfferSmtpDispatch(),
    externalRecipients: [offer.candidateEmail],
    from: sender.from,
    html,
    idempotencyKey: offerExpiryIdempotencyKey(offer.id),
    origin: {
      eventType: "offer_expired",
      module: "offers",
      notificationType: "offer_expired",
    },
    replyTo: sender.replyTo,
    subject,
    text,
    to: [offer.candidateEmail],
  });

  const skipped = result.skipped === true;
  const skippedReason = skipped ? (result as { reason: string }).reason : null;

  // Only retire the offer when the notice actually left. A suppressed notice (testing mode,
  // unsubscribe, confidence-gate hold) must not silently withdraw a live offer the candidate was
  // never told about — the button is still there to try again.
  const stamped = skipped ? offer : await setOfferStatus(offer.id, "withdrawn");

  return {
    attachmentIncluded: false,
    attachmentWarning: null,
    bcc: [],
    cc: [],
    copyNotes: [],
    from: sender.from,
    offer: stamped,
    recipient: offer.candidateEmail,
    senderConfigured: sender.isConfigured,
    skipped,
    skippedReason,
    subject,
  };
}
