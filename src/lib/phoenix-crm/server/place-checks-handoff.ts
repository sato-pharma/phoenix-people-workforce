/**
 * Phoenix CRM — Place checks: the rows the page read and did not send, kept for the click (owner,
 * 2026-11-14, "Load lists on demand").
 *
 * The page still reads every place in use and every decision — it counts the opening figures from them
 * (`place-checks-on-demand.ts`) — and sends only what Needs you draws. Reading the same rows again on the
 * click took 11 s from the laptop (the two widest reads of the module, measured 14 Nov 2026), so the page
 * leaves what it read here and the click takes it: the lists arrive as fast as they can be sent, and they
 * are the very rows the counts on his screen were made from.
 *
 * 🔴 ONE ENTRY PER PERSON, TAKEN ONCE, GONE AFTER TWO MINUTES. The rows are the two biggest sets in the
 * module (about 8.5 MB as sent), so nothing is kept longer than the click needs: the next open replaces
 * the entry, the click removes it, and a timer drops one nobody took. A miss is never an error — the route
 * reads the rows itself, as it would with no entry at all (another server, a click after two minutes, a
 * second click after a re-read of the page has not happened yet).
 *
 * It is keyed by the person, not by a token the browser sends, so a re-read of the page (`placeCheckReread`)
 * leaves a fresh entry that the board's reload, on the same address, takes. It lives on `globalThis`
 * because a page and a route handler are separate bundles in one server process.
 */

import type { PlaceChecksEverything } from "@/lib/phoenix-crm/place-checks-on-demand";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

export const PLACE_CHECKS_HANDOFF_MS = 2 * 60_000;

type Kept = { at: number; everything: PlaceChecksEverything; timer: ReturnType<typeof setTimeout> };

const STORE = Symbol.for("phoenix.placeChecks.handoff");

function store(): Map<string, Kept> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Kept> | undefined>;
  holder[STORE] ??= new Map();
  return holder[STORE];
}

/** Whose rows these are: the person, their role and whether it is a test account — each reads its own set. */
export function placeChecksHandoffKey(viewer: Pick<PhoenixCrmViewer, "hrId" | "role" | "isTestPersona">): string {
  return `${viewer.hrId}|${viewer.role}|${viewer.isTestPersona ? "test" : "real"}`;
}

/** The page: leave what it read for the click, replacing anything this person left before. */
export function keepPlaceChecksForTheClick(key: string, everything: PlaceChecksEverything, now = Date.now()): void {
  const kept = store();
  const before = kept.get(key);
  if (before) clearTimeout(before.timer);
  const timer = setTimeout(() => {
    if (kept.get(key)?.at === now) kept.delete(key);
  }, PLACE_CHECKS_HANDOFF_MS);
  // Never hold the server open for a timer whose only job is to forget.
  (timer as { unref?: () => void }).unref?.();
  kept.set(key, { at: now, everything, timer });
}

/** The route: take what the page left, once, if it is still fresh; otherwise null and the route reads. */
export function takePlaceChecksForTheClick(key: string, now = Date.now()): PlaceChecksEverything | null {
  const kept = store();
  const entry = kept.get(key);
  if (!entry) return null;
  kept.delete(key);
  clearTimeout(entry.timer);
  return now - entry.at <= PLACE_CHECKS_HANDOFF_MS ? entry.everything : null;
}
