import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PORTAL_CARD_BORDER,
  PORTAL_COLLAPSED_SIDEBAR_WIDTH,
  PORTAL_ICON_RAIL,
  PORTAL_RAIL_LINK,
  PORTAL_SIDEBAR_WIDTH,
} from "../src/config/sidebar-metrics.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Two overflows in the shell chrome, OUTSIDE `main`, so a scrollWidth check over `main` never saw
 * them. Measured 2026-09-16 in headless Chromium with dev-auth request headers, classic scrollbars
 * and display scale 100%, at 375, 768, 1024, 1280 and 1920px.
 *
 *   1. employee-portal-layout.tsx — the portal's dark icon rail. Its nav carried `px-2` and
 *      `.phoenix-employee-sidebar-scroll`, whose `scrollbar-gutter: stable` Chromium counts in the
 *      nav's own width: a 52px link made the nav 78px, centred in a 58px rail. The rail and its
 *      column read scrollWidth 68 > clientWidth 58 on every portal page from 1024px, and the active
 *      section's orange marker, 8px left of its link, sat outside the card's clip.
 *   2. topbar.tsx — the admin global search. "Search employees, reports, pages..." was `truncate`:
 *      215px of text in a 150px span at 1024px (195px at 768px), so it ended in an ellipsis, against
 *      the owner's rule that wrapping wins.
 *
 * The rail is held by a MODEL of how the browser sizes that nav, read off its classes and checked
 * against src/config/sidebar-metrics.ts in both rail widths — not by a byte window, which a
 * harmless reorder would break and a new `pl-3` would slip past. The scroller class is modelled as
 * unlayered CSS, which is what it is: it beats every Tailwind utility, so a `[scrollbar-width:none]`
 * placed beside it changes nothing and its gutter is charged whatever else the nav carries.
 *
 * Comments are stripped by the shared scanner in tests/support/comment-strip.ts, not the one-line
 * regex: a line comment in topbar.tsx quotes a wildcard route, which that regex reads as a comment
 * opener, deleting real code up to the next comment close (tests/comment-strip-ratchet.test.ts).
 */

const LAYOUT = "src/components/employee-portal/employee-portal-layout.tsx";
const TOPBAR = "src/components/layout/topbar.tsx";

/** Tailwind v4's `--spacing`. */
const SPACING_PX = 4;

/** The thin track `.phoenix-employee-sidebar-scroll` reserves, measured in Chromium (sidebar-metrics.ts). */
const THIN_GUTTER_PX = 10;

/** A classic scrollbar, measured in the same run: what a nav that scrolls with a visible bar gives up. */
const CLASSIC_TRACK_PX = 15;

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

/** A spacing value in px: `2` is 8, `0.5` is 2, `px` is 1, `[3px]` is 3, `[0.25rem]` is 4. */
function spacingPx(value: string): number | null {
  if (value === "px") return 1;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * SPACING_PX;
  const arbitrary = value.match(/^\[(-?\d+(?:\.\d+)?)(px|rem)\]$/);
  if (arbitrary) return Number(arbitrary[1]) * (arbitrary[2] === "rem" ? 16 : 1);
  return null;
}

/**
 * Padding on one side. The rail only renders from `lg:`, so an unprefixed token and one scoped to
 * any min-width breakpoint are both live somewhere it is shown; the widest one is charged.
 */
function sidePaddingPx(list: string[], side: "left" | "right"): number {
  const own = side === "left" ? ["pl", "ps"] : ["pr", "pe"];
  let widest = 0;
  for (const token of list) {
    const match = token.match(/^(?:(?:sm|md|lg|xl|2xl):)?(p|px|pl|pr|ps|pe)-(.+)$/);
    if (!match || !(match[1] === "p" || match[1] === "px" || own.includes(match[1]))) continue;
    const px = spacingPx(match[2]);
    if (px !== null) widest = Math.max(widest, px);
  }
  return widest;
}

/** The width a vertical scrollbar takes from the nav, and why. */
function scrollbarTrack(list: string[]): { px: number; why: string } {
  if (list.includes("phoenix-employee-sidebar-scroll")) {
    return {
      px: THIN_GUTTER_PX,
      why: "`.phoenix-employee-sidebar-scroll` is unlayered and reserves a thin track with scrollbar-gutter: stable",
    };
  }
  const scrolls = list.some((token) => /^overflow(-y)?-(auto|scroll)$/.test(token));
  if (scrolls && !list.includes("[scrollbar-width:none]")) {
    return {
      px: CLASSIC_TRACK_PX,
      why: "it scrolls with a visible bar, and a short window with many sections makes it scroll",
    };
  }
  return { px: 0, why: "no track" };
}

/** `left-0` is 0, `left-2` is 8, `left-[-8px]` and `-left-2` are -8. */
function leftInsetPx(list: string[]): number | null {
  for (const token of list) {
    const match = token.match(/^(-)?left-(.+)$/);
    if (!match) continue;
    const px = spacingPx(match[2]);
    if (px === null) return null;
    return match[1] ? -px : px;
  }
  return null;
}

const LEADING: Record<string, number> = {
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
};

function lineHeightPx(list: string[], fontPx: number, inheritedPx: number): number {
  for (const token of list) {
    const match = token.match(/^leading-(.+)$/);
    if (!match) continue;
    if (match[1] in LEADING) return LEADING[match[1]] * fontPx;
    const px = spacingPx(match[1]);
    if (px !== null) return px;
  }
  return inheritedPx;
}

export function runShellChromeOverflowsTests() {
  // ── 1. the portal icon rail ────────────────────────────────────────────────────────────────
  const layout = stripComments(readFileSync(LAYOUT, "utf8"));
  const sidebarStart = layout.indexOf("export function EmployeePortalSidebar");
  assert.notEqual(sidebarStart, -1, `${LAYOUT}: EmployeePortalSidebar is gone — re-point this test.`);
  const sidebar = layout.slice(sidebarStart);

  const aside = sidebar.match(/<aside className=\{`[^`]*\$\{collapsed \? "w-\[(\d+)px\]" : "w-\[(\d+)px\]"\}`\}>/);
  assert.ok(aside, `${LAYOUT}: the sidebar <aside> no longer switches "w-[…px]" on \`collapsed\`.`);
  const collapsedAside = Number(aside[1]);
  const expandedAside = Number(aside[2]);
  assert.equal(
    expandedAside,
    PORTAL_SIDEBAR_WIDTH,
    `${LAYOUT}: the aside is ${expandedAside}px but sidebar-metrics.ts budgets ${PORTAL_SIDEBAR_WIDTH}px.`,
  );
  assert.equal(
    collapsedAside,
    PORTAL_COLLAPSED_SIDEBAR_WIDTH,
    `${LAYOUT}: the collapsed aside is ${collapsedAside}px but sidebar-metrics.ts budgets ` +
      `${PORTAL_COLLAPSED_SIDEBAR_WIDTH}px.`,
  );

  const railMatch = sidebar.match(/<div className=\{`\$\{collapsed \? "w-full" : "w-\[(\d+)px\]"\} shrink-0[^`]*`\}>/);
  assert.ok(
    railMatch && railMatch.index !== undefined,
    `${LAYOUT}: the icon rail is no longer \`\${collapsed ? "w-full" : "w-[…px]"} shrink-0 …\`.`,
  );
  const railWidth = Number(railMatch[1]);
  assert.equal(
    railWidth,
    PORTAL_ICON_RAIL,
    `${LAYOUT}: the icon rail is ${railWidth}px but sidebar-metrics.ts budgets ${PORTAL_ICON_RAIL}px. ` +
      `Change both, and the label budget that depends on it, together.`,
  );
  const rail = sidebar.slice(railMatch.index);

  const navMatch = rail.match(/<nav className="([^"]*)">/);
  assert.ok(navMatch && navMatch.index !== undefined, `${LAYOUT}: the icon rail no longer holds a <nav> with a literal className.`);
  const nav = tokens(navMatch[1]);
  const afterNav = rail.slice(navMatch.index);

  const linkMatch = afterNav.match(/className=\{`([^`$]*)\$\{/);
  assert.ok(
    linkMatch && linkMatch.index !== undefined,
    `${LAYOUT}: the rail link no longer opens with a static className before its active-state switch.`,
  );
  const link = tokens(linkMatch[1]);
  const linkWidthToken = link.map((token) => token.match(/^w-\[(\d+)px\]$/)).find(Boolean);
  assert.ok(linkWidthToken, `${LAYOUT}: the rail link "${linkMatch[1].trim()}" has no fixed "w-[…px]".`);
  const linkWidth = Number(linkWidthToken[1]);
  assert.equal(
    linkWidth,
    PORTAL_RAIL_LINK,
    `${LAYOUT}: the rail link is ${linkWidth}px but sidebar-metrics.ts budgets ${PORTAL_RAIL_LINK}px.`,
  );

  const markerMatch = afterNav.slice(linkMatch.index).match(/<span className="([^"]*\babsolute\b[^"]*)" \/>/);
  assert.ok(markerMatch, `${LAYOUT}: the rail link no longer draws its active marker as an absolute <span>.`);
  const marker = tokens(markerMatch[1]);
  const markerInset = leftInsetPx(marker);
  assert.ok(markerInset !== null, `${LAYOUT}: the active marker "${markerMatch[1]}" has no readable left-… inset.`);
  const markerWidthToken = marker.map((token) => token.match(/^w-\[(\d+)px\]$/)).find(Boolean);
  const markerWidth = markerWidthToken ? Number(markerWidthToken[1]) : 0;

  const padLeft = sidePaddingPx(nav, "left");
  const padRight = sidePaddingPx(nav, "right");
  const track = scrollbarTrack(nav);
  const navNeeds = linkWidth + padLeft + padRight + track.px;
  const navFillsRail = nav.includes("w-full") || nav.includes("self-stretch");
  const markerContext = link.includes("relative") ? "link" : nav.includes("relative") ? "nav" : null;

  for (const [state, width] of [
    ["expanded", railWidth],
    ["collapsed", collapsedAside - PORTAL_CARD_BORDER],
  ] as const) {
    assert.ok(
      navNeeds <= width,
      `${LAYOUT}: the icon rail's nav needs ${navNeeds}px (a ${linkWidth}px link + ${padLeft}px + ` +
        `${padRight}px side padding + a ${track.px}px scrollbar track: ${track.why}) but the ${state} ` +
        `rail is ${width}px. That is the overflow measured on 2026-09-16: the nav is centred past both ` +
        `edges of the rail, the rail reads scrollWidth > clientWidth on every portal page from 1024px, ` +
        `and the card's clip swallows the active marker. Nav: "${navMatch[1]}".`,
    );

    assert.ok(
      markerContext,
      `${LAYOUT}: neither the rail link nor its nav is \`relative\`, so the active marker is placed ` +
        `against some ancestor outside the rail.`,
    );
    const navWidth = navFillsRail ? width : navNeeds;
    const navX = (width - navWidth) / 2;
    const linkX = navX + padLeft + (navWidth - padLeft - padRight - track.px - linkWidth) / 2;
    const markerX = (markerContext === "link" ? linkX : navX) + markerInset;
    assert.ok(
      markerX >= 0 && markerX + markerWidth <= width,
      `${LAYOUT}: in the ${state} ${width}px rail the active section's marker lands at ${markerX}px ` +
        `(${markerInset}px from its ${markerContext}, which starts at ` +
        `${markerContext === "link" ? linkX : navX}px). The card is overflow-hidden at the rail's ` +
        `edges, so a marker outside 0–${width}px is not drawn at all — the reader loses which section ` +
        `is open. Marker: "${markerMatch[1]}".`,
    );
  }

  // ── 2. the admin global search placeholder ─────────────────────────────────────────────────
  const topbar = stripComments(readFileSync(TOPBAR, "utf8"));

  const placeholder = topbar.match(/<span className="([^"]*)">\{systemUiText\.globalSearchPlaceholder\}<\/span>/);
  assert.ok(
    placeholder,
    `${TOPBAR}: the global search no longer renders {systemUiText.globalSearchPlaceholder} in a <span> ` +
      `with a literal className. Re-point this test at whatever prints the placeholder — do not drop it.`,
  );
  const clipsText = (token: string) =>
    /^(?:[a-z0-9]+:)?(truncate|text-ellipsis|text-clip|whitespace-nowrap|overflow-hidden|overflow-clip|line-clamp-\d+)$/.test(
      token,
    );
  const spanClips = tokens(placeholder[1]).filter(clipsText);
  assert.deepEqual(
    spanClips,
    [],
    `${TOPBAR}: the search placeholder is "${placeholder[1]}" — ${JSON.stringify(spanClips)} is back. ` +
      `From md to xl the box is narrower than "Search employees, reports, pages...": at 1024px it gave ` +
      `the text 150px of the 215px it needs, so the line ended in an ellipsis. The owner's rule is ` +
      `that text never ends in an ellipsis — it wraps.`,
  );

  const button = topbar.match(/aria-label="Open command palette"\s+className=\{`([^`$]*\bmd:flex\b[^`$]*)/);
  assert.ok(button, `${TOPBAR}: the md-and-up "Open command palette" button no longer has a static className.`);
  const buttonTokens = tokens(button[1]);
  const buttonClips = buttonTokens.filter(clipsText);
  assert.deepEqual(
    buttonClips,
    [],
    `${TOPBAR}: the search button carries ${JSON.stringify(buttonClips)}, which cuts the placeholder ` +
      `from outside the span.`,
  );

  const heightToken = buttonTokens.map((token) => token.match(/^h-(\d+)$/)).find(Boolean);
  assert.ok(heightToken && buttonTokens.includes("text-sm"), `${TOPBAR}: the search button is no longer "h-N … text-sm".`);
  const innerHeight = Number(heightToken[1]) * SPACING_PX - (buttonTokens.includes("border") ? 2 : 0);
  // text-sm is 14px on a 20px line in Tailwind v4.
  const lineHeight = lineHeightPx(tokens(placeholder[1]), 14, lineHeightPx(buttonTokens, 14, 20));
  assert.ok(
    2 * lineHeight <= innerHeight,
    `${TOPBAR}: the placeholder wraps to two lines at 1024px (a 150px span), and two ${lineHeight}px ` +
      `lines need ${2 * lineHeight}px — more than the ${innerHeight}px inside the search box, so the ` +
      `second line would spill over its border. "leading-tight" (17.5px) is what keeps both inside.`,
  );
}
