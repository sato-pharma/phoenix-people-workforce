// Personal mailbox — how often a person's own routes may log in to their mailbox. Every read and
// every send is a real login against their real Turbify account, and Yahoo locks an account after
// enough failed logins; the needs_reconnect flag stops a dead password being retried, and these
// ceilings stop a stuck browser tab (or a script) from hammering a working one. Keyed per owner,
// so one person's clicking never spends anyone else's budget.

import { assertApiRateLimit } from "@/lib/security/api-rate-limit";

const CEILINGS = {
  /** Pasting an app password: each try is two logins (reading and sending). */
  connect: { limit: 5, windowMs: 10 * 60_000 },
  /** Listing, opening and downloading, together. */
  read: { limit: 40, windowMs: 60_000 },
  send: { limit: 10, windowMs: 60_000 },
} as const;

export async function assertPersonalMailboxCeiling(ownerKey: string, kind: keyof typeof CEILINGS): Promise<void> {
  const ceiling = CEILINGS[kind];
  await assertApiRateLimit({
    identifier: `owner:${ownerKey.toLowerCase()}`,
    limit: ceiling.limit,
    scope: `personal-mailbox:${kind}`,
    windowMs: ceiling.windowMs,
  });
}
