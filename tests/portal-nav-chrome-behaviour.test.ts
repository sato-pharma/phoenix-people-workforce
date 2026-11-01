import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HOME_ENTRY,
  MAX_BOTTOM_NAV_CUSTOM,
  PORTAL_NAV_REGISTRY,
  PROFILE_ENTRY,
  defaultBottomNavHrefs,
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
 *      as the search box, which is under ~230px at a 1024px window — long labels were cut mid-word.
 *      Its results also ignored module locks, and the drawer's invisible backdrop button was the
 *      first Tab stop on every page.
 *   5. The bell and the messages panel printed times in the DEVICE's zone, not Cairo.
 *   6. Both panels hang from a header that never scrolls away. The messages panel was capped only
 *      below `sm`, so at 1024x768 its Send button sat ~250px under the screen; the bell ran past a
 *      320x568 phone; and on the portal the phone bottom bar (z-40) sat on top of both panels' last
 *      rows. One cap now, at every width, minus the bottom bar's height where it is shown.
 *   7. Sonner's toasts (the new-mail pop-up among them) are mounted outside both shells, so their
 *      8px corners and round close button escaped the square-corner rule everywhere.
 *   8. Choosing a module in the bell's filter closed the bell: SearchableSelect portals its options
 *      to <body>, and the outside-click dismiss read that press as "outside".
 *   9. The sidebar's Direct Orders row never carried the `direct-orders-needs-action` badge its seed
 *      row and its phone tab both had (#2020 wired it everywhere but the hand-built portal row).
 *  10. The messages envelope loaded only when opened, so its badge was blank until then, and nothing
 *      ever marked a message read, so once a count appeared it never went down. (Since 1 Nov 2026 the
 *      badge's count rides the session pulse — read in the same statement as the bell's notices — so
 *      the mount-time fetch of the whole list, a request on every page view, is gone.)
 *  11. The bell's module filter printed codes: "phoenix crm", "crm account setup".
 *
 * Source shape is read with comments stripped, so the prose explaining a removal cannot satisfy or
 * trip its own assertion.
 */

const LAYOUT = "src/components/employee-portal/employee-portal-layout.tsx";
const BOTTOM_NAV = "src/components/employee-portal/employee-portal-bottom-nav.tsx";
const BELL = "src/components/layout/in-app-notifications-bell.tsx";
const MESSAGES = "src/components/layout/internal-messages-menu.tsx";
const PANEL_POSITION = "src/lib/navigation/panel-position.ts";
const GLOBALS = "app/globals.css";
const DISMISS_HOOK = "src/hooks/use-dismiss-on-outside-interaction.ts";
const SEARCHABLE_SELECT = "src/components/ui/searchable-select.tsx";

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
  const middle = defaultBottomNavHrefs(visibility).filter((href) => visible.has(href)).slice(0, MAX_BOTTOM_NAV_CUSTOM);
  return [HOME_ENTRY.href, ...middle, PROFILE_ENTRY.href];
}

/** Visibility for a role, with no device mapping, no shared calendar and Phoenix CRM open. */
function visibilityFor(role: string, options?: { hrId?: string; line?: string }) {
  return resolveEmployeePortalNavVisibility(
    role,
    role,
    options?.line ?? null,
    null,
    options?.hrId ?? null,
    false,
    false,
    true,
  );
}

/** Which sidebar rows a viewer is offered, by href. */
function sidebarHrefs(visibility: ReturnType<typeof resolveEmployeePortalNavVisibility>): Set<string> {
  return new Set(visiblePortalNavEntries(visibility).map((entry) => entry.href));
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
  assert.match(
    listbox.slice(0, resultsEnd),
    /isNavItemLockedFor\(\{ href: item\.href \}, lockedModuleKeys\)/,
    "A locked module must wear its padlock in the search results, as its sidebar row does.",
  );
  assert.match(
    topNav,
    /aria-label="Close menu"[\s\S]{0,400}?inert=\{!mobileMenuOpen\}/,
    "The drawer's full-screen backdrop button must be inert while closed, or it is the first Tab stop.",
  );

  // ── 5. Header panel times read in Cairo ─────────────────────────────────────────────────────
  for (const file of [BELL, MESSAGES]) {
    const source = stripComments(readFileSync(file, "utf8"));
    const formatters = Array.from(source.matchAll(/new Intl\.DateTimeFormat\([\s\S]*?\}\)/g)).map((m) => m[0]);
    assert.ok(formatters.length > 0, `${file} must still format its times with Intl.DateTimeFormat`);
    for (const formatter of formatters) {
      assert.match(formatter, /timeZone: "Africa\/Cairo"/, `${file}: every displayed time is Cairo wall-clock, never the device's zone.`);
    }
  }

  // ── 6. Header panels stop at the screen, above the phone bottom bar ─────────────────────────
  assert.match(
    readFileSync(PANEL_POSITION, "utf8"),
    /export const HEADER_PANEL_MAX_HEIGHT = "calc\(100dvh - 5rem - var\(--phx-portal-bottom-nav-reserve, 0px\)\)";/,
    "The header panel cap must subtract the portal's phone bottom bar.",
  );
  for (const file of [BELL, MESSAGES]) {
    const source = stripComments(readFileSync(file, "utf8"));
    assert.match(source, /maxHeight: HEADER_PANEL_MAX_HEIGHT/, `${file}: the panel must be capped to the screen.`);
    assert.match(
      source,
      /"absolute left-0 top-full z-30 mt-1\.5 overflow-x-hidden overflow-y-auto rounded border shadow-lg"/,
      `${file}: the capped panel must scroll itself — it hangs from a header that never scrolls away.`,
    );
  }
  const css = stripComments(readFileSync(GLOBALS, "utf8"));
  assert.match(
    css,
    /\.employee-portal-shell \{\s*--phx-portal-bottom-nav-reserve: calc\(61px \+ env\(safe-area-inset-bottom, 0px\)\);\s*\}/,
    "The portal must declare the bottom bar's height for the header panels to subtract.",
  );
  assert.match(
    css,
    /@media \(min-width: 1024px\) \{\s*\.employee-portal-shell \{\s*--phx-portal-bottom-nav-reserve: 0px;/,
    "From `lg` the bottom bar is hidden, so it reserves nothing.",
  );

  // ── 7. Toasts are square ────────────────────────────────────────────────────────────────────
  assert.match(
    css,
    /\[data-sonner-toaster\] \[data-sonner-toast\],\s*\[data-sonner-toaster\] \[data-sonner-toast\] \* \{\s*border-radius: 0 !important;/,
    "Sonner's toasts sit outside both shells' square-corner rule and must be squared on their own.",
  );

  // ── 9. A sidebar row carries the same badge as its phone tab ────────────────────────────────
  // employee-portal-bottom-nav-badges.test.ts compares the registry with the catalog SEED and calls
  // the seed "the sidebar" — but the portal sidebar is built by hand in this layout, which is how the
  // Direct Orders row shipped without the badge its seed row and its phone tab both carried.
  const sidebarRows = new Map<string, string | null>();
  for (const match of layout.matchAll(
    /\{ href: "(\/employee-portals[^"]*)", label: "[^"]+", icon: \w+(?:, navBadge: "([a-z-]+)" as const)? \}/g,
  )) {
    sidebarRows.set(match[1], match[2] ?? null);
  }
  assert.ok(sidebarRows.size > 40, `The sidebar rows must still be readable here (read ${sidebarRows.size}).`);
  for (const entry of PORTAL_NAV_REGISTRY) {
    if (!sidebarRows.has(entry.href)) continue;
    assert.equal(
      sidebarRows.get(entry.href),
      entry.navBadge ?? null,
      `${entry.fullLabel}: the sidebar row and the phone tab must announce the same badge.`,
    );
  }

  // ── 10. The envelope's unread count appears without opening it, and clears once read ─────────
  const messages = stripComments(readFileSync(MESSAGES, "utf8"));
  assert.match(
    messages,
    /subscribePulseNotices\(\(notices\) => \{\s*if \(typeof notices\.unreadMessages === "number"\) \{\s*setUnreadCount\(notices\.unreadMessages\);\s*return;\s*\}/,
    "The envelope badge takes its unread count from the session pulse, so it counts unread messages before the panel is opened — with no request of its own.",
  );
  assert.match(
    messages,
    /if \(fetchedOnce\.current\) return;\s*fetchedOnce\.current = true;\s*void loadMessages\(\);/,
    "A pulse that cannot say (no count) makes the menu fetch its list once, as it did before.",
  );
  assert.doesNotMatch(
    messages,
    /window\.setTimeout\(\(\) => void loadMessages\(\), 0\)/,
    "No fetch of the whole list on mount for one number — it cost a request, and a session read, on every page view.",
  );
  assert.match(
    messages,
    /fetch\(`\/api\/messages\/\$\{encodeURIComponent\(message\.id\)\}\/read`, \{ method: "PATCH" \}\)/,
    "Shown inbox messages must be marked read, or the unread count never goes down.",
  );
  assert.match(
    messages,
    /loadMessages\(\{ markRead: tab === "internal" \}\)/,
    "Only the Phoenix messages tab, open, counts as reading them.",
  );

  // ── 11. The bell names modules, never prints their codes ───────────────────────────────────
  const bell = stripComments(readFileSync(BELL, "utf8"));
  assert.doesNotMatch(bell, /\.replace\(\/_\/g, " "\)/, "The bell must not print a module or category code with its underscores swapped for spaces.");
  assert.match(bell, /\{notificationCodeLabel\(moduleName\)\}/, "The module filter must show names.");
  assert.match(bell, /\{notificationCodeLabel\(notification\.category\)\}/, "The category chip must show a name.");

  // ── 12. The owner's four rulings of 2026-09-29 ──────────────────────────────────────────────
  //
  // (a) The Head-Office "Manager" rung loses the five rows it inherited through the District
  //     Manager alias and could never use. It keeps everything else that alias gives it.
  const managerRung = visibilityFor("Manager");
  const managerRows = sidebarHrefs(managerRung);
  for (const href of [
    "/employee-portals/team-performance",
    "/employee-portals/sales-vs-target",
    "/employee-portals/monthly-closing",
    "/employee-portals/early-birds",
    "/employee-portals/plans",
  ]) {
    assert.ok(!managerRows.has(href), `The Head-Office Manager rung must not be offered ${href} — it opens empty or refuses.`);
  }
  assert.ok(managerRows.has("/employee-portals/plans/calendar"), "The rung keeps the READ-ONLY Planning Calendar, which works for it.");
  // Team Coaching Reports (/coaching) left the sidebar for EVERY role on 2026-09-29 — the owner moved
  // it to "Remove from sidebar" on his arrangement sheet. The page stays, reached from the coaching
  // command-centre cards and the admin twin; it is simply no longer a sidebar row.
  assert.ok(!managerRows.has("/employee-portals/coaching"), "Team Coaching Reports left the sidebar at the owner's word (2026-09-29).");
  assert.ok(managerRows.has("/employee-portals/probation"), "The rung keeps its probation tracker.");
  // A-3 is on that rung, so her 2026-06-10 Plans override goes with it — the builder always
  // refused her — while her Planning Calendar stays.
  const a3 = visibilityFor("Manager", { hrId: "A-3" });
  assert.equal(a3.showPlansTab, false, "A-3's Plans row goes with the rung: submitting was always Forbidden for her.");
  assert.equal(a3.showPlanningCalendarTab, true, "A-3 keeps the read-only Planning Calendar.");
  // The District Manager proper is untouched by all of this.
  const districtManager = visibilityFor("District Manager");
  for (const href of [
    "/employee-portals/team-performance",
    "/employee-portals/sales-vs-target",
    "/employee-portals/monthly-closing",
    "/employee-portals/early-birds",
    "/employee-portals/plans",
  ]) {
    assert.ok(sidebarHrefs(districtManager).has(href), `A real District Manager keeps ${href}.`);
  }

  // (b) The Training Manager gets the two rows he could already open.
  const trainingManager = visibilityFor("Training Manager");
  assert.equal(trainingManager.showProbationTab, true, "Training Manager: canViewAllProbation admits him, so the row must exist.");
  assert.equal(trainingManager.showVacanciesTab, false, "Training Manager: the Vacancies row was removed from his seat 2026-10-24 (owner).");

  // (c) Report It reaches every portal role, as one row or the other, never both.
  for (const role of [
    "Medical Rep",
    "District Manager",
    "Regional Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
    "Training Manager",
    "Manager",
    "Employee",
  ]) {
    const visibility = visibilityFor(role);
    assert.ok(
      visibility.showReportItTab || visibility.showReportItDashboardTab,
      `${role} can submit a Report It, so ${role} must have a row for it.`,
    );
    assert.ok(
      !(visibility.showReportItTab && visibility.showReportItDashboardTab),
      `${role} must not be offered Report It twice.`,
    );
    assert.ok(sidebarHrefs(visibility).has("/employee-portals/report-it"), `${role}: the Report It destination must be reachable.`);
  }

  // (d) The Medical Rep's default phone bar, and everyone else's left exactly as it was.
  assert.deepEqual(
    defaultBarHrefs(visibilityFor("Medical Rep")),
    [
      "/employee-portals",
      "/employee-portals/field-crm",
      "/employee-portals/incentive",
      "/employee-portals/monthly-closing",
      "/employee-portals/profile",
    ],
    "The Medical Rep's default bar is Phoenix CRM · Incentive · Monthly Closing (owner, 2026-09-29).",
  );
  const UNCHANGED_DEFAULT_BARS: Record<string, string[]> = {
    "District Manager": ["/employee-portals/plans", "/employee-portals/plans/calendar", "/employee-portals/source-of-sales", "/employee-portals/team-performance"],
    "Regional Manager": ["/employee-portals/plans", "/employee-portals/plans/calendar", "/employee-portals/source-of-sales", "/employee-portals/marketing-requests"],
    "National Sales Manager": ["/employee-portals/plans", "/employee-portals/plans/calendar", "/employee-portals/source-of-sales", "/employee-portals/marketing-requests"],
    "Product Manager": ["/employee-portals/plans", "/employee-portals/plans/calendar", "/employee-portals/source-of-sales", "/employee-portals/report-it"],
    "Group Product Manager": ["/employee-portals/plans", "/employee-portals/plans/calendar", "/employee-portals/source-of-sales", "/employee-portals/report-it"],
    "Marketing Manager": ["/employee-portals/plans", "/employee-portals/plans/calendar", "/employee-portals/source-of-sales", "/employee-portals/report-it"],
    // The Training Manager lost the Weekly / Monthly Plan tab on 2026-10-24 (owner); the Planning Calendar stays.
    "Training Manager": ["/employee-portals/plans/calendar", "/employee-portals/report-it", "/employee-portals/expense-dashboard"],
  };
  for (const [role, middle] of Object.entries(UNCHANGED_DEFAULT_BARS)) {
    assert.deepEqual(
      defaultBarHrefs(visibilityFor(role)),
      ["/employee-portals", ...middle, "/employee-portals/profile"],
      `${role}'s default phone bar must be exactly what it was before 2026-09-29 — opening Report It to every role must not displace anyone's tabs.`,
    );
  }

  // ── 8. A portaled option is part of the menu that holds it ─────────────────────────────────
  assert.match(
    stripComments(readFileSync(DISMISS_HOOK, "utf8")),
    /target\.closest\("\[data-floating-layer\]"\)\) return;/,
    "A press inside a floating layer must not dismiss the menu it belongs to.",
  );
  assert.match(
    readFileSync(SEARCHABLE_SELECT, "utf8"),
    /role="listbox"[\s\S]{0,400}?data-floating-layer=""/,
    "SearchableSelect's portaled options must carry the floating-layer marker.",
  );
}
