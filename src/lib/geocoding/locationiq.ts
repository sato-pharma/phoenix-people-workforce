/**
 * Server-only LocationIQ client — the single HTTP boundary for LocationIQ, mirroring how
 * src/lib/google-maps/server.ts centralizes the Google key/calls. Two consumers only:
 *   - src/lib/crm/checkin-geocode.ts (reverse: CRM check-in coordinates -> address)
 *   - src/lib/sales/normalizer/{pharmacy-geocode,brick-centroids}.ts (forward: address text -> coordinates)
 * outstation, marketing-requests, and Routes/Directions stay on Google directly and never import
 * this module — that scope boundary is deliberate, not an oversight.
 *
 * ACCURACY OVER COST: LocationIQ (OpenStreetMap-derived) has no literal "confidence: 0.82" field
 * on its reverse endpoint, and its forward/search `importance` is a notability score, not a
 * positional-confidence score. scoreReverseConfidence/scoreForwardConfidence below are heuristic
 * proxies built from what the API actually, reliably returns (matched address-component
 * granularity for reverse; matched OSM class/type for forward) — they are deliberately
 * conservative: an ambiguous/coarse match scores under LOCATIONIQ_CONFIDENCE_THRESHOLD so the
 * caller falls back to Google rather than accepting a vague result just because it was free.
 * Recalibrate against real production responses once LOCATIONIQ_API_KEY is live — this is a
 * best-effort estimate, not a vendor-guaranteed metric.
 */

const LOCATIONIQ_TIMEOUT_MS = 10_000;
export const LOCATIONIQ_CONFIDENCE_THRESHOLD = 90;

function getLocationIqKey(): string {
  return (process.env.LOCATIONIQ_API_KEY ?? "").trim();
}

export function hasLocationIqKey(): boolean {
  return getLocationIqKey().length > 0;
}

async function fetchLocationIqJson(url: URL): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCATIONIQ_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { cache: "no-store", signal: controller.signal });
    if (!response.ok) return null; // rate-limited/no-match/etc — caller falls back to Google, never throws
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type LocationIqAddress = {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  quarter?: string;
  residential?: string;
  city?: string;
  town?: string;
  village?: string;
  // Nominatim's tag for the markaz-equivalent administrative level (confirmed against real
  // LocationIQ responses 2026-07-23 — Egyptian results use state_district, not county).
  state_district?: string;
  county?: string;
  state?: string;
  country?: string;
};

export type LocationIqReverseResult = {
  address?: LocationIqAddress;
  display_name?: string;
};

/** Raw reverse-geocode call: coordinates -> place. Returns null on any failure (best-effort). */
export async function locationIqReverseGeocode(lat: number, lon: number): Promise<LocationIqReverseResult | null> {
  const key = getLocationIqKey();
  if (!key) return null;

  const url = new URL("https://us1.locationiq.com/v1/reverse");
  url.searchParams.set("key", key);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  // Without this, LocationIQ returns Arabic labels/components by default (confirmed live
  // 2026-07-23: "القاهرة" instead of "Cairo") — English is required both to match the existing
  // Google-derived address convention and, critically, because GOVERNORATE_TO_REGION's keys are
  // English (an Arabic governorate name would silently fail every region-gate match downstream).
  url.searchParams.set("accept-language", "en");

  const payload = await fetchLocationIqJson(url);
  return (payload && typeof payload === "object" ? (payload as LocationIqReverseResult) : null);
}

/**
 * Confidence proxy for a reverse match, 0-100: how granular the returned address actually is.
 * A check-in address is useless if it only resolves to "Cairo Governorate, Egypt" — this must
 * score under the threshold so the caller re-tries with Google, even though LocationIQ technically
 * "succeeded" (returned a non-empty, well-formed response).
 */
export function scoreReverseConfidence(result: LocationIqReverseResult | null): number {
  const address = result?.address;
  if (!result?.display_name || !address) return 0;
  if (address.house_number && address.road) return 95;
  if (address.road) return 82;
  if (address.neighbourhood || address.suburb || address.quarter || address.residential) return 60;
  if (address.city || address.town || address.village) return 40;
  if (address.county || address.state || address.country) return 15;
  return 30; // has display_name + some address fields, but none of the recognized tiers matched
}

export type LocationIqSearchResult = {
  address?: LocationIqAddress;
  class?: string;
  display_name?: string;
  importance?: number;
  lat?: string;
  lon?: string;
  type?: string;
};

/** Raw forward-geocode call: address text -> top place match. Returns null on any failure. */
export async function locationIqForwardGeocode(searchText: string): Promise<LocationIqSearchResult | null> {
  const key = getLocationIqKey();
  if (!key || !searchText.trim()) return null;

  const url = new URL("https://us1.locationiq.com/v1/search");
  url.searchParams.set("key", key);
  url.searchParams.set("q", searchText);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  // All Phoenix geography is Egypt — biasing/restricting to it is a real accuracy win, not just
  // a cost one: it rules out a same-named place abroad winning the top match.
  url.searchParams.set("countrycodes", "eg");
  // See the matching comment in locationIqReverseGeocode — required so address.state etc. come
  // back as "Cairo"/"Damietta" (matching GOVERNORATE_TO_REGION's English keys), not Arabic.
  url.searchParams.set("accept-language", "en");

  const payload = await fetchLocationIqJson(url);
  const results = Array.isArray(payload) ? (payload as LocationIqSearchResult[]) : [];
  return results[0] ?? null;
}

/**
 * Confidence proxy for a forward match, 0-100: is the top result a specific point of interest
 * (a real building/shop/amenity — precise enough to trust its lat/lng), a mere road match, or a
 * generic place/administrative match (the geocoder gave up and matched a whole city/governorate,
 * which is exactly the "ambiguous" case that must fall back to Google).
 */
export function scoreForwardConfidence(result: LocationIqSearchResult | null): number {
  if (!result?.lat || !result?.lon) return 0;
  const preciseClasses = new Set(["amenity", "shop", "healthcare", "office", "building", "tourism", "leisure"]);
  const roadClasses = new Set(["highway"]);
  const coarseClasses = new Set(["place", "boundary", "administrative"]);
  const cls = result.class ?? "";
  if (preciseClasses.has(cls)) return 90;
  if (roadClasses.has(cls)) return 65;
  if (coarseClasses.has(cls)) return 20;
  // Unrecognized class — fall back to the vendor's own importance signal (0-1) if present, else a
  // conservative mid value that still requires Google confirmation under the 75 threshold.
  if (typeof result.importance === "number" && Number.isFinite(result.importance)) {
    return Math.round(Math.min(1, Math.max(0, result.importance)) * 100);
  }
  return 50;
}
