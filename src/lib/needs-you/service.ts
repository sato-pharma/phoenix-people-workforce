/**
 * The fan-out. One adapter per source, one call, a per-source timeout, and no branch that can turn a
 * failure into a zero.
 *
 * 🔴 WHY THIS IS ONE CALL AND NOT A DEFERRED/STREAMING SECOND PHASE. Several of these reads take
 * seconds, so the tempting shape is a fast band plus a `<Suspense>` band that fills in later. That
 * shape re-opens the exact hole this module closes: a deferred band that fails renders NOTHING, and a
 * missing source becomes invisible again — which is the under-report, dressed as a performance win.
 * The page is `force-dynamic` and a reload is the refresh. There is no polling.
 *
 * 🔴 AND WHY A TIMEOUT PRODUCES AMBER, NOT AN EMPTY LANE. A source that has not answered in eight
 * seconds is a source whose contents are unknown. The loser becomes
 * `{status: "unavailable", because: "it did not answer within 8 seconds"}` and shows up in band one
 * with that sentence, so a slow queue reads as unread rather than as clear.
 *
 * 🔴 AND WHY THE FAN-OUT IS BOUNDED RATHER THAN A `Promise.all` OVER ALL 22 (2026-10-09). It WAS an
 * unbounded `Promise.all`, and on production the owner read the board three times and got 9 items,
 * then 8, then 7 — a different set of amber rows each time, and nine of the 22 sources unread on the
 * read he kept. Nothing was slow: measured alone against production the same evening, the worst
 * source took 5,516 ms and NONE of the 22 exceeded the 8-second budget. Started together they
 * inflate each other — the three heavy ones to 10,280 / 9,387 / 9,222 ms, and even a 903 ms source
 * to 7,016 ms — so the budget was being spent queueing behind the other 21 reads rather than on the
 * read itself. Three measured fixes, in the order they matter:
 *
 *   1. TWO LANES, so a heavy source never runs beside another heavy source (one at a time) while
 *      the light ones fan out four at a time. Measured: wall 12.7 s, heaviest single source
 *      5,647 ms, nothing within 2 s of the budget, and no `57014 canceling statement due to
 *      statement timeout` — which the 22-way shape DID provoke out of `phx_closing_drift_status`.
 *      At two heavy lanes the peak was 7,687 ms: 313 ms of headroom, which is not headroom at all,
 *      so the heavy lane is ONE.
 *   2. EACH SOURCE'S CLOCK STARTS WHEN THAT SOURCE STARTS. Under the old shape every timer started
 *      at fan-out, so a source could spend its whole budget in a queue and amber having never run.
 *      `office-allocation-drift` starts at +10.5 s in the measured run and answers in 2,264 ms: a
 *      fan-out clock ambers it, its own clock does not.
 *   3. A BOARD CEILING, because bounding the width unbounds the total. 22 sources that all hang
 *      cost 8 s in parallel and up to 48 s through lanes, so the whole fan-out carries
 *      {@link NEEDS_YOU_BOARD_BUDGET_MS}; a source still queued when it passes is returned amber
 *      with its own sentence instead of starting a read nobody is waiting for any more.
 *
 * 🔴 WHAT THIS DELIBERATELY TRADES. The page is SLOWER in the healthy case. Three whole-board
 * reads from the laptop after the fix: 14.9 s, 12.2 s, 19.6 s — against the old shape's 10.3 s — and
 * all three returned **0 amber of 22 sources** and the identical 14 / 9 / 1 lanes, where the old
 * shape returned 9, then 8, then 7 items with a different set of unread sources each time. The
 * heavy lane IS that wall: three sources at 4.6-5.5 s each, run one after another on purpose.
 *
 * That is the right way round for this board — "a board that under-reports is worse than no board"
 * (`types.ts`) prices a few seconds of a loading screen he is already shown below nine sources he
 * cannot see, two of which were hiding 13 overdue marketing requests at his own step and a
 * nine-day-old uncollected leaver deduction. Never buy the seconds back by widening a lane. The way
 * to make this page faster is to make a heavy source cheaper, which changes what it measures and is
 * his call, not a scheduling one.
 */
import type { AccessContext } from "@/lib/auth/permissions";
import { logStructured } from "@/lib/observability/log";

import { buildNeedsYouBoard } from "./classify";
import { isForbiddenSourceError, needsYouAdapters, type NeedsYouAdapter } from "./sources";
import {
  needsYouSourceLabels,
  type NeedsYouBoard,
  type NeedsYouSourceResult,
  type NeedsYouSourceState,
} from "./types";

/**
 * Eight seconds per source, counted from the moment THAT source starts — never from the fan-out.
 *
 * Measured alone against production 2026-10-09, the slowest source answers in 5,516 ms, so this is
 * not a ceiling any healthy read approaches; a source that reaches it is a source in trouble. The
 * lane limits below are what keep it that way, and raising this number instead of narrowing a lane
 * would make a hung source hold the page for longer without making any source answer.
 */
export const NEEDS_YOU_SOURCE_TIMEOUT_MS = 8_000;

/**
 * ONE. A heavy source never runs beside another heavy source.
 *
 * At two, the measured peak was 7,687 ms against an 8,000 ms budget — 313 ms, which is noise, not
 * headroom, and production carries real traffic this measurement did not. At one, the peak was
 * 5,647 ms. Account: the header.
 */
export const NEEDS_YOU_HEAVY_LANE_LIMIT = 1;

/**
 * Four light sources at a time. Nineteen sources averaging 400 ms drain in about 2 s, well inside
 * the heavy lane's own run, so widening this buys no wall time — it only puts the light sources
 * back into contention with each other.
 */
export const NEEDS_YOU_LIGHT_LANE_LIMIT = 4;

/**
 * The whole fan-out's ceiling. Bounding the width unbounds the total: 22 sources that all hang cost
 * 8 s under a `Promise.all` and up to 48 s through two lanes, which would be a page that never
 * paints. A source still QUEUED when this passes is returned amber rather than started — and a
 * source already running keeps its own 8 s, so the worst case is this plus one budget.
 *
 * 🔴 45 s, AND IT IS NOT A LATENCY TARGET — IT IS THE LINE PAST WHICH THE BOARD IS BROKEN RATHER
 * THAN SLOW. Three whole-board reads measured from the laptop read 12.2 s, 14.9 s and 19.6 s, so a
 * 30 s ceiling sat inside 1.6x of a measured read: it would have fired on an ordinary slow
 * afternoon and ambered sources that were about to answer, manufacturing the exact under-report the
 * lanes were built to remove. Tightening this to trim the page is therefore backwards — trim the
 * page by making a heavy source cheaper.
 */
export const NEEDS_YOU_BOARD_BUDGET_MS = 45_000;

const TIMED_OUT = Symbol("needs-you-source-timed-out");

/** The first line of whatever an unknown rejection carries, in words a person can read. */
function reasonFrom(error: unknown): string {
  const message = String((error as Error | undefined)?.message ?? error ?? "").split("\n")[0].trim();
  return message || "it did not answer";
}

/**
 * Race one adapter against the clock.
 *
 * The timer is CLEARED on both paths. A `setTimeout` left pending would keep the Node event loop
 * alive for eight seconds after the page has already streamed, which on a serverless-style runtime
 * shows up as a request that will not finish rather than as anything to do with this board.
 */
async function loadWithTimeout(
  adapter: NeedsYouAdapter,
  access: AccessContext,
  now: Date,
  budgetMs: number,
): Promise<NeedsYouSourceState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      adapter.load(access, now),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
      }),
    ]);
    if (raced === TIMED_OUT) {
      logStructured("ERROR", "Needs You source timed out", {
        labels: {
          event: "needs_you_source_timeout",
          source: adapter.id,
          hrId: access.hrId,
          role: access.role,
          scope: access.scope,
        },
      });
      // The sentence carries the budget it actually raced, so a changed budget cannot leave the
      // row claiming a number nothing measured. At 8,000 ms it reads exactly as it always has.
      return {
        status: "unavailable",
        because: `it did not answer within ${Math.round(budgetMs / 1000)} seconds`,
      };
    }
    return raced;
  } catch (error) {
    // A `Forbidden:` rejection means this viewer holds no rung on that queue — a TRUE zero, and
    // nothing to alarm about. Every OTHER rejection means the queue did not answer, which is not a
    // zero at all. Collapsing the two is what turns "I could not read resignations" into "there are
    // no resignations", and it is why `not-applicable` is a state of its own.
    if (isForbiddenSourceError(error)) {
      logStructured("DEBUG", "Needs You source refused", {
        labels: {
          event: "needs_you_source_forbidden",
          source: adapter.id,
          hrId: access.hrId,
          role: access.role,
          scope: access.scope,
        },
        error,
      });
      return { status: "not-applicable", because: "you hold no rung on this queue" };
    }
    logStructured("ERROR", "Needs You source failed", {
      labels: {
        event: "needs_you_source_failed",
        source: adapter.id,
        hrId: access.hrId,
        role: access.role,
        scope: access.scope,
      },
      error,
    });
    return { status: "unavailable", because: reasonFrom(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The whole board, in one call.
 *
 * `Promise.all` is safe here ONLY because `loadWithTimeout` cannot reject: every failure path inside
 * it returns a state. If that ever stops being true, this becomes `allSettled` — an `all` that can
 * reject would take the whole page down, and a page that errors is at least honest, but an `all`
 * whose rejection was caught upstream into an empty board would not be.
 */
/**
 * Run a CHOSEN set of adapters, each with the same timeout and the same three-state result.
 *
 * 🔴 WHY THIS IS EXPORTED SEPARATELY FROM `getNeedsYouBoard`, AND WHY THE CEO SHARES THE ADAPTERS
 * RATHER THAN THE BOARD. `getCeoAdminSignals` (`src/lib/ceo/command-center.ts`) held its own
 * implementation of three signals this module also owns, and they had already drifted: its probation
 * rule filters to people still employed and reads `lifecycleRiskWindows.probationCriticalDays`,
 * where this module's adapter did neither. Two expressions of one rule is the whole defect.
 *
 * Calling the whole `getNeedsYouBoard` from there would have fixed the drift by adding THIRTEEN
 * source reads to the owner's heaviest landing page in order to use three of them, and would have
 * changed the leave tile's meaning (this module's leave source answers "awaiting YOU"; the CEO tile
 * answers "pending anywhere"). Sharing the adapters costs nothing, changes no number, and leaves one
 * producer per rule — and the caller still receives `unavailable`, so a failed read cannot become a
 * zero on that screen either.
 */
/**
 * The four numbers above, overridable.
 *
 * 🔴 NOTHING IN THE APP PASSES THIS, AND NOTHING SHOULD. It exists so
 * `tests/needs-you-source-scheduling.test.ts` can prove the two properties that are otherwise
 * untestable without sitting through real seconds — that a source's budget starts when the SOURCE
 * starts rather than at fan-out, and that the board ceiling ambers a source it never read instead of
 * dropping it. A page that passes its own numbers here is a page that has quietly left the measured
 * shape; change the constants instead, with a measurement.
 */
export type NeedsYouFanOutOptions = {
  sourceTimeoutMs?: number;
  boardBudgetMs?: number;
  heavyLaneLimit?: number;
  lightLaneLimit?: number;
};

export async function loadNeedsYouSources(
  access: AccessContext,
  adapters: readonly NeedsYouAdapter[],
  now: Date = new Date(),
  options: NeedsYouFanOutOptions = {},
): Promise<NeedsYouSourceResult[]> {
  const sourceTimeoutMs = options.sourceTimeoutMs ?? NEEDS_YOU_SOURCE_TIMEOUT_MS;
  const heavyLaneLimit = options.heavyLaneLimit ?? NEEDS_YOU_HEAVY_LANE_LIMIT;
  const lightLaneLimit = options.lightLaneLimit ?? NEEDS_YOU_LIGHT_LANE_LIMIT;
  const deadline = Date.now() + (options.boardBudgetMs ?? NEEDS_YOU_BOARD_BUDGET_MS);
  // Written by INDEX, so results come back in the order they were asked for however the two lanes
  // interleave. `classify.ts` does not depend on that order, but a caller reading `results[0]`
  // would, and a non-deterministic order is what makes one flaky test look like two.
  const results = new Array<NeedsYouSourceResult | undefined>(adapters.length);

  const drain = async (indexes: readonly number[], limit: number): Promise<void> => {
    let next = 0;
    const lane = async (): Promise<void> => {
      for (;;) {
        const slot = next;
        next += 1;
        if (slot >= indexes.length) return;
        const index = indexes[slot]!;
        const adapter = adapters[index]!;
        if (Date.now() >= deadline) {
          // Never read: still queued when the board ran out of time. Amber for the same reason a
          // timeout is amber — its contents are unknown — and in its own words, so the row cannot
          // be mistaken for a read that happened and found nothing.
          logStructured("ERROR", "Needs You source was never read", {
            labels: {
              event: "needs_you_source_unstarted",
              source: adapter.id,
              hrId: access.hrId,
              role: access.role,
              scope: access.scope,
            },
          });
          results[index] = {
            id: adapter.id,
            state: { status: "unavailable", because: "the board ran out of time before it could be read" },
          };
          continue;
        }
        results[index] = {
          id: adapter.id,
          state: await loadWithTimeout(adapter, access, now, sourceTimeoutMs),
        };
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, limit) }, lane));
  };

  const heavy: number[] = [];
  const light: number[] = [];
  adapters.forEach((adapter, index) => {
    if (adapter.cost === "heavy") heavy.push(index);
    else light.push(index);
  });

  // Both lanes at once. The heavy lane is the long pole, so the light ones finish inside its run.
  await Promise.all([drain(heavy, heavyLaneLimit), drain(light, lightLaneLimit)]);

  // Every adapter asked for, answered. A hole here would render as a source that is not on the
  // board at all, so it throws rather than filters — `classify.ts` would drop it in silence.
  return results.map((result, index) => {
    if (!result) throw new Error(`needs-you: source "${adapters[index]?.id}" produced no result`);
    return result;
  });
}

export async function getNeedsYouBoard(access: AccessContext, now: Date = new Date()): Promise<NeedsYouBoard> {
  const results: NeedsYouSourceResult[] = await loadNeedsYouSources(access, needsYouAdapters, now);
  const board = buildNeedsYouBoard(results, now);
  if (board.notProven.length > 0) {
    logStructured("WARNING", "Needs You board could not prove a clean read", {
      labels: {
        event: "needs_you_board_incomplete",
        hrId: access.hrId,
        role: access.role,
        scope: access.scope,
        unavailable: board.notProven.map((entry) => needsYouSourceLabels[entry.id]).join(", "),
      },
    });
  }
  return board;
}
