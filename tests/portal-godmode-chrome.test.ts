import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PORTAL_BADGE_SOURCES,
  PORTAL_GO_SHORTCUTS,
  PORTAL_RECENT_PAGES_LIMIT,
  availableGoShortcuts,
  breadcrumbFor,
  cairoHour,
  filterSections,
  greetingForHour,
  initialsFor,
  nextRecentHrefs,
  parseStoredStringList,
  rowForPath,
  rowMatchesQuery,
  toggleInList,
  togglePinnedHref,
  waitingOnYouTotal,
  waitingQueues,
  type PortalChromeSection,
} from "../src/lib/employee-portal/portal-chrome.ts";
import { shownDefaultBottomNavHrefs } from "../src/components/employee-portal/employee-portal-nav-registry.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The employee portal's "godmode" sidebar and top bar (owner, 2026-09-29, all 14 items accepted):
 * a command bar, recent pages, pins shared with the phone bar, a sidebar filter, a live "waiting on
 * you" counter, pop-out sections on the collapsed rail with live counts, a "you are here" trail, an
 * offline warning, keyboard shortcuts, focus mode, the person's own photo, a greeting with a live
 * Cairo clock, and folding sections.
 *
 * Item 14 — a navy sidebar — was built and turned down on sight the same day ("sidebar color is very
 * bad"). The sidebar and the phone menu stay WHITE; section 3 below pins that ruling, so a later
 * session cannot "finish" the navy look.
 *
 * Two halves. The RULES live in src/lib/employee-portal/portal-chrome.ts, React-free, and are tested
 * here by calling them. The WIRING lives in React components the Node harness cannot import (they pull
 * next/navigation at module scope), so it is pinned by source shape with comments stripped.
 */

const LAYOUT = "src/components/employee-portal/employee-portal-layout.tsx";
const WIDGETS = "src/components/employee-portal/portal-chrome-widgets.tsx";
const QUICK_ACTIONS = "src/lib/employee-portal/portal-quick-actions.ts";

const SECTIONS: PortalChromeSection[] = [
  {
    items: [
      { href: "/employee-portals", label: "Command Center" },
      { href: "/employee-portals/plans", label: "Weekly / Monthly Plan" },
      { href: "/employee-portals/plans/calendar", label: "Planning Calendar" },
    ],
    title: "My Workspace",
  },
  {
    items: [
      { href: "/employee-portals/approvals/vacation", label: "Leave Approvals", navBadge: "vacation-approvals-pending" },
      { href: "/employee-portals/approvals/plan", label: "Plan Approvals", navBadge: "plan-approvals-pending" },
      { href: "/employee-portals/approvals-hub", label: "Other Approvals", navBadge: "approvals-hub-pending" },
    ],
    title: "Approvals Hub",
  },
  {
    items: [
      { href: "/employee-portals/sales-vs-target", label: "Sales vs Target" },
      { href: "/employee-portals/weekly-sales", label: "Weekly Sales" },
      { href: "/employee-portals/direct-orders", label: "Direct Orders", navBadge: "direct-orders-needs-action" },
    ],
    title: "Sales",
  },
];

function componentBody(source: string, name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must still exist`);
  const rest = source.slice(start + marker.length);
  const next = rest.search(/\n(?:export )?function /);
  return next === -1 ? source.slice(start) : source.slice(start, start + marker.length + next);
}

export function runPortalGodmodeChromeTests() {
  // ── 1. The rules ────────────────────────────────────────────────────────────────────────────

  // Stored lists read defensively: junk is an empty list, never an error.
  assert.deepEqual(parseStoredStringList(null), []);
  assert.deepEqual(parseStoredStringList("not json"), []);
  assert.deepEqual(parseStoredStringList('{"a":1}'), []);
  assert.deepEqual(parseStoredStringList('["a", 3, "", "b"]'), ["a", "b"]);

  // Recent pages: newest first, once each, capped.
  assert.deepEqual(nextRecentHrefs(["a", "b", "c"], "b"), ["b", "a", "c"]);
  const many = Array.from({ length: 10 }, (_, i) => `p${i}`);
  assert.equal(nextRecentHrefs(many, "new").length, PORTAL_RECENT_PAGES_LIMIT);
  assert.equal(nextRecentHrefs(many, "new")[0], "new");

  assert.deepEqual(toggleInList(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleInList(["a", "b"], "a"), ["b"]);

  // Pins ARE the phone bar's list, and the bar shows the first four. A first pin starts from the tabs
  // the bar is showing, and a new pin goes FIRST so it is always on the bar.
  const repBar = ["/employee-portals/field-crm", "/employee-portals/incentive", "/employee-portals/monthly-closing"];
  assert.deepEqual(
    togglePinnedHref([], "/employee-portals/visits", repBar),
    ["/employee-portals/visits", ...repBar],
    "a rep's first pin must keep his Phoenix CRM · Incentive · Monthly Closing tabs, not replace them",
  );
  assert.deepEqual(
    togglePinnedHref([], "/employee-portals/incentive", repBar),
    ["/employee-portals/incentive", "/employee-portals/field-crm", "/employee-portals/monthly-closing"],
    "with nothing pinned every row reads 'Pin', so a tap on a default tab PINS it — it must never take it off the bar",
  );
  assert.deepEqual(
    togglePinnedHref(repBar, "/employee-portals/incentive", repBar),
    ["/employee-portals/field-crm", "/employee-portals/monthly-closing"],
    "once pinned, unpinning removes that one tab only",
  );
  assert.deepEqual(
    togglePinnedHref(["a", "b", "c", "d"], "e", repBar),
    ["e", "a", "b", "c", "d"],
    "a fifth pin goes first — appended, it would sit past the bar's four and never show on the phone",
  );
  assert.deepEqual(togglePinnedHref(["e", "a"], "e", repBar), ["a"]);
  const repVisibility = resolveEmployeePortalNavVisibility("Medical Rep", "Medical Rep", null, null, null, false, false, true);
  assert.deepEqual(
    shownDefaultBottomNavHrefs(repVisibility),
    repBar,
    "the defaults a first pin starts from are exactly the tabs the rep's bar shows",
  );
  const dmShown = shownDefaultBottomNavHrefs(resolveEmployeePortalNavVisibility("District Manager", "District Manager"));
  assert.ok(dmShown.length > 0 && dmShown.length <= 4, "the bar holds at most four middle tabs (got " + dmShown.length + ")");

  // The row a page belongs to: deepest match, and the portal root claims only itself.
  assert.equal(rowForPath("/employee-portals/plans/calendar", SECTIONS)?.label, "Planning Calendar");
  assert.equal(rowForPath("/employee-portals/direct-orders/new", SECTIONS)?.label, "Direct Orders");
  assert.equal(rowForPath("/employee-portals", SECTIONS)?.label, "Command Center");
  assert.equal(rowForPath("/employee-portals/unknown-page", SECTIONS), null, "the root must not claim every portal page");

  // The trail.
  assert.deepEqual(breadcrumbFor("/employee-portals/weekly-sales", SECTIONS), { label: "Weekly Sales", section: "Sales" });
  assert.deepEqual(breadcrumbFor("/employee-portals/profile", SECTIONS), { label: "My Profile", section: "My Workspace" });
  assert.equal(breadcrumbFor("/employee-portals/unknown-page", SECTIONS), null);

  // The filter: every word, any order, any case, label or section.
  assert.ok(rowMatchesQuery({ label: "Weekly Sales", section: "Sales" }, "sales WEEK"));
  assert.ok(rowMatchesQuery({ label: "Leave Approvals", section: "Approvals Hub" }, "hub"));
  assert.ok(!rowMatchesQuery({ label: "Weekly Sales", section: "Sales" }, "weekly plan"));
  assert.ok(rowMatchesQuery({ label: "anything", section: "x" }, "   "), "an empty filter matches everything");
  const filtered = filterSections(SECTIONS, "weekly");
  assert.deepEqual(
    filtered.map((section) => [section.title, section.items.map((item) => item.label)]),
    [["My Workspace", ["Weekly / Monthly Plan"]], ["Sales", ["Weekly Sales"]]],
    "a filter keeps matching rows only and drops a section it empties",
  );

  // Waiting on you — the ONE number. "Other Approvals" already holds every leave and plan request,
  // so with it on the sidebar the dedicated queues must not be added a second time.
  assert.deepEqual(
    waitingOnYouTotal([
      { count: 5, navBadge: "approvals-hub-pending", overdue: false },
      { count: 2, navBadge: "vacation-approvals-pending", overdue: false },
      { count: 1, navBadge: "plan-approvals-pending", overdue: false },
      { count: 3, navBadge: "marketing-approvals-pending", overdue: false },
      { count: 4, navBadge: "direct-orders-needs-action", overdue: false },
    ]),
    { overdue: false, total: 12 },
    "hub 5 + marketing 3 + direct orders 4 — the leave and plan requests are inside the hub's 5",
  );
  assert.deepEqual(
    waitingOnYouTotal([
      { count: 2, navBadge: "vacation-approvals-pending", overdue: false },
      { count: 1, navBadge: "plan-approvals-pending", overdue: false },
      { count: null, navBadge: "marketing-approvals-pending", overdue: false },
    ]),
    { overdue: false, total: 3 },
    "without the hub the dedicated queues add, and a queue that has not answered adds nothing",
  );
  assert.equal(
    waitingOnYouTotal([
      { count: 5, navBadge: "approvals-hub-pending", overdue: false },
      { count: 2, navBadge: "vacation-approvals-pending", overdue: true },
    ]).overdue,
    true,
    "a late leave request is still an alarm when the hub is what counts it",
  );
  assert.equal(
    waitingOnYouTotal([{ count: 0, navBadge: "plan-approvals-pending", overdue: true }]).overdue,
    false,
    "an empty queue is never overdue",
  );
  assert.deepEqual(
    waitingQueues(SECTIONS).map((queue) => queue.navBadge),
    ["vacation-approvals-pending", "plan-approvals-pending", "approvals-hub-pending", "direct-orders-needs-action"],
    "the counter lists each badged queue once, in sidebar order",
  );

  // `G` shortcuts: only pages this viewer's sidebar offers, plus the two every role opens.
  const offered = availableGoShortcuts(SECTIONS).map((shortcut) => shortcut.key);
  assert.ok(offered.includes("h") && offered.includes("s") && offered.includes("p"), `got ${offered.join(",")}`);
  assert.ok(!offered.includes("c"), "Phoenix CRM is not on this sidebar, so G C must not be offered");
  assert.equal(new Set(PORTAL_GO_SHORTCUTS.map((shortcut) => shortcut.key)).size, PORTAL_GO_SHORTCUTS.length, "every G letter is unique");

  // Identity.
  assert.equal(initialsFor("Samaa Mosaad Said Khalil"), "SK");
  assert.equal(initialsFor("dev.preview"), "D");
  assert.equal(initialsFor("   "), "?");
  // Cairo is UTC+3 in September: 22:06 UTC on the 28th is 01:06 on the 29th in Cairo.
  assert.equal(cairoHour(new Date("2026-09-28T22:06:00Z")), 1);
  assert.equal(cairoHour(new Date("2026-09-29T06:00:00Z")), 9);
  assert.equal(greetingForHour(9), "Good morning");
  assert.equal(greetingForHour(12), "Good afternoon");
  assert.equal(greetingForHour(17), "Good evening");
  assert.equal(greetingForHour(1), "Good evening");

  // ── 2. The wiring ───────────────────────────────────────────────────────────────────────────
  const layout = stripComments(readFileSync(LAYOUT, "utf8"));
  const widgets = stripComments(readFileSync(WIDGETS, "utf8"));

  // The badge sources the counters listen to are exactly the ones the rows render.
  for (const src of Object.values(PORTAL_BADGE_SOURCES)) {
    assert.ok(layout.includes(`<NavBadge src="${src}" />`), `the sidebar must render a row badge for ${src} — the counters listen to it`);
  }

  const menu = componentBody(layout, "EmployeePortalMenu");
  assert.match(menu, /aria-expanded=\{!folded\}/, "a section header must say whether it is open");
  assert.match(menu, /disabled=\{!canFold\}/, "a section that cannot fold must say so on its button");
  assert.match(
    menu,
    /const canFold = !isActiveSection && !filtering;/,
    "the section you are in must not fold away — it would hide the row that says where you are — nor any section while filtering",
  );
  assert.match(menu, /writeStoredList\(PORTAL_COLLAPSED_SECTIONS_KEY, toggleInList\(collapsedSections, section\.title\)\)/, "folding is remembered on this device");
  assert.match(menu, /data-active-row=\{active \? "true" : undefined\}/, "the sliding marker finds the lit row by this attribute");
  assert.match(menu, /const active = !section\.virtual && /, "a pinned or recent COPY of a row never lights up");
  assert.match(menu, /tabIndex=\{-1\}/, "the pin star stays out of the Tab order — the command bar pins by keyboard");
  assert.match(menu, /absolute left-2\.5 top-1\/2/, "the star sits over the icon, so no row gets wider");

  const sidebar = componentBody(layout, "EmployeePortalSidebar");
  assert.match(sidebar, /withPinned\(sections, pinnedHrefs\)/, "the sidebar leads with Pinned only — Recent was removed from the rail (owner, 2026-09-29); it still leads the command bar");
  assert.match(sidebar, /onTogglePin=\{togglePin\}/);
  assert.match(sidebar, /filterQuery=\{filter\}/);
  assert.match(sidebar, /<PortalPendingCount navBadges=\{badged\} tone="rail" \/>/, "the rail icons carry live counts");
  assert.match(sidebar, /flyoutSection && flyout \?/, "the collapsed rail pops a section out");
  assert.match(
    sidebar,
    /if \(collapsed && event\.detail > 0 && event\.button === 0 && !event\.metaKey && !event\.ctrlKey && !event\.shiftKey && !event\.altKey\) \{\s*event\.preventDefault\(\);\s*openFlyout\(section\.title, event\.currentTarget\);\s*return;/,
    "folded, a CLICK on a rail icon opens its pop-out (the promise was hover OR click; a tablet has no hover) — Enter and Ctrl-click still go to the first page",
  );
  assert.match(sidebar, /document\.addEventListener\("mousedown", onPointerDown\)/, "a tap outside closes the pop-out — a tablet never fires mouse-leave");
  assert.match(sidebar, /closest\("\[data-portal-flyout\], \[data-portal-rail-link\]"\)/);
  assert.match(sidebar, /data-portal-flyout=""/);
  assert.match(sidebar, /data-portal-rail-link=""/);
  assert.match(
    sidebar,
    /setPinnedHrefs\(togglePinnedHref\(pinnedHrefs, href, shownDefaultBottomNavHrefs\(visibility\)\)\)/,
    "sidebar pins write the phone bar's own list — one set of favourites — through the rule that keeps the defaults",
  );
  assert.doesNotMatch(layout, /toggleInList\(pinnedHrefs/, "no surface may toggle a pin without the phone bar's rule");

  // Fold defaults. TWO SEPARATE PREFERENCES, and only one of them changed:
  //
  //   THE RAIL still opens COLLAPSED to icons — owner, 2026-09-29, untouched.
  //   THE SECTION TITLES now open EXPANDED — owner, 2026-10-03: "make the sidebar titles in emp
  //   portal expanded not collapsed by default". That REVERSES the 2026-09-29 half which folded every
  //   section except My Workspace, leaving a rep reading a column of names with a count beside each
  //   and nothing visible until he opened a fold.
  //
  // Both are pinned: each is a one-line default a later edit could flip in passing, and neither
  // failure shows up in a test that only renders the markup.
  assert.match(layout, /function getEmployeeSidebarCollapsedServerSnapshot\(\) \{\s*return true;/, "the rail is collapsed by default");
  assert.match(layout, /return stored === null \? true : stored === "true";/, "a device with no stored fold opens the rail collapsed");
  assert.match(menu, /const collapsedSections = collapsePreferenceSet \? storedCollapsedSections : defaultCollapsedSections;/, "the default fold set applies only until this device chooses");
  assert.match(
    layout,
    /const NO_SECTIONS_FOLDED: readonly string\[\] = \[\];/,
    "the default fold set is an empty, stable module-level constant",
  );
  assert.match(
    menu,
    /const defaultCollapsedSections = NO_SECTIONS_FOLDED;/,
    "by default NOTHING is folded — every section title opens expanded (owner, 2026-10-03)",
  );
  assert.doesNotMatch(
    menu,
    /baseSections\.filter\(\(section\) => section\.title !== "My Workspace"\)/,
    "the retired 2026-09-29 default (everything folded but My Workspace) must not come back",
  );

  // The collapsed rail wears the transparent phoenix mark (the expanded panel keeps the bird-icon
  // lockup, whose white tile is invisible on the white panel — only the navy rail needed transparency).
  assert.match(sidebar, /src="\/brand\/phoenix-notification-icon\.png"/, "the collapsed rail wears the transparent phoenix mark");

  const chrome = componentBody(layout, "EmployeePortalChrome");
  assert.match(
    chrome,
    /if \(wideScreen\) \{\s*list\.push\(\s*\{\s*hint: "\["[\s\S]*?id: "shortcuts"/,
    "on a phone the command bar leaves out folding the sidebar and the keyboard card — neither exists there",
  );
  assert.match(chrome, /run: \(\) => setPinnedHrefs\(togglePinnedHref\(pinnedHrefs, currentRow\.href, shownDefaultBottomNavHrefs\(visibility\)\)\)/);
  assert.match(
    componentBody(widgets, "PortalCommandBar"),
    /className="hidden shrink-0 flex-wrap[^"]*md:flex"/,
    "the keyboard help row is hidden on a phone, which has none of those keys",
  );
  assert.match(chrome, /event\.key\.toLowerCase\(\) === "k"/, "Ctrl/⌘ K opens the command bar");
  assert.match(chrome, /if \(isTypingTarget\(event\.target\)\) return;/, "no shortcut steals keystrokes from a field");
  assert.match(chrome, /focusMode=\{focusMode\}/, "the top bar hides in focus mode");
  assert.doesNotMatch(chrome, /focusMode \? null : <EmployeePortalTopNav/, "the top bar must stay MOUNTED in focus mode — it carries the session guard");
  assert.match(chrome, /\{focusMode \? null : <EmployeePortalSidebar/);
  assert.match(chrome, /Exit focus mode/, "focus mode always has a visible way back");
  assert.match(chrome, /writeStoredList\(PORTAL_RECENT_PAGES_KEY, nextRecentHrefs\(current, href\)\)/, "recent pages are noted");

  const topNav = componentBody(layout, "EmployeePortalTopNav");

  // The top bar's premium pass (owner, 2026-09-29 — his "2-3-5"): a "+ New" quick-action menu and a
  // grouped icon cluster.
  assert.match(topNav, /<PortalQuickActions onNavigate=\{navigateTo\} visibility=\{visibility\} \/>/, "the top bar carries the + New quick-action menu");
  const quickActions = componentBody(layout, "PortalQuickActions");
  assert.match(quickActions, /if \(actions\.length === 0\) return null;/, "someone with no available action sees no + New button");
  assert.doesNotMatch(quickActions, /method: "POST"|method: "PATCH"/i, "the + New menu only navigates — it never acts");
  // The action list moved to a React-free lib file so ONE source feeds this menu, the command bar
  // and the phone bar's action button — and, critically, so its hrefs leave the layout, which
  // tests/employee-portal-bottom-nav.test.ts reads to demand every href there be a phone-bar
  // registry entry. The gate assertion moves with the list rather than being deleted.
  const quickActionsLib = stripComments(readFileSync(QUICK_ACTIONS, "utf8"));
  assert.match(
    quickActionsLib,
    /visibility\.showExpenseActionTab\s*\?[\s\S]*?href: "\/employee-portals\/submit-expense"/,
    "Submit an expense is gated by its own flag",
  );
  assert.doesNotMatch(quickActionsLib, /method: "POST"|method: "PATCH"|fetch\(/i, "the shared action list only names destinations — it never acts");
  assert.doesNotMatch(layout, /"\/employee-portals\/direct-orders\/new"/, "quick-action hrefs stay OUT of the layout — the phone-bar guard reads every href literal here");
  assert.match(topNav, /\[&>\*:not\(:first-child\)\]:border-l[\s\S]*?<DisplayScaleControl isAdminMode=\{false\} \/>\s*<EmployeePortalInbox mailboxConnected=\{data\.mailboxConnected\} \/>/, "zoom and the unified inbox are one bordered cluster with dividers; the inbox is told what the shell's render already knows about the mailbox");

  // The unified inbox (item 2): notifications + messages behind ONE bell with two tabs, reusing the
  // shared components in their embedded mode. It only navigates/marks-read via those components; it
  // never fetches or mutates on its own.
  const inbox = componentBody(layout, "EmployeePortalInbox");
  assert.match(inbox, /<InAppNotificationsBell embedded isAdminMode=\{false\} onClose=\{close\} onUnreadChange=\{setNotifUnread\} \/>/, "the inbox embeds the shared notifications feed");
  assert.match(inbox, /<InternalMessagesMenu embedded isAdminMode=\{false\} mailboxConnected=\{mailboxConnected\} onUnreadChange=\{setMessageUnread\} \/>/, "the inbox embeds the shared messages feed, handing it the mailbox state");
  assert.match(inbox, /const total = notifUnread \+ messageUnread;/, "the trigger badge is the combined unread count");
  assert.match(inbox, /: "hidden"/, "both feeds stay mounted while closed so the badge stays live");
  assert.doesNotMatch(inbox, /fetch\(|method: "(POST|PATCH)"/i, "the inbox wrapper adds no data logic of its own — the embedded feeds own it");

  // Admin is untouched: the shared components still default to standalone (no embedded).
  const bellSrc = readFileSync("src/components/layout/in-app-notifications-bell.tsx", "utf8");
  const messagesSrc = readFileSync("src/components/layout/internal-messages-menu.tsx", "utf8");
  assert.match(bellSrc, /embedded = false/, "the bell's embedded mode is opt-in — admin keeps the standalone bell");
  assert.match(messagesSrc, /embedded = false/, "the messages menu's embedded mode is opt-in — admin keeps the standalone menu");
  const adminTopbar = readFileSync("src/components/layout/topbar.tsx", "utf8");
  assert.match(adminTopbar, /<InAppNotificationsBell isAdminMode=\{isAdminMode\} \/>/, "the admin top bar still uses the standalone bell, unchanged");
  assert.match(adminTopbar, /<InternalMessagesMenu isAdminMode=\{isAdminMode\} mailboxConnected=\{mailboxConnected\} \/>/, "the admin top bar still uses the standalone messages menu, told whether a mailbox is connected");

  // ── The phone (owner, 2026-09-29: "bring godmode to the phone") ─────────────────────────────
  // A search button opens the command bar below the width where the search box appears.
  assert.match(
    topNav,
    /aria-label="Search pages and actions"\s*className="[^"]*\bmd:hidden"\s*onClick=\{onOpenCommandBar\}/,
    "phones get a search button that opens the command bar",
  );
  // The waiting number rides on the Menu button — the number only. A "Waiting on you" card at the top
  // of the phone menu was built the same day and removed on sight at the owner's word (2026-09-29).
  assert.match(topNav, /<PortalPendingCount navBadges=\{queueBadges\} tone="menu" \/>/, "the phone's Menu button carries the waiting number");
  assert.match(topNav, /queueBadges = waitingQueues\(menuSections\)/);
  assert.doesNotMatch(layout, /WaitingOnYouCard/, "the owner removed the phone menu's waiting card — do not bring it back");
  assert.doesNotMatch(widgets, /function WaitingOnYouCard/, "the owner removed the phone menu's waiting card — do not bring it back");
  // Pins from the phone menu: a star button turns pin mode on, and a tap then pins instead of opening.
  assert.match(topNav, /aria-label=\{pinMode \? "Done pinning" : "Pin pages"\}/);
  assert.match(topNav, /onTogglePin=\{togglePin\}\s*pathname=\{pathname\}\s*pinMode=\{pinMode\}/, "the phone menu is handed the pin switch");
  assert.match(
    topNav,
    /setPinnedHrefs\(togglePinnedHref\(pinnedHrefs, href, shownDefaultBottomNavHrefs\(visibility\)\)\)/,
    "a phone pin goes through the same rule as a desk pin",
  );
  assert.match(
    menu,
    /const canPin = Boolean\(onTogglePin\) && !locked && !isMobile;/,
    "the invisible hover star must never sit over a phone row — a tap meant to open the page would pin it",
  );
  assert.match(
    menu,
    /if \(pinMode\) \{[\s\S]*?aria-pressed=\{pinned\}[\s\S]*?disabled=\{locked\}[\s\S]*?onClick=\{\(\) => onTogglePin\?\.\(item\.href\)\}/,
    "in pin mode a tap pins, and a locked page cannot be pinned",
  );
  assert.match(topNav, /<WaitingOnYouChip onNavigate=\{navigateTo\} sections=\{menuSections\} \/>/);
  assert.doesNotMatch(layout, /Live Performance/, "the decorative Live Performance chip is gone — the waiting counter took its place");
  assert.match(topNav, /<PortalAvatar fullName=\{employeeName\} photoSrc=\{photoSrc\}/, "the account button shows the person, not the logo");
  assert.match(topNav, /data\.employee\.photoUrl \?\? employeeProfileImageForHrId\(data\.employee\.hrId\)/);
  assert.match(topNav, /href="\/employee-portals\/payslips"/, "Payslips quick link");
  assert.match(topNav, /href="\/employee-portals\/vacation-request"/, "Vacation Request quick link");
  assert.match(topNav, /<EmployeePortalGreeting firstName=\{firstName\} \/>/);

  const greeting = componentBody(layout, "EmployeePortalGreeting");
  assert.match(greeting, /useState<string \| null>\(null\)/, "the greeting starts empty so the server HTML and first client pass match");
  assert.ok(greeting.includes('{visitsCanBeHeld ? "Offline — only visits will save" : "Offline — nothing will save"}'), "🔴 the line is true for the screen it sits on: a rep on Visits can keep a visit, and everyone else still cannot save");

  // The waiting counter opens queues — it never decides anything.
  const chip = componentBody(widgets, "WaitingOnYouChip");
  assert.doesNotMatch(chip, /approve|reject|method: "POST"|method: "PATCH"/i, "the counter must never act on a request");
  assert.match(chip, /if \(queues\.length === 0\) return null;/, "someone who owns no queue sees no permanent 0");

  // ── 3. The sidebar stays WHITE (owner, 2026-09-29) ──────────────────────────────────────────
  const navItem = componentBody(layout, "navItemClass");
  assert.match(navItem, /"text-\[#26334F\] hover:bg-\[#FFF6F0\] hover:text-\[#F05A1A\]"/, "rows keep the original white-sidebar palette");
  for (const [name, body] of [["EmployeePortalSidebar", sidebar], ["EmployeePortalMenu", menu]] as const) {
    assert.doesNotMatch(body, /#0F1930|#131F3A|#0A1224/, `${name}: the navy label column was turned down — do not bring it back`);
  }
  assert.match(
    topNav,
    /id="employee-portal-mobile-sidebar"/,
  );
  assert.match(
    topNav,
    /flex-col border-r border-slate-200 bg-white shadow-2xl/,
    "the phone menu stays white too",
  );
}
