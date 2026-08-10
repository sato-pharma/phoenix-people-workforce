/**
 * The sidebar rail's measured geometry, in one place, so the width budget a label actually gets is
 * derivable instead of guessed.
 *
 * Owner rule: sidebar text is never truncated with an ellipsis and never wraps. The label span in
 * src/components/layout/sidebar.tsx still carries `truncate` as a last-resort safety net, but
 * tests/sidebar-label-width.test.ts asserts that net is never reached — so a label that would clip
 * fails CI instead of shipping as "Finance Command …".
 *
 * Every number below is read off the Tailwind classes in sidebar.tsx. Keep them in sync; the test
 * is only as honest as these constants.
 */

/** `SIDEBAR_WIDTH_EXPANDED = "w-[280px]"` on the <aside>. */
export const SIDEBAR_WIDTH = 280;

/** Nav scroller `px-3` (12 each side) + the item group's `px-1` (4 each side). */
const CONTAINER_PADDING = 12 * 2 + 4 * 2;

/** NavRow <Link> `px-2.5` (10 each side). */
const ROW_PADDING = 10 * 2;

/** Icon box `h-9 w-9`, shrink-0, plus the Link's `gap-3`. */
const ICON_BOX = 36;
const ICON_GAP = 12;

/**
 * `pr-6` on the label wrapper. The pin star is `absolute right-1.5 h-6 w-6` and appears on hover,
 * so this space is permanently reserved to stop it covering the end of the label.
 */
const PIN_RESERVE = 24;

/** ArrowUpRight `h-3.5 w-3.5` after the wrapper's `gap-1.5`. Hub (standalone) rows only. */
const HUB_ARROW = 14 + 6;

/** ApprovalNavBadge: `min-w-[18px] px-1` (18 + 8) after the wrapper's `gap-1.5`. */
const BADGE = 18 + 4 * 2 + 6;

/**
 * Pixels a label actually gets. `hub` is a section that resolves to exactly ONE visible item —
 * sidebar.tsx renders those as a standalone row carrying the ↗. The arrow is suppressed when the
 * row also has a badge (two trailing adornments do not fit), which is why they never both apply.
 */
export function labelBudgetPx({ hub, badge }: { badge: boolean; hub: boolean }): number {
  let budget = SIDEBAR_WIDTH - CONTAINER_PADDING - ROW_PADDING - ICON_BOX - ICON_GAP - PIN_RESERVE;
  if (badge) budget -= BADGE;
  else if (hub) budget -= HUB_ARROW;
  return budget;
}

/** Matches the label span: 13px / 600 / tracking -0.01em, in the app's resolved sans stack. */
export const LABEL_FONT_CSS =
  'font-size:13px;font-weight:600;letter-spacing:-0.01em;font-family:"Aptos","Segoe UI Variable Display","Segoe UI Variable Text","Segoe UI","Inter","Helvetica Neue",Arial,sans-serif';

export const SIDEBAR_LABEL_SNAPSHOT_PATH = "tests/fixtures/sidebar-label-widths.json";
