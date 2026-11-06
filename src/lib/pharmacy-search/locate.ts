/**
 * Putting a pharmacy on the map, and putting a map point back into a territory.
 *
 * These are the two directions the search engine needs:
 *
 * - **Forward** (`resolvePharmacyCoordinates`) — a pharmacy we already hold has a name, an
 *   address and a brick but usually no coordinates; `source_of_sales_customer_map` has no lat/lon
 *   column at all. Three fallbacks, best first, each labelled so the reader knows how precise the
 *   pin is.
 * - **Reverse** (`snapToNearestBrick`) — Google hands back a point for a pharmacy Phoenix has
 *   never seen, and the owner's actual question is "which brick, area and region is it in".
 *   696 of the 700 bricks carry a geocoded centroid, which makes that answerable. The pin table
 *   holds more rows than that — 822 as of 2026-09-08 — because `geo_locations` keeps a pin after
 *   its brick is retired, so the snap considers only bricks the brick table still knows.
 *
 *   The 320 retired pins that merely DUPLICATED a live pin's coordinates were deleted that day.
 *   The 126 that remain sit at coordinates of their OWN, so a retired id can now be genuinely
 *   nearest rather than merely tie a live one: the filter matters MORE after that cleanup, not
 *   less. See `pickNearestBrick`.
 */

import { normalizeArabicPharmacyName } from "@/lib/pharmacy-master/pharmacy-matching";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

import { haversineKm, isUsablePoint, roundKm, type Point } from "./geo";
import { getTerritoryReference, resolveTerritory } from "./reference";
import type { PharmacyCoordinates, PharmacyTerritory } from "./types";

/**
 * Beyond this, "nearest brick centroid" stops meaning anything — Egypt's bricks are districts,
 * not provinces, and a 25 km nearest-neighbour is a desert road, not a territory. The caller
 * shows the distance either way so the reader can judge a borderline one themselves.
 */
export const MAX_BRICK_SNAP_KM = 25;

export type BrickPin = { brickId: string; latitude: number; longitude: number };

let cachedPins: { loadedAt: number; pins: BrickPin[] } | null = null;
const PIN_TTL_MS = 10 * 60 * 1000;

async function loadBrickPins(): Promise<BrickPin[]> {
  if (cachedPins && Date.now() - cachedPins.loadedAt < PIN_TTL_MS) return cachedPins.pins;

  const supabase = getSupabaseAdmin();
  // Paged to the end: a fixed `.limit(5000)` would leave the nearest-brick snap choosing among a
  // subset of the pins, and the brick it returned would be wrong with nothing to show it.
  let data: Array<Record<string, unknown>>;
  try {
    data = await fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("geo_locations")
          .select("source_key, latitude, longitude")
          .eq("source_type", "brick_centroid"),
      "id",
    );
  } catch (error) {
    throw new Error(`Could not load brick centroids: ${toQueryError(error).message}`);
  }

  // A faithful read of the table, retired brick ids included — `pickNearestBrick` is where the
  // live-brick rule is applied, so this stays a plain read with one meaning.
  const pins: BrickPin[] = [];
  for (const row of data) {
    const brickId = String(row.source_key ?? "").trim();
    if (!brickId || !isUsablePoint(row.latitude as number, row.longitude as number)) continue;
    pins.push({ brickId, latitude: row.latitude as number, longitude: row.longitude as number });
  }

  cachedPins = { loadedAt: Date.now(), pins };
  return pins;
}

/** Test seam — drops the brick-pin cache so a following call re-reads. */
export function resetBrickPinCache(): void {
  cachedPins = null;
}

export type BrickSnap = {
  /** Straight-line km from the point to the brick's centroid. Shown to the reader, always. */
  distanceKm: number;
  territory: PharmacyTerritory;
};

/**
 * Nearest LIVE brick to a point. Pure and exported so the tie that matters can be pinned.
 *
 * `geo_locations` pins the same physical centroid under more than one brick vocabulary: a
 * retired id and the current one sit at identical coordinates, so they tie at exactly the same
 * distance and whichever the read happens to return first wins. `isLiveBrick` is what breaks
 * that tie towards the id `source_of_sales_bricks` still knows. A retired id resolves to no area
 * and no region, so snapping to one produces a saved discovery nobody can use — and it fails
 * silently, because a brick id is present and only the territory behind it is empty.
 */
export function pickNearestBrick(options: {
  isLiveBrick: (brickId: string) => boolean;
  pins: readonly BrickPin[];
  point: Point;
}): { brickId: string; distanceKm: number } | null {
  const { isLiveBrick, pins, point } = options;

  let best: { brickId: string; distanceKm: number } | null = null;
  for (const pin of pins) {
    if (!isLiveBrick(pin.brickId)) continue;
    const distanceKm = haversineKm(point, { latitude: pin.latitude, longitude: pin.longitude });
    if (!best || distanceKm < best.distanceKm) best = { brickId: pin.brickId, distanceKm };
  }
  return best;
}

/**
 * Nearest brick to a coordinate, with the area and region that brick belongs to.
 *
 * Returns null when nothing is within `MAX_BRICK_SNAP_KM` — a wrong brick is far more damaging
 * than no brick, because a brick is what decides which area gets credited for a sale.
 */
export async function snapToNearestBrick(point: Point): Promise<BrickSnap | null> {
  const [pins, reference] = await Promise.all([loadBrickPins(), getTerritoryReference()]);
  if (pins.length === 0) return null;

  const best = pickNearestBrick({
    isLiveBrick: (brickId) => reference.bricks.has(brickId),
    pins,
    point,
  });

  if (!best || best.distanceKm > MAX_BRICK_SNAP_KM) return null;

  return {
    distanceKm: roundKm(best.distanceKm),
    territory: resolveTerritory(reference, { brickId: best.brickId }),
  };
}

/**
 * Best available coordinates for a pharmacy we already hold, or null when even the brick has no
 * centroid. `source` is not decoration — a `brick_centroid` pin is the middle of a whole district
 * and must never be presented as the pharmacy's own location.
 */
export async function resolvePharmacyCoordinates(input: {
  brickId: string | null;
  name: string;
}): Promise<PharmacyCoordinates | null> {
  const supabase = getSupabaseAdmin();
  const normalizedName = normalizeArabicPharmacyName(input.name);

  // 1. A rep physically stood there and captured the point — the only first-hand source we have.
  if (normalizedName) {
    const { data, error } = await supabase
      .from("marketing_pharmacies")
      .select("captured_latitude, captured_longitude, normalized_name")
      .eq("normalized_name", normalizedName)
      .not("captured_latitude", "is", null)
      .limit(1);

    if (error) throw new Error(`Marketing pharmacy lookup failed: ${error.message}`);
    const row = data?.[0];
    if (row && isUsablePoint(row.captured_latitude as number, row.captured_longitude as number)) {
      return {
        latitude: row.captured_latitude as number,
        longitude: row.captured_longitude as number,
        source: "marketing_capture",
      };
    }
  }

  // 2. This address was geocoded before and cached — free, and already vetted by whoever ran it.
  if (normalizedName) {
    const { data, error } = await supabase
      .from("geo_locations")
      .select("latitude, longitude")
      .eq("source_type", "pharmacy_address")
      .eq("source_key", normalizedName)
      .limit(1);

    if (error) throw new Error(`Geocode cache lookup failed: ${error.message}`);
    const row = data?.[0];
    if (row && isUsablePoint(row.latitude as number, row.longitude as number)) {
      return {
        latitude: row.latitude as number,
        longitude: row.longitude as number,
        source: "geocode_cache",
      };
    }
  }

  // 3. Fall back to the middle of its brick. Good enough to find nearby doctors, not good enough
  //    to call the pharmacy's location — hence the distinct `source`.
  if (input.brickId) {
    const { data, error } = await supabase
      .from("geo_locations")
      .select("latitude, longitude")
      .eq("source_type", "brick_centroid")
      .eq("source_key", input.brickId)
      .limit(1);

    if (error) throw new Error(`Brick centroid lookup failed: ${error.message}`);
    const row = data?.[0];
    if (row && isUsablePoint(row.latitude as number, row.longitude as number)) {
      return {
        latitude: row.latitude as number,
        longitude: row.longitude as number,
        source: "brick_centroid",
      };
    }
  }

  return null;
}

export function googleMapsUrlFor(point: Point | null, name: string): string | null {
  if (point) return `https://www.google.com/maps/search/?api=1&query=${point.latitude},${point.longitude}`;
  const query = name.trim();
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${query}, Egypt`)}`;
}
