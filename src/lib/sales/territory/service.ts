import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

import { fetchTerritoryAreaPharmacies } from "./pharmacies";
import { resolveTerritoryRootScope } from "./root-scope";
import {
  buildTerritorySkeleton,
  deniedSkeleton,
  loadLineAreas,
  resolveAuLineCode,
  territoryAsOfDate,
} from "./skeleton";
import type { TerritoryAreaPayload, TerritoryRootScope, TerritorySkeleton } from "./types";

export { isTerritoryLinePickerRole, TERRITORY_LINE_PICKER_ROLES } from "./root-scope";
export { TERRITORY_PICKER_LINES } from "./skeleton";

/** Thrown when a request's resolved territory scope denies it — the API layer maps this to 403. */
export class TerritoryAccessError extends Error {}

// Every role the Territory Drilldown module serves. Medical Rep / District Manager / Regional
// Manager / National Sales Manager each drill their OWN single line's seat tree; Super Admin and
// CEO see every line, so they pick one and drill it nationwide (see TERRITORY_LINE_PICKER_ROLES in
// root-scope.ts). Mirrors the PORTAL_SOS_ROLES / isPortalSosRole precedent in
// portal-sos-dashboard.ts: the role gate lives with the domain service, not the API route, so the
// page and every route agree.
export const TERRITORY_DRILLDOWN_ROLES = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Super Admin",
  "CEO",
] as const satisfies readonly PhoenixRole[];

const TERRITORY_DRILLDOWN_ROLE_SET = new Set<PhoenixRole>(TERRITORY_DRILLDOWN_ROLES);

export function isTerritoryDrilldownRole(role: PhoenixRole): boolean {
  return TERRITORY_DRILLDOWN_ROLE_SET.has(role);
}

/** The current month (UTC), matching the trailing window the area route builds. The skeleton's
 *  area list is resolved as of this month's end, so a forward-dated territory move is not shown
 *  before it takes effect (finding 5). */
function currentWindowPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The window a per-area fetch was asked for ends at its newest period (lastNPeriods pushes
 *  oldest-first); with no periods, fall back to the current month. */
function windowEndPeriod(periods: string[]): string {
  return periods.length > 0 ? periods[periods.length - 1] : currentWindowPeriod();
}

export async function getTerritorySkeleton(
  ctx: AccessContext,
  selectedLine?: string | null,
): Promise<TerritorySkeleton> {
  const rootScope = await resolveTerritoryRootScope(ctx, selectedLine);
  if (rootScope.level === "denied") {
    return deniedSkeleton(ctx.role, rootScope.diagnostic);
  }
  return buildTerritorySkeleton(ctx.role, rootScope, territoryAsOfDate(currentWindowPeriod()));
}

/**
 * Whether `areaCode` is actually inside the caller's resolved scope. For "region" (District
 * Manager today) and "nationwide" (future National Sales Manager) this MUST check the same
 * line-scoped organogram seat structure buildTerritorySkeleton uses to list areas — not just
 * region membership — or a viewer could fetch a sibling line's area (e.g. a region's Anti
 * Infective DM requesting a CNS-only area) even though it never appears in their own tree. A
 * region routinely hosts a separate DM seat per line, each covering a different subset of
 * that region's areas (see loadLineAreas), so "same region" alone is not "in my territory".
 */
async function isAreaInRootScope(
  areaCode: string,
  rootScope: Exclude<TerritoryRootScope, { level: "denied" }>,
  asOf: string,
): Promise<boolean> {
  if (rootScope.level === "area") {
    return rootScope.sosAreaCodes.includes(areaCode);
  }
  const auLineCode = resolveAuLineCode(rootScope.officialLine);
  if (!auLineCode) return false;
  const regionCodes =
    rootScope.level === "region" ? new Set(rootScope.regionCodes.map((code) => code.toUpperCase())) : null;
  // As of the SAME window end the fetch is for, so an area's membership matches the list the
  // skeleton showed — validating against today's geography would 403 an area a forward-dated move
  // has not yet reached, or admit one it already left.
  const lineAreas = await loadLineAreas(auLineCode, regionCodes, asOf);
  return lineAreas.some((area) => area.areaCode.toUpperCase() === areaCode);
}

/**
 * The lazy per-area pharmacy fetch. Re-derives resolveTerritoryRootScope on EVERY call and
 * checks the requested area against it — the server boundary is authoritative on every
 * request, not just at page load, so a client asking for an out-of-scope area gets denied
 * here regardless of what the (already-scoped) skeleton it was given shows.
 */
export async function getTerritoryAreaPharmacies(
  ctx: AccessContext,
  areaCode: string,
  periods: string[],
  selectedLine?: string | null,
): Promise<TerritoryAreaPayload> {
  const rootScope = await resolveTerritoryRootScope(ctx, selectedLine);
  if (rootScope.level === "denied") {
    throw new TerritoryAccessError(rootScope.diagnostic.message);
  }

  const asOf = territoryAsOfDate(windowEndPeriod(periods));
  const normalizedAreaCode = areaCode.trim().toUpperCase();
  if (!normalizedAreaCode || !(await isAreaInRootScope(normalizedAreaCode, rootScope, asOf))) {
    throw new TerritoryAccessError(`Area "${areaCode}" is outside your territory.`);
  }

  return fetchTerritoryAreaPharmacies(normalizedAreaCode, periods, rootScope.officialLine);
}
