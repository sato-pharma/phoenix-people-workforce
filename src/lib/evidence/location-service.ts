/**
 * Server side of the evidence location stamp: turn one GPS pin into an address plus the Phoenix
 * brick / area / region it falls in.
 *
 * Two independent lookups, run together because neither needs the other:
 *   - Google reverse geocoding gives the street address a human recognises (for Phoenix CRM's captures
 *     only, remembered for a few hours per ~11 m cell — `memoizeReverseGeocode` — because a rep asks
 *     it again at every door he returns to);
 *   - the brick centroid index (`src/lib/crm/brick-geo.ts`) gives the Phoenix territory, which
 *     Google has never heard of and which is the half an approver actually acts on.
 *
 * BEST EFFORT BY DESIGN. Every capture surface takes the photo AFTER the location resolves, so a
 * throw here would block a rep from filing evidence at all — over an address caption. Both halves
 * therefore degrade to null and the caption says so in words (see `location-stamp.ts`); the
 * coordinates are captured by the device and never depend on this call.
 */

import { loadBrickCentroids, resolveBrickForPoint } from "@/lib/crm/brick-geo";
import { readAccuracyInput, readCoordinateInput } from "@/lib/geo/coordinate-input";
import { googleReverseGeocode } from "@/lib/google-maps/server";

import type { EvidenceLocationStamp } from "./location-stamp";
import { formatEvidenceLocationLabel, formatEvidenceLocationLines } from "./location-stamp";

/** What an evidence-location endpoint hands back: the facts, plus the exact text to burn in. */
export type EvidenceLocationPayload = EvidenceLocationStamp & {
  /**
   * Google's own address components, passed through untouched.
   *
   * The marketing capture screen writes these into the customer's OWN area/governorate fields, so
   * they must stay exactly what Google said — never the Phoenix territory resolved below, which is
   * where the pin fell, not what the pharmacy is registered as. (Owner rule: for a marketing
   * customer the REGISTERED CODE beats live GPS.)
   */
  components: { area: string | null; city: string | null; governorate: string | null };
  /** One-line form, for `capturedLocationLabel` and the approver screens. */
  label: string;
  /** The lines for the photo's watermark panel, already worded and ordered. */
  lines: string[];
};

type ReverseGeocode = Awaited<ReturnType<typeof googleReverseGeocode>>;

/**
 * Four decimals of a degree is about 11 m of latitude (and a little less of longitude at Egypt's
 * latitudes) — inside the error of any phone fix, which is tens of metres at its best — so two
 * captures in one cell are, as far as the GPS can tell, the same spot.
 */
export const REVERSE_GEOCODE_CELL_DECIMALS = 4;
/** A street address does not move in an afternoon; a rename or a new building waits out this window. */
export const REVERSE_GEOCODE_TTL_MS = 6 * 60 * 60 * 1000;
/** A bound, so the memo stays around a megabyte whatever the field does: one address and three names a cell. */
export const REVERSE_GEOCODE_MAX_ENTRIES = 2000;

/** The cell a coordinate falls in, as the memo's key. */
export function reverseGeocodeCell(latitude: number, longitude: number): string {
  return `${latitude.toFixed(REVERSE_GEOCODE_CELL_DECIMALS)},${longitude.toFixed(REVERSE_GEOCODE_CELL_DECIMALS)}`;
}

/**
 * A reverse-geocode lookup that answers a capture from memory when one was already made in the same
 * cell within the last few hours.
 *
 * WHY (2026-10-16 Phoenix CRM performance audit). Every photo a rep takes asks Google for the street
 * address of where he stands — a paid call, a few hundred milliseconds he waits through before the
 * shutter can stamp the picture — and the answer was never reused, though a rep standing at the same
 * door for a place photo, then a visit, then a second visit later in the week, asks the same question
 * each time. Production is one long-lived Node process, so a small map in memory serves every request.
 *
 * ONLY THE ADDRESS IS REUSED, never the reading. The caller's own latitude, longitude and accuracy go
 * into the stamp exactly as captured, and the brick is still resolved from those exact coordinates; the
 * memo holds Google's answer for the CELL, which is the first capture's address for every capture
 * inside it until it expires.
 *
 * Only a real answer is kept. A missing key (null) and a Google failure (a throw) are never remembered,
 * so the next capture asks again exactly as before. Least recently used goes first when it is full.
 * The lookup and the clock are arguments so the test can drive both.
 */
export function memoizeReverseGeocode(
  lookup: (location: { lat: number; lng: number }) => Promise<ReverseGeocode>,
  options: { maxEntries: number; ttlMs: number; now?: () => number },
): (latitude: number, longitude: number) => Promise<ReverseGeocode> {
  const now = options.now ?? Date.now;
  const remembered = new Map<string, { at: number; result: NonNullable<ReverseGeocode> }>();
  return async (latitude, longitude) => {
    const cell = reverseGeocodeCell(latitude, longitude);
    const hit = remembered.get(cell);
    if (hit) {
      remembered.delete(cell);
      if (now() - hit.at < options.ttlMs) {
        // A Map keeps insertion order, so putting the entry back moves it to the newest end — which
        // is what makes evicting from the front, below, a least-recently-used eviction.
        remembered.set(cell, hit);
        return hit.result;
      }
    }
    // The miss asks for the capture's OWN coordinates, never the cell's rounded corner, so the first
    // capture in a cell gets exactly the address it would have got before this memo existed.
    const result = await lookup({ lat: latitude, lng: longitude });
    if (result) {
      remembered.set(cell, { at: now(), result });
      while (remembered.size > options.maxEntries) {
        const oldest = remembered.keys().next();
        if (oldest.done) break;
        remembered.delete(oldest.value);
      }
    }
    return result;
  };
}

const reverseGeocodeNearby = memoizeReverseGeocode(googleReverseGeocode, {
  maxEntries: REVERSE_GEOCODE_MAX_ENTRIES,
  ttlMs: REVERSE_GEOCODE_TTL_MS,
});

/**
 * Google's best single-string address, falling back to the components it did return.
 *
 * `formattedAddress` is null on a pin in the desert or over water, but `area`/`city` often survive
 * — "Badr City, Cairo" is far more use to an approver than nothing at all.
 */
function pickAddress(result: ReverseGeocode): string | null {
  if (!result) return null;
  const formatted = String(result.formattedAddress ?? "").trim();
  if (formatted) return formatted;
  const composed = [result.area, result.city, result.governorate]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean);
  // The three components overlap often enough ("Giza" as both city and governorate) that a naive
  // join prints the same word twice on the photo.
  return Array.from(new Set(composed)).join(", ") || null;
}

/**
 * Resolve one captured pin into the full evidence stamp.
 *
 * Never throws. A caller that gets `address: null` and `brickName: null` still has a usable stamp —
 * the coordinates it passed in are echoed back and the wording covers the gap.
 *
 * `reuseNearbyAddress` is Phoenix CRM's alone (its photo stamp and its place save): the outstation,
 * direct-order and marketing captures ask Google every time, exactly as before 2026-10-16, because
 * the marketing capture writes Google's area and governorate into the customer it creates.
 */
export async function resolveEvidenceLocation(
  input: {
    accuracyMeters?: number | null;
    latitude: number;
    longitude: number;
  },
  options: { reuseNearbyAddress?: boolean } = {},
): Promise<EvidenceLocationPayload> {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);

  const [geocode, centroids] = await Promise.all([
    // With `reuseNearbyAddress`, answered from memory when a capture in the same ~11 m cell asked
    // within the last few hours — see `memoizeReverseGeocode`; the coordinates below are still the
    // ones passed in.
    (options.reuseNearbyAddress ? reverseGeocodeNearby(latitude, longitude) : googleReverseGeocode({ lat: latitude, lng: longitude }))
      // A missing GOOGLE_MAPS_SERVER_KEY returns null; a 5xx from Google throws. Neither may cost
      // the rep their photo.
      .catch(() => null),
    // Already degrades to [] internally on any database error.
    loadBrickCentroids(),
  ]);

  const address = pickAddress(geocode);
  const brick = resolveBrickForPoint(latitude, longitude, centroids);

  const stamp: EvidenceLocationStamp = {
    // Never `Number(...)`: `Number(null)` is 0, which stamped a withheld accuracy as "±0 m".
    accuracyMeters: readAccuracyInput(input.accuracyMeters),
    address,
    areaName: brick?.areaName ?? null,
    // Rounded to 100 m: the caption reads "42 km away", and carrying 13 decimals of a haversine
    // into a JSON payload invites someone to treat it as a measurement.
    brickDistanceKm: brick ? Math.round(brick.distanceKm * 10) / 10 : null,
    brickName: brick?.brickName ?? null,
    latitude,
    longitude,
    regionName: brick?.regionName ?? null,
  };

  return {
    ...stamp,
    components: {
      area: geocode?.area ?? null,
      city: geocode?.city ?? null,
      governorate: geocode?.governorate ?? null,
    },
    label: formatEvidenceLocationLabel(stamp),
    lines: formatEvidenceLocationLines(stamp),
  };
}

/**
 * Shared request parsing for the four evidence-location endpoints (outstation, direct orders,
 * marketing, Phoenix CRM). Returns the coordinates, or null, which every one of those routes
 * answers as "no position" — the routes differ only in which permission they assert, never in
 * what they read.
 *
 * Each coordinate is read with readCoordinateInput, never `Number(...)`: `Number(null)`, `Number("")`
 * and `Number(" ")` are all 0, so a request with a blank latitude and longitude was stamped at
 * 0°N 0°E, in the Gulf of Guinea, and that fake pin was burned into the photo as the rep's
 * position. A blank coordinate now takes the same refusal a missing one always did, and the phone
 * falls back to its own "lookup unavailable" stamp, so the photo is never lost over it.
 */
export function parseEvidenceLocationBody(body: Record<string, unknown>):
  | { accuracyMeters: number | null; latitude: number; longitude: number }
  | null {
  const latitude = readCoordinateInput(body.latitude);
  const longitude = readCoordinateInput(body.longitude);
  if (latitude == null || longitude == null) return null;
  // A pin outside these bounds is a unit mix-up (radians, or lat/lng swapped), not a place.
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return {
    accuracyMeters: readAccuracyInput(body.accuracyMeters ?? body.accuracy),
    latitude,
    longitude,
  };
}
