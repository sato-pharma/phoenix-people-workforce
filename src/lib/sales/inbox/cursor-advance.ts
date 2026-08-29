// Sales mailbox intake — where the UID cursor is allowed to stop.
//
// This is four lines of state, extracted into its own module for one reason: it is the entire
// data-safety property of the poller, and buried inside an IMAP loop it could only ever be checked
// by reading it. Here it can be driven directly by a test.
//
// THE RULE. A message that fails must not be skipped, and it must not stop the messages behind it.
// Those two are separate concerns and this repo has already paid for confusing them:
//
//   • Skip the failure  → its workbook is lost silently. Nobody can know what they were not shown,
//                         because the only record of it was the message the cursor just stepped
//                         over. During a monthly close that is a distributor's sales going missing.
//   • Stop on the failure → the folder stalls behind it. Fifty permanently-exhausted rows held the
//                         head of the notification outbox for thirteen days here while every
//                         dashboard stayed green and every cron returned 200.
//
// So the loop always continues, and the cursor stops at the FIRST failure. Everything after that
// failure is still read and recorded in this run; next run re-reads from the failure onwards, and
// the arrivals table's (mailbox, uidvalidity, uid, index) unique key turns every already-recorded
// one into a `duplicate` — which is precisely the outcome that key exists to produce. Re-reading
// costs a little bandwidth. Skipping costs a distributor's month.

export type CursorTracker = {
  /** Record that `uid` was fully handled. Advances the cursor only while nothing has failed. */
  succeeded: (uid: number) => void;
  /** Record that `uid` could not be handled. Pins the cursor here, permanently for this run. */
  failed: (uid: number) => void;
  /** The UID to persist — every message up to and including it is safely recorded. */
  lastProcessedUid: () => number;
  /** The first UID that failed, or null. A number here means this folder will re-read from it. */
  stalledAtUid: () => number | null;
};

export function createCursorTracker(baselineUid: number): CursorTracker {
  let lastProcessed = baselineUid;
  let stalledAt: number | null = null;

  return {
    failed(uid: number) {
      // FIRST failure only. A later, lower-numbered failure must not drag the cursor backwards,
      // and a later, higher-numbered one must not move the stall point forwards past a message
      // that was never handled.
      if (stalledAt === null) stalledAt = uid;
    },
    lastProcessedUid: () => lastProcessed,
    stalledAtUid: () => stalledAt,
    succeeded(uid: number) {
      // Once anything has failed the cursor is frozen, even for messages that then succeed. Their
      // success is not lost — the arrivals are written — it simply is not allowed to certify that
      // the failed message behind them was dealt with.
      if (stalledAt !== null) return;
      lastProcessed = Math.max(lastProcessed, uid);
    },
  };
}
