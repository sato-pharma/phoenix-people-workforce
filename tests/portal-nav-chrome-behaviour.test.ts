import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_BOTTOM_NAV_HREFS,
  HOME_ENTRY,
  MAX_BOTTOM_NAV_CUSTOM,
  PROFILE_ENTRY,
  visiblePortalNavEntries,
} from "../src/components/employee-portal/employee-portal-nav-registry.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { resolveDeepestActiveHref } from "../src/lib/navigation/active-path.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Behaviour defects in the employee-portal chrome, found by the 2026-09-28 audit of the portal
 * sidebar and top bar. None of them showed up as overflow or a dead link, which is what the other
 * chrome tests look for — each was the chrome doing the wrong thing on an interaction.
 *
 *   1. The phone bottom bar lit TWO tabs at once on a nested page. It tested `startsWith(href + "/")`
 *      per tab, while the sidebar resolves ONE deepest match (resolveDeepestActiveHref). A District
 *      Manager's DEFAULT bar carries Plans (/plans) and Planning (/plans/calendar), so on the
 *      calendar both were highlighted.
 *   2. The header's user menu never closed on an outside click or Escape. The admin Topbar got
 *      useDismissOnOutsideInteraction on 2026-07-24 (8e7d3ca8d); the portal header never did, so the
 *      open menu sat over the page swallowing clicks until its own button was pressed again.
 *   3. The closed mobile drawer was only slid off-screen: every link in it stayed in the Tab order
 *      under `aria-hidden`. The admin drawer is `inert` when closed; the portal's now is too, and
 *      Escape closes it.
 *   4. The header search announced a listbox but only Enter worked, and only on the first result;
 *      its result labels were `whitespace-nowrap` inside an `overflow-hidden` panel exactly as wide
 *      as the search box, which is about 230px at a 1024px window — long labels were cut mid-word.
 *
 * Source shape is read with comments stripped, so the prose explaining a removal cannot satisfy or
 * trip its own assertion.
 */

const LAYOUT = "src/components/employee-portal/employee-portal-layout.tsx";
const BOTTOM_NAV = "src/components/employee-portal/employee-portal-bottom-nav.tsx";

function componentBody(source: string, name: string): string {
  const marker = `export function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must still be exported from its file`);
  const rest = source.slice(start + marker.length);
  const next = rest.search(/\nexport (?:function|const|default|async) /);
  return next === -1 ? source.slice(start) : source.slice(start, start + marker.length + next);
}

/** The middle tabs the bar shows when the person has pinned nothing — the component's own rule. */
function defaultBarHrefs(visibility: ReturnType<typeof resolveEmployeePortalNavVisibility>): string[] {
  const visible = new Set(visiblePortalNavEntries(visibility).map((entry) => entry.href));
  const middle = DEFAULT_BOTTOM_NAV_HREFS.filter((href) => visible.has(href)).slice(0, MAX_BOTTOM_NAV_CUSTOM);
  return [HOME_ENTRY.href, ...middle, PROFILE_ENTRY.href];
}

export function runPortalNavChromeBehaviourTests() {
  const layout = stripComments(readFileSync(LAYOUT, "utf8"));
  const bottomNav = stripComments(readFileSync(BOTTOM_NAV, "utf8"));

  // ── 1. One lit tab ──────────────────────────────────────────────────────────────────────────
  assert.match(
    bottomNav,
    /resolveDeepestActiveHref\(/,
    "The bottom bar must pick its lit tab with resolveDeepestActiveHref, the rule the sidebar uses.",
  );
  assert.doesNotMatch(
    bottomNav,
    /startsWith\(`\$\{[\w.]+\}\/`\)/,
    "The bottom bar must not test each tab by prefix — a parent and its child on one bar both light up.",
  );
  assert.match(
    bottomNav,
    /const active = item\.href === activeHref;/,
    "Each tab must be lit only when it IS the one resolved href.",
  );

  // The case that shipped: a District Manager's default bar, standing on the planning calendar.
  const dmBar = defaultBarHrefs(resolveEmployeePortalNavVisibility("District Manager", "District Manager"));
  assert.ok(
    dmBar.includes("/employee-portals/plans") && dmBar.includes("/employee-portals/plans/calendar"),
    `The District Manager's default bar is the case this pins; it must still hold Plans and Planning (got ${dmBar.join(", ")}).`,
  );
  const exactOnly = new Set(["/employee-portals"]);
  const lit = dmBar.filter(
    (href) => href === resolveDeepestActiveHref("/employee-portals/plans/calendar", dmBar, exactOnly),
  );
  assert.deepEqual(lit, ["/employee-portals/plans/calendar"], "Exactly one tab is lit on the planning calendar.");
  assert.equal(
    resolveDeepestActiveHref("/employee-portals/profile", dmBar, exactOnly),
    "/employee-portals/profile",
    "Home stays dark on the profile page.",
  );

  // ── 2. The user menu dismisses ──────────────────────────────────────────────────────────────
  const topNav = componentBody(layout, "EmployeePortalTopNav");
  assert.match(
    topNav,
    /useDismissOnOutsideInteraction\(userMenuRef, userMenuOpen, setUserMenuOpen\)/,
    "The header user menu must close on an outside click and on Escape, as the admin Topbar's does.",
  );
  assert.match(topNav, /ref=\{userMenuRef\}/, "The dismiss hook needs the menu's container ref, or every click is 'outside'.");

  // ── 3. The closed drawer leaves the Tab order ───────────────────────────────────────────────
  assert.match(
    topNav,
    /id="employee-portal-mobile-sidebar"\s+inert=\{!mobileMenuOpen\}/,
    "The mobile drawer must be inert while closed, so its links leave the Tab order.",
  );
  assert.match(
    topNav,
    /event\.key === "Escape"\) setMobileMenuOpen\(false\)/,
    "Escape must close the mobile drawer.",
  );

  // ── 4. The search is a real combobox, and its results wrap ──────────────────────────────────
  assert.match(topNav, /role="combobox"/, "The search input must announce itself as the combobox driving the listbox.");
  assert.match(topNav, /aria-activedescendant=/, "The highlighted result must be announced.");
  assert.match(topNav, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/, "Arrow keys must move through the results.");
  assert.match(topNav, /aria-selected=\{index === activeSearchIndex\}/, "aria-selected must follow the highlighted result.");
  const listbox = topNav.slice(topNav.indexOf('role="listbox"'));
  assert.ok(listbox.length > 0 && topNav.includes('role="listbox"'), "The results panel must still be a listbox.");
  const resultsEnd = listbox.indexOf("No matching portal pages.");
  assert.ok(resultsEnd > 0, "The results panel must still end in its empty state.");
  assert.doesNotMatch(
    listbox.slice(0, resultsEnd),
    /whitespace-nowrap|truncate|text-ellipsis|line-clamp/,
    "Search results must wrap: the panel is only as wide as the search box and clips anything wider.",
  );
}
