// Recruitment / ATS — pure decision logic for the inbound-CV IMAP poll (no I/O, no imapflow
// runtime dependency — safe to unit-test with plain fixture objects, same split as
// email-message-parser.ts).
//
// Three decisions live here because each one has already caused, or would cause, a silent loss of
// real candidates:
//   - WHICH FOLDERS to read. An INBOX-only poll loses every CV the provider files as spam, and
//     applicant mail (unknown sender + attachment) is exactly what spam filters act on.
//   - WHICH MESSAGES to read. A first-ever poll of a folder must not walk its whole history, and
//     a capped run must leave the remainder for the next run instead of skipping past it.
//   - WHAT COUNTS AS FAILURE. A mailbox that cannot be reached is an outage, not a quiet 200.

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

/**
 * The junk folder keeps its own cursor row so INBOX's cursor — which on the live mailbox is
 * already tens of thousands of UIDs deep — is never disturbed by adding spam coverage.
 */
export function junkCursorLabel(mailboxLabel: string): string {
  return `${mailboxLabel}:junk`;
}

// The queue dedupe key for an email. UIDVALIDITY is included so a server-side mailbox rebuild
// (which resets UIDs to 1) can't map a brand-new message onto an old message's key and have the
// queue's unique index silently drop it as a duplicate.
export function emailQueueKey(cursorLabel: string, uidValidity: bigint | number, uid: number): string {
  return `email:${cursorLabel}:${String(uidValidity)}:${uid}`;
}

// Yahoo (the live provider here) names its spam folder "Bulk Mail"; Gmail uses "[Gmail]/Spam",
// Outlook "Junk Email". SPECIAL-USE \Junk is the reliable signal when the server advertises it,
// so prefer that and fall back to name matching only when it does not.
const JUNK_NAME_PATTERN = /^(bulk(\s+mail)?|junk(\s+e-?mail)?|spam)$/i;

export function pickJunkFolder(
  folders: ReadonlyArray<{ path: string; specialUse?: string; name?: string }>,
): string | null {
  const bySpecialUse = folders.find((folder) => folder.specialUse === "\\Junk");
  if (bySpecialUse) return bySpecialUse.path;
  const byName = folders.find((folder) => JUNK_NAME_PATTERN.test((folder.name ?? folder.path).trim()));
  return byName ? byName.path : null;
}

/**
 * Decides which UIDs this run should fetch and where the cursor lands afterwards.
 *
 * `baselineUid` is the subtle part. It is where the cursor must be written when this run fetches
 * nothing. On a normal run that is simply the existing cursor. On a FIRST run it is
 * `uidNext - 1` — everything already sitting in the folder is older than the backfill window and
 * has to be written off, because otherwise the next run would find a cursor of 0, no longer look
 * like a first run, and re-walk the entire folder from UID 1.
 */
export function planFolderPoll(input: {
  candidateUids: readonly number[];
  isFirstRun: boolean;
  lastProcessedUid: number;
  maxMessages: number;
  uidNext: number;
}): { uids: number[]; baselineUid: number; backlogRemaining: boolean } {
  const floor = input.isFirstRun ? 0 : input.lastProcessedUid;
  const ordered = [...input.candidateUids].filter((uid) => uid > floor).sort((left, right) => left - right);
  const uids = ordered.slice(0, Math.max(0, input.maxMessages));

  const emptyBaseline = input.isFirstRun ? Math.max(0, input.uidNext - 1) : input.lastProcessedUid;
  // When messages ARE fetched the cursor is driven by the highest UID actually processed (the
  // caller tracks that); this baseline only has to guarantee it never moves backwards.
  const baselineUid = uids.length > 0 ? Math.min(...uids) - 1 : emptyBaseline;

  return { backlogRemaining: ordered.length > uids.length, baselineUid, uids };
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
