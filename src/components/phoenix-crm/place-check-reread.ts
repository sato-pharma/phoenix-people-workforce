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
   * A control that reads the page at once — a bulk run's end, a comment, a recommendation, a declaration.
   * Drops a timer still waiting (the same page is never read twice) and is owed like a decision, so leaving
   * before that read lands still reads the page on coming back (22 Nov 2026: a bulk run was never owed).
   */
  refreshNow: (read: () => void) => void;
  /**
   * The board is drawing the page the server read at `readAt` (its own stamp, never the browser's clock).
   * 🔴 A DECISION IS OWED UNTIL A PAGE READ AFTER IT IS ON SCREEN (owner, 22 Nov 2026: "I keep approving or
   * rejecting … I turn around and do anything, and I come back … the same place … is as it is"). A
   * decision pressed less than `quietMs` before he left had its re-read dropped (`cancel`), and the
   * browser kept the page as it was before his decisions: Back, or a link opened again within the router
   * cache's 30 seconds, drew that old page with every row he had settled still waiting. So each decision
   * remembers which page it was pressed on; a newer page settles it, and the same old page drawn again —
   * the board opening on it after he comes back — reads the page at once, on Place checks itself.
   * 🔴 A DECISION PRESSED WHILE A READ IS ALREADY RUNNING IS NOT SETTLED BY THAT READ — its rows were read
   * before the press (the page build is 10 to 27 seconds). It is owed to the page that read brings instead.
   * `null` (a board with no stamp) settles nothing and reads nothing.
   */
  showing: (readAt: string | null, read: () => void) => void;
  /**
   * A decision this module does not time is owed all the same (22 Nov 2026): another tab of his saved one,
   * so this tab's page is older than it, or a bulk run has started deciding rows on it. Nothing is read now;
   * the board reads it when the tab is shown or the page drawn again (`shownAgain`, `showing`).
   */
  owe: () => void;
  /**
   * The tab is shown or focused again on the page stamped `readAt`. Reads only what is owed with no timer
   * waiting and no read running — a decision of his own still inside its quiet time keeps its one read, and
   * a read already on its way brings the newer page itself, so looking away and back never adds a build.
   */
  shownAgain: (readAt: string | null, read: () => void) => void;
  /** The reviewer is back on the board: read now if a decision is waiting, and do nothing if none is. */
  flush: () => void;
  /**
   * Drop what is waiting without reading. 🔴 THE RE-READ DIES WITH THE PAGE (17 Nov 2026, the audit's
   * background runs): this one lives for the tab, so a decision pressed just before leaving Place checks
   * rebuilt whatever page he had opened since, thirty seconds later. The board calls it when it closes.
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

export function createPlaceCheckReread<Handle>(
  clock: Clock<Handle>,
  quietMs = PLACE_CHECK_REREAD_QUIET_MS,
  tellOtherTabs: () => void = () => {},
): PlaceCheckReread {
  let waiting: { handle: Handle; read: () => void } | null = null;
  // The page on screen, and the page the latest unsettled decision was pressed on ({ readAt: null } when it
  // was pressed before any board said what it was drawing — then the next page drawn settles it or reads).
  // `duringRead`: a read this module started was still running when it was pressed.
  let shown: string | null = null;
  let owed: { readAt: string | null; duringRead: boolean } | null = null;
  // A read this module started has not yet brought a newer page.
  let reading = false;

  const start = (read: () => void) => {
    reading = true;
    read();
  };

  const dropTimer = () => {
    if (!waiting) return;
    clock.clear(waiting.handle);
    waiting = null;
  };

  const flush = () => {
    if (!waiting) return;
    const { read } = waiting;
    dropTimer();
    start(read);
  };

  const showing = (readAt: string | null, read: () => void) => {
    if (readAt === null) return;
    if (shown === null || readAfter(readAt, shown)) reading = false;
    shown = readAt;
    if (!owed) return;
    if (owed.readAt !== null && readAfter(readAt, owed.readAt)) {
      if (!owed.duringRead) {
        owed = null;
        return;
      }
      // This page may be the read that was already running when he pressed: owe the decision to it. A
      // timer still waiting reads after it; with none (he left, and came back), read now.
      owed = { readAt, duringRead: false };
      if (!waiting) start(read);
      return;
    }
    // The page on screen is the one the decision was pressed on, or older: read it again now. A timer
    // still waiting would read the same page a second time, so it goes.
    owed = { readAt: owed.readAt ?? readAt, duringRead: false };
    dropTimer();
    start(read);
  };

  return {
    ask: (read) => {
      dropTimer();
      waiting = { handle: clock.set(flush, quietMs), read };
      owed = { readAt: shown, duringRead: reading };
      tellOtherTabs();
    },
    refreshNow: (read) => {
      dropTimer();
      owed = { readAt: shown, duringRead: reading };
      tellOtherTabs();
      start(read);
    },
    showing,
    owe: () => {
      if (!owed) owed = { readAt: shown, duringRead: reading };
    },
    shownAgain: (readAt, read) => {
      if (waiting || reading) return;
      showing(readAt, read);
    },
    flush,
    cancel: dropTimer,
  };
}

/** The tabs of one browser tell each other a decision was saved, so none of them keeps an older page. */
const OTHER_TABS = "phoenix-crm-place-checks";
let channel: BroadcastChannel | null | undefined;
function otherTabs(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof window === "undefined" || typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(OTHER_TABS);
  return channel;
}

/** The board listens while it is open; a decision in another tab owes this tab's page a read. */
export function hearOtherTabs(decided: () => void): () => void {
  const tabs = otherTabs();
  if (!tabs) return () => {};
  const listener = () => decided();
  tabs.addEventListener("message", listener);
  return () => tabs.removeEventListener("message", listener);
}

/** The one for this tab: every control on the page shares it, so a run of them still costs one re-read. */
export const placeCheckReread = createPlaceCheckReread<ReturnType<typeof setTimeout>>(
  {
    clear: (handle) => clearTimeout(handle),
    set: (run, ms) => setTimeout(run, ms),
  },
  PLACE_CHECK_REREAD_QUIET_MS,
  () => {
    try {
      otherTabs()?.postMessage("decided");
    } catch {
      // A tab that cannot be told reads its page when it is next opened, as before.
    }
  },
);
