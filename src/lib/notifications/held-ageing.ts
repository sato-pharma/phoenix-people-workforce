/**
 * How long the Notification Confidence Gate has been holding something, and how alarming that is.
 *
 * WHY THIS EXISTS. A held notification has no clock. The gate holds it for a HUMAN, and until
 * 2026-09-05 each delivery retry re-hit the hold and burned an attempt, so a held row quietly died
 * after five tries and was recorded as a delivery FAILURE — 21 resignation emails on 2026-08-28,
 * dead at 5/5, describing resignations that had completed anyway. #3266 made a hold a terminal skip,
 * which stopped the dying and stopped the lying.
 *
 * That fix left the other half open: nothing shows how long the queue has been waiting. On the day
 * it happened the backlog was found by hand and cleared in bulk (161 reviews, one sweep, eight
 * minutes after those 21 had already expired). A queue whose only discovery mechanism is somebody
 * happening to look is one nobody looks at.
 *
 * There is deliberately NO expiry here and nothing is auto-decided. A held notification is waiting
 * on a judgement only a Super Admin may make; the answer to "nobody looked" is to make the waiting
 * visible, never to decide it automatically.
 */

/** Bands a held item by age. Big is bad — see `heldAgeBand`. */
export type HeldAgeBand = "fresh" | "stale" | "critical";

const STALE_AFTER_HOURS = 24;
const CRITICAL_AFTER_HOURS = 72;

/**
 * Band a held review by how long it has waited.
 *
 * 🔴 BIG IS URGENT, and that is the opposite of a countdown. Anything measured against an expiry —
 * the direct-order Held Desk's 14-day clock, for instance — has SMALL as its urgent end, and
 * copying that palette across paints the most neglected item in the calmest colour. A hold has no
 * expiry at all, so the number only ever grows.
 *
 * The thresholds are in HOURS, not days, because these are notifications. Something meant to arrive
 * within minutes and still unreviewed the next morning is already late; a day is not "fresh" here
 * in the way it is for a returned order a rep must act on.
 */
export function heldAgeBand(hoursWaiting: number): HeldAgeBand {
  if (hoursWaiting >= CRITICAL_AFTER_HOURS) return "critical";
  if (hoursWaiting >= STALE_AFTER_HOURS) return "stale";
  return "fresh";
}

/**
 * Whole hours between `since` and `now`, floored, never negative.
 *
 * A future-dated or unparseable timestamp reads 0 rather than a negative age. A negative would sort
 * to the top of an oldest-first queue and present as the most urgent item on the screen.
 */
export function hoursHeldSince(since: string | null | undefined, now: Date = new Date()): number {
  if (!since) return 0;
  const at = new Date(since).getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now.getTime() - at) / (60 * 60 * 1000)));
}

/** A compact age for a chip: hours below a day, whole days above it. */
export function formatHeldAge(hoursWaiting: number): string {
  if (hoursWaiting < 1) return "under 1h";
  if (hoursWaiting < 24) return `${hoursWaiting}h`;
  const days = Math.floor(hoursWaiting / 24);
  return `${days}d`;
}

export type HeldQueueSummary = {
  /** Nothing held at all. The screen says so rather than showing an empty band row. */
  empty: boolean;
  total: number;
  fresh: number;
  stale: number;
  critical: number;
  /** Hours the OLDEST held item has waited. 0 when the queue is empty. */
  oldestHours: number;
  /** The worst band present, so the header can carry one honest colour. */
  worst: HeldAgeBand;
};

/**
 * Summarise the held queue for the header.
 *
 * `worst` is counted from the bands present rather than re-derived as `heldAgeBand(oldestHours)`.
 * Today those are the SAME ANSWER and no test can tell them apart — `heldAgeBand` is monotonic in
 * age, so the oldest item necessarily carries the worst band. (That monotonicity is not assumed:
 * the test walks 200 hours asserting severity never falls.)
 *
 * Counting is kept anyway because it survives the thing that would break the shortcut — a future
 * band keyed on anything other than age alone, say a type that is critical the moment it is held.
 * The shortcut would then quietly report the oldest row's band as the queue's worst and miss it.
 * This is a cheap hedge, not a fix for a live bug.
 */
export function summarizeHeldQueue(
  createdAts: ReadonlyArray<string | null | undefined>,
  now: Date = new Date(),
): HeldQueueSummary {
  const bands = createdAts.map((at) => heldAgeBand(hoursHeldSince(at, now)));
  const oldestHours = createdAts.reduce<number>((max, at) => Math.max(max, hoursHeldSince(at, now)), 0);
  const critical = bands.filter((band) => band === "critical").length;
  const stale = bands.filter((band) => band === "stale").length;
  return {
    empty: createdAts.length === 0,
    total: createdAts.length,
    fresh: bands.filter((band) => band === "fresh").length,
    stale,
    critical,
    oldestHours,
    worst: critical > 0 ? "critical" : stale > 0 ? "stale" : "fresh",
  };
}
