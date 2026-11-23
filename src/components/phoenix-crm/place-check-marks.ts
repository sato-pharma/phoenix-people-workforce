/**
 * Phoenix CRM — the saved marks of Place checks: which rows a decision control has already settled in this
 * tab. Pure, no React, so a test runs the real store; `place-check-done.tsx` holds the one for the tab.
 *
 * 🔴 THE SAVED MARK OUTLIVES THE CONTROL (owner, 2026-11-08: "places checks is stale"). It was component
 * state, so a list that remounted — a tab change, a filter, Show more, the one-by-one review closing —
 * forgot it, and the decided row stood there with live buttons until the page's re-read, up to 30 seconds
 * later: the next press answered "This place was already decided". Kept for the tab, keyed by the row as it
 * was pressed, every control drawing that same row reads it; the re-read's changed row no longer matches,
 * so the server's own view takes over exactly as before.
 *
 * 🔴 EVERY CONTROL DRAWING THE ROW REDRAWS WHEN ONE OF THEM IS SAVED (owner, 22 Nov 2026: "it accept with
 * me … the same place … is as it is"). The mark used to redraw only the control that was pressed: on a
 * place in use, Reject vanished and Approve — its sibling, with no parent to redraw it — stood live beside
 * the rejected row until the page's re-read, so the row looked undecided and a press answered "already
 * decided". Each control listens for its own row's mark (`listen`), and saving one tells them all.
 */

/** How many rows the tab remembers; the oldest mark goes first, and its controls are told. */
export const SAVED_MARKS_KEPT = 500;

/**
 * 🔴 THE WAIT IS LEFT OUT OF THE KEY (22 Nov 2026). It is re-worded every hour ("Waiting 3 hours" →
 * "Waiting 4 hours"), so a re-read that does not carry the decision yet — a build already running when he
 * pressed, the copy kept for the click — handed back the same undecided row with a new wait, the key
 * missed, and the decided row stood with live buttons again. A real change of the row (decided, restorable,
 * refusable) still changes the key, so the server's own view takes over as before.
 */
const VOLATILE_KEYS: ReadonlySet<string> = new Set(["waitingText", "waitingLong", "waitingHours"]);

/** The row as it was pressed, as the mark's key. */
export function savedMarkKey(subject: unknown): string {
  return JSON.stringify(subject, (key: string, value: unknown) => (VOLATILE_KEYS.has(key) ? undefined : value)) ?? "";
}

export type SavedMarks<Outcome> = {
  /** The outcome saved on the row keyed `snapshot`, or null. */
  savedUnder: (snapshot: string) => Outcome | null;
  /** A control saved `outcome` on the row: every control drawing it is told. */
  remember: (snapshot: string, outcome: Outcome) => void;
  /** A control drawing the row keyed `snapshot` listens for its mark; the answer stops listening. */
  listen: (snapshot: string, listener: () => void) => () => void;
};

export function createSavedMarks<Outcome>(kept = SAVED_MARKS_KEPT): SavedMarks<Outcome> {
  const marks = new Map<string, Outcome>();
  const listeners = new Map<string, Set<() => void>>();

  const tell = (snapshot: string) => {
    for (const listener of [...(listeners.get(snapshot) ?? [])]) listener();
  };

  return {
    savedUnder: (snapshot) => (marks.has(snapshot) ? (marks.get(snapshot) as Outcome) : null),
    remember: (snapshot, outcome) => {
      marks.delete(snapshot);
      marks.set(snapshot, outcome);
      tell(snapshot);
      while (marks.size > kept) {
        const oldest = marks.keys().next().value;
        if (oldest === undefined) break;
        marks.delete(oldest);
        tell(oldest);
      }
    },
    listen: (snapshot, listener) => {
      const own = listeners.get(snapshot) ?? new Set<() => void>();
      own.add(listener);
      listeners.set(snapshot, own);
      return () => {
        own.delete(listener);
        if (own.size === 0 && listeners.get(snapshot) === own) listeners.delete(snapshot);
      };
    },
  };
}
