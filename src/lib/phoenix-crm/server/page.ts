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
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { PHOENIX_CRM_PORTAL_BASE, type PhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";
import { loadPhoenixCrmOverview, type PhoenixCrmOverview } from "@/lib/phoenix-crm/server/overview";

// The sidebar half lives in its own module so the portal chrome never compiles the overview loader
// (see sidebar-entries.ts). Re-exported, so every page that already imports it from here is unchanged.
export {
  NO_PHOENIX_CRM_ENTRIES,
  phoenixCrmEntryAvailable,
  phoenixCrmHasSomethingToSay,
  phoenixCrmSidebarEntries,
  type PhoenixCrmSidebarEntries,
} from "@/lib/phoenix-crm/server/sidebar-entries";

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

/** The sentence under the page title, for who is looking. */
export function phoenixCrmPageDescription(overview: PhoenixCrmOverview): string {
  const { viewer } = overview;
  if (viewer.isSuperAdmin) {
    // His test mode is retired (phoenix-crm-app.tsx `standingNote`), so the line no longer offers it.
    return "Read the field force's own entries on any territory, and set the numbers, line openings and Ramadan dates.";
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
