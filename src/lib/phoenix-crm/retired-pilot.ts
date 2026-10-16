/**
 * The retired 2026-09-14 Phoenix CRM pilot (the owner, 2026-09-25). Its two addresses,
 * /employee-portals/phoenix-crm and /admin/phoenix-crm, now forward to the live field app, and this is
 * the one place that says which field-app tab does the work each pilot tab did.
 *
 * Its Pilot reps roster has no counterpart, so that tab, like any other, opens on the viewer's
 * default tab. Pure, so a test can call it.
 */

import { isPhoenixCrmModuleKey, PHOENIX_CRM_PORTAL_BASE, phoenixCrmModulePath } from "@/lib/phoenix-crm/modules";

export const RETIRED_PILOT_TAB_TARGETS: ReadonlyMap<string, string> = new Map([
  ["visits", "visits"],
  ["planning", "plan"],
  ["kpis", "reports"],
]);

function firstValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

/** The pilot's own `?tab=` carried across the admin-to-portal hop, unmapped; nothing when it is not a tab name. */
export function retiredPilotTabPassThrough(value: string | string[] | undefined): string {
  const tab = firstValue(value);
  return /^[a-z-]{1,20}$/.test(tab) ? `?tab=${tab}` : "";
}

/** "?tab=plan" for a pilot address that asked for `?tab=planning`; nothing for any other tab. */
export function retiredPilotTabQuery(value: string | string[] | undefined): string {
  const target = RETIRED_PILOT_TAB_TARGETS.get(firstValue(value));
  return target ? `?tab=${target}` : "";
}

/**
 * Where the portal pilot address lands, in ONE hop: a mapped tab opens its module's own page, anything
 * else the chooser. Going by `/field-crm?tab=` cost a second redirect — and a second whole portal
 * render — before the page (Phoenix CRM performance audit, 2026-10-16). The module page sends an
 * admin-shell viewer on to his own twin exactly as the chooser did.
 */
export function retiredPilotPortalTarget(value: string | string[] | undefined): string {
  const target = RETIRED_PILOT_TAB_TARGETS.get(firstValue(value));
  return isPhoenixCrmModuleKey(target) ? phoenixCrmModulePath(PHOENIX_CRM_PORTAL_BASE, target) : PHOENIX_CRM_PORTAL_BASE;
}
