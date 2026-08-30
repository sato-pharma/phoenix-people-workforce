import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { foldAreaOptionsForLine, scopeAndFoldAreaChildren } from "@/lib/sales/closing-area-merges";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";

import type { TerritoryDiagnostic, TerritoryRootScope, TerritorySkeleton } from "./types";

export type CanonicalArea = { areaCode: string; areaName: string; regionCode: string };

/**
 * Every canonical area, line-agnostic — used ONLY for the "area" root level (Medical Rep).
 * A rep's own area is already precisely resolved from their employee record (via the
 * sos_area_crosswalk RPC in root-scope.ts), so there is no ambiguity to disambiguate by line
 * here; this is a pure name/region lookup against au_v_canonical_areas, the same table the
 * People Organogram itself reads (au.canonical_areas). A canonical area's name never varies
 * by line, only its region/rep/DM/carries_target do (see loadLineAreas below).
 */
async function loadCanonicalAreas(): Promise<CanonicalArea[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("au_v_canonical_areas")
    .select("area_code,area_name,code_region_code,is_active")
    .eq("is_active", true)
    .order("area_code");
  if (error) throw error;
  return (data ?? [])
    .map((row) => ({
      areaCode: String((row as { area_code?: string | null }).area_code ?? "").trim(),
      areaName: String((row as { area_name?: string | null }).area_name ?? "").trim(),
      regionCode: String((row as { code_region_code?: string | null }).code_region_code ?? "").trim(),
    }))
    .filter((area) => area.areaCode);
}

// Source-of-Sales official line ("Anti Infective") -> People Organogram au.seats line_code
// ("anti_infective"). Only three real product lines currently carry a seat structure (see
// au.lines) — kept as a small explicit map, same precedent as monthly-targets.ts's
// LINE_TO_NORMALIZED_LINE, rather than an extra round-trip query for 3 stable values.
const AU_LINE_CODE_BY_OFFICIAL_LINE: Record<string, string> = {
  "anti infective": "anti_infective",
  cns: "cns",
  pedia: "pedia",
};

export function resolveAuLineCode(officialLine: string): string | null {
  return AU_LINE_CODE_BY_OFFICIAL_LINE[officialLine.trim().toLowerCase()] ?? null;
}

/**
 * au.regions' code -> name map, via its public wrapper au_v_regions — the SAME organogram
 * source area names already come from. Needed because au's operational_region_code vocabulary
 * is sometimes MORE granular than source_of_sales_regions: e.g. Anti Infective operationally
 * splits Upper Egypt into "UE-1"/"UE-2" DM territories (au_v_line_area_map reflects that split),
 * while source_of_sales_regions has only one plain "UE" row — so a region-name lookup against
 * the Source-of-Sales table would silently have no name (and therefore no visible region card)
 * for those areas, even though their sales data is real and reachable.
 */
async function loadAuRegionNames(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("au_v_regions")
    .select("region_code,region_name,is_active")
    .eq("is_active", true);
  if (error) throw error;
  const names = new Map<string, string>();
  for (const row of data ?? []) {
    const code = String((row as { region_code?: string | null }).region_code ?? "").trim();
    const name = String((row as { region_name?: string | null }).region_name ?? "").trim();
    if (code) names.set(code.toUpperCase(), name || code);
  }
  return names;
}

/**
 * Areas that structurally belong to ONE line's own People Organogram seat tree — optionally
 * narrowed to a set of regions — via au_v_line_area_map (the same seat structure
 * loadTargetableAreas already reads in monthly-targets.ts). `carries_target = true` selects
 * exactly the areas in "occupied" or "vacant_will_hire" state for this line, excluding
 * "other_line_specific"/"other_permanent" rows — i.e. areas that are structurally a SIBLING
 * line's territory in the same geography.
 *
 * This is what makes a District Manager's (and later Regional/National Sales Manager's) area
 * list match their organogram subtree exactly, instead of "every area in the region": a
 * region routinely has a SEPARATE District Manager seat per line (Delta (1) has one DM for
 * Anti Infective, a different DM for CNS, a different one for Pedia, each covering a
 * different subset of that region's areas) — showing every area in the region would leak
 * areas that belong to a sibling line's DM, not this viewer's own seat.
 */
export async function loadLineAreas(auLineCode: string, regionCodes: Set<string> | null): Promise<CanonicalArea[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("au_v_line_area_map")
    .select("area_code,area_name,operational_region_code,carries_target")
    .eq("line_code", auLineCode)
    .eq("carries_target", true);
  if (regionCodes && regionCodes.size > 0) {
    query = query.in("operational_region_code", [...regionCodes]);
  }
  const { data, error } = await query.order("area_code");
  if (error) throw error;
  return (data ?? [])
    .map((row) => ({
      areaCode: String((row as { area_code?: string | null }).area_code ?? "").trim(),
      areaName: String((row as { area_name?: string | null }).area_name ?? "").trim(),
      regionCode: String((row as { operational_region_code?: string | null }).operational_region_code ?? "").trim(),
    }))
    .filter((area) => area.areaCode);
}

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
  // For "region", the region set is already known before the area fetch (it bounds the
  // au_v_line_area_map query itself). For "area" it's derived afterward from the resolved
  // area(s); for "nationwide" it stays null throughout (no region restriction).
  let regionCodesInScope: Set<string> | null =
    rootScope.level === "region" ? new Set(rootScope.regionCodes.map((code) => code.toUpperCase())) : null;
  const auLineCode = resolveAuLineCode(rootScope.officialLine);

  const [references, allAreas, auRegionNames] = await Promise.all([
    loadSalesReferenceData({ includeCustomerBricks: false }),
    rootScope.level === "area"
      ? loadCanonicalAreas()
      : auLineCode
        ? loadLineAreas(auLineCode, regionCodesInScope)
        // officialLine didn't map to a known organogram line_code (shouldn't happen — every
        // resolved rootScope carries a real product line by construction) — fail closed to an
        // empty area list rather than falling back to an unfiltered/wrong-line listing.
        : Promise.resolve([] as CanonicalArea[]),
    loadAuRegionNames(),
  ]);

  // areaCodesInScope: non-null ONLY for the "area" root (a Medical Rep locked to their own
  // area(s), and nothing else in the region — see resolveTerritoryRootScope). It must NOT be
  // widened to "every area in the same region", or a rep's skeleton would name sibling areas
  // (and their blocks/bricks) they have no right to see, even though the per-area fetch would
  // still 403 them — the skeleton itself must already reflect the real boundary.
  let areaCodesInScope: Set<string> | null = null;
  let rootAreaCodes: string[] | null = null;

  const allBlocks = references.blocks ?? [];
  const allBricks = references.bricks ?? [];

  if (rootScope.level === "area") {
    rootAreaCodes = rootScope.sosAreaCodes;
    areaCodesInScope = new Set(rootAreaCodes.map((code) => code.toUpperCase()));
    const areaRows = allAreas.filter((area) => areaCodesInScope!.has(area.areaCode.toUpperCase()));
    // Regions are still shown (as read-only context around the locked area), so region codes
    // stay derived from it — this only widens the REGION list, never the AREA list.
    regionCodesInScope = new Set(areaRows.map((area) => area.regionCode.toUpperCase()));
  }
  // rootScope.level === "region": regionCodesInScope was already set above the parallel fetch.
  // rootScope.level === "nationwide": stays null → loadLineAreas above ran with no region
  // restriction, so allAreas already covers every region the viewer's line has any presence in.

  const scopedAreas = allAreas
    .filter((area) =>
      areaCodesInScope
        ? areaCodesInScope.has(area.areaCode.toUpperCase())
        // "region"/"nationwide": allAreas is already line(+region)-scoped by loadLineAreas
        // above — this is a defense-in-depth re-check, not the primary filter.
        : !regionCodesInScope || regionCodesInScope.has(area.regionCode.toUpperCase()),
    )
    .map((area) => ({ areaCode: area.areaCode, areaName: area.areaName, regionCode: area.regionCode }));
  // Fold this line's merged areas into ONE option: Pedia shows Fayoum (GZ6) + Beni Suef (UE9) as a
  // single "Fayoum - Beni Suef" area (owner rule 2026-08-30). The folded-away code's blocks/bricks
  // are re-keyed onto the survivor below (scopeAndFoldAreaChildren), and the per-area pharmacy fetch
  // expands it back to both real codes (see pharmacies.ts), so nothing Beni Suef sold is lost. Anti
  // Infective and CNS have no rule, so foldAreaOptionsForLine returns their areas unchanged.
  const areas = foldAreaOptionsForLine(auLineCode, scopedAreas);

  // Scope blocks/bricks by the viewer's REAL (pre-fold) area codes, NOT the post-fold option codes:
  // the folded-away partner (UE9) re-keys to the survivor (GZ6) for display, and GZ6's own bricks are
  // already GZ6, so filtering on the folded code would leak Fayoum's bricks to a viewer scoped only
  // to Beni Suef. scopeAndFoldAreaChildren filters on the real code first, then re-keys for display.
  // No live viewer is scoped to one code without the other today (both share a Pedia seat) — this
  // only hardens the latent case.
  const realAreaCodesInScope = scopedAreas.map((area) => area.areaCode);

  // Regions shown = exactly the regions actually represented in `areas` above, named via the
  // organogram (au_v_regions) rather than source_of_sales_regions — never an empty region card
  // for a region where the viewer's line structurally has zero areas (confirmed to happen for
  // real: Anti Infective has 0 active areas in "Others" nationwide), and never a real region of
  // areas with no name to show (also confirmed for real: Anti Infective's "UE-1"/"UE-2" Upper
  // Egypt split exists only in au.regions, not in source_of_sales_regions). Deriving the region
  // list from the final area list, rather than independently from a region master table, means
  // it's automatically correct for every root level without special-casing any of them.
  const regionCodesWithAreas = new Set(areas.map((area) => area.regionCode.toUpperCase()));
  const regions = [...regionCodesWithAreas]
    .map((regionCode) => ({ regionCode, regionName: auRegionNames.get(regionCode) ?? regionCode }))
    .sort((a, b) => a.regionName.localeCompare(b.regionName));

  const blocks = scopeAndFoldAreaChildren(auLineCode, realAreaCodesInScope, allBlocks)
    .map((block) => ({ blockCode: block.blockCode, blockName: block.blockName, areaCode: block.areaCode }));

  const bricks = scopeAndFoldAreaChildren(auLineCode, realAreaCodesInScope, allBricks)
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
