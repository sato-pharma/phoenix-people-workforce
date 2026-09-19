import { systemLegalEntity } from "@/config/system-settings";
import { receivingDomain, toReceivableAddress, toReceivableHeader } from "@/lib/email/receivable-address";

/**
 * Who a job offer comes FROM.
 *
 * The owner's instruction, verbatim: "when sending official job offers, I don't want to use
 * Phoenix Identity. I want to use Sato Pharma corporate pharmaceutical company." Phoenix is the
 * internal workforce system; a person receiving an offer has never heard of it, and an offer of
 * employment that arrives branded as somebody's HR software reads as a phishing attempt.
 *
 * So an offer is the third thing in this codebase that speaks as the company rather than as the
 * product — the other two being the employment contract and social-insurance Form 1, which read
 * the same `systemLegalEntity`. Everything visible to the candidate (From name, letterhead,
 * signature block, footer) is Sato; nothing says Phoenix.
 *
 * ── On DNS, and why an offer is sent FROM the apex ──
 * `send.satopharma.com` is SPF/DKIM-verified, but it is a SENDING-ONLY host: its MX is Amazon SES's
 * bounce collector, so it owns no mailboxes. An offer that named it as its From address made every
 * reply that skipped the Reply-To header — a client that ignores it, a provider that drops it (Resend
 * did, #4090), a forwarded copy — bounce with "this mailbox is not available", twice, to real
 * candidates. So the From and the Reply-To of an offer are both mapped onto the apex, where the
 * mailboxes are (`toReceivableAddress`), whatever the environment says. The apex is verified in
 * Resend too (the Sato Email Composer already sends from it), so authentication is unchanged.
 * A candidate WILL reply to an offer, and a reply that bounces is worse than no offer at all.
 */

/** Display name on the From header. The company as it appears on legal paperwork. */
export const OFFER_SENDER_NAME = systemLegalEntity.legalNameEn;

/**
 * Fallback mailbox, used only when `JOB_OFFER_EMAIL_FROM` is unset.
 *
 * On the apex, where `hr@` is a real mailbox — never on the sending subdomain, which cannot
 * receive (see the note above).
 */
const fallbackOfferFromEmail = `hr@${receivingDomain}`;

/** Where a candidate's reply lands. The apex domain, like every other Reply-To here. */
const fallbackOfferReplyTo = "hr@satopharma.com";

export type OfferSender = {
  /** Fully-formed From header: `Sato Pharma <hr@satopharma.com>`. */
  from: string;
  /** True when the address came from configuration rather than the placeholder default. */
  isConfigured: boolean;
  replyTo: string;
};

/**
 * The From/Reply-To pair for an offer email.
 *
 * `JOB_OFFER_EMAIL_FROM` has existed in `.env.example`, `docs/environment.md` and the Railway
 * secret sync since before this module — scaffolded, synced to production, and read by nothing.
 * This is its first consumer. It may hold either a bare address or a full `Name <addr>` header;
 * a bare address gets the company name attached, because a From header with no display name is
 * the single strongest "this is automated" signal a mail client shows.
 */
export function resolveOfferSender(): OfferSender {
  const configured = (process.env.JOB_OFFER_EMAIL_FROM ?? "").trim();
  const replyTo = toReceivableAddress((process.env.JOB_OFFER_REPLY_TO ?? "").trim() || fallbackOfferReplyTo);

  if (!configured) {
    return {
      from: `${OFFER_SENDER_NAME} <${fallbackOfferFromEmail}>`,
      isConfigured: false,
      replyTo,
    };
  }

  const from = toReceivableHeader(
    configured.includes("<") ? configured : `${OFFER_SENDER_NAME} <${configured}>`,
  );

  return { from, isConfigured: true, replyTo };
}

/**
 * The company block printed on the offer itself — letterhead, signature and footer.
 *
 * Read from `systemLegalEntity` rather than retyped so that the offer, the employment contract
 * and Form 1 can never disagree about the employer's own name or registered address. A candidate
 * who receives an offer naming one entity and then a contract naming another has a real reason
 * to ask what they are signing.
 */
export function offerCompanyIdentity() {
  return {
    addressAr: systemLegalEntity.headOfficeAr,
    legalNameAr: systemLegalEntity.legalNameAr,
    legalNameEn: systemLegalEntity.legalNameEn,
    responsibleManagerAr: systemLegalEntity.responsibleManagerAr,
  };
}
