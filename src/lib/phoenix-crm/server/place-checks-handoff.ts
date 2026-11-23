/**
 * Phoenix CRM — Place checks: the rows the page read and did not send, kept for the click (owner,
 * 2026-11-14, "Load lists on demand").
 *
 * The opening figures are counted from every place in use and every decision
 * (`place-checks-on-demand.ts`), and the board is sent only what Needs you draws. Reading the same rows
 * again on the click took 11 s from the laptop (the two widest reads of the module, measured 14 Nov 2026),
 * so the read that counts the figures leaves its rows here and the click takes them: the lists arrive as
 * fast as they can be sent, and they are the very rows the counts on his screen were made from.
 *
 * 🔴 THE SUMMARY'S READ LEAVES THEM, NOT THE PAGE (owner, 23 Nov 2026: "Fix speed next"). The page made that
 * read itself until then, before it drew a row; it is now asked for by the board once it is on screen
 * (`server/place-checks-wide-read.ts`), and it is that route that keeps the rows.
 *
 * 🔴 ONE ENTRY PER PERSON, TAKEN ONCE, GONE AFTER TWO MINUTES. The rows are the two biggest sets in the
 * module (about 8.5 MB as sent), so nothing is kept longer than the click needs: the next open replaces
 * the entry, the click removes it, and a timer drops one nobody took. A miss is never an error — the route
 * reads the rows itself, as it would with no entry at all (another server, a click after two minutes, a
 * second click after a re-read of the page has not happened yet).
 *
 * It is keyed by the person, not by a token the browser sends, so the summary asked for again after a
 * re-read of the page (`placeCheckReread`) leaves a fresh entry for the next click. It lives on
 * `globalThis` because two route handlers are separate bundles in one server process.
 *
 * 🔴 KEPT BY WHEN THE READ STARTED, NEVER BY WHEN IT FINISHED. Two of these reads can be in flight for one
 * person (the board asks again after a decision), each about ten seconds long, and the older one can finish
 * last. An entry is never replaced by a read that started before it.
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

/**
 * The summary's read: leave what it read for the click, replacing anything this person left before.
 * `now` is the moment the read STARTED; a read that started before the one already kept changes nothing.
 */
export function keepPlaceChecksForTheClick(key: string, everything: PlaceChecksEverything, now = Date.now()): void {
  const kept = store();
  const before = kept.get(key);
  if (before && before.at > now) return;
  if (before) clearTimeout(before.timer);
  const timer = setTimeout(() => {
    if (kept.get(key)?.at === now) kept.delete(key);
  }, PLACE_CHECKS_HANDOFF_MS);
  // Never hold the server open for a timer whose only job is to forget.
  (timer as { unref?: () => void }).unref?.();
  kept.set(key, { at: now, everything, timer });
}

/** The route: take what the summary's read left, once, if it is still fresh; otherwise null and the route reads. */
export function takePlaceChecksForTheClick(key: string, now = Date.now()): PlaceChecksEverything | null {
  const kept = store();
  const entry = kept.get(key);
  if (!entry) return null;
  kept.delete(key);
  clearTimeout(entry.timer);
  return now - entry.at <= PLACE_CHECKS_HANDOFF_MS ? entry.everything : null;
}
