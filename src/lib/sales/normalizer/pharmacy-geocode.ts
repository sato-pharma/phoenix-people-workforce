import { googleGeocodeComponents, hasGoogleServerKey } from "@/lib/google-maps/server";
import {
  hasLocationIqKey,
  locationIqForwardGeocode,
  LOCATIONIQ_CONFIDENCE_THRESHOLD,
  scoreForwardConfidence,
} from "@/lib/geocoding/locationiq";
import { foldCustomerNameText, normalizeCustomerNameKey } from "@/lib/sales/normalizer/customer-normalize";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Cache-first geocoding of pharmacy name+address strings, mirroring the pattern in
// src/lib/outstation/destination-geocode.ts: results persist in `geo_locations`, each distinct
// pharmacy is geocoded ONCE ever, only successes are cached (failures retry next load), and
// everything degrades gracefully when the table or the server key is unavailable.
//
// The cache key folds respellings via the customer normalizer, so "صيدلية د/ أحمد | شارع الجيش"
// and "صيدليه دكتور احمد | ش الجيش" hit the same cache row.

export type PharmacyGeo = {
  lat: number;
  lng: number;
  governorate: string | null;
  markaz: string | null;
};

const SOURCE_TYPE = "pharmacy_address";
const GEOCODE_CONCURRENCY = 8;
// Live (billed) geocodes allowed per call. Cache hits are unmetered. Overflow entries simply
// come back un-geocoded and score in the failure confidence tier — never an error.
const MAX_LIVE_GEOCODES_PER_CALL = 150;

export function pharmacyGeoKey(name: string, address: string): string {
  const key = [normalizeCustomerNameKey(name), foldCustomerNameText(address)]
    .filter(Boolean)
    .join(" ")
    .trim();
  return key.slice(0, 400);
}

type CacheRow = {
  source_type: string;
  source_key: string;
  label: string;
  address_text: string | null;
  city: string | null;
  area: string | null;
  latitude: number | null;
  longitude: number | null;
  geocode_status: string;
  geocode_provider: string;
};

/**
 * LocationIQ first (free), accepted only when its match is precise enough (see
 * LOCATIONIQ_CONFIDENCE_THRESHOLD) — a pharmacy geocoded to a whole city/governorate is worse
 * than no geocode, so a low-confidence hit falls through to Google exactly like a miss would.
 * No independent domain check exists here (unlike brick-centroids.ts's region gate), so the
 * confidence score is the sole accuracy gate.
 */
async function resolvePharmacyGeoComponents(
  searchText: string,
): Promise<{ geo: PharmacyGeo; provider: "locationiq" | "google" } | null> {
  const locationIqResult = await locationIqForwardGeocode(searchText);
  if (
    scoreForwardConfidence(locationIqResult) >= LOCATIONIQ_CONFIDENCE_THRESHOLD &&
    locationIqResult?.lat &&
    locationIqResult?.lon
  ) {
    return {
      geo: {
        governorate: locationIqResult.address?.state ?? null,
        lat: Number(locationIqResult.lat),
        lng: Number(locationIqResult.lon),
        markaz: locationIqResult.address?.state_district ?? locationIqResult.address?.county ?? locationIqResult.address?.city ?? null,
      },
      provider: "locationiq",
    };
  }

  if (!hasGoogleServerKey()) return null;
  const geo = await googleGeocodeComponents(searchText);
  return geo ? { geo, provider: "google" } : null;
}

// Resolve geo info for a batch of pharmacies. Input entries carry the raw name/address; the
// result map is keyed by pharmacyGeoKey(name, address).
export async function resolvePharmacyGeo(
  entries: { name: string; address: string }[],
): Promise<Map<string, PharmacyGeo>> {
  const result = new Map<string, PharmacyGeo>();
  const byKey = new Map<string, { name: string; address: string }>();
  for (const entry of entries) {
    const key = pharmacyGeoKey(entry.name, entry.address);
    if (key && !byKey.has(key)) byKey.set(key, entry);
  }
  const distinct = Array.from(byKey.keys());
  if (distinct.length === 0) return result;

  const supabase = getSupabaseAdmin();

  // 1. Cache pass — rows with real coordinates count as hits; failed rows re-attempt.
  const cachedKeys = new Set<string>();
  try {
    const CHUNK = 200; // .in() with hundreds of long keys — keep each query bounded
    for (let i = 0; i < distinct.length; i += CHUNK) {
      const { data, error } = await supabase
        .from("geo_locations")
        .select("source_key, latitude, longitude, city, area")
        .eq("source_type", SOURCE_TYPE)
        .in("source_key", distinct.slice(i, i + CHUNK));
      if (error) continue;
      (data ?? []).forEach((row) => {
        const r = row as { source_key?: unknown; latitude?: number | null; longitude?: number | null; city?: string | null; area?: string | null };
        const key = String(r.source_key ?? "");
        if (!key || r.latitude == null || r.longitude == null) return;
        result.set(key, {
          governorate: r.city ?? null,
          lat: Number(r.latitude),
          lng: Number(r.longitude),
          markaz: r.area ?? null,
        });
        cachedKeys.add(key);
      });
    }
  } catch {
    // geo_locations unavailable — continue with live geocoding only.
  }

  if (!hasLocationIqKey() && !hasGoogleServerKey()) return result;

  // 2. Live pass for misses, capped.
  const misses = distinct.filter((key) => !cachedKeys.has(key)).slice(0, MAX_LIVE_GEOCODES_PER_CALL);
  for (let index = 0; index < misses.length; index += GEOCODE_CONCURRENCY) {
    const batch = misses.slice(index, index + GEOCODE_CONCURRENCY);
    const geocoded = await Promise.all(
      batch.map(async (key) => {
        const source = byKey.get(key);
        const searchText = [source?.name, source?.address].map((s) => String(s ?? "").trim()).filter(Boolean).join(" ");
        try {
          return { key, resolved: await resolvePharmacyGeoComponents(searchText) };
        } catch {
          return { key, resolved: null };
        }
      }),
    );

    const toCache: CacheRow[] = [];
    geocoded.forEach(({ key, resolved }) => {
      if (!resolved) return; // never cache failures
      const { geo, provider } = resolved;
      result.set(key, { governorate: geo.governorate, lat: geo.lat, lng: geo.lng, markaz: geo.markaz });
      const source = byKey.get(key);
      toCache.push({
        address_text: String(source?.address ?? "").trim() || null,
        area: geo.markaz,
        city: geo.governorate,
        geocode_provider: provider,
        geocode_status: "success",
        label: String(source?.name ?? "").trim().slice(0, 300) || key,
        latitude: geo.lat,
        longitude: geo.lng,
        source_key: key,
        source_type: SOURCE_TYPE,
      });
    });

    if (toCache.length > 0) {
      try {
        await supabase.from("geo_locations").upsert(toCache, { onConflict: "source_type,source_key" });
      } catch {
        // Best-effort cache write; coords are still used this call.
      }
    }
  }

  return result;
}
