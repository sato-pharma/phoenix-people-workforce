import { ADMIN_STANDING_EMAIL } from "@/lib/email/admin-telegram-mirror";

/**
 * The owner's hidden copy of every job offer (owner, 2026-11-10: "all job offers i am by default in
 * the bcc", then "Yes, job offers only").
 *
 * Until 2026-11-06 every automated email blind-copied him, offers included. "Stop the BCC copies" took
 * that away from all of them at once — about 8,000 a month were teaching Yahoo that satopharma.com mail
 * is junk — and offers lost his copy with the rest; 9 went out without him before he noticed. This puts
 * it back for job offers ALONE, a handful a day. Every other automated email stays without it, and the
 * generic send path (`send-phoenix-email.ts`) still adds no standing copy: the offer adds its own.
 *
 * Added at delivery, after HR's copies were planned, so it never uses one of HR's ten places
 * (`OFFER_COPY_MAX`) and is never stored on the offer — an update or a resend adds it afresh.
 */
export const OFFER_OWNER_BCC = ADMIN_STANDING_EMAIL;

/**
 * The BCC an offer letter is handed to the provider with: HR's own BCC, then the owner — unless he is
 * already the candidate, on the CC line or in HR's BCC, where a second copy would change nothing.
 */
export function offerBccWithOwnerCopy(input: { bcc: readonly string[]; candidateEmail: string; cc: readonly string[] }): string[] {
  const owner = OFFER_OWNER_BCC.toLowerCase();
  const already = [input.candidateEmail, ...input.cc, ...input.bcc].some((address) => address.trim().toLowerCase() === owner);
  return already ? [...input.bcc] : [...input.bcc, OFFER_OWNER_BCC];
}
