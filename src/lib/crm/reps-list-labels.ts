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
