import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { foldAreaOptionsForLine, scopeAndFoldAreaChildren } from "@/lib/sales/closing-area-merges";
import { closingRegionsAsOfDate } from "@/lib/sales/closing-organogram-regions";
import { loadSalesNameMastersOncePerRender } from "@/lib/sales/medical-rep-area-scope";

import type { TerritoryDiagnostic, TerritoryRootScope, TerritorySkeleton } from "./types";

export type CanonicalArea = { areaCode: string; areaName: string; regionCode: string };

/**
 * Every canonical area, line-agnostic — the NAME/MEMBERSHIP base for the "area" root level
 * (Medical Rep). A rep's own area is already precisely resolved from their employee record (via the
 * sos_area_crosswalk RPC in root-scope.ts), so there is no ambiguity to disambiguate by line here;
 * this is a name lookup against au_v_canonical_areas, the same table the People Organogram itself
 * reads (au.canonical_areas). A canonical area's NAME never varies by line — but its REGION does
 * (Qalubeya is Delta (1) here yet Delta (3) on Anti Infective; Beni Suef is Giza here yet Upper
 * Egypt on Pedia), so the region this returns is corrected per line by applyLineRegionOverride
 * before it reaches the rep card. See loadLineAreas below for the per-line authority.
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

// The three product lines that carry a People Organogram seat tree (au.lines) — exactly the keys of
// AU_LINE_CODE_BY_OFFICIAL_LINE, in canonical Source-of-Sales casing. A nationwide viewer with no
// single line of their own (Super Admin / CEO, who see every line) drills ONE of these at a time,
// because the whole skeleton is built from a single line's seat areas (see loadLineAreas). Head
// Office is absent by design — it carries no seat structure and no tracked sales.
export const TERRITORY_PICKER_LINES = ["Anti Infective", "CNS", "Pedia"] as const;

/**
 * The date the drilldown resolves an area's organogram geography at: the LAST DAY of the window-end
 * month, via the SAME period→date rule the monthly closing uses (closingRegionsAsOfDate). The
 * trailing window shown always ends at the current month, so this is the last day of the current
 * month. Reading the window end — not "today" — is what keeps a forward-dated territory move (one
 * written as a pair effective the 1st of a FUTURE month) out of a window that ends before it takes
 * effect, exactly as f_line_area_map_asof(period_end) does for the closing and achievement numbers.
 */
export function territoryAsOfDate(windowEndPeriod: string): string {
  return closingRegionsAsOfDate(windowEndPeriod);
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

/** One raw au_v_line_area_map_all row — the effective-dated seat history, one row per
 *  (line, area) period. `effective_to` is NULL on the currently-open row. */
export type LineAreaMapRow = {
  area_code?: string | null;
  area_name?: string | null;
  operational_region_code?: string | null;
  carries_target?: boolean | null;
  effective_from?: string | null;
  effective_to?: string | null;
};

/**
 * Pure as-of winner selection over au_v_line_area_map_all rows. Per area, pick the row whose
 * [effective_from, effective_to) window contains `asOf` — effective_to EXCLUSIVE, latest
 * effective_from wins — the EXACT predicate au.f_line_area_map_asof and buildOperationalRegionMap
 * use, so the drilldown, the closing and the achievement engine never disagree about who owns an
 * area on a given date. Only winners with `carries_target = true` are kept (an area whose in-force
 * row is a sibling line's "other_line_specific"/"other_permanent" seat is excluded), and the
 * optional `regionCodes` set narrows to those operational regions.
 *
 * Reading the window end instead of au_v_line_area_map (which is effective_to IS NULL = today AND
 * every FUTURE-dated row) is the fix for finding 5: a move written as a pair effective the 1st of
 * next month otherwise appears in a window that ends this month, showing the future region early.
 * Pure and exported so that dating rule is provable without a database.
 */
export function selectLineAreasAsOf(
  rows: readonly LineAreaMapRow[],
  asOf: string,
  regionCodes: Set<string> | null,
): CanonicalArea[] {
  const winningFrom = new Map<string, string>();
  const winner = new Map<string, CanonicalArea>();
  const winnerCarries = new Map<string, boolean>();
  for (const row of rows) {
    const areaCode = String(row.area_code ?? "").trim();
    if (!areaCode) continue;
    const key = areaCode.toUpperCase();
    const from = String(row.effective_from ?? "");
    const to = String(row.effective_to ?? "");
    // Not yet in force for the window end. This single line is the whole point of `asOf`.
    if (from && from > asOf) continue;
    // Already superseded — EXCLUSIVE, matching the database: a row closed on 2026-09-01 covers
    // 2026-08-31 and not 2026-09-01, which is the day its successor opens.
    if (to && to <= asOf) continue;
    // ISO dates order correctly as plain strings; "" (a missing effective_from) loses to any date.
    const incumbent = winningFrom.get(key);
    if (incumbent !== undefined && incumbent >= from) continue;
    winningFrom.set(key, from);
    winner.set(key, {
      areaCode,
      areaName: String(row.area_name ?? "").trim(),
      regionCode: String(row.operational_region_code ?? "").trim(),
    });
    winnerCarries.set(key, Boolean(row.carries_target));
  }
  const out: CanonicalArea[] = [];
  for (const [key, area] of winner) {
    if (!winnerCarries.get(key)) continue;
    if (regionCodes && regionCodes.size > 0 && !regionCodes.has(area.regionCode.toUpperCase())) continue;
    out.push(area);
  }
  return out.sort((a, b) => a.areaCode.localeCompare(b.areaCode));
}

/**
 * Areas that structurally belong to ONE line's own People Organogram seat tree — optionally
 * narrowed to a set of regions — resolved AS OF `asOf` (the window-end date) against
 * au_v_line_area_map_all, the effective-dated seat history. `carries_target = true` selects
 * exactly the areas in "occupied" or "vacant_will_hire" state for this line, excluding
 * "other_line_specific"/"other_permanent" rows — i.e. areas that are structurally a SIBLING
 * line's territory in the same geography.
 *
 * This is what makes a District Manager's (and Regional/National Sales Manager's) area list match
 * their organogram subtree exactly, instead of "every area in the region": a region routinely has
 * a SEPARATE District Manager seat per line (Delta (1) has one DM for Anti Infective, a different
 * DM for CNS, a different one for Pedia, each covering a different subset of that region's areas) —
 * showing every area in the region would leak areas that belong to a sibling line's DM.
 *
 * AS OF, not "today": the previous read hit au_v_line_area_map (effective_to IS NULL), so a
 * forward-dated move showed its future region for the whole trailing window before it took effect.
 * See selectLineAreasAsOf and territoryAsOfDate.
 */
export async function loadLineAreas(
  auLineCode: string,
  regionCodes: Set<string> | null,
  asOf: string,
): Promise<CanonicalArea[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("au_v_line_area_map_all")
    .select("area_code,area_name,operational_region_code,carries_target,effective_from,effective_to")
    .eq("line_code", auLineCode);
  if (error) throw error;
  return selectLineAreasAsOf((data ?? []) as LineAreaMapRow[], asOf, regionCodes);
}

/**
 * Correct each area's line-agnostic canonical region to the region it sits in on THIS line.
 *
 * WHY. The Medical Rep card's region is built from loadCanonicalAreas (line-agnostic), but the
 * region a canonical area belongs to VARIES BY LINE — Beni Suef is Giza canonically yet Upper Egypt
 * on Pedia's seat tree; Qalubeya is Delta (1) canonically yet Delta (3) on Anti Infective. Measured
 * on production 2026-09-22, that mismatch showed the wrong region on 13 of 66 seated reps' cards.
 * `lineAreaRegions` is au_v_line_area_map.operational_region_code for the rep's own line — the SAME
 * per-line authority the DM/RM/nationwide levels already read via loadLineAreas — so after this a
 * rep and his manager name the same region for the same area.
 *
 * An OVERRIDE, not a source swap: an area the line map does not carry (none today, measured
 * 0-of-66) keeps its canonical region and stays on the card rather than vanishing. Pure and
 * exported so the fix is provable without a database; `lineAreaRegions` empty (every non-Medical-
 * Rep level, which already reads the line-aware region directly) returns the base areas untouched.
 */
export function applyLineRegionOverride(
  baseAreas: readonly CanonicalArea[],
  lineAreaRegions: readonly CanonicalArea[],
): CanonicalArea[] {
  if (lineAreaRegions.length === 0) return baseAreas.map((area) => ({ ...area }));
  const lineRegionByArea = new Map<string, string>();
  for (const area of lineAreaRegions) {
    const code = area.areaCode.trim().toUpperCase();
    const region = area.regionCode.trim();
    if (code && region) lineRegionByArea.set(code, region);
  }
  return baseAreas.map((area) => {
    const lineRegion = lineRegionByArea.get(area.areaCode.trim().toUpperCase());
    return lineRegion ? { ...area, regionCode: lineRegion } : { ...area };
  });
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
  asOf: string,
): Promise<TerritorySkeleton> {
  // For "region", the region set is already known before the area fetch (it bounds the
  // au_v_line_area_map query itself). For "area" it's derived afterward from the resolved
  // area(s); for "nationwide" it stays null throughout (no region restriction).
  let regionCodesInScope: Set<string> | null =
    rootScope.level === "region" ? new Set(rootScope.regionCodes.map((code) => code.toUpperCase())) : null;
  const auLineCode = resolveAuLineCode(rootScope.officialLine);

  const [references, baseAreas, auRegionNames, lineAreaRegions] = await Promise.all([
    // The name masters (includeCustomerBricks: false), read ONCE per page render: a Medical Rep's
    // root scope already read them to confirm his own areas, so this render reuses that read rather
    // than making a second (2026-10-01, "slow to transfer between page and page"). Nothing below
    // mutates them — the blocks and bricks are filtered and copied, never edited in place.
    loadSalesNameMastersOncePerRender(),
    rootScope.level === "area"
      ? loadCanonicalAreas()
      : auLineCode
        ? loadLineAreas(auLineCode, regionCodesInScope, asOf)
        // officialLine didn't map to a known organogram line_code (shouldn't happen — every
        // resolved rootScope carries a real product line by construction) — fail closed to an
        // empty area list rather than falling back to an unfiltered/wrong-line listing.
        : Promise.resolve([] as CanonicalArea[]),
    loadAuRegionNames(),
    // The rep's own line's region for each area, ONLY for the Medical Rep (area) level — the other
    // levels already read the line-aware region directly through loadLineAreas above, so they pass
    // an empty list and applyLineRegionOverride leaves their areas untouched. See that function.
    rootScope.level === "area" && auLineCode
      ? loadLineAreas(auLineCode, null, asOf)
      : Promise.resolve([] as CanonicalArea[]),
  ]);

  // Line-agnostic canonical region -> the rep's own line's region (a no-op for every level that
  // already read the line-aware region). This is the whole of the 2026-09-22 rep-card region fix.
  const allAreas = applyLineRegionOverride(baseAreas, lineAreaRegions);

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
