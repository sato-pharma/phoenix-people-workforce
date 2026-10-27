import { resolveGovernorate } from "@/lib/geo/egypt-locations";
import { googleGeocodeComponents, googlePlacesTextSearch, hasGoogleServerKey } from "@/lib/google-maps/server";
import {
  hasLocationIqKey,
  locationIqForwardGeocode,
  LOCATIONIQ_CONFIDENCE_THRESHOLD,
  scoreForwardConfidence,
} from "@/lib/geocoding/locationiq";
import { loadSalesReferenceData, type SalesBrickReference } from "@/lib/sales/monthly-distributor-import";
import { resolveGovernorateRegion, type BrickCentroid } from "@/lib/sales/normalizer/geo-validate";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { MANUAL_PIN_PROVIDER, pinConfidence } from "@/lib/territory-management/service";

// Brick centroid acquisition + lookup. A centroid is the approximate coordinate of a brick
// territory, cached forever in `geo_locations` (source_type='brick_centroid', source_key=brick_id).
// Two providers:
//   field_gps — median of real GPS captures from marketing_pharmacies linked to the brick via
//               the pharmacy-code ↔ customer-map join (free, but NOT ground truth: rep GPS can be
//               spoofed, so it only replaces a pin pinConfidence ranks no higher than itself)
//   google    — one-time geocode of "<brick_name>, <area_name>, Egypt"
//
// SANITY GATE: a google-geocoded centroid is stored with geocode_status='success' ONLY when its
// governorate maps to the brick's own region (Sharkia passes for D2/D3 bricks). Anything else is
// stored as 'region_mismatch' so it is visible in coverage stats but NEVER drives distance-based
// confidence — a wrong centroid is worse than none.

const SOURCE_TYPE = "brick_centroid";
const GEOCODE_CONCURRENCY = 8;
// Hard cap per build invocation — this is a one-time-ever cost (~1 geocode/brick); re-invoke to
// continue where the previous run stopped.
const MAX_GEOCODES_PER_BUILD = 600;

const PAGE = 1000;

export type BrickCentroidCoverage = {
  totalBricks: number;
  cached: number;
  success: number;
  mismatch: number;
};

function normalizeCodeForJoin(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function centroidPassesRegionGate(governorate: string | null, brickRegionCode: string): boolean {
  const govRegion = resolveGovernorateRegion(governorate);
  if (govRegion.ambiguous) return brickRegionCode === "D2" || brickRegionCode === "D3";
  return govRegion.regionCode != null && govRegion.regionCode === brickRegionCode;
}

type BrickGeoComponents = { governorate: string | null; lat: number; lng: number; markaz: string | null };

/**
 * LocationIQ first (free), Google as a fallback — but for a brick centroid, the region gate
 * (centroidPassesRegionGate, above) is the authoritative accuracy signal, stronger than the
 * generic confidence score: we already know which governorate the brick belongs to, so "does the
 * geocoded governorate match" is ground truth, not a heuristic. A LocationIQ result must clear
 * BOTH the confidence threshold AND the region gate to be accepted; otherwise Google is tried,
 * and whichever provider's result passes the region gate wins. If neither passes, the better of
 * the two (preferring Google, the stronger general geocoder) is still stored as
 * geocode_status='region_mismatch' — a visible diagnostic, matching the pre-existing behavior,
 * never used for distance-based confidence.
 */
async function resolveBrickGeo(
  searchText: string,
  brickRegionCode: string,
): Promise<{ geo: BrickGeoComponents; passesGate: boolean; provider: "locationiq" | "google" | "google_places" } | null> {
  // PLACES FIRST. The Geocoding API is built for street addresses and mangles Egyptian district
  // names — asked for "الحضرة الجديدة" it returned an electronics shop in Montaza, 8.5 km from the
  // real district, with partial_match set. Places text search (what Google Maps itself uses) finds
  // the district, and taking the first GEOGRAPHIC hit skips the businesses named after it.
  // Verified against stored pins: سفاجا moved 314 km, الاقصر 180 km, الزرقا 64 km.
  if (hasGoogleServerKey()) {
    const place = await googlePlacesTextSearch(searchText);
    // Only a real place is trusted here. A business that merely shares the name usually sits in
    // the right district, but it is not the district — let the geocoders argue about those.
    if (place?.isGeographic) {
      const geo: BrickGeoComponents = {
        governorate: resolveGovernorate(place.formattedAddress),
        lat: place.lat,
        lng: place.lng,
        markaz: place.name,
      };
      if (centroidPassesRegionGate(geo.governorate, brickRegionCode)) {
        return { geo, passesGate: true, provider: "google_places" };
      }
    }
  }

  const locationIqResult = await locationIqForwardGeocode(searchText);
  if (scoreForwardConfidence(locationIqResult) >= LOCATIONIQ_CONFIDENCE_THRESHOLD && locationIqResult?.lat && locationIqResult?.lon) {
    const geo: BrickGeoComponents = {
      governorate: locationIqResult.address?.state ?? null,
      lat: Number(locationIqResult.lat),
      lng: Number(locationIqResult.lon),
      markaz: locationIqResult.address?.state_district ?? locationIqResult.address?.county ?? locationIqResult.address?.city ?? null,
    };
    if (centroidPassesRegionGate(geo.governorate, brickRegionCode)) {
      return { geo, passesGate: true, provider: "locationiq" };
    }
    if (!hasGoogleServerKey()) return { geo, passesGate: false, provider: "locationiq" };
    const googleGeo = await googleGeocodeComponents(searchText);
    if (googleGeo && centroidPassesRegionGate(googleGeo.governorate, brickRegionCode)) {
      return { geo: googleGeo, passesGate: true, provider: "google" };
    }
    // Neither passes — prefer Google's read as the stored mismatch diagnostic when available.
    return googleGeo ? { geo: googleGeo, passesGate: false, provider: "google" } : { geo, passesGate: false, provider: "locationiq" };
  }

  if (!hasGoogleServerKey()) return null;
  const googleGeo = await googleGeocodeComponents(searchText);
  if (!googleGeo) return null;
  return { geo: googleGeo, passesGate: centroidPassesRegionGate(googleGeo.governorate, brickRegionCode), provider: "google" };
}

/**
 * Offset pager. Every `fetchPage` MUST apply a stable `.order()` or pages silently lose and
 * duplicate rows (#1446), and must THROW on error rather than returning null — returning null made a
 * transient failure indistinguishable from end-of-data, quietly truncating the centroid set.
 */
async function pageAll<T>(fetchPage: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await fetchPage(from, from + PAGE - 1);
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

// Free enrichment: brick → median of field-rep GPS captures of pharmacies mapped to that brick.
async function collectFieldGpsCentroids(): Promise<Map<string, { lat: number; lng: number }>> {
  const supabase = getSupabaseAdmin();
  const result = new Map<string, { lat: number; lng: number }>();
  try {
    // customer_code (normalized) → brick_id
    const mapRows = await pageAll<{ customer_code: string | null; brick_id: string | null }>(async (from, to) => {
      const { data, error } = await supabase
        .from("source_of_sales_customer_map")
        .select("customer_code, brick_id")
        .eq("active", true)
        .not("brick_id", "is", null)
        // ORDER BY id: offset pages must be stably ordered or rows silently vanish (#1446).
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw error;
      return (data ?? []) as { customer_code: string | null; brick_id: string | null }[];
    });
    const brickByCode = new Map<string, string>();
    for (const row of mapRows) {
      const code = normalizeCodeForJoin(String(row.customer_code ?? ""));
      const brick = String(row.brick_id ?? "").trim();
      if (code && brick) brickByCode.set(code, brick);
    }
    if (brickByCode.size === 0) return result;

    // pharmacy_id → normalized distributor pharmacy code
    const codeRows = await pageAll<{ pharmacy_id: string | null; normalized_pharmacy_code: string | null }>(async (from, to) => {
      const { data, error } = await supabase
        .from("marketing_pharmacy_distributor_codes")
        .select("pharmacy_id, normalized_pharmacy_code")
        .eq("active", true)
        // ORDER BY id: offset pages must be stably ordered or rows silently vanish (#1446).
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw error;
      return (data ?? []) as { pharmacy_id: string | null; normalized_pharmacy_code: string | null }[];
    });
    const brickByPharmacyId = new Map<string, string>();
    for (const row of codeRows) {
      const brick = brickByCode.get(normalizeCodeForJoin(String(row.normalized_pharmacy_code ?? "")));
      const pharmacyId = String(row.pharmacy_id ?? "");
      if (brick && pharmacyId && !brickByPharmacyId.has(pharmacyId)) brickByPharmacyId.set(pharmacyId, brick);
    }
    if (brickByPharmacyId.size === 0) return result;

    // GPS captures per brick
    const gpsRows = await pageAll<{ id: string | null; captured_latitude: number | null; captured_longitude: number | null }>(async (from, to) => {
      const { data, error } = await supabase
        .from("marketing_pharmacies")
        .select("id, captured_latitude, captured_longitude")
        .not("captured_latitude", "is", null)
        .not("captured_longitude", "is", null)
        // ORDER BY id: offset pages must be stably ordered or rows silently vanish (#1446).
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw error;
      return (data ?? []) as { id: string | null; captured_latitude: number | null; captured_longitude: number | null }[];
    });
    const capturesByBrick = new Map<string, { lats: number[]; lngs: number[] }>();
    for (const row of gpsRows) {
      const brick = brickByPharmacyId.get(String(row.id ?? ""));
      if (!brick || row.captured_latitude == null || row.captured_longitude == null) continue;
      let bucket = capturesByBrick.get(brick);
      if (!bucket) { bucket = { lats: [], lngs: [] }; capturesByBrick.set(brick, bucket); }
      bucket.lats.push(Number(row.captured_latitude));
      bucket.lngs.push(Number(row.captured_longitude));
    }
    for (const [brick, bucket] of capturesByBrick) {
      // Require >= 2 captures — a single point could be one mis-tagged pharmacy.
      if (bucket.lats.length >= 2) result.set(brick, { lat: median(bucket.lats), lng: median(bucket.lngs) });
    }
  } catch {
    // Marketing tables unavailable — enrichment contributes nothing, google pass still runs.
  }
  return result;
}

/**
 * Count a coverage summary over ONE population: bricks that still exist.
 *
 * `geo_locations` keeps a centroid row after its brick is retired — in production 126 of the 822
 * `brick_centroid` rows are orphans whose `source_key` matches no brick (it read 446 of 1,142 until
 * 2026-09-08, when the 320 that merely duplicated a live pin's coordinates were deleted; the
 * remainder hold coordinates of their own and stay). Counting the numerator
 * over the raw table while the denominator came from the live brick list put the two halves on
 * different populations, so the normalizer workspace rendered "949 / 698 bricks located" and its
 * `success < totalBricks` gate — the ONLY route to the Build geo index button — could never fire,
 * hiding the 4 live bricks that still have no centroid at all.
 *
 * Exported pure so the invariant is testable without a database: a coverage summary may never
 * report more located bricks than exist.
 */
export function summarizeBrickCentroidCoverage(
  brickIds: readonly string[],
  rows: readonly { geocode_status: string | null; source_key: string | null }[],
): BrickCentroidCoverage {
  const live = new Set(brickIds.map((id) => String(id ?? "")));
  const liveRows = rows.filter((row) => live.has(String(row.source_key ?? "")));
  return {
    cached: liveRows.length,
    mismatch: liveRows.filter((row) => row.geocode_status === "region_mismatch").length,
    success: liveRows.filter((row) => row.geocode_status === "success").length,
    totalBricks: brickIds.length,
  };
}

export async function getBrickCentroidCoverage(): Promise<BrickCentroidCoverage> {
  const [refs, cachedRows] = await Promise.all([
    loadSalesReferenceData({ includeCustomerBricks: false }),
    pageAll<{ geocode_status: string | null; source_key: string | null }>(async (from, to) => {
      const { data, error } = await getSupabaseAdmin()
        .from("geo_locations")
        .select("source_key, geocode_status")
        .eq("source_type", SOURCE_TYPE)
        // ORDER BY id: offset pages must be stably ordered or rows silently vanish (#1446).
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw error;
      return (data ?? []) as { geocode_status: string | null; source_key: string | null }[];
    }),
  ]);
  return summarizeBrickCentroidCoverage(
    (refs.bricks ?? []).map((brick) => brick.brickId),
    cachedRows,
  );
}

export async function loadBrickCentroids(): Promise<Map<string, BrickCentroid>> {
  const result = new Map<string, BrickCentroid>();
  try {
    const rows = await pageAll<{ source_key: string | null; latitude: number | null; longitude: number | null; city: string | null; area: string | null; geocode_provider: string | null; geocode_status: string | null }>(async (from, to) => {
      const { data, error } = await getSupabaseAdmin()
        .from("geo_locations")
        .select("source_key, latitude, longitude, city, area, geocode_provider, geocode_status")
        .eq("source_type", SOURCE_TYPE)
        // ORDER BY id: offset pages must be stably ordered or rows silently vanish (#1446).
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw error;
      return (data ?? []) as never[];
    });
    for (const row of rows) {
      const key = String(row.source_key ?? "");
      if (!key || row.latitude == null || row.longitude == null) continue;
      result.set(key, {
        governorate: row.city ?? null,
        lat: Number(row.latitude),
        lng: Number(row.longitude),
        markaz: row.area ?? null,
        provider: row.geocode_provider ?? null,
        status: String(row.geocode_status ?? ""),
      });
    }
  } catch {
    // Cache unavailable — callers fall back to markaz/governorate tiers.
  }
  return result;
}

export type BuildBrickCentroidsResult = {
  fieldGps: number;
  geocoded: number;
  mismatched: number;
  remaining: number;
  sharedFallback: number;
  skippedExisting: number;
};

/**
 * When Google cannot find a brick name it silently returns the city or governorate CENTRE. That
 * point passes the region gate (it IS in the right governorate) but locates nothing — in
 * production one pin was carrying 16 different bricks, and 302 of 699 "usable" centroids sat on
 * 94 shared points. A coordinate already claimed by another brick is therefore never `success`.
 */
function coordinateKey(lat: number, lng: number): string {
  return `${lat},${lng}`;
}

const FIELD_GPS_PROVIDER = "field_gps";

/**
 * Rep GPS is never ground truth — check-ins can be spoofed (owner rule) — so field GPS may only
 * replace a pin the territory map's own ranking (pinConfidence) trusts no more than field GPS. A
 * person's pin ('manual', or a 'manual:<hr id>' form) and a named-district or named-place geocode
 * outrank it and are kept; a block centre, check-in GPS, an older field GPS pin, and any geocode
 * that failed its gate (region_mismatch, shared_fallback — they locate nothing) are replaced.
 */
export function fieldGpsMayReplacePin(existing: BrickCentroid | undefined): boolean {
  if (!existing) return true;
  // A person's pin is never overwritten, whatever its status.
  if (String(existing.provider ?? "").startsWith(MANUAL_PIN_PROVIDER)) return false;
  if (existing.status !== "success") return true;
  return pinConfidence(existing.provider ?? null, existing.status).percent <= pinConfidence(FIELD_GPS_PROVIDER, "success").percent;
}

/** Pass 1's plan: the field-GPS rows to write, and the bricks whose better pin is kept instead. */
export function planFieldGpsUpserts(
  bricks: Pick<SalesBrickReference, "brickId" | "brickName">[],
  fieldGps: Map<string, { lat: number; lng: number }>,
  existing: Map<string, BrickCentroid>,
): { kept: string[]; upserts: Record<string, unknown>[] } {
  const kept: string[] = [];
  const upserts: Record<string, unknown>[] = [];
  for (const brick of bricks) {
    const gps = fieldGps.get(brick.brickId);
    if (!gps) continue;
    if (!fieldGpsMayReplacePin(existing.get(brick.brickId))) {
      kept.push(brick.brickId);
      continue;
    }
    upserts.push({
      address_text: null,
      area: null,
      city: null,
      geocode_provider: FIELD_GPS_PROVIDER,
      geocode_status: "success",
      label: brick.brickName || brick.brickId,
      latitude: gps.lat,
      longitude: gps.lng,
      source_key: brick.brickId,
      source_type: SOURCE_TYPE,
    });
  }
  return { kept, upserts };
}

export async function buildBrickCentroids(): Promise<BuildBrickCentroidsResult> {
  const supabase = getSupabaseAdmin();
  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const bricks = refs.bricks ?? [];
  const existing = await loadBrickCentroids();

  const summary: BuildBrickCentroidsResult = {
    fieldGps: 0,
    geocoded: 0,
    mismatched: 0,
    remaining: 0,
    sharedFallback: 0,
    skippedExisting: 0,
  };

  // Coordinates already claimed by a brick. Seeded from the cache and extended as this run
  // writes, so a fallback point is caught both against history and within the same batch.
  const claimedCoordinates = new Set<string>();
  for (const [, centroid] of existing) claimedCoordinates.add(coordinateKey(centroid.lat, centroid.lng));

  // Pass 1 — field-GPS enrichment (free). Replaces only a pin no better than field GPS
  // (fieldGpsMayReplacePin); a person's pin or a named geocode is kept and counted in skippedExisting.
  const fieldGps = await collectFieldGpsCentroids();
  const { kept, upserts: gpsUpserts } = planFieldGpsUpserts(bricks, fieldGps, existing);
  summary.fieldGps = gpsUpserts.length;
  if (gpsUpserts.length > 0) {
    try {
      await supabase.from("geo_locations").upsert(gpsUpserts, { onConflict: "source_type,source_key" });
    } catch { /* best-effort */ }
  }

  // Pass 2 — geocode (LocationIQ first, region-gated; Google as fallback) for bricks still
  // without any cached centroid.
  const pending = bricks.filter((b) => !existing.has(b.brickId) && !fieldGps.has(b.brickId));
  // Every brick whose cached pin this build leaves as it was: the better pins Pass 1 refused to
  // replace, plus the pinned bricks field GPS never reached. fieldGps + skippedExisting + pending
  // covers every brick once.
  summary.skippedExisting = kept.length + bricks.filter((b) => existing.has(b.brickId) && !fieldGps.has(b.brickId)).length;
  if (!hasLocationIqKey() && !hasGoogleServerKey()) {
    summary.remaining = pending.length;
    return summary;
  }
  const toGeocode = pending.slice(0, MAX_GEOCODES_PER_BUILD);

  for (let index = 0; index < toGeocode.length; index += GEOCODE_CONCURRENCY) {
    const batch = toGeocode.slice(index, index + GEOCODE_CONCURRENCY);
    const geocoded = await Promise.all(
      batch.map(async (brick) => {
        // Brick name ONLY. The area name is a Phoenix internal label ("Alex Center", "Dakahlia 2"),
        // not a place any map knows, and appending it actively degrades the match: bare
        // "الحضرة الجديدة" resolves to the Al Hadrah locality, while adding "Alex Center" returns a
        // sports venue, and "الزرقا, Port said - Domiat" returns a city-hall office instead of the
        // town. Region correctness is enforced by centroidPassesRegionGate, not by the query text.
        const searchText = String(brick.brickName ?? "").trim();
        try {
          return { brick, resolved: await resolveBrickGeo(searchText, brick.regionCode) };
        } catch {
          return { brick, resolved: null };
        }
      }),
    );
    const upserts: Record<string, unknown>[] = [];
    for (const { brick, resolved } of geocoded) {
      if (!resolved) continue; // failures retry on the next build run
      const { geo, passesGate, provider } = resolved;
      const key = coordinateKey(geo.lat, geo.lng);
      const isSharedFallback = claimedCoordinates.has(key);
      claimedCoordinates.add(key);

      // Region gate first (wrong governorate is the worse error), then the shared-pin check.
      const status = !passesGate ? "region_mismatch" : isSharedFallback ? "shared_fallback" : "success";
      upserts.push({
        address_text: null,
        area: geo.markaz,
        city: geo.governorate,
        geocode_provider: provider,
        geocode_status: status,
        label: brick.brickName || brick.brickId,
        latitude: geo.lat,
        longitude: geo.lng,
        source_key: brick.brickId,
        source_type: SOURCE_TYPE,
      });
      if (status === "success") summary.geocoded += 1;
      else if (status === "shared_fallback") summary.sharedFallback += 1;
      else summary.mismatched += 1;
    }
    if (upserts.length > 0) {
      try {
        await supabase.from("geo_locations").upsert(upserts, { onConflict: "source_type,source_key" });
      } catch { /* best-effort */ }
    }
  }

  summary.remaining = Math.max(0, pending.length - toGeocode.length);
  return summary;
}

export { centroidPassesRegionGate };
