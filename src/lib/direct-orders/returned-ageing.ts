/**
 * The pure rules behind the Returned Ageing Desk.
 *
 * Extracted from the desk component so they can be pinned by a test. A band that decides which
 * orders look urgent is a business rule, not styling, and the inversion below is exactly the kind
 * of thing a later edit "tidies" back into agreement with the Held Desk.
 */

/** Bands an order's age. Big is bad here — see `returnedAgeBand`. */
export type ReturnedAgeBand = "fresh" | "stale" | "critical";

/** One `returned` event as the desk reads it. */
export type ReturnEventLike = {
  requestId: string;
  createdAt: string;
  message: string | null;
};

/**
 * Band a returned order by how long it has waited.
 *
 * 🔴 DELIBERATELY THE INVERSE OF THE HELD DESK. Held counts DOWN to a 14-day expiry, so a SMALL
 * number is the urgent one there. `returned` has no clock at all — nothing expires it and nothing
 * chases it — so the number only ever grows and BIG is the alarming end.
 *
 * Copying the held palette across would paint the oldest, most neglected order in the calmest
 * colour and the newest one red, which is the exact opposite of the truth. That mistake is easy to
 * make and invisible in review, which is why this is a named function with a test rather than a
 * ternary inside the component.
 */
export function returnedAgeBand(daysWaiting: number): ReturnedAgeBand {
  if (daysWaiting >= 21) return "critical";
  if (daysWaiting >= 7) return "stale";
  return "fresh";
}

/**
 * Whole days between `since` and `now`, floored, never negative.
 *
 * A clock skew or a future-dated row must read 0 rather than a negative age, which would sort to
 * the top of an oldest-first desk and read as the most urgent thing on the screen.
 */
export function daysWaitingSince(since: string | null, now: Date = new Date()): number {
  if (!since) return 0;
  const at = new Date(since).getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now.getTime() - at) / (24 * 60 * 60 * 1000)));
}

/**
 * The LATEST return per request.
 *
 * An order can be returned, corrected, resubmitted and returned again. Only the last comment is
 * still open — showing the first would hand the rep a question they already answered, and the
 * desk's whole purpose is to show what is outstanding.
 *
 * Takes events in ANY order and sorts them itself rather than trusting the caller's `ORDER BY`.
 * The query does order them, but a helper that silently depends on that is one refactor away from
 * picking the oldest comment with no error anywhere.
 */
export function pickLatestReturnPerRequest(
  events: readonly ReturnEventLike[],
): Map<string, ReturnEventLike> {
  const latest = new Map<string, ReturnEventLike>();
  for (const event of events) {
    const at = new Date(event.createdAt).getTime();
    if (!Number.isFinite(at)) continue;
    const held = latest.get(event.requestId);
    if (!held || at > new Date(held.createdAt).getTime()) latest.set(event.requestId, event);
  }
  return latest;
}
