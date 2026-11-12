// What the My Visits page sends to the phone: every tab's count, and the rows of ONE page of ONE tab.
//
// 🔴 WHY (owner, 12 Nov 2026, "slim My Visits"). The page used to ship every row of the 90-day
// window to the browser and page through them there, 25 at a time. For one Medical Rep that was
// 1,049 visits and 599 check-ins: 956 KB of page for 25 rows on screen, and the slowest picture on
// the portal (real users' largest paint about 6.8 s). The server still reads the whole window — the
// tab counts, the duplicate collapse and the field / days-off split all need it — but it now keeps
// only the page being looked at. Moving to another tab or page asks the server again (`?tab=&page=`).
//
// Client-safe and pure: no read, no clock. The page builds it; tests/my-visits-view.test.ts pins it.

import { partitionMyVisitRows } from "@/lib/employee-portal/my-visits-partition";
import { TEAM_VISIT_ROW_CAP } from "@/lib/employee-portal/my-crm-visits-constants";
import type {
  MyCrmCheckinRow,
  MyCrmDoubleVisitRow,
  MyCrmVisitRow,
  TeamCrmVisitRow,
} from "@/lib/employee-portal/my-crm-visits";

/** Rows on one page of any tab. */
export const MY_VISITS_PAGE_SIZE = 25;

export const MY_VISITS_TABS = ["visits", "double", "checkins", "team"] as const;
export type MyVisitsTab = (typeof MY_VISITS_TABS)[number];

export type MyVisitsCounts = { visits: number; double: number; checkins: number; team: number };

type Paging = { page: number; totalPages: number; totalRows: number };

/** The open tab's rows. A visits or team tab also carries its days not in the field, which are not paged. */
export type MyVisitsTabView =
  | ({ tab: "visits"; rows: MyCrmVisitRow[]; offDutyRows: MyCrmVisitRow[] } & Paging)
  | ({ tab: "double"; rows: MyCrmDoubleVisitRow[] } & Paging)
  | ({ tab: "checkins"; rows: MyCrmCheckinRow[] } & Paging)
  | ({ tab: "team"; rows: TeamCrmVisitRow[]; offDutyRows: TeamCrmVisitRow[] } & Paging);

export type MyVisitsView = {
  counts: MyVisitsCounts;
  /** The Team Visits tab exists only for a viewer whose team logged a visit in the window. */
  hasTeam: boolean;
  /** The team feed reached TEAM_VISIT_ROW_CAP, so older team visits are not listed — the tab says so. */
  teamCapped: boolean;
  view: MyVisitsTabView;
};

/** `?tab=`, matched against the tabs this viewer has; anything else opens My visits. */
export function parseMyVisitsTab(value: string | string[] | undefined, hasTeam: boolean): MyVisitsTab {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "team") return hasTeam ? "team" : "visits";
  return (MY_VISITS_TABS as readonly string[]).includes(raw ?? "") ? (raw as MyVisitsTab) : "visits";
}

/** `?page=`, a whole number from 1; anything else is page 1. Clamped to the last page later. */
export function parseMyVisitsPage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const page = Number(raw);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

function pageOf<T>(rows: readonly T[], requested: number): { rows: T[] } & Paging {
  const totalPages = Math.max(1, Math.ceil(rows.length / MY_VISITS_PAGE_SIZE));
  const page = Math.min(Math.max(1, requested), totalPages);
  return {
    page,
    rows: rows.slice((page - 1) * MY_VISITS_PAGE_SIZE, page * MY_VISITS_PAGE_SIZE),
    totalPages,
    totalRows: rows.length,
  };
}

/**
 * Counts from the whole window, rows from one page. The visits and team counts are the field visits
 * only — days not in the field are listed under their own heading and never counted (owner,
 * 2026-09-25), through the one shared partition so the count and the list cannot disagree.
 */
export function buildMyVisitsView(input: {
  visits: readonly MyCrmVisitRow[];
  doubleVisits: readonly MyCrmDoubleVisitRow[];
  checkins: readonly MyCrmCheckinRow[];
  teamVisits: readonly TeamCrmVisitRow[];
  tab: string | string[] | undefined;
  page: string | string[] | undefined;
}): MyVisitsView {
  const visitSplit = partitionMyVisitRows(input.visits);
  const teamSplit = partitionMyVisitRows(input.teamVisits);
  const hasTeam = input.teamVisits.length > 0;
  const tab = parseMyVisitsTab(input.tab, hasTeam);
  const page = parseMyVisitsPage(input.page);

  const counts: MyVisitsCounts = {
    visits: visitSplit.fieldRows.length,
    double: input.doubleVisits.length,
    checkins: input.checkins.length,
    team: teamSplit.fieldRows.length,
  };

  const view: MyVisitsTabView =
    tab === "team"
      ? { tab, ...pageOf(teamSplit.fieldRows, page), offDutyRows: teamSplit.offDutyRows }
      : tab === "double"
        ? { tab, ...pageOf(input.doubleVisits, page) }
        : tab === "checkins"
          ? { tab, ...pageOf(input.checkins, page) }
          : { tab, ...pageOf(visitSplit.fieldRows, page), offDutyRows: visitSplit.offDutyRows };

  return { counts, hasTeam, teamCapped: input.teamVisits.length >= TEAM_VISIT_ROW_CAP, view };
}

/** The address of one tab's page. Page 1 of My visits is the bare page, so the sidebar link stays the one address. */
export function myVisitsHref(basePath: string, tab: MyVisitsTab, page: number): string {
  const params = new URLSearchParams();
  if (tab !== "visits") params.set("tab", tab);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}
