import { getSupabaseAdmin } from "@/lib/supabase/server";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

// An employee's operational region is fully determined by their (line, area) via the au sales
// geography — NOT hand-typed. `au_v_line_area_map` maps (line_code, area_code) ->
// operational_region_code, and `au_v_regions` maps region_code -> region_name. This module is the
// single source of truth for that derivation, reused by the employee editor, the master import,
// and the directory so region can never drift from the sales areas.

export type ResolvedEmployeeRegion = {
  regionCode: string;
  regionName: string | null;
  areaName: string | null;
};

export type RegionCrosswalk = {
  /** key `${lineCode}::${areaCode}` (both normalized) -> { regionCode, areaName } */
  byLineArea: Map<string, { regionCode: string; areaName: string | null }>;
  /** normalized region_code -> region display name */
  regionNameByCode: Map<string, string>;
};

export type LineAreaMapRow = {
  line_code?: string | null;
  area_code?: string | null;
  area_name?: string | null;
  operational_region_code?: string | null;
};

export type RegionRow = {
  region_code?: string | null;
  region_name?: string | null;
};

function normalizeCode(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

// Region/area codes are canonical uppercase tokens in the au model (e.g. "D1", "AB", "AB1").
function normalizeRegionCode(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

export function lineAreaKey(
  lineCode: string | null | undefined,
  areaCode: string | null | undefined,
) {
  return `${normalizeCode(lineCode)}::${normalizeCode(areaCode)}`;
}

// Pure: assemble the crosswalk from raw au_v_line_area_map + au_v_regions rows. First mapping for a
// given (line, area) wins; the loader restricts to the currently-effective rows so there is only
// one anyway.
export function buildRegionCrosswalk(
  lineAreaRows: LineAreaMapRow[],
  regionRows: RegionRow[],
): RegionCrosswalk {
  const byLineArea = new Map<string, { regionCode: string; areaName: string | null }>();
  for (const row of lineAreaRows) {
    const regionCode = normalizeRegionCode(row.operational_region_code);
    if (!normalizeCode(row.line_code) || !normalizeCode(row.area_code) || !regionCode) {
      continue;
    }
    const key = lineAreaKey(row.line_code, row.area_code);
    if (!byLineArea.has(key)) {
      byLineArea.set(key, {
        regionCode,
        areaName: row.area_name?.trim() || null,
      });
    }
  }

  const regionNameByCode = new Map<string, string>();
  for (const row of regionRows) {
    const code = normalizeRegionCode(row.region_code);
    const name = row.region_name?.trim();
    if (code && name) {
      regionNameByCode.set(code, name);
    }
  }

  return { byLineArea, regionNameByCode };
}

// Pure: resolve one (lineCode, areaCode) against the crosswalk. Returns null when the pair is not
// a known sales seat — callers fail closed (keep the prior value / surface it) rather than guess.
export function resolveRegionFromCrosswalk(
  lineCode: string | null | undefined,
  areaCode: string | null | undefined,
  crosswalk: RegionCrosswalk,
): ResolvedEmployeeRegion | null {
  const hit = crosswalk.byLineArea.get(lineAreaKey(lineCode, areaCode));
  if (!hit) {
    return null;
  }
  return {
    regionCode: hit.regionCode,
    regionName: crosswalk.regionNameByCode.get(hit.regionCode) ?? null,
    areaName: hit.areaName,
  };
}

// Loader: fetch the currently-effective au crosswalk + region names and assemble it. Cheap master
// data (low thousands of rows), same views the territory skeleton already reads.
export async function loadRegionCrosswalk(
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<RegionCrosswalk> {
  const [lineAreaResult, regionResult] = await Promise.all([
    supabase
      .from("au_v_line_area_map")
      .select("line_code,area_code,area_name,operational_region_code,effective_to")
      .is("effective_to", null),
    supabase.from("au_v_regions").select("region_code,region_name"),
  ]);

  if (lineAreaResult.error) {
    throw new Error(lineAreaResult.error.message);
  }
  if (regionResult.error) {
    throw new Error(regionResult.error.message);
  }

  return buildRegionCrosswalk(
    (lineAreaResult.data ?? []) as LineAreaMapRow[],
    (regionResult.data ?? []) as RegionRow[],
  );
}

// Pure: choose the region fields to persist. When the (line, area) resolves, the au region is
// authoritative and overrides the free-text name; otherwise the fallback name is kept with no code.
export function employeeRegionFields(
  resolved: ResolvedEmployeeRegion | null,
  fallbackRegionName: string | null,
): { region_name: string | null; region_code: string | null } {
  if (resolved) {
    return {
      region_name: resolved.regionName ?? fallbackRegionName,
      region_code: resolved.regionCode,
    };
  }
  return { region_name: fallbackRegionName, region_code: null };
}

// Resolve an employee's region from their stored line_id + area_id: looks up the area/line codes,
// then the au crosswalk. Returns null when either id is missing/unknown or the (line, area) pair is
// not a sales seat (e.g. Head Office) — callers then keep the free-text region and store no code.
export async function resolveRegionByIds(
  lineId: number | null,
  areaId: number | null,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<ResolvedEmployeeRegion | null> {
  if (!lineId || !areaId) {
    return null;
  }
  const [areaResult, lineResult] = await Promise.all([
    supabase.from("areas").select("code").eq("id", areaId).maybeSingle(),
    supabase.from("lines").select("code").eq("id", lineId).maybeSingle(),
  ]);
  const areaCode = (areaResult.data as { code?: string | null } | null)?.code ?? null;
  const lineCode = (lineResult.data as { code?: string | null } | null)?.code ?? null;
  if (!areaCode || !lineCode) {
    return null;
  }
  const crosswalk = await loadRegionCrosswalk(supabase);
  return resolveRegionFromCrosswalk(lineCode, areaCode, crosswalk);
}
