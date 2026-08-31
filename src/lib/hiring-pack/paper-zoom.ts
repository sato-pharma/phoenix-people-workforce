// How large the paper is drawn on screen, given how much room the panel has for it.
//
// This is arithmetic, not layout, and it lives here rather than inside the editor component for one
// reason: it is the half that can be wrong. Whether a ResizeObserver delivers its callback is
// standard browser behaviour; whether the number it is handed produces a page that fits is a rule,
// and a rule belongs somewhere a registered test can read it. (It could not have been checked in the
// browser in any case — ResizeObserver rides the rendering lifecycle, so in a hidden pane it never
// fires at all, which reads exactly like a broken feature. Measured 2026-08-31.)

/**
 * The on-screen box the page is drawn into, before zoom.
 *
 * Comfortably wider than any of the nine documents at 100% — A4 is 794px at 96dpi and US Legal 816px
 * — so the page is never the thing being cropped. The iframe holds the real paper at its real size
 * and the zoom is a CSS transform applied outside it, which is what keeps `print()` at exactly 100%
 * and every placed value on its printed box.
 */
export const PAGE_WIDTH_PX = 900;
export const PAGE_HEIGHT_PX = 1120;

/** What the panel opens at when there is room for it. */
export const DEFAULT_ZOOM = 0.85;

/**
 * The smallest the fit will go on its own.
 *
 * A page shrunk past about a third is unreadable, so below this showing the whole width buys nothing
 * and the panel keeps its scrollbar instead — a legible half beats an illegible whole. The zoom
 * buttons still go lower; this is the floor for the automatic fit, not for the operator.
 */
export const MIN_FIT_ZOOM = 0.32;

/**
 * The zoom that shows the whole width of the page in `usableWidth` pixels of panel.
 *
 * Only ever shrinks. A panel wider than the page keeps the default rather than blowing the paper up
 * to fill it, because a document magnified past its printed size stops being a preview of the
 * printed size.
 *
 * Returns the default for a width that is not a usable number — a panel measured mid-layout can
 * report 0 or NaN, and scaling the page to nothing on the strength of that would be a worse answer
 * than leaving it where it was.
 */
export function fitZoomForWidth(usableWidth: number): number {
  if (!Number.isFinite(usableWidth) || usableWidth <= 0) return DEFAULT_ZOOM;
  if (usableWidth >= PAGE_WIDTH_PX * DEFAULT_ZOOM) return DEFAULT_ZOOM;
  return Math.max(MIN_FIT_ZOOM, Number((usableWidth / PAGE_WIDTH_PX).toFixed(3)));
}
