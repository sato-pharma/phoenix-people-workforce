import { hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import type { ManagerLane, OrganogramRow } from "@/lib/reports/organogram-view-model";

/**
 * The org chart's "Hide vacant and resigned" switch (owner, 2026-10-29). It hides BOXES only:
 * the KPI cards, seat counts, lane chips and the export keep reading every row, so no number
 * moves when it is on. A resigned person's seat already reaches the chart as a vacancy row
 * (the directory feeding it is active-only); the departed check is the belt to that.
 */
export function isHiddenOrganogramRow(row: OrganogramRow): boolean {
  return (
    row.type === "vacancy" || hasDepartedEmployment(row.employmentStatus) || hasDepartedEmployment(row.status)
  );
}

export function visibleLaneMembers(members: OrganogramRow[], hide: boolean): OrganogramRow[] {
  return hide ? members.filter((member) => !isHiddenOrganogramRow(member)) : members;
}

/** A lane disappears only when its header seat AND every member under it are hidden. */
export function isLaneHidden(group: ManagerLane, hide: boolean): boolean {
  if (!hide) return false;
  const headerHidden = !group.dsm || isHiddenOrganogramRow(group.dsm);
  return headerHidden && visibleLaneMembers(group.members, true).length === 0;
}
