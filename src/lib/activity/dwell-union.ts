// Credit each page view only for the wall-clock time NO OTHER page view of the
// same person already covers.
//
// Why this exists: the tracker records a dwell per page, and two browser WINDOWS
// are both `visible` at once, so both accumulate over the same wall clock. Summing
// the dwells therefore counts the same minute twice. Measured on production
// (2026-09-26): one person's summed dwell came to 111% of their own logged-in
// time — a number that cannot be true, printed on screen as "Active min".
//
// This module is pure: no clock, no database, no framework. Give it intervals,
// it gives back the seconds each one may claim, and those seconds sum to exactly
// the length of the union.

export type DwellInterval = { startMs: number; endMs: number };

/** A beacon can arrive late (suspended tab, client clock skew). Beyond this the
 * reported `entered_at` is not trusted and the interval is anchored to the
 * arrival instant instead. Production p95 lag on 2026-09-26 was 4.4 seconds. */
export const BEACON_LAG_TOLERANCE_SECONDS = 300;

/**
 * Credited (uncovered) seconds per input interval, returned in INPUT order.
 *
 * Σ credited === the length of the union of the intervals. An interval wholly
 * inside one already credited earns 0 — it is a second window over the same
 * minute, not a second minute. There is deliberately NO gap tolerance: a gap
 * between two views is time the person was not on a Phoenix page, and closing it
 * would re-invent the inflation this replaces.
 */
export function creditUncoveredSeconds(intervals: DwellInterval[]): number[] {
  const credited = new Array<number>(intervals.length).fill(0);

  const order: number[] = [];
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index];
    if (!interval) continue;
    if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs)) continue;
    if (interval.endMs <= interval.startMs) continue;
    order.push(index);
  }

  // Sort by start, then by end, then by input index — so the result does not
  // depend on the order rows happened to arrive from PostgREST.
  order.sort((left, right) => {
    const byStart = intervals[left].startMs - intervals[right].startMs;
    if (byStart !== 0) return byStart;
    const byEnd = intervals[left].endMs - intervals[right].endMs;
    if (byEnd !== 0) return byEnd;
    return left - right;
  });

  let coveredUntilMs = Number.NEGATIVE_INFINITY;
  for (const index of order) {
    const { startMs, endMs } = intervals[index];
    if (endMs <= coveredUntilMs) continue; // fully covered by an earlier interval
    const fromMs = startMs > coveredUntilMs ? startMs : coveredUntilMs;
    credited[index] = (endMs - fromMs) / 1000;
    coveredUntilMs = endMs;
  }

  return credited;
}

/**
 * The wall-clock interval a single page view occupied.
 *
 * `entered_at` is the instant the page became visible and is populated on every
 * row measured in the last 30 days, so the interval is real rather than inferred.
 * When the beacon's own arithmetic disagrees with its arrival time by more than
 * BEACON_LAG_TOLERANCE_SECONDS the row is anchored to `created_at` instead —
 * a suspended tab reports a true dwell that ended long before delivery, and
 * trusting `entered_at` there would stretch one view across hours.
 */
export function dwellIntervalForEvent(input: {
  createdAtIso: string | null;
  enteredAtIso: string | null;
  dwellSeconds: number;
}): DwellInterval | null {
  const dwellMs = Math.max(0, Math.round(Number(input.dwellSeconds) || 0) * 1000);
  if (dwellMs <= 0) return null;

  const createdMs = input.createdAtIso ? new Date(input.createdAtIso).getTime() : Number.NaN;
  const enteredMs = input.enteredAtIso ? new Date(input.enteredAtIso).getTime() : Number.NaN;

  if (Number.isFinite(enteredMs)) {
    const lagMs = Number.isFinite(createdMs) ? Math.abs(createdMs - enteredMs - dwellMs) : 0;
    if (lagMs <= BEACON_LAG_TOLERANCE_SECONDS * 1000) {
      return { startMs: enteredMs, endMs: enteredMs + dwellMs };
    }
  }

  if (!Number.isFinite(createdMs)) return null;
  return { startMs: createdMs - dwellMs, endMs: createdMs };
}
