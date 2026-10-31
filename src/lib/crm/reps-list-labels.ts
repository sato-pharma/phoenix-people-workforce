/**
 * The Reps List's words for a doctor with no brick. Pure and client-safe, so the server list
 * (`reps-list.ts`) and the board (`components/crm/reps-list-tables.tsx`) say the same thing.
 */

/**
 * The heading of a contact Phoenix knows no place, locality or region for — Phoenix CRM's own words
 * (`phoenix-crm/customer-list-grouping.ts`). It replaced "No CRM region recorded" on 2026-10-31: a
 * doctor added in Phoenix CRM never had an iReports360 region, so the old words blamed the wrong system.
 */
export const REPS_LIST_NO_LOCATION = "No location yet";

/**
 * What a Brick cell, filter option or export says for a group with no brick: the locality with the
 * flag beside it, or "No location yet" alone — there is no locality to flag.
 */
export function unmappedBrickLabel(heading: string, flag = "— no brick yet"): string {
  return heading === REPS_LIST_NO_LOCATION ? heading : `${heading} ${flag}`;
}

/** The least a group needs for the two count lines below. */
type SpreadGroup = { heading: string; mapped: boolean };

const isNowhere = (group: SpreadGroup): boolean => !group.mapped && group.heading === REPS_LIST_NO_LOCATION;

/**
 * The tab's summary line: "{held} across 6 bricks", "… and 2 localities awaiting one", plus
 * "· 2 with no location yet". `count` is the group's rows IN THIS TAB.
 *
 * "No location yet" is neither a brick nor a locality awaiting one — there is no locality at all — so
 * it is counted in rows on its own clause (owner, 2026-10-31). Counted as a locality it read
 * "2 pharmacies across 1 locality awaiting a brick" on a rep whose two pharmacies have no location.
 */
export function brickSpreadLine(held: string, groups: readonly (SpreadGroup & { count: number })[]): string {
  const brickCount = groups.filter((group) => group.mapped).length;
  const localityCount = groups.filter((group) => !group.mapped && !isNowhere(group)).length;
  const nowhereRows = groups.filter(isNowhere).reduce((total, group) => total + group.count, 0);
  const bricks = `${brickCount} ${brickCount === 1 ? "brick" : "bricks"}`;
  const localities = `${localityCount} ${localityCount === 1 ? "locality" : "localities"}`;
  const placed =
    localityCount === 0
      ? brickCount === 0
        ? null
        : bricks
      : brickCount === 0
        ? `${localities} awaiting a brick`
        : `${bricks} and ${localities} awaiting one`;
  if (!placed) return `${held}, no location yet`;
  return nowhereRows > 0 ? `${held} across ${placed} · ${nowhereRows} with no location yet` : `${held} across ${placed}`;
}

/**
 * The "Awaiting a brick" tile's sub-line on the board, by the same rule: localities not yet mapped,
 * and the rows with no location at all stated apart.
 */
export function awaitingBrickSub(list: {
  groups: readonly (SpreadGroup & { rows: readonly unknown[] })[];
  unmappedRegionCount: number;
}): string {
  const nowhere = list.groups.find(isNowhere);
  const localityGap = list.unmappedRegionCount - (nowhere ? 1 : 0);
  return [
    localityGap > 0 ? `${localityGap} ${localityGap === 1 ? "locality" : "localities"} not yet mapped` : null,
    nowhere ? `${nowhere.rows.length} with no location yet` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
