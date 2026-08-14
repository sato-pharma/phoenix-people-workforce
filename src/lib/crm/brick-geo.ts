/**
 * GPS -> Phoenix brick resolution for CRM check-ins.
 *
 * A check-in is the one CRM record that always carries real GPS coordinates, but it has no
 * geography of its own: the CRM's own `regionID` lives on VISITS, and the check-in address is a
 * reverse-geocoded convenience label, not a Phoenix place. This module closes that gap by matching
 * each check-in's coordinates to the NEAREST brick centroid, so the Check-ins tab can show the real
 * Phoenix Brick / Area / Region a check-in physically happened in.
 *
 * Reference points are the `brick_centroid` rows in `geo_locations` (one geocoded lat/lon per
 * brick), joined to `source_of_sales_bricks` for the brick's area/region. Nearest-centroid is an
 * approximation of true point-in-polygon: it is exact in dense urban areas where centroids are
 * close together, and degrades with distance, so the resolved distance is ALWAYS returned and
 * surfaced as a confidence label rather than hidden. Two known limitations, deliberately visible
 * instead of silently absorbed:
 *   - a few centroids are themselves mis-geocoded (a brick name that resolves to the wrong town),
 *     which can pull nearby check-ins onto the wrong brick — such rows usually show a large
 *     distance, which is why the distance is a first-class output;
 *   - a check-in far from every centroid (desert road, new development) gets a low-confidence match
 *     rather than a fabricated exact one.
 *
 * Read-only and best-effort: any failure yields an empty index, so the Brick/Area/Region columns
 * simply render "—" instead of breaking the page.
 */

import { unstable_cache } from "next/cache";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";

/** One brick with a known geographic centre, ready for distance comparison. */
type BrickCentroid = {
  areaCode: string | null;
  areaName: string | null;
  brickId: string;
  brickName: string | null;
  lat: number;
  lon: number;
  regionCode: string | null;
  regionName: string | null;
};

/** The resolved brick for a coordinate, with the distance that justifies it. */
export type ResolvedBrickPoint = {
  /**
   * The CODE, alongside the display name. Added 2026-08-08 for the outstation claim-validation
   * check, which asks whether a captured point falls inside the territory of the rep a manager
   * was visiting. That comparison has to join on codes: area NAMES are display strings that vary
   * in spelling and casing between sources, and matching money-adjacent territory on a label is
   * exactly the kind of fragile join that silently stops matching after a rename.
   *
   * Both values are already loaded onto BrickCentroid and populated — they were simply not
   * carried through to the result, so exposing them costs nothing and changes no matching maths.
   */
  areaCode: string | null;
  areaName: string | null;
  brickId: string;
  brickName: string | null;
  distanceKm: number;
  regionCode: string | null;
  regionName: string | null;
};

/** Confidence bands for a nearest-centroid match, in km. A check-in inside its own brick is
 * typically well under 1km from that brick's centre; beyond ~10km the nearest centroid is a
 * neighbouring locality's, so the row is flagged for review rather than presented as fact. */
const NEAR_KM = 1;
const GOOD_KM = 3;
const REVIEW_KM = 10;

/** Human label for a match distance — the "Confidence / Note" column's value. */
export function brickMatchConfidence(distanceKm: number): string {
  if (distanceKm <= NEAR_KM) return `High · ${distanceKm.toFixed(1)} km`;
  if (distanceKm <= GOOD_KM) return `Good · ${distanceKm.toFixed(1)} km`;
  if (distanceKm <= REVIEW_KM) return `Review · ${distanceKm.toFixed(1)} km`;
  return `Weak · ${distanceKm.toFixed(0)} km — nearest brick is far`;
}

const EARTH_RADIUS_KM = 6371;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in km between two coordinates. */
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * The raw read+join, with NO error handling on purpose: any failure throws, and `unstable_cache`
 * only ever caches a resolved value, so a transient DB error is never written into the cache. The
 * public wrapper below turns that throw into an empty list (and retries next request).
 *
 * Shared across requests through the Next.js Data Cache instead of a module-level variable. In the
 * App Router each route segment gets its OWN module instance, so the previous `let cache` was cold
 * on most of the pages that call this (CRM check-ins, outstation claim validation) and the read ran
 * far more often than its 5-minute TTL should have permitted. `revalidate: 300` keeps that exact
 * 5-minute staleness window; the `sos-reference` tag lets any validated SoS import bust it
 * immediately — `invalidateSalesDashboardCache` already fires that tag on every import/refresh path,
 * and dashboard/invalidation.ts already documents brick centroids as a `sos-reference` consumer.
 */
const loadBrickCentroidsCached = unstable_cache(
  async (): Promise<BrickCentroid[]> => {
    const supabase = getSupabaseAdmin();
    // Both of these tables exceed PostgREST's 1,000-row cap, so an unpaginated read silently
    // truncated them: production has 1,142 brick_centroid rows (446 of which are orphans whose
    // brick no longer exists, and which therefore consumed the row budget for nothing) against
    // 696 live bricks — roughly 12% of real bricks never reached the index. A check-in inside a
    // dropped brick then snapped to the nearest SURVIVING centroid and still rendered a confident
    // "High · 0.8 km", and which bricks vanished depended on heap order, so it varied per render.
    // The same truncation also made brick VALIDATION reject legitimate brick ids elsewhere.
    const [points, bricks, areasRes, regionsRes] = await Promise.all([
      fetchAllRows<{ latitude: number | null; longitude: number | null; source_key: string | null }>(
        () =>
          supabase
            .from("geo_locations")
            .select("source_key, latitude, longitude")
            .eq("source_type", "brick_centroid")
            .not("latitude", "is", null)
            .not("longitude", "is", null),
        "source_key",
      ),
      fetchAllRows<{
        active: boolean | null;
        area_code: string | null;
        brick_id: string | null;
        brick_name: string | null;
        region_code: string | null;
      }>(
        () => supabase.from("source_of_sales_bricks").select("brick_id, brick_name, area_code, region_code, active"),
        "brick_id",
      ),
      // Small masters (~48 areas, ~6 regions) — comfortably inside one page.
      supabase.from("source_of_sales_areas").select("area_code, area_name"),
      supabase.from("source_of_sales_regions").select("region_code, region_name"),
    ]);

    const areaName = new Map<string, string>();
    for (const a of (areasRes.data ?? []) as Array<{ area_code: string | null; area_name: string | null }>) {
      if (a.area_code) areaName.set(a.area_code, a.area_name ?? "");
    }
    const regionName = new Map<string, string>();
    for (const r of (regionsRes.data ?? []) as Array<{ region_code: string | null; region_name: string | null }>) {
      if (r.region_code) regionName.set(r.region_code, r.region_name ?? "");
    }
    const brickById = new Map<
      string,
      { active: boolean | null; area_code: string | null; brick_name: string | null; region_code: string | null }
    >();
    for (const b of bricks) {
      if (b.brick_id) brickById.set(b.brick_id, b);
    }

    const centroids: BrickCentroid[] = [];
    for (const point of points) {
      if (!point.source_key || point.latitude == null || point.longitude == null) continue;
      const brick = brickById.get(point.source_key);
      // Only bricks that still exist AND are active are valid targets — a retired brick must never
      // be proposed as a check-in's geography.
      if (!brick || !(brick.active ?? true)) continue;
      const areaCode = brick.area_code ?? null;
      const regionCode = brick.region_code ?? null;
      centroids.push({
        areaCode,
        areaName: areaCode ? areaName.get(areaCode) ?? null : null,
        brickId: point.source_key,
        brickName: brick.brick_name ?? null,
        lat: Number(point.latitude),
        lon: Number(point.longitude),
        regionCode,
        regionName: regionCode ? regionName.get(regionCode) ?? null : null,
      });
    }
    return centroids;
  },
  ["crm-brick-centroids"],
  { revalidate: 300, tags: ["sos-reference"] },
);

/**
 * Every brick that has a geocoded centre, joined to its area/region. Degrades to an empty list on
 * any error (the caller then renders "—"): this is a display overlay, never load-bearing. The catch
 * lives OUTSIDE the cache deliberately — a transient DB error returns [] for this one call without
 * poisoning the cache, so the next request retries, exactly as the old module-cache did.
 */
export async function loadBrickCentroids(): Promise<BrickCentroid[]> {
  try {
    return await loadBrickCentroidsCached();
  } catch {
    return [];
  }
}

/**
 * Nearest brick to one coordinate. Returns null when there are no centroids at all, or the point
 * has no usable coordinates. A cheap bounding-box pre-filter (~1.5°, far wider than any plausible
 * brick) skips the great-circle maths for the vast majority of candidates.
 */
export function resolveBrickForPoint(
  lat: number | null | undefined,
  lon: number | null | undefined,
  centroids: readonly BrickCentroid[],
): ResolvedBrickPoint | null {
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (centroids.length === 0) return null;

  let best: BrickCentroid | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const candidate of centroids) {
    if (Math.abs(candidate.lat - lat) > 1.5 || Math.abs(candidate.lon - lon) > 1.5) continue;
    const km = haversineKm(lat, lon, candidate.lat, candidate.lon);
    if (km < bestKm) {
      bestKm = km;
      best = candidate;
    }
  }
  if (!best) return null;
  return {
    areaCode: best.areaCode,
    areaName: best.areaName,
    brickId: best.brickId,
    brickName: best.brickName,
    distanceKm: bestKm,
    regionCode: best.regionCode,
    regionName: best.regionName,
  };
}
