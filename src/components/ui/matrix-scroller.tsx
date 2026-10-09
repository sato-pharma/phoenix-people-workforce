/**
 * The one sideways-scroll box the fits-the-screen golden rule exempts: a MATRIX whose width IS a count.
 *
 * AGENTS.md §4 forbids a horizontal scroll and names its own anti-pattern — "fit by MERGING columns,
 * never shrinking type; `overflow-x-auto` over a `min-width` IS the bug". A matrix cannot obey it,
 * because no merge bounds a count: one column per product, one per month, or one block per product
 * times its months. The owner ruled on exactly that shape for the monthly closing matrix — it "can
 * NEVER fit; leave the scroll" — and the sticky first column that freezes the names only works
 * inside a sideways scroll.
 *
 * It is ONE component, imported by every grid of that shape, so that the permission is declared and
 * reasoned about in exactly one place and the fits-the-screen ratchet
 * (tests/fits-the-screen-ratchet.test.ts) counts it once however many matrices exist. Adding the
 * third monthly matrix LOWERED that count for this reason; the weekly per-product units grid joins
 * it for the same one. Anything that is not a matrix of this shape does not belong here — it belongs
 * in a `w-full table-fixed` with a `<colgroup>`.
 */
import type { ReactNode } from "react";

export function MatrixScroller({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}
