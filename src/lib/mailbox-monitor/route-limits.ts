// The ceiling on live IMAP logins against a monitored mailbox — one rule, one place.
//
// Every route that reaches this module's service layer ends in a real LOGIN against a real
// employee's mailbox with the stored credential: opening it, listing a folder, reading a message,
// re-testing the credential, or proving a replacement. None of them consults the row's status
// first, and the dashboard leaves Open and Re-check enabled on a failing row — so a mailbox whose
// app password has been revoked can be hammered with failed logins by ordinary clicking.
//
// That matters more here than the usual rate-limit reasons. Yahoo/Turbify locks an account out
// after enough failed logins, and a locked-out mailbox is the ONE thing that would make compliance
// reading visible to the person whose mail is being read — the exact opposite of the silence
// guarantee the whole module is built on (see imap-client.ts). A ceiling on one of the five paths
// is not a ceiling, which is why this lives here rather than inline in the route that needed it
// first.
//
// Keyed per ACTOR and per MAILBOX: one runaway mailbox must not spend another mailbox's budget,
// and mailbox_monitor is Super-Admin-only, so an actor-only key would be one global bucket.

import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

/** Ten live logins per mailbox per minute, per actor. Matches the add path's ceiling. */
const IMAP_LOGINS_PER_MINUTE = 10;

export async function assertMailboxImapCeiling(input: {
  actor: string | null | undefined;
  monitorId: string;
  request: Request;
  /** What the caller is about to do, e.g. "mailbox-monitor:open". Kept per-path so one noisy
   *  operation cannot exhaust the budget another one needs. */
  scope: string;
}): Promise<void> {
  await assertApiRateLimit({
    identifier: `${rateLimitIdentity({ actor: input.actor, request: input.request })}:${input.monitorId}`,
    limit: IMAP_LOGINS_PER_MINUTE,
    scope: input.scope,
    windowMs: 60_000,
  });
}
