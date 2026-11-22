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
  /**
   * The board is drawing the page the server read at `readAt` (its own stamp, never the browser's clock).
   * 🔴 A DECISION IS OWED UNTIL A PAGE READ AFTER IT IS ON SCREEN (owner, 22 Nov 2026: "I keep approving or
   * rejecting … I turn around and do anything, and I come back … the same place … is as it is"). A
   * decision pressed less than `quietMs` before he left had its re-read dropped (`cancel`), and the
   * browser kept the page as it was before his decisions: Back, or a link opened again within the router
   * cache's 30 seconds, drew that old page with every row he had settled still waiting. So each decision
   * remembers which page it was pressed on; a newer page settles it, and the same old page drawn again —
   * the board opening on it after he comes back — reads the page at once, on Place checks itself.
   * `null` (a board with no stamp) settles nothing and reads nothing.
   */
  showing: (readAt: string | null, read: () => void) => void;
  /** The reviewer is back on the board: read now if a decision is waiting, and do nothing if none is. */
  flush: () => void;
  /**
   * Drop what is waiting without reading. 🔴 THE RE-READ DIES WITH THE PAGE (17 Nov 2026, the audit's
   * background runs): this one lives for the tab, so a decision pressed just before leaving Place checks
   * rebuilt whatever page he had opened since, thirty seconds later. The board calls it when it closes, and
   * a control that refreshes the page at once calls it first, so the same page is never read twice.
   * It drops only the timer: a decision stays owed (`showing`) until a page read after it is drawn.
   */
  cancel: () => void;
};

/** Whether the page stamped `readAt` was read after the page stamped `owed` — both the server's own stamps. */
function readAfter(readAt: string, owed: string | null): boolean {
  if (owed === null) return false;
  const later = Date.parse(readAt);
  const before = Date.parse(owed);
  return Number.isFinite(later) && Number.isFinite(before) && later > before;
}

export function createPlaceCheckReread<Handle>(clock: Clock<Handle>, quietMs = PLACE_CHECK_REREAD_QUIET_MS): PlaceCheckReread {
  let waiting: { handle: Handle; read: () => void } | null = null;
  // The page on screen, and the page the latest unsettled decision was pressed on ({ readAt: null } when it
  // was pressed before any board said what it was drawing — then the next page drawn settles it or reads).
  let shown: string | null = null;
  let owed: { readAt: string | null } | null = null;

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
      owed = { readAt: shown };
    },
    showing: (readAt, read) => {
      if (readAt === null) return;
      shown = readAt;
      if (!owed) return;
      if (owed.readAt !== null && readAfter(readAt, owed.readAt)) {
        owed = null;
        return;
      }
      // The page on screen is the one the decision was pressed on, or older: read it again now. A timer
      // still waiting would read the same page a second time, so it goes.
      if (owed.readAt === null) owed = { readAt };
      if (waiting) {
        clock.clear(waiting.handle);
        waiting = null;
      }
      read();
    },
    flush,
    cancel: () => {
      if (!waiting) return;
      clock.clear(waiting.handle);
      waiting = null;
    },
  };
}

/** The one for this tab: every control on the page shares it, so a run of them still costs one re-read. */
export const placeCheckReread = createPlaceCheckReread<ReturnType<typeof setTimeout>>({
  clear: (handle) => clearTimeout(handle),
  set: (run, ms) => setTimeout(run, ms),
});
