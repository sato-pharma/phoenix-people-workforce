/**
 * The sidebar rails' measured geometry, in one place, so the width budget a label actually gets is
 * derivable instead of guessed.
 *
 * Owner rule: sidebar text is never truncated with an ellipsis and never wraps.
 * tests/sidebar-label-width.test.ts asserts that a label always fits, so one that would clip fails
 * CI instead of shipping as "Finance Command …".
 *
 * There are TWO rails and they share almost nothing: the admin shell
 * (src/components/layout/sidebar.tsx) and the employee portal
 * (src/components/employee-portal/employee-portal-layout.tsx). Different widths, different padding,
 * different icon sizes, different type. `labelBudgetPx` therefore REQUIRES a `shell` — see the note
 * on that function for why that argument is not optional.
 *
 * Most numbers below are read off the Tailwind classes in those two files. The ones that are NOT
 * visible in any JSX — borders and scrollbar gutters — are measured in a real browser and called out
 * individually. Keep them in sync; the test is only as honest as these constants.
 */

export type SidebarShell = "admin" | "portal";

// ── Admin rail (src/components/layout/sidebar.tsx) ───────────────────────────

/** `SIDEBAR_WIDTH_EXPANDED = "w-[292px]"` on the <aside>. This is its OFFSET width — border included. */
export const SIDEBAR_WIDTH = 292;

/**
 * The aside's own `border-r`. Tailwind sets `box-sizing: border-box`, so the 1px rule lives INSIDE
 * the declared width and the content box is 1px narrower. Measured on the pre-widening rail:
 * asideOffsetWidth 280, asideClientWidth 279.
 */
const ASIDE_BORDER = 1;

/**
 * The nav scroller's permanently reserved scrollbar track. `.phoenix-admin-sidebar-scroll` in
 * app/globals.css sets `scrollbar-gutter: stable` alongside `scrollbar-width: thin`, so Chromium
 * holds the track open whether or not the nav is scrolling — that space is never given back to the
 * label.
 *
 * Invisible in sidebar.tsx, which is why the model missed it until #2353. Measured in Chromium
 * 2026-08-23: navOffsetWidth 279, navClientWidth 269.
 */
const SCROLLBAR_GUTTER = 10;

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

/** NavBadge `min-w-[18px] px-1` (18 + 8) after the label wrapper's `gap-1.5`. */
const BADGE = 18 + 4 * 2 + 6;

// ── Employee-portal rail (src/components/employee-portal/employee-portal-layout.tsx) ──

/**
 * The portal's desktop nav scroller, MEASURED rather than derived: its width comes from a flex
 * layout inside a 312px aside, not from a `w-[…]` class anyone can read off the JSX.
 * Chromium 2026-08-23: asideOffsetWidth 312, navOffsetWidth 220, navClientWidth 210 — the same 10px
 * gutter as the admin rail, because `.phoenix-employee-sidebar-scroll` carries the same
 * `scrollbar-gutter: stable`. clientWidth already excludes that gutter, so it is not subtracted
 * again below.
 */
const PORTAL_NAV_CLIENT_WIDTH = 210;

/** The desktop nav's `pr-1`. */
const PORTAL_NAV_PADDING = 4;

/** Portal item <Link> `px-4` (16 each side). */
const PORTAL_ROW_PADDING = 16 * 2;

/** Portal item icon `h-[15px] w-[15px]`, shrink-0, plus the row's `gap-3`. */
const PORTAL_ICON = 15;
const PORTAL_ICON_GAP = 12;

/**
 * The portal reuses the admin `NavBadge` (imported from sidebar.tsx), so the pill is the same
 * `min-w-[18px] px-1` = 26px — but it sits as a direct child of the row's `gap-3`, not inside the
 * admin's `gap-1.5` wrapper, so it costs 12px of gap instead of 6.
 */
const PORTAL_BADGE = 18 + 4 * 2 + 12;

/**
 * Pixels a label actually gets, in the shell it is rendered in.
 *
 * `shell` is REQUIRED and deliberately has no default. Until #2353 this function modelled only the
 * admin rail while the test happily charged portal rows the same number, so widening the admin rail
 * silently RAISED the budget the test granted a portal label it had never modelled — a green test
 * certifying a shell it could not see. Making the caller name the shell is what stops that
 * recurring.
 *
 * Admin: 292 - 1 border - 10 gutter - 24 nav px-3 - 8 group px-1 - 20 row px-2.5 - 36 icon
 * - 12 gap - 24 pin = 157 plain; a hub row pays 20 more for the ↗ (137), a badge row 32 (125).
 * A hub row that also has a badge drops the ↗, so it is charged as a badge row.
 *
 * Portal: 210 nav client - 4 pr-1 - 32 row px-4 - 15 icon - 12 gap = 147 plain; a badge row pays
 * 38 more (109). The portal has no hub arrow and no pin star (grep: zero `ArrowUpRight`, zero
 * `pr-6`), so `hub` is ignored there rather than silently costing nothing in a model that pretends
 * to account for it.
 */
export function labelBudgetPx({
  badge,
  hub,
  shell,
}: {
  badge: boolean;
  hub: boolean;
  shell: SidebarShell;
}): number {
  if (shell === "portal") {
    const budget =
      PORTAL_NAV_CLIENT_WIDTH - PORTAL_NAV_PADDING - PORTAL_ROW_PADDING - PORTAL_ICON - PORTAL_ICON_GAP;
    return badge ? budget - PORTAL_BADGE : budget;
  }

  let budget =
    SIDEBAR_WIDTH -
    ASIDE_BORDER -
    SCROLLBAR_GUTTER -
    CONTAINER_PADDING -
    ROW_PADDING -
    ICON_BOX -
    ICON_GAP -
    PIN_RESERVE;
  if (badge) budget -= BADGE;
  else if (hub) budget -= HUB_ARROW;
  return budget;
}

const LABEL_FONT_FAMILY =
  'font-family:"Aptos","Segoe UI Variable Display","Segoe UI Variable Text","Segoe UI","Inter","Helvetica Neue",Arial,sans-serif';

/** Admin label span: 13px / 600 / tracking -0.01em, in the app's resolved sans stack. */
export const LABEL_FONT_CSS = `font-size:13px;font-weight:600;letter-spacing:-0.01em;${LABEL_FONT_FAMILY}`;

/**
 * Portal desktop label span: `text-[12px] font-bold`, no tracking class. Smaller AND heavier than
 * the admin rail, so a label's width genuinely differs between the two shells — which is why the
 * snapshot stores a measurement per shell rather than one number per label.
 */
export const PORTAL_LABEL_FONT_CSS = `font-size:12px;font-weight:700;${LABEL_FONT_FAMILY}`;

export function labelFontCss(shell: SidebarShell): string {
  return shell === "portal" ? PORTAL_LABEL_FONT_CSS : LABEL_FONT_CSS;
}

export const SIDEBAR_LABEL_SNAPSHOT_PATH = "tests/fixtures/sidebar-label-widths.json";
