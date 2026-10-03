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

/** Eight seconds per source. Measured against the slowest adapters that are still worth waiting for. */
export const NEEDS_YOU_SOURCE_TIMEOUT_MS = 8_000;

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
): Promise<NeedsYouSourceState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      adapter.load(access, now),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), NEEDS_YOU_SOURCE_TIMEOUT_MS);
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
      return { status: "unavailable", because: "it did not answer within 8 seconds" };
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
export async function loadNeedsYouSources(
  access: AccessContext,
  adapters: readonly NeedsYouAdapter[],
  now: Date = new Date(),
): Promise<NeedsYouSourceResult[]> {
  return Promise.all(
    adapters.map(async (adapter) => ({
      id: adapter.id,
      state: await loadWithTimeout(adapter, access, now),
    })),
  );
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
