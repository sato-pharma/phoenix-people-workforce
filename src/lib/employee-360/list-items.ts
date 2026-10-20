// Employee 360 — the cards on the index list, built in ONE place for the three lists that show them:
// the admin index, the portal's company-wide browse list and the portal's team picker.
//
// Each card carries `managersAbove` (owner, 2026-10-20 — the Manager filter must offer every manager
// on the chain and keep his whole subtree; see list-manager-filter.ts). It is walked by HR id over the
// WHOLE directory the page loaded, never over the visible cards: a chain that passes through somebody
// the viewer may not open (a manager above his own seat, or the one person removed from Employee 360)
// would otherwise stop there, and a National Sales Manager would again be missing from the filter on
// a district's reps. Only names travel — the cards themselves are still exactly the visible rows.

import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveEmployee360RoleCategory, type Employee360RoleCategory } from "@/lib/employee-360/roles";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { buildManagersAboveByHrId } from "@/lib/org/manager-filter";
import { bridgeEmployeeLineToOfficial } from "@/lib/sales/official-lines";

export type Employee360ListItem = {
  hrId: string;
  displayName: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  managerName: string | null;
  /** The managers above `managerName`, nearest first (the direct manager is not repeated). */
  managersAbove: string[];
  employmentStatus: string | null;
  category: Employee360RoleCategory;
};

/**
 * The cards for `visibleRows` (already scoped by `resolveEmployee360VisibleRows`), sorted by name.
 * `directoryRows` is the directory those rows came from; it is read only for the manager chain.
 */
export function buildEmployee360ListItems(
  visibleRows: readonly EmployeeDirectoryRow[],
  directoryRows: readonly EmployeeDirectoryRow[],
): Employee360ListItem[] {
  const managersAboveByKey = buildManagersAboveByHrId(directoryRows, canonicalHrIdKey);
  return visibleRows
    .map((row) => {
      const category = resolveEmployee360RoleCategory(row.jobTitle ?? row.positionTitle);
      if (!category) return null;
      const key = canonicalHrIdKey(row.hrId);
      return {
        hrId: row.hrId,
        displayName: row.displayName || row.fullName,
        jobTitle: row.jobTitle,
        // Canonical line spelling — collapses the duplicate "Anti Inf" (id=53) / "Anti infective"
        // (id=1) master rows to ONE line in the filter, cards and hero.
        lineName: bridgeEmployeeLineToOfficial(row.lineName),
        areaName: row.areaName,
        regionName: row.regionName,
        managerName: row.managerName,
        managersAbove: (key ? managersAboveByKey.get(key) : undefined) ?? [],
        employmentStatus: row.employmentStatus,
        category,
      } satisfies Employee360ListItem;
    })
    .filter((item): item is Employee360ListItem => item !== null)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}
