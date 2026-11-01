/**
 * Phoenix CRM — when the Place checks page reads itself again after a decision.
 *
 * 🔴 ONE RE-READ FOR A RUN OF DECISIONS, NOT ONE EACH (2026-11-01, "fix the portal home slow opens").
 * Every saved decision used to rebuild the whole page at once. That page is the heaviest read in the
 * module: on Sunday 1 Nov 2026 one build was 250+ database reads and 10 to 27 seconds, a reviewer decides
 * every 12 to 30 seconds, so the builds overlapped — and while they ran, every read in the company took
 * about four times as long (a sign-in read went from 47 ms to 191 ms), the field's portal home included.
 *
 * So a decision only asks for a re-read, and the re-read waits until the decisions have stopped for
 * `quietMs`. Nothing a reviewer needs is lost in the wait: the control has already drawn its saved outcome
 * (`useSavedOutcome`, owner, 2026-10-24), which holds until the re-read hands the row back.
 *
 * It lives apart from the hook, with its clock passed in, so a test can run the real day's decisions.
 */

export const PLACE_CHECK_REREAD_QUIET_MS = 30_000;

type Clock<Handle> = { clear: (handle: Handle) => void; set: (run: () => void, ms: number) => Handle };

export type PlaceCheckReread = {
  /** A decision was saved. Whatever was waiting waits again, from now. */
  ask: (read: () => void) => void;
  /** The reviewer is back on the board: read now if a decision is waiting, and do nothing if none is. */
  flush: () => void;
};

export function createPlaceCheckReread<Handle>(clock: Clock<Handle>, quietMs = PLACE_CHECK_REREAD_QUIET_MS): PlaceCheckReread {
  let waiting: { handle: Handle; read: () => void } | null = null;

  const flush = () => {
    if (!waiting) return;
    const { handle, read } = waiting;
    waiting = null;
    clock.clear(handle);
    read();
  };

  return {
    ask: (read) => {
      if (waiting) clock.clear(waiting.handle);
      waiting = { handle: clock.set(flush, quietMs), read };
    },
    flush,
  };
}

/** The one for this tab: every control on the page shares it, so a run of them still costs one re-read. */
export const placeCheckReread = createPlaceCheckReread<ReturnType<typeof setTimeout>>({
  clear: (handle) => clearTimeout(handle),
  set: (run, ms) => setTimeout(run, ms),
});
