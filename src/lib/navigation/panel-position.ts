/**
 * Horizontal placement for a popover anchored to a button, clamped to the viewport.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * MEASURED ON PRODUCTION, 2026-09-02, revision 803d74e13: the nav row's "+" panel opened at
 * `left: 184 → right: 472` inside a **375px** viewport — roughly 97px of it off-screen, clipped
 * rather than scrollable, so that strip was unreachable. It broke the owner's fits-the-screen golden
 * rule, and it did so in a way the obvious check misses: the DOCUMENT never scrolled horizontally
 * (375/375), because the overflow was clipped by an ancestor. Measuring `scrollWidth > clientWidth`
 * over `main` says the page is fine while a popover hangs off the side of it.
 *
 * ── Why it is not CSS ────────────────────────────────────────────────────────
 * The panel is anchored to a button whose x position is not knowable in CSS, and BOTH edges are in
 * play. At 375px the upper row's "+" sits near the right edge, so a left-anchored panel overflows
 * RIGHT; the lower row's "+" sits near the left edge, so a right-anchored one would overflow LEFT.
 * Centring fails for the same reason. Narrowing the panel does not help either — the overflow comes
 * from the anchor's position, not the width. So the placement has to be computed against a measured
 * viewport, which means arithmetic, which means it belongs in a function that can be tested rather
 * than in a className.
 *
 * It is called from the "+"'s own click handler, where the button's rect is already in hand —
 * deliberately NOT from an effect, because `setState` inside `useEffect` is a lint error here.
 */

/** The panel's preferred width — Tailwind `w-72`, kept in sync by `nav-panel-width` below. */
export const NAV_PANEL_WIDTH = 288;

/** Breathing room kept between the panel and each edge of the viewport. */
export const NAV_PANEL_GUTTER = 8;

export type PanelPlacement = {
  /**
   * Pixels to shift the panel from its anchor's left edge — negative pulls it back on screen.
   * Applied as a margin so the panel keeps its vertical `top-full` anchoring and continues to move
   * with the row rather than detaching from it on scroll.
   */
  offsetLeft: number;
  /** The width to render at, never wider than the viewport minus both gutters. */
  width: number;
};

/**
 * Place a panel of `preferredWidth` under an anchor whose left edge is at `anchorLeft`, keeping the
 * whole panel inside `viewportWidth` with `gutter` to spare on each side.
 *
 * Preference order: sit flush with the anchor's left edge; if that would run off the right, slide
 * left just far enough; if the anchor itself is closer to the left edge than the gutter, sit at the
 * gutter. When the viewport is narrower than the panel plus both gutters, the panel is narrowed —
 * at which point there is exactly one legal position and every anchor resolves to it.
 */
export function clampPanelToViewport({
  anchorLeft,
  gutter = NAV_PANEL_GUTTER,
  preferredWidth = NAV_PANEL_WIDTH,
  viewportWidth,
}: {
  anchorLeft: number;
  gutter?: number;
  preferredWidth?: number;
  viewportWidth: number;
}): PanelPlacement {
  const width = Math.min(preferredWidth, Math.max(0, viewportWidth - gutter * 2));
  // The rightmost left-edge that still leaves a gutter on the right. Never below `gutter` itself,
  // so a viewport too small for even one gutter pair cannot produce a negative position.
  const rightmost = Math.max(gutter, viewportWidth - width - gutter);
  const left = Math.max(gutter, Math.min(anchorLeft, rightmost));
  return { offsetLeft: Math.round(left - anchorLeft), width };
}

/**
 * The same clamp for a panel that prefers to hang from its anchor's RIGHT edge — a trigger sitting
 * near the right of a toolbar, where left-alignment would push the panel off-screen on desktop.
 *
 * MEASURED ON PRODUCTION, 2026-09-02, revision 99c9909f2: the notifications bell's panel is
 * right-anchored and opened at `left: -50 → right: 301` in a **375px** viewport — 50px off the LEFT
 * edge, clipped rather than scrollable. It is the mirror image of the "+" panel's failure the same
 * morning, and it confirms the note above: BOTH edges are in play, and narrowing does not save you.
 * That panel's width was ALREADY capped at `100vw - 1.5rem` (351px, so it fit) and it still hung off
 * the screen, because the overflow came from where the anchor sat, not from how wide the panel was.
 *
 * `main` measured 375/375 throughout, as ever.
 *
 * Returns the offset from the anchor's LEFT edge, so the caller positions with `left-0` +
 * `marginLeft` exactly as the left-aligned case does — one mechanism, not two.
 */
export function placeAnchoredPanel({
  align,
  anchorLeft,
  anchorRight,
  gutter = NAV_PANEL_GUTTER,
  preferredWidth = NAV_PANEL_WIDTH,
  viewportWidth,
}: {
  align: "left" | "right";
  anchorLeft: number;
  anchorRight: number;
  gutter?: number;
  preferredWidth?: number;
  viewportWidth: number;
}): PanelPlacement {
  const width = Math.min(preferredWidth, Math.max(0, viewportWidth - gutter * 2));
  // Where the panel WANTS to sit before any clamping. Right-alignment means its right edge meets the
  // anchor's right edge, which is a left edge of `anchorRight - width`.
  const preferredLeft = align === "right" ? anchorRight - width : anchorLeft;
  const placed = clampPanelToViewport({
    anchorLeft: preferredLeft,
    gutter,
    preferredWidth: width,
    viewportWidth,
  });
  // Re-express the result against the anchor's own left edge, which is what the caller offsets from.
  return {
    offsetLeft: Math.round(preferredLeft + placed.offsetLeft - anchorLeft),
    width: placed.width,
  };
}

/** The slice of `window` the subscription below needs — kept narrow so a test can stand in for it. */
export type ViewportChangeTarget = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

/** The events that can change the viewport under an already-open panel. */
export const VIEWPORT_CHANGE_EVENTS = Object.freeze(["resize", "orientationchange"] as const);

/**
 * Re-runs `reposition` whenever the viewport changes size, and returns the matching unsubscribe.
 *
 * THE GAP THIS CLOSES: every caller above measures its anchor in the CLICK handler, because
 * `setState` inside `useEffect` is a lint error in this repo and the anchor's rect is only
 * meaningful at the moment of opening. Correct at open — and stale from then on. Rotate a phone from
 * landscape to portrait with the notifications bell open and the panel keeps the 380px width and the
 * offset it was handed for an 812px viewport: it lands at `left: -17` in a 375px one, 17px off the
 * left edge, clipped rather than scrollable. That is the same golden-rule failure the clamp exists to
 * prevent, arriving through the one door the clamp does not watch.
 *
 * Deliberately framework-free and in this module rather than beside the hook, so the wiring can be
 * proven without a DOM or a React renderer — see `tests/nav-panel-position.test.ts`.
 */
export function subscribeToViewportChange(target: ViewportChangeTarget, reposition: () => void) {
  // One shared listener reference, or `removeEventListener` would detach nothing on cleanup.
  const onViewportChange = () => reposition();

  for (const event of VIEWPORT_CHANGE_EVENTS) target.addEventListener(event, onViewportChange);
  return () => {
    for (const event of VIEWPORT_CHANGE_EVENTS) target.removeEventListener(event, onViewportChange);
  };
}
