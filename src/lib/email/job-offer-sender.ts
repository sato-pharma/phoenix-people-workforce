import { receivingDomain, sendingOnlyDomain } from "@/lib/email/receivable-address";

/**
 * The two mailboxes a job offer may be sent from, and nothing else.
 *
 * Owner rule, 2026-10-13, verbatim: "all job offers email must only fire from HR@satopharma.com
 * or hr@send.satopharma.com". An offer of employment is the one letter this system sends that a
 * stranger receives before they work here: it is legally binding, it quotes a salary, and the
 * address it arrives from is the only thing the candidate can check it against. Every other
 * Phoenix email may speak as Phoenix from whichever verified sender is available; an offer may
 * not.
 *
 * The rule needs enforcing in TWO places, because an offer's From is decided twice:
 *
 *  1. `resolveOfferSender()` reads `JOB_OFFER_EMAIL_FROM`, which is an environment value anybody
 *     with Railway access can change. A value outside this list is refused there, not used.
 *  2. The PROVIDER chain rewrites the From of any message it hands to a backup account, because a
 *     sending domain can be verified in only one Resend account. Measured on production
 *     2026-10-13: Resend account 1 holds `satopharma.com` AND `send.satopharma.com` verified;
 *     account 2 holds only `send2.satopharma.com`, account 3 only `send3.satopharma.com`, and
 *     Brevo overrides the From outright with `BREVO_EMAIL_FROM`, which is
 *     `Phoenix Workforce <phoenix@send.satopharma.com>`. So an offer sent on a day Resend's first
 *     account was capped left as `Sato Pharma HR <phoenix@send2.satopharma.com>` — or, on Brevo,
 *     as *Phoenix Workforce*, which is the one brand an offer must never wear. An account that
 *     would have to rewrite the From now declines the message instead, so the offer waits for the
 *     account that can send it as HR rather than going out as something else.
 *
 * The addresses are DERIVED from the domain configuration, never retyped: the apex is where the
 * mailboxes live and the `send.` subdomain is the sending-only host (`receivable-address.ts`), so
 * a change of domain cannot leave this list pointing at the old one.
 */

/** The local part, the same on both hosts. */
const jobOfferMailbox = "hr";

/** `hr@satopharma.com` — the apex, where the mailbox really is, and what goes on the wire. */
export const JOB_OFFER_SENDER_ADDRESS = `${jobOfferMailbox}@${receivingDomain}`;

/** Both spellings the owner allows: the apex and the sending subdomain. */
export const JOB_OFFER_SENDER_ADDRESSES: readonly string[] = [
  JOB_OFFER_SENDER_ADDRESS,
  `${jobOfferMailbox}@${sendingOnlyDomain}`,
];

/** The bare address out of a `Name <addr>` header, or the value itself when it is already bare. */
export function senderAddressOf(value: string): string {
  const match = String(value ?? "").match(/<([^>]+)>\s*$/);
  return (match ? match[1] : String(value ?? "")).trim().toLowerCase();
}

/**
 * Is this address (bare or inside a header) one of the two the owner allows for an offer?
 *
 * Case-insensitive: he wrote `HR@satopharma.com`, mailboxes are not case-sensitive in practice,
 * and a capitalised value in the environment must not read as a different address.
 */
export function isJobOfferSender(value: string): boolean {
  const address = senderAddressOf(value);
  return JOB_OFFER_SENDER_ADDRESSES.includes(address);
}
