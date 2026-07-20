import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

import { fetchTerritoryAreaPharmacies } from "./pharmacies";
import { resolveTerritoryRootScope } from "./root-scope";
import { buildTerritorySkeleton, deniedSkeleton, loadLineAreas, resolveAuLineCode } from "./skeleton";
import type { TerritoryAreaPayload, TerritoryRootScope, TerritorySkeleton } from "./types";

/** Thrown when a request's resolved territory scope denies it — the API layer maps this to 403. */
export class TerritoryAccessError extends Error {}

// Every role the Territory Drilldown module serves — the phased rollout (Medical Rep, then
// District Manager, then Regional Manager, then National Sales Manager) is complete. Mirrors
// the PORTAL_SOS_ROLES / isPortalSosRole precedent in portal-sos-dashboard.ts: the role gate
// lives with the domain service, not the API route, so the page and every route agree.
export const TERRITORY_DRILLDOWN_ROLES = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
] as const satisfies readonly PhoenixRole[];

const TERRITORY_DRILLDOWN_ROLE_SET = new Set<PhoenixRole>(TERRITORY_DRILLDOWN_ROLES);

export function isTerritoryDrilldownRole(role: PhoenixRole): boolean {
  return TERRITORY_DRILLDOWN_ROLE_SET.has(role);
}

export async function getTerritorySkeleton(ctx: AccessContext): Promise<TerritorySkeleton> {
  const rootScope = await resolveTerritoryRootScope(ctx);
  if (rootScope.level === "denied") {
    return deniedSkeleton(ctx.role, rootScope.diagnostic);
  }
  return buildTerritorySkeleton(ctx.role, rootScope);
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
): Promise<boolean> {
  if (rootScope.level === "area") {
    return rootScope.sosAreaCodes.includes(areaCode);
  }
  const auLineCode = resolveAuLineCode(rootScope.officialLine);
  if (!auLineCode) return false;
  const regionCodes =
    rootScope.level === "region" ? new Set(rootScope.regionCodes.map((code) => code.toUpperCase())) : null;
  const lineAreas = await loadLineAreas(auLineCode, regionCodes);
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
): Promise<TerritoryAreaPayload> {
  const rootScope = await resolveTerritoryRootScope(ctx);
  if (rootScope.level === "denied") {
    throw new TerritoryAccessError(rootScope.diagnostic.message);
  }

  const normalizedAreaCode = areaCode.trim().toUpperCase();
  if (!normalizedAreaCode || !(await isAreaInRootScope(normalizedAreaCode, rootScope))) {
    throw new TerritoryAccessError(`Area "${areaCode}" is outside your territory.`);
  }

  return fetchTerritoryAreaPharmacies(normalizedAreaCode, periods, rootScope.officialLine);
}
