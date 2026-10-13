import { receivingDomain, sendingOnlyDomain } from "@/lib/email/receivable-address";
import { senderAddressOf } from "@/lib/email/job-offer-sender";

/**
 * The HR sending account is DEDICATED to the mail that speaks as a person.
 *
 * Owner rule, 2026-10-13: "make it and hrbp dedicated only for job offers + sato email composer" —
 * `it` being `hr@satopharma.com`, the address a job offer now fires from
 * (`job-offer-sender.ts`), and `hrbp@` the Sato Email Composer's.
 *
 * ── Why he asked for it ──
 * Resend's FIRST account is the only one holding `satopharma.com` and `send.satopharma.com`
 * verified, so it is the only account that can send as `hr@`, `hrbp@` or `ceo@` — and it was also
 * the first stop for every automated Phoenix notification. Measured on production 2026-10-13:
 * 404 messages went through Resend on 11 October and 381 on 12 October, against a daily quota of
 * about 100, so the account was capped most days. That is why 30 of the last 63 offer messages
 * were sent by a BACKUP account and 18 of them went out branded *Phoenix Workforce*: the payslip
 * and notification traffic had spent the quota that the offer needed.
 *
 * ── What this does ──
 * An ordinary Phoenix notification no longer starts at that account at all; it starts at the
 * extra accounts (`RESEND_EMAIL_FROM_2/3/4`, then Brevo), which send under their own verified
 * addresses and were already carrying the overflow. Mail from a Sato human identity keeps the
 * account to itself.
 *
 * `ceo@` is in this set as well, and that is a judgement rather than his words: the CEO composer's
 * From is `ceo@send.satopharma.com` by his own 2026-10-06 decision, and it is a host only the
 * first account and Brevo can authenticate. Had `ceo@` been treated as ordinary traffic, every CEO
 * letter would have been pushed onto a backup account and re-addressed as `phoenix@send2…` — so
 * leaving it here keeps the CEO letter sending exactly as it does today, which is the one thing
 * this change must not alter.
 */

/** The local parts that speak as a person: HR, the HR business partner, the chief executive. */
const satoIdentityMailboxes = new Set(["hr", "hrbp", "ceo"]);

/** The two Sato hosts. Anything else — an outside domain, `send2…` — is not an identity sender. */
const satoIdentityHosts = new Set([receivingDomain.toLowerCase(), sendingOnlyDomain.toLowerCase()]);

/**
 * Does this From header speak as a Sato person (so the dedicated account is its first stop), or is
 * it ordinary automated Phoenix mail (which must leave that account's quota alone)?
 */
export function isSatoIdentitySender(from: string): boolean {
  const address = senderAddressOf(from);
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  return satoIdentityMailboxes.has(address.slice(0, at)) && satoIdentityHosts.has(address.slice(at + 1));
}
