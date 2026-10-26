import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

/**
 * The region -> area -> brick cascade, and the people attached to an area.
 *
 * Every seat, region and area-state fact lives in the `au` schema, which PostgREST does not expose
 * (`.schema("au")` answers PGRST106). So all of it comes through the public wrappers added in
 * `20260906235700_market_awareness_geography_function.sql`, never through a table read.
 */

export type MarketAwarenessArea = {
  regionCode: string;
  regionName: string;
  areaCode: string;
  areaName: string;
  areaState: string;
  /** False for Office, Main Store and similar buckets — shown greyed, never hidden. */
  selectable: boolean;
  unselectableReason: string | null;
  repHrId: string | null;
  repName: string | null;
  dmHrId: string | null;
  dmName: string | null;
  /** The seat exists and nobody is in it. 41 of 147 area-line rows on production. */
  repVacant: boolean;
};

export type MarketAwarenessRegion = {
  regionCode: string;
  regionName: string;
  areas: MarketAwarenessArea[];
};

export type MarketAwarenessBrickOption = {
  brickId: string;
  brickName: string;
  blockCode: string | null;
};

export type MarketAwarenessRegionManager = {
  dmHrId: string | null;
  dmName: string | null;
  areaCount: number;
};

type AreaRow = {
  region_code: string;
  region_name: string | null;
  area_code: string;
  area_name: string | null;
  area_state: string | null;
  selectable: boolean | null;
  unselectable_reason: string | null;
  rep_seat_id: string | null;
  rep_hr_id: string | null;
  rep_name: string | null;
  dm_seat_id: string | null;
  dm_hr_id: string | null;
  dm_name: string | null;
};

function toArea(row: AreaRow): MarketAwarenessArea {
  return {
    regionCode: String(row.region_code ?? "").trim(),
    regionName: String(row.region_name ?? row.region_code ?? "").trim(),
    areaCode: String(row.area_code ?? "").trim(),
    areaName: String(row.area_name ?? row.area_code ?? "").trim(),
    areaState: String(row.area_state ?? "").trim(),
    selectable: row.selectable === true,
    unselectableReason: row.unselectable_reason,
    repHrId: row.rep_hr_id,
    repName: row.rep_name,
    dmHrId: row.dm_hr_id,
    dmName: row.dm_name,
    // A seat that exists with nobody in it. Distinguished from "no seat at all", which is what an
    // Office-style bucket has — that case is caught by `selectable` instead.
    repVacant: Boolean(row.rep_seat_id) && !row.rep_hr_id,
  };
}

/**
 * Areas for one line, grouped into regions — the cascade exactly as the owner described it: pick a
 * region, then an area of that region, "even if vacant".
 *
 * Keyed on ONE line because the map is per line: Anti-Infective spans 9 regions, CNS and Pedia 7,
 * over the same 49 areas. The activity's primary line is what orders this, which is why a primary
 * line exists at all.
 */
export async function loadRegionsForLine(lineCode: string): Promise<MarketAwarenessRegion[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_market_awareness_areas", {
    p_line_code: lineCode,
  });
  if (error) throw toQueryError(error);

  const areas = ((data as AreaRow[] | null) ?? []).map(toArea);
  const byRegion = new Map<string, MarketAwarenessRegion>();

  for (const area of areas) {
    const existing = byRegion.get(area.regionCode);
    if (existing) {
      existing.areas.push(area);
      continue;
    }
    byRegion.set(area.regionCode, {
      regionCode: area.regionCode,
      regionName: area.regionName,
      areas: [area],
    });
  }

  return [...byRegion.values()].sort((a, b) => a.regionName.localeCompare(b.regionName));
}

/**
 * One area out of regions already loaded — case-insensitive and trimmed, exactly as `findArea` reads
 * it. Pure, so a list of activities can resolve every area from ONE load per line instead of one
 * `phx_market_awareness_areas` round trip per row.
 */
export function areaIn(
  regions: MarketAwarenessRegion[],
  areaCode: string,
): MarketAwarenessArea | null {
  const wanted = areaCode.trim().toLowerCase();
  for (const region of regions) {
    const match = region.areas.find((area) => area.areaCode.toLowerCase() === wanted);
    if (match) return match;
  }
  return null;
}

export async function findArea(
  lineCode: string,
  areaCode: string,
): Promise<MarketAwarenessArea | null> {
  return areaIn(await loadRegionsForLine(lineCode), areaCode);
}

/**
 * Bricks of one area. `source_of_sales_bricks` is the authority for branch -> area.
 *
 * The brick NAME is not unique — four brick names appear in two different areas each — so the value
 * carried everywhere in this module is `brick_id`, and the name is display only. Selecting a brick
 * by name is how an activity ends up measuring a place on the other side of the country.
 */
export async function loadBricksForArea(areaCode: string): Promise<MarketAwarenessBrickOption[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_bricks")
    .select("brick_id, brick_name, block_code, active, effective_to")
    .eq("area_code", areaCode.trim())
    .is("effective_to", null)
    .eq("active", true)
    .order("brick_name", { ascending: true })
    .limit(1000);
  if (error) throw toQueryError(error);

  return ((data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
    brickId: String(row.brick_id ?? "").trim(),
    brickName: String(row.brick_name ?? row.brick_id ?? "").trim(),
    blockCode: row.block_code ? String(row.block_code).trim() : null,
  }));
}

/**
 * Every district manager in a region, for a line — the owner's answer 32. A seat whose `dmHrId` is
 * null is a real vacancy and is returned rather than dropped: the caller says "vacant" instead of
 * quietly notifying a shorter list than the screen promised.
 */
export async function loadRegionManagers(
  lineCode: string,
  regionCode: string,
): Promise<MarketAwarenessRegionManager[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_market_awareness_region_managers", {
    p_line_code: lineCode,
    p_region_code: regionCode,
  });
  if (error) throw toQueryError(error);

  return ((data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
    dmHrId: row.dm_hr_id ? String(row.dm_hr_id) : null,
    dmName: row.dm_name ? String(row.dm_name) : null,
    areaCount: Number(row.area_count ?? 0),
  }));
}
