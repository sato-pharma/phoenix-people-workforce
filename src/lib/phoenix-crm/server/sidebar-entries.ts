/**
 * Phoenix CRM — which of its rows the portal sidebar offers, and whether the module has anything to say
 * to a person at all.
 *
 * 🔴 ITS OWN MODULE, AND IT MUST NOT IMPORT THE OVERVIEW LOADER. The sidebar is drawn on EVERY portal
 * page (employee-portal-server-shell.tsx, the navigation route, profile, payslips), so whatever this file
 * imports is compiled into all of them. These functions lived in page.ts until 2026-10-17, beside
 * `loadPhoenixCrmPage`, whose `loadPhoenixCrmOverview` drags in visit-asks, the insight reports and the
 * list — 227 files the sidebar never calls, measured in the import graph — and the portal layout reached
 * 728 files because of it. page.ts re-exports everything here, so the module's own pages are unchanged.
 */

import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { isForbiddenError } from "@/lib/auth/server";
import { ApiError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { forecastIsOffered } from "@/lib/phoenix-crm/daily-forecast";
import {
  doubleVisitReportAudience,
  readsFieldHeardByProduct,
  readsTeamPlaceChecks,
  resolvePhoenixCrmViewer,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { dmPlansInPhoenixCrm } from "@/lib/phoenix-crm/server/manager-plan-switch";

/**
 * Has the module anything to say to this person — a territory to work, or a date to wait for?
 *
 * 🔴 THE SECOND HALF IS THE FIX, AND IT COST A REAL HOUR. Until 2026-09-26 the door opened only on
 * something OPEN, and `scopeTerritories` is already filtered to open lines — so a District Manager
 * whose whole district sits on a line that has not opened got no sidebar row, no page, and not one
 * word anywhere saying why. He is indistinguishable from a stranger with no seat at all. The owner
 * hit it on a CNS manager's account and could only ask what was broken; nothing was.
 *
 * Golden Rule #1 permits this sentence: it is about his ACCESS, never his conduct. The wording comes
 * from `lineOpeningText` — a line and a date, nothing else.
 *
 * A person with NO seat anywhere still gets nothing, which is right: a closed line must not open the
 * door for someone the organogram does not place in the field at all. The one exception is a role the
 * owner gave a report of its own: the product and marketing managers read what the field heard about
 * their own products (owner, 2026-10-02), so the module has that one report to say to them.
 */
export function phoenixCrmHasSomethingToSay(viewer: PhoenixCrmViewer): boolean {
  return (
    viewer.isSuperAdmin ||
    viewer.ownTerritories.length > 0 ||
    viewer.scopeTerritories.length > 0 ||
    viewer.waitingTerritories.length > 0 ||
    viewer.waitingScopeTerritories.length > 0 ||
    readsFieldHeardByProduct(viewer)
  );
}

/**
 * What the portal sidebar offers of Phoenix CRM: the module's own row (`crm`), the "Daily Forecast"
 * row under Forecast & Target (`forecast`, owner, 2026-10-01: "put it under forecast in sidebar"), and
 * the district manager's own "Place checks" row beside the module (`placeChecks`, owner, 2026-10-13:
 * "in every district manager account, build a tab in his sidebar"). ONE viewer lookup answers all
 * three, because the sidebar is drawn on every portal page.
 */
export type PhoenixCrmSidebarEntries = {
  crm: boolean;
  forecast: boolean;
  placeChecks: boolean;
  doubleVisitRequests: boolean;
  /** He plans his week in Phoenix CRM now, so the legacy Weekly / Monthly Plan row goes (2026-10-16). */
  managerPlans: boolean;
};

/** No row at all — what a failed, refused or seatless lookup answers. */
export const NO_PHOENIX_CRM_ENTRIES: PhoenixCrmSidebarEntries = {
  crm: false,
  forecast: false,
  placeChecks: false,
  doubleVisitRequests: false,
  managerPlans: false,
};

/**
 * Whether My Visits and the portal sidebar show the Phoenix CRM row: to a holder of `phoenix_crm`
 * read whom the module has something to say to — see `phoenixCrmHasSomethingToSay`. And whether the
 * sidebar shows the Daily Forecast row: to that same person when the forecast is offered to him
 * (`forecastIsOffered`, the very function that offers the tab), so the row can never open onto a
 * refusal. And whether the sidebar shows Place checks: to a district manager or acting district
 * manager (`readsTeamPlaceChecks`, the very predicate that gates the page), so that row cannot open
 * onto a refusal either. It never throws: the sidebar renders whatever happens here, and a failure is
 * logged rather than shown as a missing row nobody can explain.
 *
 * 🔴 NO ROLE LIST HERE, FOR THE THIRD ROW EITHER. The flag is the page's own gate, asked of the same
 * viewer — a second list of roles in `src/lib/employee-portal/navigation.ts` would drift from it the
 * first time a seat tier moves, and the sidebar would then offer a tab that redirects.
 */
export async function phoenixCrmSidebarEntries(access: AccessContext): Promise<PhoenixCrmSidebarEntries> {
  try {
    if (!(await canAccess(access, "phoenix_crm", "read"))) return NO_PHOENIX_CRM_ENTRIES;
    const viewer = await resolvePhoenixCrmViewer(access);
    const crm = phoenixCrmHasSomethingToSay(viewer);
    return {
      crm,
      forecast: crm && forecastIsOffered(viewer),
      placeChecks: readsTeamPlaceChecks(viewer),
      // The Double visit requests report (owner, 2026-10-16) — every manager up to the CEO and the product
      // managers a rep can ask. The page's own predicate, so the row cannot open onto a redirect.
      doubleVisitRequests: doubleVisitReportAudience(viewer) !== null,
      // A district manager whose team is live plans his week in Phoenix CRM (owner, 2026-10-16) — the
      // legacy form's own refusal asks the same function, so the row and the form cannot disagree.
      managerPlans: crm && (await dmPlansInPhoenixCrm(viewer.hrId, { org: viewer.org, cairoToday: viewer.cairoToday }).catch(() => false)),
    };
  } catch (error) {
    if ((error instanceof ApiError && error.status < 500) || isForbiddenError(error)) return NO_PHOENIX_CRM_ENTRIES;
    logError("Phoenix CRM entry check failed", {
      error,
      labels: { event: "phoenix_crm_entry_check_failed", route: "/employee-portals/visits" },
    });
    return NO_PHOENIX_CRM_ENTRIES;
  }
}

/** The Phoenix CRM row alone — what the My Visits button asks. */
export async function phoenixCrmEntryAvailable(access: AccessContext): Promise<boolean> {
  return (await phoenixCrmSidebarEntries(access)).crm;
}
