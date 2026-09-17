import type { PanelPlacement } from "@/lib/navigation/panel-position";

/**
 * Where a filter dropdown's panel opens: under its trigger, inside the screen and inside `main`.
 *
 * ── The defect ───────────────────────────────────────────────────────────────
 * `MultiSelectFilter` and `RoiMultiSelect` hung a 320px panel from the LEFT edge of their trigger,
 * always. The right-hand cells of a filter grid are narrower than that, so their panels ran past the
 * right edge. With every dropdown open on the managers' Weekly Sales page in a 1,440px window, one or
 * two panels crossed it and `main` grew 58px wider than its own box (2026-09-16). On the live portal at
 * 1280px, the Distributor panel spanned 1,030 → 1,286px of a 1,265px page (2026-09-17).
 *
 * ── Why not the clamp in panel-position.ts ──────────────────────────────────
 * That clamp places the topbar panels, which sit outside `main`, in the viewport's own pixels. These
 * dropdowns sit INSIDE `main`, and two things change there:
 *
 *   1. `main` wears the display zoom (0.8 by default from 1024px; see display-scale.ts). A rect comes
 *      back in screen pixels, but `margin-left` and `width` are read in the zoomed element's own
 *      pixels, so every measured length is divided by the zoom before the clamp sees it. Skip that and,
 *      at 0.8, a panel pulled back from the right edge moves only 80% of the way it was sent.
 *   2. The viewport is not the only edge. The portal leaves a gutter to the right of `main`, so a panel
 *      that is still on the screen can cross `main`'s own edge — and `main` is where the owner measures
 *      the scroll. The room is therefore the viewport less a gutter, cut down to `main` and to every
 *      ancestor that clips.
 *
 * The panel still takes the same shape as the topbar panels — `left-0` plus a measured `marginLeft`
 * and `width` (a `PanelPlacement`) — but the offset is not rounded. That clamp rounds it twice, which
 * can land a whole pixel outside its room; against `main`'s own edge a pixel is a scroll.
 *
 * Framework-free and DOM-free (the measurement reads through the narrow `MeasuredBox` below), so the
 * arithmetic and the walk up the page are both proven without a browser: see
 * `tests/multi-select-filter-fits.test.ts`. The hook that wires it to a `<details>` is
 * `src/hooks/use-dropdown-panel-placement.ts`.
 */

/** The panel's preferred width, in the trigger's own CSS pixels: what both dropdowns always asked for. */
export const DROPDOWN_PANEL_WIDTH = 320;

/** Screen pixels kept clear between the panel and each edge of the viewport. */
export const DROPDOWN_PANEL_VIEWPORT_GUTTER = 8;

/**
 * Screen pixels kept clear inside `main` and inside every clipping ancestor. A pixel, not a gutter: the
 * trigger already sits inside those boxes, and a panel hung from its right edge should line up with it.
 * The pixel absorbs the browser snapping a fractional edge outward, which would read as a 1px scroll.
 */
export const DROPDOWN_PANEL_EDGE_SAFETY = 1;

export type HorizontalEdges = { left: number; right: number };

/**
 * Place the panel of a trigger whose edges are `trigger`, inside `room`. Both are screen pixels, as
 * `getBoundingClientRect` reports them; `zoom` is screen pixels per CSS pixel at the trigger.
 *
 * A trigger in the right half of the room hangs its panel from its RIGHT edge, and one in the left
 * half from its left edge. Either way the clamp then keeps the whole panel inside the room, and a room
 * narrower than the panel narrows the panel: the labels inside wrap, and the type never shrinks.
 *
 * Returns CSS pixels in the trigger's own coordinates, ready for `marginLeft` and `width` on a `left-0`
 * panel.
 */
export function placeDropdownPanel({
  preferredWidth = DROPDOWN_PANEL_WIDTH,
  room,
  trigger,
  zoom,
}: {
  preferredWidth?: number;
  room: HorizontalEdges;
  trigger: HorizontalEdges;
  zoom: number;
}): PanelPlacement {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  // A room narrower than the trigger means the trigger already crosses one of its edges, or the page
  // measured oddly. Keep the panel under the trigger and no wider than it: that adds no overflow of its
  // own, where a clamp into a sliver of room would leave a panel too narrow to use.
  const edges = room.right - room.left < trigger.right - trigger.left ? trigger : room;
  const width = Math.min(preferredWidth, (edges.right - edges.left) / scale);
  const onScreen = width * scale;
  const flush = trigger.left + trigger.right > edges.left + edges.right ? trigger.right - onScreen : trigger.left;
  // `onScreen` never exceeds the room, so this interval is never empty.
  const left = Math.min(Math.max(flush, edges.left), edges.right - onScreen);
  return { offsetLeft: (left - trigger.left) / scale, width };
}

/** The slice of an element the measurement reads, kept narrow so a test can stand in for a zoomed page. */
export type MeasuredBox = {
  readonly tagName: string;
  readonly offsetWidth: number;
  readonly clientWidth: number;
  readonly clientLeft: number;
  readonly parentElement: MeasuredBox | null;
  getBoundingClientRect(): { readonly left: number; readonly right: number; readonly width: number };
};

/**
 * The room a panel hung from `anchor` may use, in screen pixels: the viewport less its gutter, cut
 * down to the inside of `main` and of every ancestor whose `overflow-x` is not `visible`.
 *
 * `main` counts even when it does not clip, because its `scrollWidth` is what grows. A clipping
 * ancestor counts because whatever crosses it is cut off and cannot be reached, while the page still
 * reports that it fits. Each box's inner edges come from `clientLeft` and `clientWidth`, which are in
 * that box's own pixels, so each is scaled by that box's own zoom (its rect width over `offsetWidth`).
 * A box with no width (an inline or `display: contents` wrapper) has no edges to give and is skipped.
 */
export function measureDropdownRoom(
  anchor: MeasuredBox,
  viewportWidth: number,
  overflowX: (box: MeasuredBox) => string,
): HorizontalEdges {
  let left = DROPDOWN_PANEL_VIEWPORT_GUTTER;
  let right = viewportWidth - DROPDOWN_PANEL_VIEWPORT_GUTTER;
  for (let box = anchor.parentElement; box; box = box.parentElement) {
    if (box.tagName !== "MAIN" && overflowX(box) === "visible") continue;
    if (!box.offsetWidth || !box.clientWidth) continue;
    const rect = box.getBoundingClientRect();
    const scale = rect.width / box.offsetWidth;
    const inner = rect.left + box.clientLeft * scale;
    left = Math.max(left, inner + DROPDOWN_PANEL_EDGE_SAFETY);
    right = Math.min(right, inner + box.clientWidth * scale - DROPDOWN_PANEL_EDGE_SAFETY);
  }
  return { left, right };
}

/**
 * Measure `anchor` (the dropdown's `<details>`) where it stands and place its panel. Returns null when
 * the anchor is not laid out, which leaves the panel on its CSS fallback.
 */
export function measureDropdownPanel(
  anchor: MeasuredBox,
  viewportWidth: number,
  overflowX: (box: MeasuredBox) => string,
): PanelPlacement | null {
  const rect = anchor.getBoundingClientRect();
  if (!anchor.offsetWidth || !rect.width) return null;
  return placeDropdownPanel({
    room: measureDropdownRoom(anchor, viewportWidth, overflowX),
    trigger: rect,
    zoom: rect.width / anchor.offsetWidth,
  });
}
