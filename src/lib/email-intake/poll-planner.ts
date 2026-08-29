// Shared IMAP poll planning — pure decision logic, no I/O and no imapflow dependency.
//
// These three functions were written for the recruitment CV poller and are now used by the sales
// mailbox intake as well. They live here rather than in either domain because each one encodes a
// non-obvious rule that must not be re-derived a second time and got subtly wrong:
//
//   - WHICH FOLDERS to read. An INBOX-only poll loses everything the provider filed as spam, and
//     mail from an address the mailbox has never corresponded with, carrying an attachment, is
//     exactly what a consumer spam filter acts on. That describes an applicant's CV and it equally
//     describes a distributor's first monthly sales file.
//   - WHERE THE CURSOR LANDS when a run fetches nothing. See planFolderPoll — the first-run case
//     is the trap, and getting it wrong makes every subsequent run re-walk the whole folder.
//   - WHICH FOLDER IS THE JUNK ONE, across providers that each name it differently.
//
// Domain-specific decisions deliberately stay in the callers: what counts as a message worth
// keeping, what the queue key is, and what a poll summary looks like all differ per domain, and
// sharing those shapes would couple the two pollers without sharing anything real.

/**
 * The junk folder keeps its own cursor row so INBOX's cursor — which on a live mailbox is already
 * tens of thousands of UIDs deep — is never disturbed by adding spam coverage.
 */
export function junkCursorLabel(mailboxLabel: string): string {
  return `${mailboxLabel}:junk`;
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
