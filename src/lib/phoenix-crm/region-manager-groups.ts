import type { OrgSeat } from "@/lib/phoenix-crm/scope";

/**
 * Every screen built for the Regional Sales Manager groups the reps by their REGION and their DISTRICT MANAGER
 * (owner, 2026-11-09: "in every screen u build for Hany group reps by their manager and region"). Each group's
 * heading names both — "Delta (2) · Sahar El Gallad" — and the groups run in region order.
 *
 * The region is the organogram's (`au_v_org_tree.region_name`: Alex-BHR, Delta (1), Delta (2)), read off the
 * district manager's seat, or off the rep's own seat when no district manager sits above him. Two reps with no
 * district manager in DIFFERENT regions are two groups, never one "No district manager" heap.
 *
 * Pure, so the rule is pinned without a database.
 */

export const NO_REGION = "No region";

/** The organogram region a seat sits in; never guessed from the seat's label. */
export function seatRegionName(seat: Pick<OrgSeat, "regionName"> | null | undefined): string | null {
  const name = seat?.regionName?.trim();
  return name ? name : null;
}

export type RegionManagerGroup<T> = {
  /** Stable key: the region and the district manager's seat. */
  key: string;
  regionName: string;
  /** The district manager's seat; null when no district manager sits above these reps. */
  district: OrgSeat | null;
  items: T[];
};

/**
 * Groups items (one per rep seat) by region, then by district-manager seat. The region comes from the district
 * seat first and the rep's seat second. Sorted by region name, then by the district seat id, so the order is the
 * organogram's and never the order the reads came back in.
 */
export function groupByRegionAndManager<T>(
  items: readonly T[],
  seatOf: (item: T) => OrgSeat,
  districtOf: (seat: OrgSeat) => OrgSeat | null,
): Array<RegionManagerGroup<T>> {
  const groups = new Map<string, RegionManagerGroup<T>>();
  for (const item of items) {
    const seat = seatOf(item);
    const district = districtOf(seat);
    const regionName = seatRegionName(district) ?? seatRegionName(seat) ?? NO_REGION;
    const key = `${regionName}|${district?.seatId ?? ""}`;
    const group = groups.get(key) ?? { district, items: [], key, regionName };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      Number(left.regionName === NO_REGION) - Number(right.regionName === NO_REGION) ||
      left.regionName.localeCompare(right.regionName) ||
      (left.district?.seatId ?? "~").localeCompare(right.district?.seatId ?? "~"),
  );
}

/** The heading every group wears: "Delta (2) · Sahar El Gallad". */
export function regionManagerTitle(regionName: string, managerName: string): string {
  return `${regionName} · ${managerName}`;
}

/** The line under it: how many reps, and how many of the region's rep seats stand empty. */
export function regionGroupCaption(reps: number, vacant: number): string {
  const filled = reps - vacant;
  const repsText = `${filled} ${filled === 1 ? "rep" : "reps"}`;
  return vacant > 0 ? `Region and district manager · ${repsText} · ${vacant} vacant ${vacant === 1 ? "seat" : "seats"}` : `Region and district manager · ${repsText}`;
}
