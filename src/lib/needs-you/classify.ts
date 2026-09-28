/**
 * The pure core of the Needs You board.
 *
 * NO DATABASE, NO CLOCK OF ITS OWN, NO ACCESS CONTEXT. Same split as `scripts/needs-you.mjs` and
 * `scripts/branch-pr-state.mjs`, and for the same reason: the one rule here whose wrong answer costs
 * something — "is it provable that nothing needs him" — has to be drivable by a test without a live
 * machine, a session or a browser.
 *
 * This file is the ONLY place `allClearProvable` is computed. Nothing downstream may re-derive it,
 * and in particular nothing may gate the empty state on `yours.length === 0`: that is precisely the
 * under-report, because a board whose every source died also has an empty `yours`.
 */
import {
  needsYouSourceIds,
  needsYouSourceLabels,
  type NeedsYouBoard,
  type NeedsYouItem,
  type NeedsYouNotProven,
  type NeedsYouSourceId,
  type NeedsYouSourceReport,
  type NeedsYouSourceResult,
} from "./types.ts";

/**
 * The sentence that may only ever be printed when `allClearProvable` is true.
 *
 * Exported so the test can assert its ABSENCE from a render with a dead source, rather than
 * restating it and asserting against its own copy — a restatement drifts, and then the test passes
 * while the screen says the wrong thing.
 */
export const NEEDS_YOU_ALL_CLEAR_SENTENCE = "Nothing is waiting on a decision only you can make.";

/**
 * What the `yours` band says when it is empty but the silence is NOT provable.
 *
 * This is the whole mechanism in one string: an empty board with a dead source must read differently
 * from an empty board that was fully read, or the two are indistinguishable on screen.
 */
export const NEEDS_YOU_NOT_PROVEN_EMPTY_SENTENCE =
  "Nothing landed here, but not every source answered — read what could not be read, above, before treating this as clear.";

/**
 * A source the fan-out never reported on at all.
 *
 * `classify.ts` walks `needsYouSourceIds` rather than the results it was handed, so a source lost to
 * a dropped `await`, an early `return`, or a registry line someone deleted arrives here as AMBER
 * instead of vanishing. The failure direction is the safe one by construction.
 */
const MISSING_SOURCE_REASON = "the board never received an answer from it (nothing reported on this source)";

/** Oldest first; an item with no timestamp sorts last, then by key so the order is deterministic. */
function byOldest(a: NeedsYouItem, b: NeedsYouItem): number {
  if (a.oldestAt && b.oldestAt && a.oldestAt !== b.oldestAt) return a.oldestAt.localeCompare(b.oldestAt);
  if (a.oldestAt && !b.oldestAt) return -1;
  if (!a.oldestAt && b.oldestAt) return 1;
  return a.key.localeCompare(b.key);
}

export function buildNeedsYouBoard(
  results: readonly NeedsYouSourceResult[],
  now: Date = new Date(),
): NeedsYouBoard {
  // Last answer wins if a source somehow reported twice — a duplicate is a bug in the fan-out, not a
  // reason to render two rows for one queue.
  const byId = new Map<NeedsYouSourceId, NeedsYouSourceResult["state"]>();
  for (const result of results) byId.set(result.id, result.state);

  const sources: NeedsYouSourceReport[] = [];
  const notProven: NeedsYouNotProven[] = [];
  const items: NeedsYouItem[] = [];

  // THE REGISTRY, not the results, drives this loop. See MISSING_SOURCE_REASON.
  for (const id of needsYouSourceIds) {
    const label = needsYouSourceLabels[id];
    const state = byId.get(id) ?? { status: "unavailable" as const, because: MISSING_SOURCE_REASON };

    if (state.status === "ok") {
      sources.push({ id, label, status: "ok", because: null, itemCount: state.items.length });
      items.push(...state.items);
      continue;
    }
    if (state.status === "not-applicable") {
      // A TRUE zero. It answers the board's question — nothing here is yours — so it never reaches
      // `notProven` and never blocks the all-clear. `itemCount` is 0 rather than null because this
      // source really did report zero work.
      sources.push({ id, label, status: "not-applicable", because: state.because, itemCount: 0 });
      continue;
    }
    // Did not answer. `itemCount` is NULL, never 0 — the two must not render as the same thing.
    sources.push({ id, label, status: "unavailable", because: state.because, itemCount: null });
    notProven.push({ id, label, because: state.because });
  }

  const yours = items.filter((item) => item.lane === "yours").sort(byOldest);
  const someoneElse = items.filter((item) => item.lane === "someone-else").sort(byOldest);
  const worthKnowing = items.filter((item) => item.lane === "worth-knowing").sort(byOldest);

  return {
    generatedAt: now.toISOString(),
    // BOTH halves. `notProven.length === 0` is what makes the silence provable; `yours.length === 0`
    // is what makes it silence. Either one alone is a different, wrong claim.
    allClearProvable: notProven.length === 0 && yours.length === 0,
    yours,
    someoneElse,
    worthKnowing,
    notProven,
    sources,
  };
}

/**
 * How many things are waiting on him — the number in the page's own subtitle.
 *
 * `yours` only, and deliberately NOT a total across the three lanes: a figure that counted someone
 * else's work would send him looking for decisions that are not his.
 */
export function needsYouHeadlineCount(board: NeedsYouBoard): number {
  return board.yours.length;
}
