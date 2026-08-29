// Recruitment / ATS — the recruitment-specific half of the inbound-CV IMAP poll decision logic
// (no I/O, no imapflow runtime dependency — safe to unit-test with plain fixture objects, same
// split as email-message-parser.ts).
//
// The three provider-level decisions that are NOT recruitment-specific — which folders to read,
// which UIDs a run should fetch and where the cursor lands, and which folder is the junk one —
// moved to `@/lib/email-intake/poll-planner` when the sales mailbox intake started needing the
// same rules. They are re-exported here unchanged, so every existing import of this module keeps
// working and each algorithm has exactly one home.
//
// What stays here is what only recruitment means:
//   - the queue key an email maps to in ats_inbound_intake_queue,
//   - the shape of a poll summary and its outcome vocabulary,
//   - WHAT COUNTS AS FAILURE. A mailbox that cannot be reached is an outage, not a quiet 200.

export { junkCursorLabel, pickJunkFolder, planFolderPoll } from "@/lib/email-intake/poll-planner";

export type FolderPollSummary = {
  folderPath: string;
  cursorLabel: string;
  messagesSeen: number;
  /** True when the per-run cap left messages behind — they are picked up by the next run. */
  backlogRemaining: boolean;
  // The poll only ENQUEUES now (the durable worker does the fetch + AI + candidate creation), so a
  // result is "enqueued" (a new queue row) or "duplicate" (already queued — an idempotent re-poll).
  results: Array<{ uid: number; outcome: "enqueued" | "duplicate" }>;
  error?: string;
};

export type MailboxPollSummary = {
  mailboxLabel: string;
  folders: FolderPollSummary[];
  connectionError?: string;
};

// The queue dedupe key for an email. UIDVALIDITY is included so a server-side mailbox rebuild
// (which resets UIDs to 1) can't map a brand-new message onto an old message's key and have the
// queue's unique index silently drop it as a duplicate.
export function emailQueueKey(cursorLabel: string, uidValidity: bigint | number, uid: number): string {
  return `email:${cursorLabel}:${String(uidValidity)}:${uid}`;
}

/**
 * Human-readable failures across a poll run — empty means everything worked.
 *
 * This exists because a swallowed failure is worse than no poller at all: before it, a mailbox
 * whose password had expired produced a summary with `connectionError` set, an HTTP 200, and a
 * green cron monitor, so inbound CV intake could be dead for days while every dashboard said it
 * was healthy. "No mailboxes configured" is deliberately NOT a failure — that is the documented
 * inert state before RECRUITMENT_EMAIL_INBOXES_JSON is set.
 */
export function summarizePollFailures(summaries: readonly MailboxPollSummary[]): string[] {
  const failures: string[] = [];
  for (const mailbox of summaries) {
    if (mailbox.connectionError) {
      // A connection failure already explains every folder under it — listing them too would
      // just repeat one outage N times.
      failures.push(`${mailbox.mailboxLabel}: ${mailbox.connectionError}`);
      continue;
    }
    for (const folder of mailbox.folders) {
      if (folder.error) failures.push(`${mailbox.mailboxLabel}/${folder.folderPath}: ${folder.error}`);
    }
  }
  return failures;
}
