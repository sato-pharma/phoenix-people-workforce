// Recruitment / ATS — is the screening backlog growing or shrinking, over time rather than today.
//
// ── WHY THIS IS ITS OWN MODULE, AND PURE ────────────────────────────────────────────────────────
//
// The strip that shipped on 2026-09-05 answered "how did this week go" from data the workspace
// loader already held. That was cheap and it was the right first move. It is also, measured against
// the real decision history the next day, WRONG — and wrong in a direction that flatters:
//
//   * It counted a pool row whose LATEST status stamp fell inside the window. So a candidate decided
//     three weeks ago and re-touched yesterday counted as this week's output. Measured in production
//     2026-09-05: 93 by that method against 71 candidates actually receiving a first decision.
//   * Over thirty days it fails the other way, because a re-decision moves a candidate's only stamp
//     forward and out of the older window, and a candidate filed to a shelf leaves the pool
//     entirely. Same day: 140 by that method against 216 real first decisions — a 54% undercount.
//
// A single week's figure can absorb that. A TREND cannot: a series built on it would draw a
// confident line out of an artefact, and the whole point of a trend is that somebody acts on the
// direction. So the counting moved to the decision history, and the arithmetic moved here, where it
// can be tested without a database.
//
// ── WHAT "DECIDED" MEANS, EXACTLY ───────────────────────────────────────────────────────────────
//
// One candidate receiving their FIRST decision. Not a status event: measured the same day, the week
// of 2026-08-24 carried 461 events across 189 candidates, so counting events would have reported
// two and a half times the real output. Re-deciding somebody is work, but it is not another CV
// cleared from the backlog, and this strip exists to answer whether the backlog is being cleared.
//
// ── ROLLING WINDOWS, NOT CALENDAR WEEKS ─────────────────────────────────────────────────────────
//
// Every bucket is a plain 7×24h span back from now. Calendar weeks would need a Cairo week boundary,
// and the first bucket would be a partial week whose smaller number reads as a collapse in output
// rather than as a Tuesday. A duration needs no timezone and compares like with like.

/** How many days one bucket covers. */
export const THROUGHPUT_BUCKET_DAYS = 7;

/** How many buckets the strip reports. Four sevens is the thirty-day view the plan asked for. */
export const THROUGHPUT_BUCKETS = 4;

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = THROUGHPUT_BUCKET_DAYS * DAY_MS;

export type ThroughputBucket = {
  /** 0 is the last seven days, 1 the seven before that, and so on. */
  index: number;
  /** Inclusive start of the span, as an epoch millisecond. */
  from: number;
  /** Exclusive end. */
  to: number;
  arrived: number;
  /**
   * NULL, NEVER ZERO, for a span the decision history does not cover.
   *
   * The history began on 2026-08-16; there is nothing before it. Printing 0 there would say "nobody
   * decided anything that week", which is a statement about the recruiter rather than about the
   * data, and it is the shape that turns a missing record into an accusation.
   */
  decided: number | null;
};

export type ThroughputSummary = {
  /** In the pool and never opened by THIS viewer. */
  unread: number;
  arrived7: number;
  decided7: number | null;
  arrived30: number;
  decided30: number | null;
  /** Newest first: index 0 is the last seven days. */
  buckets: ThroughputBucket[];
  /** The first instant the decision history covers, or null when there is none at all. */
  historyStartsAt: string | null;
  /** True when every reported bucket is fully inside the history — i.e. the trend is complete. */
  historyCoversEveryBucket: boolean;
};

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * Turn raw arrival and first-decision instants into the strip's figures.
 *
 * Pure: no database, no clock of its own. `now` is passed in so a test can stand anywhere in time,
 * which is the only way to check the history-boundary behaviour that the whole module exists for.
 */
export function buildThroughput(input: {
  now: number;
  /** `createdAt` for every candidate that has ever arrived — not just the ones still in the pool. */
  arrivals: readonly (string | null | undefined)[];
  /** One instant per candidate that has ever been decided: when they were FIRST decided. */
  firstDecisions: readonly (string | null | undefined)[];
  /** The earliest instant the decision history covers. */
  historyStartsAt: string | null;
  unread: number;
}): ThroughputSummary {
  const { now, unread } = input;
  const historyFrom = instant(input.historyStartsAt);

  const arrivals = input.arrivals.map(instant).filter((at): at is number => at !== null);
  const decisions = input.firstDecisions.map(instant).filter((at): at is number => at !== null);

  const countIn = (values: readonly number[], from: number, to: number) =>
    values.reduce((total, at) => (at >= from && at < to ? total + 1 : total), 0);

  // A span is only reportable when the history covers ALL of it. A partially covered span would
  // report a real number that means something narrower than its label, which is exactly the failure
  // this module was written to remove.
  const decidedIn = (from: number, to: number): number | null =>
    historyFrom === null || historyFrom > from ? null : countIn(decisions, from, to);

  const buckets: ThroughputBucket[] = [];
  for (let index = 0; index < THROUGHPUT_BUCKETS; index += 1) {
    const to = now - index * BUCKET_MS;
    const from = to - BUCKET_MS;
    buckets.push({ arrived: countIn(arrivals, from, to), decided: decidedIn(from, to), from, index, to });
  }

  const thirtyFrom = now - THROUGHPUT_BUCKETS * BUCKET_MS;

  return {
    arrived7: countIn(arrivals, now - BUCKET_MS, now),
    arrived30: countIn(arrivals, thirtyFrom, now),
    buckets,
    decided7: decidedIn(now - BUCKET_MS, now),
    decided30: decidedIn(thirtyFrom, now),
    historyCoversEveryBucket: historyFrom !== null && historyFrom <= thirtyFrom,
    historyStartsAt: input.historyStartsAt,
    unread,
  };
}

/**
 * How this week compares with the one before it — the sentence the strip actually prints.
 *
 * Returns null when either side is unreportable, rather than inventing a comparison against a week
 * whose decisions were never recorded. "Down from nothing" is worse than saying nothing.
 */
export function throughputDirection(summary: ThroughputSummary): {
  netThisWeek: number | null;
  netLastWeek: number | null;
  improving: boolean | null;
} {
  const [thisWeek, lastWeek] = summary.buckets;
  const net = (bucket: ThroughputBucket | undefined): number | null =>
    bucket && bucket.decided !== null ? bucket.arrived - bucket.decided : null;

  const netThisWeek = net(thisWeek);
  const netLastWeek = net(lastWeek);
  return {
    improving: netThisWeek === null || netLastWeek === null ? null : netThisWeek < netLastWeek,
    netLastWeek,
    netThisWeek,
  };
}
