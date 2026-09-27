import { crmPost } from "@/lib/crm/client";
import { monotonicNow, outboxRunId } from "@/lib/crm/outbox";

/**
 * Phoenix CRM — the phone's half of the server-minted time anchor (A1).
 *
 * ## What this is for
 *
 * A visit's time is normally the SERVER's: `captured_at` is the moment it issued the photo's upload
 * slot, and the phone never supplies it. With no signal there is no slot, and the obvious substitute
 * — the phone's own clock — is the one thing that must not be used. The owner ruled on it directly
 * (2026-09-27): "I want the Cairo time, but I don't want the time on the phone because they may
 * install an app that changes the time in the phone."
 *
 * So while there is still signal the server hands out an ANCHOR, a row it wrote with its own
 * timestamp on it. This module remembers that anchor beside the phone's MONOTONIC reading at that
 * instant, and at the door it reports only how much monotonic time has passed since.
 *
 * 🔴 **It never sends a timestamp.** An anchor id, an elapsed duration, a run id. The server adds the
 * elapsed time to its own record of when it issued the anchor. `src/lib/phoenix-crm/offline-clock.ts`
 * holds the arithmetic and every bound that keeps a lie inside physics.
 *
 * ## Why the anchor lives in MEMORY and the queued visit lives on DISK
 *
 * They look like the same fact and they are not, so this is worth stating rather than discovering.
 *
 * An anchor is only usable for taking a NEW elapsed reading, and an elapsed reading is only
 * meaningful against the same monotonic origin — this process. `outboxRunId()` changes when the
 * process does, and the server refuses a claim whose run id does not match the anchor's
 * (`rebooted`). So writing an anchor to disk would preserve something that is already worthless by
 * the time it is read back: keeping it in memory is not a shortcut, it is the honest lifetime.
 *
 * A QUEUED VISIT is the opposite. Its claim was measured in the process that captured it, and both
 * halves — the anchor's run id on the server, the claim's run id on disk — were recorded then. It
 * stays true across a restart, which is exactly why the outbox persists and this does not.
 *
 * ## Nothing here is ever allowed to fail out loud
 *
 * Golden Rule #1. A rep is never told an anchor exists, never told one could not be taken, and never
 * blocked by one. With no anchor his visit is still captured, still queued, still sent and still
 * counted — the server dates it at arrival instead and marks it for the manager's board. Every
 * function below therefore swallows its errors and returns null.
 */

/** What the server gave us, beside the monotonic reading taken at the same instant. */
type HeldAnchor = {
  anchorId: string;
  /** `monotonicNow()` at the moment the anchor was taken. The origin of every later measurement. */
  takenAtMonotonic: number;
  /** This process's identity, sent when the anchor was minted so the server can match it later. */
  runId: string;
  /** Which territory it was minted for — an anchor is not transferable between seats. */
  seatId: string;
  test: boolean;
};

/** The claim the phone attaches to a queued visit. 🔴 Three fields, and none of them is a time. */
export type OfflineClaim = { anchorId: string; elapsedMs: number; bootId: string };

let held: HeldAnchor | null = null;

/** Drop the anchor when the seat or the test mode changes — see `anchorMatches`. */
export function forgetTimeAnchor(): void {
  held = null;
}

function anchorMatches(seatId: string, test: boolean): boolean {
  // The run id is checked too, though it cannot currently differ — `held` is module state and dies
  // with the process. It is asserted anyway so that making this durable later cannot silently start
  // handing out claims measured against another process's clock.
  return held !== null && held.seatId === seatId && held.test === test && held.runId === outboxRunId();
}

/**
 * Take a fresh anchor if this territory has none.
 *
 * Called where a connection has just proved itself — the app has loaded a day, or a save has
 * succeeded — because that is the moment an anchor is both obtainable and worth having. It resolves
 * to nothing and throws nothing; the caller does not branch on it.
 */
export async function ensureTimeAnchor(token: string | null, seatId: string, test: boolean): Promise<void> {
  if (!token || !seatId) return;
  if (anchorMatches(seatId, test)) return;
  try {
    // Read the monotonic clock BEFORE the request, not after. The anchor's `issuedAt` is stamped
    // somewhere inside this round trip, so starting the stopwatch early can only ever make a later
    // elapsed reading look SHORTER than the truth — and the server's own window bound already
    // refuses anything that looks longer. The error is on the safe side by construction.
    const startedAt = monotonicNow();
    const runId = outboxRunId();
    const anchor = await crmPost<{ anchorId: string; issuedAt: string }>(
      "/api/phoenix-crm/time-anchor",
      "anchor",
      { bootId: runId, seatId, test },
      token,
    );
    if (!anchor?.anchorId) return;
    held = { anchorId: anchor.anchorId, runId, seatId, takenAtMonotonic: startedAt, test };
  } catch {
    // Silent by rule. No anchor simply means a visit captured offline is dated when it arrives.
  }
}

/**
 * The claim for a visit being captured right now, or null when there is no usable anchor.
 *
 * 🔴 `Date.now()` appears nowhere in this file. The elapsed value comes from `monotonicNow()`, the
 * clock a "change my time" app cannot reach.
 */
export function offlineClaimNow(seatId: string, test: boolean): OfflineClaim | null {
  if (!anchorMatches(seatId, test) || !held) return null;
  const elapsedMs = monotonicNow() - held.takenAtMonotonic;
  // A negative delta cannot happen on a monotonic clock, so if one appears the clock is not the one
  // we think it is. Withhold the claim rather than send a reading we cannot explain.
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  return { anchorId: held.anchorId, bootId: held.runId, elapsedMs: Math.round(elapsedMs) };
}
