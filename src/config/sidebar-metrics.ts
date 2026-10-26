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

/** `SIDEBAR_WIDTH_EXPANDED = "w-[272px]"` on the <aside>. This is its OFFSET width — border included. */
export const SIDEBAR_WIDTH = 272;

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

/** Nav scroller `px-2` (8 each side) + the item group's `px-1` (4 each side). */
const CONTAINER_PADDING = 8 * 2 + 4 * 2;

/** NavRow <Link> `px-2` (8 each side). */
const ROW_PADDING = 8 * 2;

/** Icon box `h-8 w-8`, shrink-0, plus the Link's `gap-2`. */
const ICON_BOX = 32;
const ICON_GAP = 8;

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
 * `w-[324px]` on the portal <aside> (the collapsed icon rail is `w-[78px]` and renders no labels).
 * Widened from 312 in #2357: `Doctor Coverage Settings` measured 147px against a 147px budget —
 * it fit by exactly zero pixels, and the portal label span has no `truncate`, so the next label to
 * exceed it would not ellipsise, it would shove the row's badge out.
 */
export const PORTAL_SIDEBAR_WIDTH = 324;

/** The collapsed aside, `w-[78px]`. The icon rail is then the whole card: 76px inside its borders. */
export const PORTAL_COLLAPSED_SIDEBAR_WIDTH = 78;

/** The card inside the aside is `w-full` with a 1px `border` on each side. */
export const PORTAL_CARD_BORDER = 1 * 2;

/** The dark icon-rail column beside the labels, `w-[58px] shrink-0`. */
export const PORTAL_ICON_RAIL = 58;

/**
 * The one thing the icon rail holds across its width: a section link, `h-10 w-[52px]`. Its nav
 * therefore pays for nothing else — no side padding, no scrollbar track (it keeps `overflow-y-auto`,
 * with the bar hidden) — which leaves 3px a side at 58px and 12px a side collapsed.
 *
 * The bar stays hidden when the nav does scroll — the owner's decision, 2026-09-16. Each link is
 * `shrink-0`, so a window too short for every section scrolls the nav instead of squashing the links
 * toward their 16px icons, and a visible classic bar would cost 15px this rail cannot pay.
 * tests/portal-rail-scrolls-never-squashes.test.ts holds both.
 *
 * Until 2026-09-16 the nav also carried `px-2` and `.phoenix-employee-sidebar-scroll`, whose
 * `scrollbar-gutter: stable` Chromium counts in the nav's OWN width: 52 + 16 + 10 = 78px, centred
 * in a 58px column. Every portal page from 1024px read scrollWidth 68 > clientWidth 58 on the rail,
 * and the active section's marker, placed 8px left of its link, sat past the card's clip.
 * tests/shell-chrome-overflows.test.ts derives the nav's width from the classes and holds it to
 * both rail widths.
 */
export const PORTAL_RAIL_LINK = 52;

/** The label column's `px-4`. */
const PORTAL_COLUMN_PADDING = 16 * 2;

/**
 * The same permanently reserved thin scrollbar track as the admin rail —
 * `.phoenix-employee-sidebar-scroll` carries `scrollbar-gutter: stable` too.
 */
const PORTAL_SCROLLBAR_GUTTER = 10;

/** The desktop nav's `pr-1`. */
const PORTAL_NAV_PADDING = 4;

/** Portal item <Link> `px-4` (16 each side). */
const PORTAL_ROW_PADDING = 16 * 2;

/** Portal item icon `h-[15px] w-[15px]`, shrink-0, plus the row's `gap-3`. */
const PORTAL_ICON = 15;
const PORTAL_ICON_GAP = 12;

/**
 * The portal reuses the admin `NavBadge` (from components/layout/nav-badge.tsx), so the pill is the same
 * `min-w-[18px] px-1` = 26px — but it sits as a direct child of the row's `gap-3`, not inside the
 * admin's `gap-1.5` wrapper, so it costs 12px of gap instead of 6.
 */
const PORTAL_BADGE = 18 + 4 * 2 + 12;

/**
 * The portal nav's usable width, DERIVED from the aside rather than pinned to one measurement.
 *
 * #2355 stored a bare `PORTAL_NAV_CLIENT_WIDTH = 210` because the nav's width comes from a flex
 * layout rather than a `w-[…]` class. That was honest but brittle: it would silently go stale the
 * moment anyone touched the aside. The full chain is readable after all —
 *
 *   aside `w-[324px]` -> card `w-full` less its 1px borders -> icon rail `w-[58px] shrink-0`
 *   -> label column `flex-1` less its `px-4` -> nav `flex-1` less the reserved scrollbar track
 *
 * — and it reproduces the real browser exactly at the old width: 312 - 2 - 58 - 32 = 220 against a
 * measured navOffsetWidth of 220, then - 10 = 210 against a measured navClientWidth of 210. That
 * agreement is what licenses using the derivation instead of a fresh measurement, and
 * PORTAL_GEOMETRY_CHECKPOINT below pins it so a future edit to these constants cannot quietly
 * drift away from the one reading taken in a real browser.
 */
export function portalNavClientWidthFor(asideWidth: number): number {
  return (
    asideWidth - PORTAL_CARD_BORDER - PORTAL_ICON_RAIL - PORTAL_COLUMN_PADDING - PORTAL_SCROLLBAR_GUTTER
  );
}

/** Chromium, 2026-08-23, on the pre-widening 312px rail. The derivation must still reproduce it. */
export const PORTAL_GEOMETRY_CHECKPOINT = { asideWidth: 312, navClientWidth: 210 } as const;

// ── Employee-portal MOBILE bottom bar (…/employee-portal-bottom-nav.tsx) ─────

/**
 * The third label surface, and the only one with no rail to be measured against: on a phone this
 * bar IS the navigation. It is modelled apart from `SidebarShell` on purpose — widening that union
 * would let a missing branch in `labelBudgetPx` silently charge a bottom-bar label an ADMIN
 * allowance, which is the exact substitution #2353 made between the two rails.
 *
 * Its constraint is also a different SHAPE. Each <li> is `flex-1` with Tailwind's default
 * `min-width: auto`, so no tab is ever laid out narrower than its own content: a narrow tab donates
 * its unused share to a wide one, and what the viewport must hold is the SUM of the six floors, not
 * six equal budgets. Modelling it as a per-tab allowance is wrong and reads far too pessimistic —
 * 375 / 6 less chrome suggests ~49px a label, while the bar in fact carried a 68px "Direct Order"
 * without clipping anything.
 *
 * Since the label wraps, a tab's floor is its longest WORD rather than the whole label, which is
 * what the "bottom-bar" half of the snapshot stores.
 */

/** HOME_ENTRY + MAX_BOTTOM_NAV_CUSTOM + PROFILE_ENTRY. Pinned against the registry by the test. */
export const BOTTOM_BAR_TABS = 6;

/** The <ul>'s `px-1`. */
const BOTTOM_BAR_LIST_PADDING = 4 * 2;

/** Per tab: the <Link>'s `mx-0.5` (2 a side) plus the label span's `px-0.5` (2 a side). */
const BOTTOM_BAR_TAB_CHROME = 2 * 2 + 2 * 2;

/**
 * The narrowest viewport the bar must survive whole.
 *
 * 360px, not the house's usual 375px reference, because 360 is the CSS width of the mainstream
 * Android phone (Galaxy S8 through S24) and the bar demonstrably broke there: on `whitespace-nowrap`
 * the worst-case six tabs floored at 367px, so they fit a 375px iPhone by 8px and scrolled a 360px
 * Android sideways. Measuring against 375 is what let that ship.
 */
export const BOTTOM_BAR_REFERENCE_WIDTH = 360;

/**
 * Total width the six tabs' TEXT may sum to. Compare it against the sum of the six widest floors,
 * never against a single label.
 */
export function bottomBarWordBudgetPx(viewportWidth: number = BOTTOM_BAR_REFERENCE_WIDTH): number {
  return viewportWidth - BOTTOM_BAR_LIST_PADDING - BOTTOM_BAR_TABS * BOTTOM_BAR_TAB_CHROME;
}

/**
 * Pixels a label actually gets, in the shell it is rendered in.
 *
 * `shell` is REQUIRED and deliberately has no default. Until #2353 this function modelled only the
 * admin rail while the test happily charged portal rows the same number, so widening the admin rail
 * silently RAISED the budget the test granted a portal label it had never modelled — a green test
 * certifying a shell it could not see. Making the caller name the shell is what stops that
 * recurring.
 *
 * Admin: 272 - 1 border - 10 gutter - 16 nav px-2 - 8 group px-1 - 16 row px-2 - 32 icon
 * - 8 gap - 24 pin = 157 plain; a hub row pays 20 more for the ↗ (137), a badge row 32 (125).
 * A hub row that also has a badge drops the ↗, so it is charged as a badge row.
 *
 * Portal: 222 nav client - 4 pr-1 - 32 row px-4 - 15 icon - 12 gap = 159 plain; a badge row pays
 * 38 more (121). The portal has no hub arrow and no pin star (grep: zero `ArrowUpRight`, zero
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
      portalNavClientWidthFor(PORTAL_SIDEBAR_WIDTH) -
      PORTAL_NAV_PADDING -
      PORTAL_ROW_PADDING -
      PORTAL_ICON -
      PORTAL_ICON_GAP;
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
  'font-family:"Aptos","Segoe UI Variable Text","Segoe UI Variable Display","Segoe UI","Inter","Helvetica Neue",Arial,sans-serif';

/**
 * Admin label span: 13px / 600 / tracking -0.01em, in the app's resolved sans stack.
 *
 * Read off src/components/layout/sidebar.tsx: the nav row's label span carries only
 * `tracking-[-0.01em]` and inherits its size and weight from the enclosing <Link>, which is
 * `text-phx-md font-semibold` — 13px at 600, since --phx-fs-md is 13px.
 *
 * This said 700 from 2026-08-28 until 2026-09-04, and the sync test below agreed with it, because
 * that test matched label spans by requiring `text-phx-` on the span's own line. The nav row does
 * not carry it — it inherits — so the matcher selected the two spans that DO: the section heading
 * and the search-result row, both `font-bold`. Model and guard were consistent with each other and
 * with neither rail row. A heavier face is wider, so for that week every admin label was measured
 * 1-6px WIDER than it ships and the budget check was correspondingly strict; the entry above it in
 * this history had the error in the opposite direction. The matcher now resolves inheritance the
 * way CSS does, which is what makes 600 provable rather than merely asserted.
 */
export const LABEL_FONT_CSS = `font-size:13px;font-weight:600;letter-spacing:-0.01em;${LABEL_FONT_FAMILY}`;

/**
 * Portal desktop label span: `text-phx-sm font-bold`, no tracking class. Smaller AND heavier than
 * the admin rail, so a label's width genuinely differs between the two shells — which is why the
 * snapshot stores a measurement per shell rather than one number per label.
 */
export const PORTAL_LABEL_FONT_CSS = `font-size:12px;font-weight:700;${LABEL_FONT_FAMILY}`;

/**
 * Mobile bottom-bar label span: `text-phx-2xs font-black` — 10px at weight 900, the smallest and
 * heaviest type of the three surfaces. Pinned to the component by
 * tests/sidebar-label-font-sync.test.ts alongside the two rails.
 */
export const BOTTOM_BAR_LABEL_FONT_CSS = `font-size:10px;font-weight:900;${LABEL_FONT_FAMILY}`;

export function labelFontCss(shell: SidebarShell): string {
  return shell === "portal" ? PORTAL_LABEL_FONT_CSS : LABEL_FONT_CSS;
}

export const SIDEBAR_LABEL_SNAPSHOT_PATH = "tests/fixtures/sidebar-label-widths.json";

/** The command that re-measures every sidebar label and rewrites the snapshot, from the primary checkout. */
export const MEASURE_SIDEBAR_LABELS_COMMAND = "pnpm run ui:measure-sidebar-labels";
/** The same run from a worktree, where pnpm is refused (bash-guard C6): the script line, through node. */
export const MEASURE_SIDEBAR_LABELS_WORKTREE_COMMAND =
  "node --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs scripts/measure-sidebar-labels.ts";

/**
 * Every label a sidebar can print for these sections: each item's own label AND every `labelByRole`
 * override, because `getSections` hands a role its override in place of the label.
 *
 * The ONE rule for which labels exist. scripts/measure-sidebar-labels.ts measures exactly these, and
 * tests/sidebar-label-snapshot.test.ts refuses a snapshot missing any of them — so the gate can never
 * demand a label the script does not measure, or let through one it does.
 */
export function sidebarLabelsOf(
  sections: readonly { items: readonly { label: string; labelByRole?: Partial<Record<string, string>> }[] }[],
): string[] {
  return [
    ...new Set(
      sections.flatMap((section) =>
        section.items.flatMap((navItem) => [navItem.label, ...Object.values(navItem.labelByRole ?? {})]),
      ),
    ),
  ]
    .filter((label): label is string => typeof label === "string")
    .sort();
}
