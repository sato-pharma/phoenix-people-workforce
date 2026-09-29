// ─────────────────────────────────────────────────────────────────────────────
// Employee portal chrome — the pure rules behind the sidebar and top bar's power features.
//
// React-free and DOM-free on purpose, so the Node test harness can exercise every rule here
// (tests/portal-godmode-chrome.test.ts). The components in src/components/employee-portal/ own
// the rendering and the browser storage; this file owns the decisions.
//
// Owner, 2026-09-29: "godmode" for the portal sidebar and top bar — a command bar, recent pages,
// pins, a sidebar filter, a live "waiting on you" counter, rail flyouts with counts, a "you are
// here" trail, an offline warning, keyboard shortcuts, focus mode, the person's photo, and a greeting
// with a live Cairo clock. A navy sidebar was tried the same day and turned down on sight ("sidebar
// color is very bad") — the sidebar stays white. EMPLOYEE PORTAL ONLY — nothing here reaches the
// admin shell.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveDeepestActiveHref } from "@/lib/navigation/active-path";

/** The sidebar badge keys the portal renders, and the endpoint that counts each one. */
export const PORTAL_BADGE_SOURCES = {
  "approvals-hub-pending": "/api/approvals-hub/pending-count",
  "vacation-approvals-pending": "/api/approvals/vacation/pending-count",
  "excuse-approvals-pending": "/api/approvals/excuse/pending-count",
  "plan-approvals-pending": "/api/approvals/plan/pending-count",
  "direct-orders-needs-action": "/api/direct-orders/needs-action-count",
  "marketing-approvals-pending": "/api/marketing-requests/pending-count",
  "market-awareness-approvals-pending": "/api/market-awareness/pending-count",
} as const;

export type PortalNavBadge = keyof typeof PORTAL_BADGE_SOURCES;

/** One sidebar row, as every feature in this file reads it. */
export type PortalChromeRow = {
  href: string;
  label: string;
  navBadge?: PortalNavBadge;
  section: string;
};

/** One sidebar section, as every feature in this file reads it. */
export type PortalChromeSection = {
  items: ReadonlyArray<{ href: string; label: string; navBadge?: PortalNavBadge }>;
  title: string;
};

// ── Browser-storage keys ─────────────────────────────────────────────────────
// Per device, like the sidebar-collapsed flag and the phone bar's pins. Versioned so a future change
// of shape can start clean instead of misreading an old value.
export const PORTAL_RECENT_PAGES_KEY = "phoenix-employee-recent-pages-v1";
export const PORTAL_COLLAPSED_SECTIONS_KEY = "phoenix-employee-sidebar-sections-collapsed-v1";

/** How many recent pages are kept, and shown first in the command bar. */
export const PORTAL_RECENT_PAGES_LIMIT = 6;

/**
 * A stored JSON list of strings, read defensively: anything that is not an array of strings —
 * a corrupt value, another app's key, an older shape — reads as an empty list, never an error.
 */
export function parseStoredStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

/** The recent list after visiting `href`: it moves to the front, appears once, and the list is capped. */
export function nextRecentHrefs(
  current: readonly string[],
  href: string,
  limit: number = PORTAL_RECENT_PAGES_LIMIT,
): string[] {
  return [href, ...current.filter((existing) => existing !== href)].slice(0, limit);
}

/** Add `value` if absent, remove it if present — the pin star and the section fold both use this. */
export function toggleInList(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((existing) => existing !== value) : [...list, value];
}

/**
 * A pin toggled from the sidebar star, the phone menu or the command bar. The pins ARE the phone
 * bar's own list, and the bar shows the first four of it. Two rules follow (found 2026-09-29, before
 * it shipped):
 *
 * - An empty list means "show the role's default tabs", so the first pin on a device that never
 *   chose any starts from the tabs the bar is showing. Toggling onto an empty list turned a rep's
 *   Phoenix CRM · Incentive · Monthly Closing bar into one lone tab the moment he pinned anything.
 * - A new pin goes FIRST, so it is always on the bar. Appended, a manager's fifth pin — four
 *   defaults plus the page he just starred — landed past the cut and never appeared on his phone.
 *
 * - With nothing pinned yet every row reads "Pin", the default tabs included, so that first tap
 *   always PINS. Toggled against the defaults, "Pin Weekly / Monthly Plan" took a manager's default
 *   Plans tab OFF his bar — caught in the browser, 2026-09-29.
 *
 * Unpinning removes it wherever it sits. Empty the list and the bar returns to the defaults.
 */
export function togglePinnedHref(
  current: readonly string[],
  href: string,
  shownDefaults: readonly string[],
): string[] {
  if (current.length === 0) return [href, ...shownDefaults.filter((existing) => existing !== href)];
  return current.includes(href) ? current.filter((existing) => existing !== href) : [href, ...current];
}

/**
 * Swap one tab on the phone bar for another, from the bar's own Edit tabs sheet (owner,
 * 2026-09-29 — he chose the tap route over a long press).
 *
 * It inherits both lessons `togglePinnedHref` above learned the hard way. An empty list means "show
 * the role's defaults", so a first edit on a device that never chose anything starts from the tabs
 * the bar is actually showing — otherwise the first swap collapses the bar to one tab. And the swap
 * happens IN PLACE: the new tab takes the old one's seat, so nothing jumps under the thumb between
 * choosing and looking.
 *
 * Choosing a page that is already on the bar swaps the two seats rather than listing it twice, and
 * `toHref` equal to `fromHref` is a no-op. A `fromHref` that is not on the bar changes nothing —
 * Home and Profile are never in this list, so this is also what refuses them.
 *
 * The length never changes, so the four-tab cap cannot be breached by an edit.
 */
export function replaceBottomNavHref(
  current: readonly string[],
  shownDefaults: readonly string[],
  fromHref: string,
  toHref: string,
): string[] {
  const base = current.length === 0 ? [...shownDefaults] : [...current];
  const seat = base.indexOf(fromHref);
  if (seat === -1 || fromHref === toHref) return base;
  const alreadyAt = base.indexOf(toHref);
  if (alreadyAt !== -1) base[alreadyAt] = fromHref;
  base[seat] = toHref;
  return base;
}

/** Every row of every section, flattened, each carrying the title of the section it lives in. */
export function flattenSections(sections: readonly PortalChromeSection[]): PortalChromeRow[] {
  return sections.flatMap((section) =>
    section.items.map((item) => ({ href: item.href, label: item.label, navBadge: item.navBadge, section: section.title })),
  );
}

/**
 * The row a page belongs to, for the recent list and the trail: the deepest sidebar row whose href
 * is the page or a parent of it. The portal root matches only itself — every portal path starts
 * with it, so without that it would claim every page.
 */
export function rowForPath(pathname: string, sections: readonly PortalChromeSection[]): PortalChromeRow | null {
  const rows = flattenSections(sections);
  const href = resolveDeepestActiveHref(
    pathname,
    rows.map((row) => row.href),
    new Set(["/employee-portals"]),
  );
  return href ? rows.find((row) => row.href === href) ?? null : null;
}

/** Pages with no sidebar row that the trail and the command bar still name. Every portal role opens them. */
export const PORTAL_PAGES_WITHOUT_A_ROW: ReadonlyArray<PortalChromeRow> = [
  { href: "/employee-portals/profile", label: "My Profile", section: "My Workspace" },
  // attendance:read — held by every portal role (see the Private Calendar note in navigation.ts).
  { href: "/employee-portals/attendance", label: "My Attendance", section: "Leave & HR" },
];

/** "Section › Page" for the top bar, or null on a page the portal cannot name. */
export function breadcrumbFor(
  pathname: string,
  sections: readonly PortalChromeSection[],
): { label: string; section: string } | null {
  const extra = PORTAL_PAGES_WITHOUT_A_ROW.find(
    (page) => pathname === page.href || pathname.startsWith(`${page.href}/`),
  );
  if (extra) return { label: extra.label, section: extra.section };
  const row = rowForPath(pathname, sections);
  return row ? { label: row.label, section: row.section } : null;
}

/**
 * The sidebar filter: a row matches when EVERY word typed appears in its label or its section's
 * title, in any order and any case. "sales week" finds Weekly Sales; "approvals" finds the whole
 * Approvals Hub section. An empty query matches everything.
 */
export function rowMatchesQuery(row: { label: string; section: string }, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${row.label} ${row.section}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The sections a filter leaves standing: matching rows only, and no section left empty. */
export function filterSections<Section extends PortalChromeSection>(sections: readonly Section[], query: string): Section[] {
  if (!query.trim()) return [...sections];
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => rowMatchesQuery({ label: item.label, section: section.title }, query)),
    }))
    .filter((section) => section.items.length > 0);
}

// ── "Waiting on you" ─────────────────────────────────────────────────────────

/** One queue's live reading from the badge poll. `count` is null until the first answer lands. */
export type QueueReading = { count: number | null; navBadge: PortalNavBadge; overdue: boolean };

/**
 * The ONE number the top bar shows, and whether any of it is overdue.
 *
 * The queues are NOT all disjoint, and a plain sum would double-count: "Other Approvals"
 * (`approvals-hub-pending`) is the combined inbox, and it already holds every leave, excuse and plan
 * item that the three dedicated queues count. So when the hub is on the viewer's sidebar it stands
 * for all four and the three are left out of the total; without it, the three are added. Marketing,
 * Market Awareness and Direct Orders are excluded from the hub by design (see the badge-counts
 * route), so they always add.
 *
 * A queue that has not answered yet (count null) adds nothing — the total never guesses.
 */
/**
 * The queues the combined "Other Approvals" inbox already contains. Kept at module scope because
 * BOTH the total below and the phone bar's Home rule need the same answer — two copies would drift.
 */
const COVERED_BY_APPROVALS_HUB = new Set<PortalNavBadge>([
  "vacation-approvals-pending",
  "excuse-approvals-pending",
  "plan-approvals-pending",
]);

export function waitingOnYouTotal(readings: readonly QueueReading[]): { overdue: boolean; total: number } {
  const hasHub = readings.some((reading) => reading.navBadge === "approvals-hub-pending");
  const coveredByHub = COVERED_BY_APPROVALS_HUB;
  let total = 0;
  let overdue = false;
  for (const reading of readings) {
    if (hasHub && coveredByHub.has(reading.navBadge)) {
      // Still an alarm if it is overdue — the hub counts it, and its lateness is real.
      if (reading.overdue && (reading.count ?? 0) > 0) overdue = true;
      continue;
    }
    const count = reading.count ?? 0;
    total += count;
    if (reading.overdue && count > 0) overdue = true;
  }
  return { overdue, total };
}

/**
 * The queues the phone bar's HOME tab speaks for: every queue this viewer owns that has no tab of
 * its own on the bar.
 *
 * Why it exists (owner, 2026-09-29): a queue badge only ever appeared if that queue happened to be
 * one of the four pinned tabs. A District Manager's default bar is Plans · Planning · Source of
 * Sales · Team — none of them badged — so approvals waiting on him showed NOTHING on the phone,
 * which is the surface where it costs most. Home now carries what the other tabs cannot.
 *
 * A queue that IS a tab is left out, so the two never show the same number twice: the tab speaks for
 * itself and Home stays quiet about it.
 *
 * THE HUB COUNTS FOR ITS MEMBERS TOO. Pinning "Other Approvals" has to silence Home about leave,
 * excuse and plan as well, because that one tab's number already contains them. Found in the
 * browser, 2026-09-29: with the hub pinned and a made-up 5/2/1/3, the tab read 5 and Home read 6 —
 * and 3 of Home's 6 were the leave and plan items that tab was already showing. Home now reads 3,
 * the marketing queue alone, and 5 + 3 is the honest distinct total.
 *
 * The reverse case keeps the hub: a viewer who pins Leave Approvals but NOT the hub still needs
 * Home to carry the hub, or the excuse and plan items behind it go unreported. There the hub's
 * number does still contain the pinned queue's items — an overlap inherent to any single combined
 * count, and the same one the desktop chip already explains in words ("Includes the leave, excuse
 * and plan requests listed here").
 */
export function homeTabWaitingBadges(
  all: readonly PortalNavBadge[],
  onTabs: readonly PortalNavBadge[],
): PortalNavBadge[] {
  const taken = new Set(onTabs);
  const hubIsOnATab = taken.has("approvals-hub-pending");
  const seen = new Set<PortalNavBadge>();
  return all.filter((badge) => {
    if (taken.has(badge) || seen.has(badge)) return false;
    if (hubIsOnATab && COVERED_BY_APPROVALS_HUB.has(badge)) return false;
    seen.add(badge);
    return true;
  });
}

/** The badged rows on a viewer's sidebar, once each, in sidebar order — what "Waiting on you" lists. */
export function waitingQueues(sections: readonly PortalChromeSection[]): PortalChromeRow[] {
  const seen = new Set<string>();
  const queues: PortalChromeRow[] = [];
  for (const row of flattenSections(sections)) {
    if (!row.navBadge || seen.has(row.navBadge)) continue;
    seen.add(row.navBadge);
    queues.push(row);
  }
  return queues;
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

/**
 * `G` then a letter jumps to a page. Offered only when the viewer's own sidebar has that page, so a
 * shortcut can never open something the sidebar does not.
 */
export const PORTAL_GO_SHORTCUTS: ReadonlyArray<{ href: string; key: string; label: string }> = [
  { key: "h", href: "/employee-portals", label: "Command Center" },
  { key: "p", href: "/employee-portals/profile", label: "My Profile" },
  { key: "c", href: "/employee-portals/field-crm", label: "Phoenix CRM" },
  { key: "v", href: "/employee-portals/visits", label: "My Visits" },
  { key: "s", href: "/employee-portals/sales-vs-target", label: "Sales vs Target" },
  { key: "m", href: "/employee-portals/monthly-closing", label: "Monthly Closing" },
  { key: "t", href: "/employee-portals/targets", label: "Targets" },
  { key: "r", href: "/employee-portals/reps-list", label: "Reps List" },
  { key: "k", href: "/employee-portals/kpis", label: "KPIs" },
  { key: "i", href: "/employee-portals/incentive", label: "Incentive" },
  { key: "l", href: "/employee-portals/vacation-request", label: "Vacation Request" },
  { key: "o", href: "/employee-portals/approvals-hub", label: "Other Approvals" },
];

/** The `G` shortcuts this viewer can use: the page must be on their sidebar (or be one every role opens). */
export function availableGoShortcuts(sections: readonly PortalChromeSection[]) {
  const hrefs = new Set([
    ...flattenSections(sections).map((row) => row.href),
    ...PORTAL_PAGES_WITHOUT_A_ROW.map((page) => page.href),
  ]);
  return PORTAL_GO_SHORTCUTS.filter((shortcut) => hrefs.has(shortcut.href));
}

// ── Hiding the phone chrome while reading ────────────────────────────────────

export type ChromeScrollState = { hidden: boolean; lastY: number };

/** How far down before a scroll counts as reading rather than a jitter, and the reveal's hair trigger. */
const CHROME_HIDE_DELTA = 24;
const CHROME_SHOW_DELTA = -4;
/** The top strip where the bar always stays, and how much taller than the screen a page must be. */
const CHROME_TOP_ZONE = 96;
const CHROME_MIN_SCROLLABLE = 240;
/** How close to the foot of the page counts as the bottom. */
const CHROME_BOTTOM_ZONE = 24;

/**
 * Whether the phone's bottom bar is hidden after a scroll (owner, 2026-09-29 — "build it, revealing
 * instantly").
 *
 * The bar costs 61px of an 812px screen, worth giving back while someone reads a long table. What
 * it must never do is be missing when it is wanted, so the rule is deliberately lopsided: 24px of
 * deliberate downward scroll to hide, FOUR pixels the other way to come back — a flick up returns
 * it before the gesture has finished.
 *
 * Three places it never hides at all:
 * - a page barely taller than the screen, where a rubber-band bounce would otherwise flash it away;
 * - the top 96px, where nothing has been read yet;
 * - the bottom, where there is nothing further to scroll to and the bar is what you reach for next.
 *
 * `lastY` always advances, hidden or not, so every delta is measured from where the finger actually
 * is and a slow drift can never accumulate into a hide.
 */
export function nextChromeScrollState(
  current: ChromeScrollState,
  { docHeight, viewportHeight, y }: { docHeight: number; viewportHeight: number; y: number },
): ChromeScrollState {
  const scrollable = docHeight - viewportHeight;
  const delta = y - current.lastY;
  if (scrollable < CHROME_MIN_SCROLLABLE) return { hidden: false, lastY: y };
  if (y <= CHROME_TOP_ZONE) return { hidden: false, lastY: y };
  if (y >= scrollable - CHROME_BOTTOM_ZONE) return { hidden: false, lastY: y };
  if (delta < CHROME_SHOW_DELTA) return { hidden: false, lastY: y };
  if (delta > CHROME_HIDE_DELTA) return { hidden: true, lastY: y };
  return { hidden: current.hidden, lastY: y };
}

// ── Identity ─────────────────────────────────────────────────────────────────

/** Up to two initials: first and last word. "Samaa Mosaad Said Khalil" → "SK"; one word → one letter. */
export function initialsFor(fullName: string | null | undefined): string {
  const words = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
  return `${first}${last}`.toUpperCase();
}

/** The hour of the day in Cairo (0-23), whatever zone the device is set to. */
export function cairoHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "Africa/Cairo" })
    .formatToParts(now)
    .find((part) => part.type === "hour")?.value;
  return Number(hour ?? 0) % 24;
}

/** Morning from 04:00, afternoon from 12:00, evening from 17:00 — Cairo time. */
export function greetingForHour(hour: number): string {
  if (hour >= 4 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}
