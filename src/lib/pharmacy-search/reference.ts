/**
 * The small territory lookups, loaded once per server process.
 *
 * Bricks (700), areas (51), regions (9) and distributors (20) together are a few hundred KB and
 * change roughly never, while every search would otherwise re-join them across the Atlantic —
 * the database is in Frankfurt and each round trip is real latency. Cached for `TTL_MS` so a
 * territory edit still shows up the same working session without a redeploy.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";

import { EMPTY_TERRITORY, type PharmacyTerritory } from "./types";

const TTL_MS = 10 * 60 * 1000;

export type BrickRow = {
  areaCode: string | null;
  blockCode: string | null;
  brickId: string;
  brickName: string | null;
  regionCode: string | null;
};

export type TerritoryReference = {
  areaNames: Map<string, string>;
  bricks: Map<string, BrickRow>;
  distributorNames: Map<string, string>;
  regionNames: Map<string, string>;
};

let cached: { loadedAt: number; value: TerritoryReference } | null = null;
let inFlight: Promise<TerritoryReference> | null = null;

async function loadTerritoryReference(): Promise<TerritoryReference> {
  const supabase = getSupabaseAdmin();

  const [bricks, areas, regions, distributors] = await Promise.all([
    supabase.from("source_of_sales_bricks").select("brick_id, brick_name, block_code, area_code, region_code"),
    supabase.from("source_of_sales_areas").select("area_code, area_name"),
    supabase.from("source_of_sales_regions").select("region_code, region_name"),
    supabase.from("source_of_sales_distributors").select("distributor_code, distributor_name"),
  ]);

  const firstError = bricks.error ?? areas.error ?? regions.error ?? distributors.error;
  if (firstError) {
    throw new Error(`Could not load territory reference data: ${firstError.message}`);
  }

  const brickMap = new Map<string, BrickRow>();
  for (const row of bricks.data ?? []) {
    const brickId = String(row.brick_id ?? "").trim();
    if (!brickId) continue;
    brickMap.set(brickId, {
      areaCode: row.area_code ?? null,
      blockCode: row.block_code ?? null,
      brickId,
      brickName: row.brick_name ?? null,
      regionCode: row.region_code ?? null,
    });
  }

  const toNameMap = (rows: Array<Record<string, unknown>> | null, codeKey: string, nameKey: string) => {
    const map = new Map<string, string>();
    for (const row of rows ?? []) {
      const code = String(row[codeKey] ?? "").trim();
      const name = String(row[nameKey] ?? "").trim();
      if (code && name) map.set(code, name);
    }
    return map;
  };

  return {
    areaNames: toNameMap(areas.data, "area_code", "area_name"),
    bricks: brickMap,
    distributorNames: toNameMap(distributors.data, "distributor_code", "distributor_name"),
    regionNames: toNameMap(regions.data, "region_code", "region_name"),
  };
}

export async function getTerritoryReference(): Promise<TerritoryReference> {
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.value;
  // Collapse a burst of concurrent first-hits onto one load rather than four identical ones.
  inFlight ??= loadTerritoryReference()
    .then((value) => {
      cached = { loadedAt: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return await inFlight;
}

/** Test seam — drops the cache so a following call re-reads. */
export function resetTerritoryReferenceCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * Turn the codes stored on a mapping row into the names a human reads.
 *
 * The brick row is the authority for area and region: a mapping row carries its own `area_code`
 * and `region_code`, but those can lag a brick that moved between areas, and
 * `source_of_sales_bricks` is the branch→area authority. Codes on the row are the fallback, not
 * the other way round.
 */
export function resolveTerritory(
  reference: TerritoryReference,
  input: { areaCode?: string | null; brickId?: string | null; regionCode?: string | null },
): PharmacyTerritory {
  const brickId = input.brickId?.trim() || null;
  const brick = brickId ? reference.bricks.get(brickId) ?? null : null;

  const areaCode = brick?.areaCode ?? input.areaCode?.trim() ?? null;
  const regionCode = brick?.regionCode ?? input.regionCode?.trim() ?? null;

  if (!brickId && !areaCode && !regionCode) return EMPTY_TERRITORY;

  return {
    areaCode,
    areaName: areaCode ? reference.areaNames.get(areaCode) ?? null : null,
    blockCode: brick?.blockCode ?? null,
    brickId,
    brickName: brick?.brickName ?? null,
    regionCode,
    regionName: regionCode ? reference.regionNames.get(regionCode) ?? null : null,
  };
}
