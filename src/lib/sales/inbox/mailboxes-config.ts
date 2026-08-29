// Sales mailbox intake — which mailbox the distributor workbooks arrive in (pure, no I/O).
//
// SALES_EMAIL_INBOXES_JSON has the same shape as RECRUITMENT_EMAIL_INBOXES_JSON and is parsed by
// the same shared code, so a mailbox is configured the same way whichever poller reads it:
//
//   [{"label":"sales","host":"imap.mail.yahoo.com","port":993,"secure":true,
//     "user":"sales@satopharma.com","password":"<app password>"}]
//
// It is a SEPARATE variable rather than a flag on the recruitment one for a reason worth keeping:
// the two pollers do entirely different things with a message, and a mailbox listed in the wrong
// variable would have its attachments run through the wrong pipeline — a distributor's workbook
// read as a CV, or an applicant's CV parked in the sales-imports bucket. Two variables make that
// mistake impossible to make silently.
//
// UNSET IS THE NORMAL STARTING STATE, and it is inert: no mailboxes, no polling, no arrivals, no
// error. That matters because the credential this needs cannot be issued from here — Turbify
// (Yahoo) app passwords are created browser-side from inside each mailbox, so somebody has to go
// and make one before this can ever read anything. Until they do, the feature is quiet, not broken.

import { parseMailboxesConfig, type MailboxConnection } from "@/lib/email-intake/mailbox-config";

export type SalesMailboxConfig = MailboxConnection;

/**
 * Parses SALES_EMAIL_INBOXES_JSON. Never throws — a malformed value disables the intake rather
 * than failing the cron job every cycle.
 */
export function parseSalesEmailInboxesConfig(json: string | undefined | null): SalesMailboxConfig[] {
  return parseMailboxesConfig<SalesMailboxConfig>(json, (base) => base);
}

export function loadSalesMailboxes(): SalesMailboxConfig[] {
  return parseSalesEmailInboxesConfig(process.env.SALES_EMAIL_INBOXES_JSON);
}
