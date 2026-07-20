import type { PhoenixRole } from "@/lib/auth/permissions";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";

import type { TerritoryDiagnostic, TerritoryRootScope, TerritorySkeleton } from "./types";

/**
 * Build the Tier-1 geography skeleton (names + codes only, no sales figures) bounded to the
 * viewer's resolved root scope. This is cheap master data — low thousands of rows nationwide,
 * comparable to what every existing Source-of-Sales filter dropdown already loads in one
 * shot — safe to load in full regardless of role. The expensive, scope-varying part is the
 * per-area pharmacy fetch (see pharmacies.ts), deferred until a user expands an Area lane.
 */
export async function buildTerritorySkeleton(
  role: PhoenixRole,
  rootScope: Exclude<TerritoryRootScope, { level: "denied" }>,
): Promise<TerritorySkeleton> {
  const references = await loadSalesReferenceData({ includeCustomerBricks: false });

  // areaCodesInScope: non-null ONLY for the "area" root (a Medical Rep locked to their own
  // area(s), and nothing else in the region — see resolveTerritoryRootScope). It must NOT be
  // widened to "every area in the same region", or a rep's skeleton would name sibling areas
  // (and their blocks/bricks) they have no right to see, even though the per-area fetch would
  // still 403 them — the skeleton itself must already reflect the real boundary.
  let areaCodesInScope: Set<string> | null = null;
  let regionCodesInScope: Set<string> | null = null;
  let rootAreaCodes: string[] | null = null;

  const allAreas = references.areas ?? [];
  const allBlocks = references.blocks ?? [];
  const allBricks = references.bricks ?? [];

  if (rootScope.level === "area") {
    rootAreaCodes = rootScope.sosAreaCodes;
    areaCodesInScope = new Set(rootAreaCodes.map((code) => code.toUpperCase()));
    const areaRows = allAreas.filter((area) => areaCodesInScope!.has(area.areaCode.toUpperCase()));
    // Regions are still shown (as read-only context around the locked area), so region codes
    // stay derived from it — this only widens the REGION list, never the AREA list.
    regionCodesInScope = new Set(areaRows.map((area) => area.regionCode.toUpperCase()));
  } else if (rootScope.level === "region") {
    regionCodesInScope = new Set(rootScope.regionCodes.map((code) => code.toUpperCase()));
  }
  // rootScope.level === "nationwide": both stay null → everything included.

  const regions = references.regions
    .filter((region) => !regionCodesInScope || regionCodesInScope.has(region.regionCode.toUpperCase()))
    .map((region) => ({ regionCode: region.regionCode, regionName: region.regionName }));

  const areas = allAreas
    .filter((area) =>
      areaCodesInScope
        ? areaCodesInScope.has(area.areaCode.toUpperCase())
        : !regionCodesInScope || regionCodesInScope.has(area.regionCode.toUpperCase()),
    )
    .map((area) => ({ areaCode: area.areaCode, areaName: area.areaName, regionCode: area.regionCode }));
  const finalAreaCodesInScope = new Set(areas.map((area) => area.areaCode.toUpperCase()));

  const blocks = allBlocks
    .filter((block) => finalAreaCodesInScope.has(block.areaCode.toUpperCase()))
    .map((block) => ({ blockCode: block.blockCode, blockName: block.blockName, areaCode: block.areaCode }));

  const bricks = allBricks
    .filter((brick) => finalAreaCodesInScope.has(brick.areaCode.toUpperCase()))
    .map((brick) => ({
      brickId: brick.brickId,
      brickName: brick.brickName,
      blockCode: brick.blockCode,
      areaCode: brick.areaCode,
    }));

  return {
    role,
    officialLine: rootScope.officialLine,
    rootLevel: rootScope.level,
    regions,
    areas,
    blocks,
    bricks,
    rootAreaCodes,
    diagnostic: null,
  };
}

export function deniedSkeleton(role: PhoenixRole, diagnostic: TerritoryDiagnostic): TerritorySkeleton {
  return {
    role,
    officialLine: "",
    rootLevel: "area",
    regions: [],
    areas: [],
    blocks: [],
    bricks: [],
    rootAreaCodes: [],
    diagnostic,
  };
}
