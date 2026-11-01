/**
 * Phoenix CRM — which tab opens, and which territory it shows.
 *
 * Plain code, so the screen and the page's first read (server/first-read.ts) answer from one rule.
 */

import type { PhoenixCrmOverview, PhoenixCrmTabs, TerritorySummary } from "@/lib/phoenix-crm/view-types";

/** Which shell the module is read in. */
export type PhoenixCrmSurface = "admin" | "portal";

export type TabKey = keyof PhoenixCrmTabs;

// The Super Admin's own tab for the test personas' approvals is LAST (owner, 2026-10-22), after Settings.
export const TAB_ORDER: readonly TabKey[] = ["visits", "list", "plan", "forecast", "team", "calendar", "doctors", "reports", "settings", "testAccounts"];

/** The tabs that show one territory, chosen with the picker above them. */
export type SeatTab = "visits" | "list" | "plan";


export function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TAB_ORDER as readonly string[]).includes(value);
}

export function allowedTabs(tabs: PhoenixCrmTabs): TabKey[] {
  return TAB_ORDER.filter((key) => tabs[key]);
}

/**
 * The tab the page opens on: the one the address asks for, when the viewer has it; else Team for a
 * manager with a real decision waiting, or for one who reads the territories without entering visits
 * (a regional or national manager, the CEO, the SFE team); else the viewer's first tab.
 *
 * 🔴 AN ADMIN ACCOUNT NEVER OPENS ON ONE REP'S ENTRY SCREEN (owner, 2026-10-03: *"in admin accounts i
 * find many defaults usage not easy at all"*). `allowed[0]` is **Visits** — a single territory's
 * day, chosen for him out of 74 by `seatOf`, with nothing to enter on it since his test mode was
 * retired. On the admin surface the landing is the whole company instead: **Team**, and **Reports**
 * where there is no Team tab (the Training Manager, a product manager). The portal keeps its own
 * landing exactly as it was — a rep still opens onto his day (A2, owner 2026-09-26).
 */
export function openingTab(overview: PhoenixCrmOverview, requested: string | null, surface: PhoenixCrmSurface): TabKey {
  const allowed = allowedTabs(overview.tabs);
  if (isTabKey(requested) && allowed.includes(requested)) return requested;
  const { tabs, viewer, visitSeatIds, waitingForYou } = overview;
  if (surface === "admin" && !viewer.isRep) {
    if (tabs.team) return "team";
    if (tabs.reports) return "reports";
  }
  // The off-plan visits are one of the decisions since 2026-10-02 — a manager with one waiting and
  // nothing else lands on Team now, instead of on the tab he happened to be given first.
  const decisions =
    (waitingForYou.isTest && !viewer.isTestPersona
      ? 0
      : waitingForYou.plans +
        waitingForYou.requests +
        waitingForYou.planEdits +
        waitingForYou.offPlanVisits +
        waitingForYou.visitAsks);
  if (tabs.team && !viewer.isRep && decisions > 0) return "team";
  if (tabs.team && !viewer.isSuperAdmin && visitSeatIds.length === 0) return "team";
  // A2 (owner, 2026-09-26): he opens the app onto his DAY, not onto a tab bar. A manager with a real
  // decision waiting still lands on Team — the two branches above run first on purpose.
  return allowed[0] ?? "visits";
}

/** The territories a tab offers. A plan is its own rep's to change; the Super Admin reads any of them. */
export function territoriesFor(overview: PhoenixCrmOverview, tab: SeatTab): TerritorySummary[] {
  if (tab !== "plan" || overview.viewer.isSuperAdmin) return overview.territories;
  return overview.territories.filter((territory) => overview.ownSeatIds.includes(territory.seatId));
}

/** A tab's territory: the one chosen, when the tab offers it; else the viewer's own, else one they add visits for, else the first. */
export function seatOf(overview: PhoenixCrmOverview, tab: SeatTab, chosen: string | null): string | null {
  const options = territoriesFor(overview, tab);
  if (chosen !== null && options.some((territory) => territory.seatId === chosen)) return chosen;
  const own = options.find((territory) => overview.ownSeatIds.includes(territory.seatId));
  const visits = options.find((territory) => overview.visitSeatIds.includes(territory.seatId));
  return (own ?? visits ?? options[0])?.seatId ?? null;
}
