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
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPhoenixCrmOverview, type PhoenixCrmOverview } from "@/lib/phoenix-crm/server/overview";

export const PHOENIX_CRM_PORTAL_PATH = "/employee-portals/field-crm";
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
 * Whether My Visits shows the Phoenix CRM button: to a holder of `phoenix_crm` read with something
 * open in the module today — a territory of their own, or territories beneath them, in a line that has
 * opened. Before a line opens, its reps and managers get no button, so nobody is sent to a page that
 * only says it is not open yet. It never throws: My Visits renders whatever happens here, and a
 * failure is logged rather than shown as a missing button nobody can explain.
 */
export async function phoenixCrmEntryAvailable(access: AccessContext): Promise<boolean> {
  try {
    if (!(await canAccess(access, "phoenix_crm", "read"))) return false;
    const viewer = await resolvePhoenixCrmViewer(access);
    return viewer.isSuperAdmin || viewer.ownTerritories.length > 0 || viewer.scopeTerritories.length > 0;
  } catch (error) {
    if ((error instanceof ApiError && error.status < 500) || isForbiddenError(error)) return false;
    logError("Phoenix CRM entry check failed", {
      error,
      labels: { event: "phoenix_crm_entry_check_failed", route: "/employee-portals/visits" },
    });
    return false;
  }
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
