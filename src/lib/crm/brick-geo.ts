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

import { getOrLoadShared, sharedReadKey } from "@/lib/cache/shared-read";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { singleFlight } from "@/lib/utils/single-flight";

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
    // These reads are paginated because the pin table HAS breached PostgREST's 1,000-row cap, and
    // an unpaginated read truncates SILENTLY: production held 1,142 brick_centroid rows (446 of
    // them orphans whose brick no longer exists, consuming the row budget for nothing) against
    // 696 live bricks — roughly 12% of real bricks never reached the index. A check-in inside a
    // dropped brick then snapped to the nearest SURVIVING centroid and still rendered a confident
    // "High · 0.8 km", and which bricks vanished depended on heap order, so it varied per render.
    // The same truncation also made brick VALIDATION reject legitimate brick ids elsewhere.
    //
    // 2026-09-08: the 320 orphan pins that merely duplicated a live pin's coordinates were deleted
    // (pre-image in geo_pins_backup_20260908.orphan_duplicate_pins_pre), leaving 822 pins — 696
    // live and 126 orphans holding coordinates of their own. The cap is no longer breached, so
    // KEEPING fetchAllRows here is deliberate: the margin is 178 rows, every brick retired from
    // source_of_sales_bricks mints a fresh orphan, and the failure mode is a silent truncation
    // rather than an error — which is exactly what nobody notices.
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
 * One cache lookup for every caller that arrives at the same moment.
 *
 * `unstable_cache` does not dedupe a miss: every caller that arrives while the entry is absent or
 * expired runs the four reads above itself. Several callers resolve a whole LIST one row at a time —
 * `attachOutstationCapturedLocations` calls this once per outstation request, and the Super Admin
 * sidebar's 30-second badge poll lists every request — so each expiry became one full read of
 * `source_of_sales_bricks` per request row. Production, 2026-09-17: 7,178 reads a day, 93% of them
 * in bursts of 61 or more reads inside five seconds. Sharing the in-flight lookup turns each burst
 * back into one read.
 *
 * It changes no value: every waiter receives exactly what the one lookup returned, and nothing is
 * kept once it settles, so the 300-second window and the `sos-reference` tag still decide staleness.
 */
const loadBrickCentroidsShared = singleFlight(() => loadBrickCentroidsCached());

/**
 * Every brick that has a geocoded centre, joined to its area/region. Degrades to an empty list on
 * any error (the caller then renders "—"): this is a display overlay, never load-bearing. The catch
 * lives OUTSIDE the cache deliberately — a transient DB error returns [] for this one call without
 * poisoning the cache, so the next request retries, exactly as the old module-cache did. It is
 * outside the shared in-flight lookup too: every waiter on a failed lookup gets [], and the slot is
 * already empty for the next call.
 */
export async function loadBrickCentroids(): Promise<BrickCentroid[]> {
  try {
    return await loadBrickCentroidsShared();
  } catch {
    return [];
  }
}

/** The brick's display name and its area's name, resolved from the SoS master by brick id. */
export type BrickNameMeta = { areaName: string | null; brickName: string };

/** The shared copy `loadBrickNames` serves: master data, keyed by the exact id set asked about. */
const BRICK_NAMES_SHARED = "crm-brick-names";
const BRICK_NAMES_SHARED_LIMITS = { maxEntries: 200, maxRowsTotal: 50_000 };

type BrickNameRow = { brickId: string; brickName: string; areaName: string | null };

/**
 * Brick name and area for a set of brick ids — the "known brick" a customer sits in before any
 * check-in gives him coordinates. The SoS master gives the name; this is where the code→name
 * resolution the owner's naming rule requires actually happens.
 *
 * It lives in this `src/lib/crm` module, not in a Phoenix CRM caller, on purpose: Phoenix CRM reads
 * only its own tables, the organogram, people's names and the product list, so any reach into the
 * Source-of-Sales masters is delegated here, exactly as brick-from-coordinates already is. An active
 * brick row is preferred where an id carries both an active and a retired one, so the name and area
 * are the current ones; a retired-only brick still names itself; a brick with no name row resolves to
 * nothing, and the caller falls back to whatever locality it has. Read-only.
 */
export async function loadBrickNames(brickIds: readonly string[]): Promise<Map<string, BrickNameMeta>> {
  const ids = [...new Set(brickIds)].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return new Map();
  // MASTER DATA, SHARED FOR A MINUTE (2026-10-16 Phoenix CRM performance audit). The List, its board,
  // Today and the planners each asked for the same territory's bricks on every open — two dependent
  // round trips a time — though the SoS master behind them changes only on an import. Keyed by the
  // exact id set, so a caller only ever receives the bricks it asked about; a copy is at most
  // `SHARED_READ_TTL_MS` old, the window the owner chose for shared reads that day. A failed read is
  // never stored, and throws exactly as before.
  const key = sharedReadKey({ ids: [...ids].sort() });
  const { rows } = await getOrLoadShared(BRICK_NAMES_SHARED, key, () => readBrickNames(ids), BRICK_NAMES_SHARED_LIMITS);
  const meta = new Map<string, BrickNameMeta>();
  for (const row of rows ?? []) meta.set(row.brickId, { areaName: row.areaName, brickName: row.brickName });
  return meta;
}

/** The live read behind `loadBrickNames`: bricks then their areas, each four chunks at a time. */
async function readBrickNames(ids: readonly string[]): Promise<BrickNameRow[]> {
  const supabase = getSupabaseAdmin();
  const chunk = <T>(items: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  };

  // The chunks are read four at a time and folded in chunk order — the rows each id sees, and the
  // order they are seen in, are exactly the one-chunk-at-a-time loop's.
  const brickPages = await mapWithConcurrency(chunk(ids, 150), 4, async (part) => {
    const { data, error } = await supabase
      .from("source_of_sales_bricks")
      .select("brick_id, brick_name, area_code, active")
      .in("brick_id", part);
    if (error) throw error;
    return (data ?? []) as Array<{ active: boolean | null; area_code: string | null; brick_id: string | null; brick_name: string | null }>;
  });
  const byBrick = new Map<string, { areaCode: string | null; brickName: string }>();
  for (const page of brickPages) {
    for (const row of page) {
      const name = (row.brick_name ?? "").trim();
      if (!row.brick_id || !name) continue;
      // A retired row never overwrites an active one already seen for the same id.
      if (byBrick.has(row.brick_id) && row.active === false) continue;
      byBrick.set(row.brick_id, { areaCode: (row.area_code ?? "").trim() || null, brickName: name });
    }
  }

  const areaCodes = [...new Set([...byBrick.values()].map((entry) => entry.areaCode).filter((code): code is string => Boolean(code)))];
  const areaPages = await mapWithConcurrency(chunk(areaCodes, 150), 4, async (part) => {
    const { data, error } = await supabase.from("source_of_sales_areas").select("area_code, area_name").in("area_code", part);
    if (error) throw error;
    return (data ?? []) as Array<{ area_code: string | null; area_name: string | null }>;
  });
  const areaNames = new Map<string, string>();
  for (const page of areaPages) {
    for (const row of page) {
      const name = (row.area_name ?? "").trim();
      if (row.area_code && name && !areaNames.has(row.area_code)) areaNames.set(row.area_code, name);
    }
  }

  return [...byBrick].map(([brickId, entry]) => ({
    brickId,
    brickName: entry.brickName,
    areaName: entry.areaCode ? areaNames.get(entry.areaCode) ?? null : null,
  }));
}

/**
 * The territory a point was captured IN, when the caller knows it — the area codes of the seat whose
 * rep took the reading. `withinKm` is the caller's own trust radius: a brick of that territory is
 * preferred only while it is close enough to be believable on its own.
 */
export type PreferredTerritory = {
  readonly areaCodes: readonly string[];
  readonly withinKm: number;
};

/**
 * Nearest brick to one coordinate. Returns null when there are no centroids at all, or the point
 * has no usable coordinates. A cheap bounding-box pre-filter (~1.5°, far wider than any plausible
 * brick) skips the great-circle maths for the vast majority of candidates.
 *
 * 🔴 `prefer` MAKES THE CAPTURING SEAT'S OWN AREA WIN A NEAR TIE, AND IT IS THE ONLY DEFENCE AGAINST
 * A CENTROID THAT IS NOT A BRICK'S CENTRE AT ALL. 68 of the 699 live centroids sit on 25 SHARED
 * coordinates (a brick name Google could not place falls back to the town's or the governorate's own
 * point), and 34 of those straddle an AREA boundary — so the nearest-centroid winner among them is
 * whichever row the array happened to hold first, which is not a geographic fact. Measured on
 * production 2026-10-10: a place captured at Tabarak hospital on King Faisal Street was filed in
 * `Imbaba - Imbaba Centers` because تكلا's junk centroid sat 1.26 km away while the real Haram-Faisal
 * brick sat 1.45 km away, and six Qena 1 captures were filed in Qena 2 on a centroid the two areas
 * SHARE to thirteen decimals. Preferring the seat's own area inside the same trust radius changed 7
 * of 631 rows and nothing else: 599 already resolved inside their own area, and the 13 whose own area
 * has no brick within the radius keep the nearest brick anywhere, which is the honest answer for a
 * rep genuinely working at the edge of a neighbouring district.
 */
export function resolveBrickForPoint(
  lat: number | null | undefined,
  lon: number | null | undefined,
  centroids: readonly BrickCentroid[],
  prefer?: PreferredTerritory | null,
): ResolvedBrickPoint | null {
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (centroids.length === 0) return null;
  const preferred = new Set(prefer?.areaCodes ?? []);

  let best: BrickCentroid | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  let own: BrickCentroid | null = null;
  let ownKm = Number.POSITIVE_INFINITY;
  for (const candidate of centroids) {
    if (Math.abs(candidate.lat - lat) > 1.5 || Math.abs(candidate.lon - lon) > 1.5) continue;
    const km = haversineKm(lat, lon, candidate.lat, candidate.lon);
    if (km < bestKm) {
      bestKm = km;
      best = candidate;
    }
    if (km < ownKm && candidate.areaCode !== null && preferred.has(candidate.areaCode)) {
      ownKm = km;
      own = candidate;
    }
  }
  // The seat's own area wins only inside the caller's trust radius; outside it the nearest brick
  // anywhere is returned exactly as before, with its own distance, so nothing is fabricated to put a
  // capture back inside a territory it is nowhere near.
  const [chosen, chosenKm] = own && prefer && ownKm <= prefer.withinKm ? [own, ownKm] : [best, bestKm];
  if (!chosen) return null;
  return {
    areaCode: chosen.areaCode,
    areaName: chosen.areaName,
    brickId: chosen.brickId,
    brickName: chosen.brickName,
    distanceKm: chosenKm,
    regionCode: chosen.regionCode,
    regionName: chosen.regionName,
  };
}
