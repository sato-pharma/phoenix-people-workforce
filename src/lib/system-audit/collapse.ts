/**
 * Retries are one operation — the fold that turns raw error events into ledger occurrences.
 *
 * One person, one failure, one sitting: a hydration error that fires 24 times as a streamed page
 * falls apart, or a save the person pressed five times in three minutes, is ONE thing that happened
 * to them, and the owner's brief counts operations, not events. Pure — no I/O, no clock — so every
 * rule below is pinned by tests/system-audit-collapse.test.ts.
 *
 * THE RULE. Events are grouped by actor (the person's HR key, or a hash of a guest's browser) +
 * signature + route family. An event EXTENDS the current occurrence of its group when it is in the
 * same page load (its `created_at − sinceNavMs` is within PAGE_LOAD_MATCH_MS of a page load the
 * occurrence already holds) OR it came within COLLAPSE_GAP_MS of the occurrence's last event.
 * Otherwise it starts a new one, keyed `<signature>:<actor>:<first event id>` — stable, so
 * re-writing it is an upsert, never a second row. Different people never merge.
 *
 * THE LEDGER MERGES WITH `add`, so an occurrence that EXTENDS one already written is emitted with
 * only the NEW events' counts (attempts, page loads, source refs); the database adds them. That is
 * safe only because no event is ever folded twice: the detector reads strictly after its watermark,
 * and the watermark moves in the SAME transaction as the rows it covers
 * (system_audit_upsert_occurrences writes `p_cursor` with the occurrences). The detector keeps each
 * write to one database call (≤ 500 occurrences, the repository's chunk size) for exactly this
 * reason — a write split across calls would commit some deltas without the watermark, and the
 * re-run would add them again.
 */

/** Two events this far apart (or less) belong to one operation. */
export const COLLAPSE_GAP_MS = 10 * 60 * 1000;
/** Two page-load starts this close are the same page load (the clocks are the browser's and ours). */
export const PAGE_LOAD_MATCH_MS = 2_000;
/** The ledger's cap on stored event ids per occurrence. */
export const MAX_SOURCE_REFS = 50;

export type FoldEvent = {
  id: string;
  /** ISO timestamp of the event row. */
  createdAt: string;
  /** `hr:<key>`, `test:<login>`, `guest:<hash>` — who it happened to. */
  actorKey: string;
  signatureKey: string;
  routeFamily: string | null;
  /** `performance.now()` at the throw, from the client context; null on server rows. */
  sinceNavMs: number | null;
};

/** An occurrence already in the ledger that a new event may still extend. */
export type OpenOccurrence = {
  dedupeKey: string;
  signatureKey: string;
  actorKey: string;
  routeFamily: string | null;
  occurredAt: string;
  firstEventAt: string;
  lastEventAt: string;
  /** The latest page load it holds, as stored in its evidence (null when unknown). */
  lastPageLoadAt: string | null;
};

export type FoldedOccurrence<E extends FoldEvent> = {
  dedupeKey: string;
  signatureKey: string;
  actorKey: string;
  routeFamily: string | null;
  /** True when this adds to an occurrence the ledger already holds. */
  isExtension: boolean;
  /** The NEW events folded in, in order. The first is the representative row. */
  events: E[];
  /** New events only — the ledger adds it. */
  attemptCount: number;
  /** New distinct page loads only (0 when every new event is in a page load already counted). */
  pageLoads: number;
  /** New event ids only, at most MAX_SOURCE_REFS. */
  sourceRefs: string[];
  /** The occurrence's own start: its first event ever (the open occurrence's, when extending). */
  occurredAt: string;
  /** Over the new events. The ledger keeps least/greatest. */
  firstEventAt: string;
  lastEventAt: string;
  /** The latest page-load start it now holds, for the next run's open-occurrence read. */
  lastPageLoadAt: string | null;
};

type Working<E extends FoldEvent> = FoldedOccurrence<E> & {
  lastEventMs: number;
  /** Page-load starts already counted for this occurrence (ms). */
  pageLoadStarts: number[];
};

function groupKey(actorKey: string, signatureKey: string, routeFamily: string | null): string {
  return `${actorKey}\u0000${signatureKey}\u0000${routeFamily ?? ""}`;
}

/**
 * When the page this event fired on was loaded. A row with no `sinceNavMs` (every server row, and
 * client rows from before the context was captured) is treated as its own page load — the honest
 * reading of a request we cannot place.
 */
export function pageLoadStartMs(event: Pick<FoldEvent, "createdAt" | "sinceNavMs">): number {
  const at = Date.parse(event.createdAt);
  if (event.sinceNavMs === null || !Number.isFinite(event.sinceNavMs) || event.sinceNavMs < 0) return at;
  return at - event.sinceNavMs;
}

function sameLoad(starts: readonly number[], start: number): boolean {
  return starts.some((known) => Math.abs(known - start) <= PAGE_LOAD_MATCH_MS);
}

function compareEvents(left: FoldEvent, right: FoldEvent): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (byTime !== 0) return byTime;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Folds `events` (any order — sorted here by `(created_at, id)`) onto the `open` occurrences.
 * Returns one entry per occurrence that received at least one new event, in the order each was
 * first touched. An open occurrence no event extends is not returned.
 */
export function foldOccurrences<E extends FoldEvent>(
  events: readonly E[],
  open: readonly OpenOccurrence[] = [],
): FoldedOccurrence<E>[] {
  const current = new Map<string, Working<E> | OpenOccurrence>();
  for (const occurrence of open) {
    const key = groupKey(occurrence.actorKey, occurrence.signatureKey, occurrence.routeFamily);
    const known = current.get(key) as OpenOccurrence | undefined;
    // Two open occurrences in one group: the later one is the one a new event can extend.
    if (!known || Date.parse(occurrence.lastEventAt) > Date.parse(known.lastEventAt)) current.set(key, occurrence);
  }

  const touched: Working<E>[] = [];
  for (const event of [...events].sort(compareEvents)) {
    const key = groupKey(event.actorKey, event.signatureKey, event.routeFamily);
    const at = Date.parse(event.createdAt);
    const start = pageLoadStartMs(event);
    const existing = current.get(key);

    if (existing && "events" in existing) {
      if (sameLoad(existing.pageLoadStarts, start) || at - existing.lastEventMs <= COLLAPSE_GAP_MS) {
        existing.events.push(event);
        existing.attemptCount += 1;
        if (!sameLoad(existing.pageLoadStarts, start)) {
          existing.pageLoadStarts.push(start);
          existing.pageLoads += 1;
          existing.lastPageLoadAt = new Date(Math.max(start, Date.parse(existing.lastPageLoadAt ?? event.createdAt))).toISOString();
        }
        if (existing.sourceRefs.length < MAX_SOURCE_REFS) existing.sourceRefs.push(event.id);
        if (at >= existing.lastEventMs) {
          existing.lastEventMs = at;
          existing.lastEventAt = event.createdAt;
        }
        continue;
      }
    } else if (existing) {
      // An occurrence the ledger already holds: extend it, emitting only what is new.
      const knownStart = existing.lastPageLoadAt ? Date.parse(existing.lastPageLoadAt) : null;
      const inKnownLoad = knownStart !== null && Number.isFinite(knownStart) && Math.abs(knownStart - start) <= PAGE_LOAD_MATCH_MS;
      if (inKnownLoad || at - Date.parse(existing.lastEventAt) <= COLLAPSE_GAP_MS) {
        const extension: Working<E> = {
          dedupeKey: existing.dedupeKey,
          signatureKey: existing.signatureKey,
          actorKey: existing.actorKey,
          routeFamily: existing.routeFamily,
          isExtension: true,
          events: [event],
          attemptCount: 1,
          pageLoads: inKnownLoad ? 0 : 1,
          sourceRefs: [event.id],
          occurredAt: existing.occurredAt,
          firstEventAt: event.createdAt,
          lastEventAt: event.createdAt,
          lastPageLoadAt: inKnownLoad ? existing.lastPageLoadAt : new Date(start).toISOString(),
          lastEventMs: at,
          pageLoadStarts: inKnownLoad && knownStart !== null ? [knownStart] : [start],
        };
        current.set(key, extension);
        touched.push(extension);
        continue;
      }
    }

    const fresh: Working<E> = {
      dedupeKey: `${event.signatureKey}:${event.actorKey}:${event.id}`,
      signatureKey: event.signatureKey,
      actorKey: event.actorKey,
      routeFamily: event.routeFamily,
      isExtension: false,
      events: [event],
      attemptCount: 1,
      pageLoads: 1,
      sourceRefs: [event.id],
      occurredAt: event.createdAt,
      firstEventAt: event.createdAt,
      lastEventAt: event.createdAt,
      lastPageLoadAt: new Date(start).toISOString(),
      lastEventMs: at,
      pageLoadStarts: [start],
    };
    current.set(key, fresh);
    touched.push(fresh);
  }

  return touched.map(({ lastEventMs: _lastEventMs, pageLoadStarts: _pageLoadStarts, ...occurrence }) => occurrence);
}

/**
 * The occurrences a fold leaves open for the NEXT batch of the same run, so a run that writes in
 * several batches folds across their boundary exactly as one fold would.
 */
export function stillOpen<E extends FoldEvent>(
  previous: readonly OpenOccurrence[],
  folded: readonly FoldedOccurrence<E>[],
): OpenOccurrence[] {
  const byGroup = new Map<string, OpenOccurrence>();
  for (const occurrence of previous) {
    byGroup.set(groupKey(occurrence.actorKey, occurrence.signatureKey, occurrence.routeFamily), occurrence);
  }
  for (const occurrence of folded) {
    const key = groupKey(occurrence.actorKey, occurrence.signatureKey, occurrence.routeFamily);
    const prior = byGroup.get(key);
    const samePrior = prior && prior.dedupeKey === occurrence.dedupeKey ? prior : null;
    byGroup.set(key, {
      dedupeKey: occurrence.dedupeKey,
      signatureKey: occurrence.signatureKey,
      actorKey: occurrence.actorKey,
      routeFamily: occurrence.routeFamily,
      occurredAt: occurrence.occurredAt,
      // Compared as instants: the ledger's `+00:00` and an event's `Z` spell the same moment differently.
      firstEventAt:
        samePrior && Date.parse(samePrior.firstEventAt) < Date.parse(occurrence.firstEventAt) ? samePrior.firstEventAt : occurrence.firstEventAt,
      lastEventAt:
        samePrior && Date.parse(samePrior.lastEventAt) > Date.parse(occurrence.lastEventAt) ? samePrior.lastEventAt : occurrence.lastEventAt,
      lastPageLoadAt: occurrence.lastPageLoadAt ?? samePrior?.lastPageLoadAt ?? null,
    });
  }
  return [...byGroup.values()];
}
