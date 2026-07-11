import { getNavigationSections } from "@/config/system-navigation";

let cachedModuleIdsByHref: Record<string, string[]> | null = null;

function employeePortalModuleIdsByHref(): Record<string, string[]> {
  if (!cachedModuleIdsByHref) {
    const map: Record<string, string[]> = {};
    for (const section of getNavigationSections("employee-portal")) {
      for (const item of section.items) {
        (map[item.href] ??= []).push(item.moduleId);
      }
    }
    cachedModuleIdsByHref = map;
  }
  return cachedModuleIdsByHref;
}

/**
 * Whether an employee-portal nav destination should render under the given
 * Modules Control curation (see getEffectiveSidebarModuleIds).
 *
 * `effectiveModuleIds === null` means no override is configured for this person —
 * every destination stays visible, matching pre-curation behavior exactly.
 *
 * When an override IS configured, an href is matched against every catalog module
 * that shares it (a handful of hrefs — e.g. /employee-portals/coaching, /employee-
 * portals/report-it — carry two role-variant labels for the same route) and is
 * visible if ANY of those candidate moduleIds is in the effective set. Only the
 * role-appropriate variant can ever appear there: getEffectiveSidebarModuleIds
 * already drops moduleIds that fail validateModuleForPerson (wrong role) before
 * returning, so this never shows the wrong role's variant.
 *
 * An href with no catalog entry at all (several legacy portal tabs were never
 * added to the Modules Control catalog) is left always-visible: curation can't
 * target what an admin was never offered a way to select.
 */
export function isEmployeePortalHrefCurated(
  href: string,
  effectiveModuleIds: readonly string[] | null,
): boolean {
  if (effectiveModuleIds === null) return true;
  const candidates = employeePortalModuleIdsByHref()[href];
  if (!candidates || candidates.length === 0) return true;
  return candidates.some((moduleId) => effectiveModuleIds.includes(moduleId));
}
