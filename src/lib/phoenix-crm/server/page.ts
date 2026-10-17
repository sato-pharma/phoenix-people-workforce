/**
 * Phoenix CRM — what the module's two pages read before the screen draws: the employee portal's
 * (/employee-portals/field-crm) and its admin shell twin (/admin/field-crm).
 *
 * Gate one is the `phoenix_crm` permission; gate two is the viewer's seats in the organogram and the
 * lines open today (access.ts). A refusal either gate writes is a sentence for the person looking, so
 * the page shows it as it is; anything else is a load failure, which the page logs and says is one,
 * never an empty module. Every API route checks both gates again.
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
import { PHOENIX_CRM_PORTAL_BASE, type PhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";
import { loadPhoenixCrmOverview, type PhoenixCrmOverview } from "@/lib/phoenix-crm/server/overview";
import { dmPlansInPhoenixCrm } from "@/lib/phoenix-crm/server/manager-plan-switch";

export const PHOENIX_CRM_PORTAL_PATH = PHOENIX_CRM_PORTAL_BASE;

/**
 * The chooser's module list and the overview's tab flags must name the SAME modules.
 *
 * `modules.ts` writes its union out by hand, because the boundary test keeps the rule modules free of
 * `server/` imports. These two lines are what stops the pair drifting: add a tab to `PhoenixCrmTabs`
 * without giving it a card, or a card without a tab, and this file stops compiling. They cost nothing
 * at runtime — both are types.
 */
type ModuleKeysCoverTabs = PhoenixCrmModuleKey extends keyof PhoenixCrmOverview["tabs"] ? true : never;
type TabsCoverModuleKeys = keyof PhoenixCrmOverview["tabs"] extends PhoenixCrmModuleKey ? true : never;
const MODULES_AND_TABS_AGREE: [ModuleKeysCoverTabs, TabsCoverModuleKeys] = [true, true];
void MODULES_AND_TABS_AGREE;
export const PHOENIX_CRM_ADMIN_PATH = "/admin/field-crm";

export type PhoenixCrmPageLoad =
  | { kind: "ready"; overview: PhoenixCrmOverview }
  /** The viewer cannot open the module; the sentence says why. */
  | { kind: "refused"; message: string }
  | { kind: "failed"; error: unknown };

const NO_PERMISSION = "Phoenix CRM is for the field force, their managers and the SFE team.";

export async function loadPhoenixCrmPage(access: AccessContext): Promise<PhoenixCrmPageLoad> {
  try {
    if (!(await canAccess(access, "phoenix_crm", "read"))) return { kind: "refused", message: NO_PERMISSION };
    const viewer = await resolvePhoenixCrmViewer(access);
    return { kind: "ready", overview: await loadPhoenixCrmOverview(viewer) };
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) return { kind: "refused", message: error.message };
    if (isForbiddenError(error)) return { kind: "refused", message: NO_PERMISSION };
    return { kind: "failed", error };
  }
}

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

/** The sentence under the page title, for who is looking. */
export function phoenixCrmPageDescription(overview: PhoenixCrmOverview): string {
  const { viewer } = overview;
  if (viewer.isSuperAdmin) {
    return "Try the module in test mode on any territory, read the field force's own entries, and set the numbers, line openings and Ramadan dates.";
  }
  if (viewer.isRep && viewer.isManager) {
    return "Your own customer list, weekly plan and visits, and the plans and requests of the territories beneath you.";
  }
  if (viewer.isRep) return "Validate your customers at the clinic, plan your week on their timings, and add each visit on the day.";
  if (viewer.isManager) {
    return "The territories beneath you: their visits, customer lists and weekly plans, and the plans and requests waiting for your decision.";
  }
  return "The field force's visits, customer lists, weekly plans and reports, from what they enter in Phoenix CRM.";
}

/** The page's `?tab=` as typed. The screen keeps it only when the viewer has that tab. */
export function requestedPhoenixCrmTab(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const tab = typeof raw === "string" ? raw.trim() : "";
  return /^[a-z]{1,20}$/.test(tab) ? tab : null;
}

/** "?tab=plan" for a redirect between the two pages; nothing when no tab was asked for. */
export function phoenixCrmTabQuery(tab: string | null): string {
  return tab ? `?tab=${tab}` : "";
}
