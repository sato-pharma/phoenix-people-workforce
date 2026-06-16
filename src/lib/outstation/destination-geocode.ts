import { googleGeocodeAddress } from "@/lib/google-maps/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Geocode outstation expense destination strings (the historical "to_location" /
// request "to_label" — real Egyptian town/city names) to precise coordinates so the
// map plots actual destinations rather than region approximations.
//
// Results are cached persistently in the existing `geo_locations` table (no new
// migration): each distinct destination is geocoded ONCE, then served from cache.
// Failures are cached too so they aren't re-tried every load. Everything degrades
// gracefully — if the table or the server key is unavailable we simply return what
// we have and the caller falls back to the region centroid.

export type Coords = { lat: number; lng: number };

const SOURCE_TYPE = "outstation_destination";
const GEOCODE_CONCURRENCY = 8;

export function normalizeDestinationKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

type CacheRow = {
  source_type: string;
  source_key: string;
  label: string;
  latitude: number | null;
  longitude: number | null;
  geocode_status: string;
  geocode_provider: string;
};

export async function resolveDestinationCoords(destinations: string[]): Promise<Map<string, Coords>> {
  const result = new Map<string, Coords>();
  const distinct = Array.from(new Set(destinations.map(normalizeDestinationKey).filter(Boolean)));
  if (distinct.length === 0) return result;

  const supabase = getSupabaseAdmin();

  // 1. Load whatever is already cached (success OR previously-failed).
  const cachedKeys = new Set<string>();
  try {
    const { data, error } = await supabase
      .from("geo_locations")
      .select("source_key, latitude, longitude")
      .eq("source_type", SOURCE_TYPE)
      .in("source_key", distinct);
    if (!error) {
      (data ?? []).forEach((row) => {
        const key = String((row as { source_key?: unknown }).source_key ?? "");
        if (!key) return;
        cachedKeys.add(key);
        const lat = (row as { latitude?: number | null }).latitude;
        const lng = (row as { longitude?: number | null }).longitude;
        if (lat != null && lng != null) result.set(key, { lat: Number(lat), lng: Number(lng) });
      });
    }
  } catch {
    // geo_locations missing — proceed with live geocoding only (no persistent cache).
  }

  // 2. Geocode the not-yet-attempted destinations in small parallel batches.
  const misses = distinct.filter((key) => !cachedKeys.has(key));
  for (let index = 0; index < misses.length; index += GEOCODE_CONCURRENCY) {
    const batch = misses.slice(index, index + GEOCODE_CONCURRENCY);
    const geocoded = await Promise.all(
      batch.map(async (key) => {
        try {
          const coords = await googleGeocodeAddress(`${key}, Egypt`);
          return { key, coords };
        } catch {
          return { key, coords: null as Coords | null };
        }
      }),
    );

    const toCache: CacheRow[] = [];
    geocoded.forEach(({ key, coords }) => {
      if (coords) result.set(key, coords);
      toCache.push({
        source_type: SOURCE_TYPE,
        source_key: key,
        label: key,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        geocode_status: coords ? "success" : "failed",
        geocode_provider: "google",
      });
    });

    if (toCache.length > 0) {
      try {
        await supabase.from("geo_locations").upsert(toCache, { onConflict: "source_type,source_key" });
      } catch {
        // Cache write is best-effort; the geocoded coords are still used this load.
      }
    }
  }

  return result;
}
