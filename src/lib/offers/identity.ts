import { systemEmail, systemLegalEntity } from "@/config/system-settings";

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
 * ── On DNS ──
 * The sending domain `send.satopharma.com` is already SPF/DKIM-verified — Phoenix's own mail has
 * gone out from it for months. SPF and DKIM authenticate the DOMAIN, not the local part, so a new
 * mailbox on that same domain inherits the existing records and needs no DNS change. What it does
 * need is for the address to exist at the ESP as a verified sender, and for the Reply-To mailbox
 * to be real and monitored — a candidate WILL reply to an offer, and a reply that bounces is
 * worse than no offer at all.
 */

/** Display name on the From header. The company as it appears on legal paperwork. */
export const OFFER_SENDER_NAME = systemLegalEntity.legalNameEn;

/**
 * Fallback mailbox, used only when `JOB_OFFER_EMAIL_FROM` is unset.
 *
 * On the already-verified sending subdomain, so an unconfigured environment still sends from an
 * authenticated domain rather than failing SPF. The local part is a placeholder pending the
 * owner's chosen HR address — see `resolveOfferSender`.
 */
const fallbackOfferFromEmail = `hr@${systemEmail.defaultFromEmail.split("@")[1] ?? "send.satopharma.com"}`;

/** Where a candidate's reply lands. The apex domain, like every other Reply-To here. */
const fallbackOfferReplyTo = "hr@satopharma.com";

export type OfferSender = {
  /** Fully-formed From header: `Sato Pharma <hr@send.satopharma.com>`. */
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
  const replyTo = (process.env.JOB_OFFER_REPLY_TO ?? "").trim() || fallbackOfferReplyTo;

  if (!configured) {
    return {
      from: `${OFFER_SENDER_NAME} <${fallbackOfferFromEmail}>`,
      isConfigured: false,
      replyTo,
    };
  }

  const from = configured.includes("<")
    ? configured
    : `${OFFER_SENDER_NAME} <${configured}>`;

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
