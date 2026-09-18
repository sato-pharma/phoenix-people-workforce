/**
 * Server side of the evidence location stamp: turn one GPS pin into an address plus the Phoenix
 * brick / area / region it falls in.
 *
 * Two independent lookups, run together because neither needs the other:
 *   - Google reverse geocoding gives the street address a human recognises;
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

/**
 * Google's best single-string address, falling back to the components it did return.
 *
 * `formattedAddress` is null on a pin in the desert or over water, but `area`/`city` often survive
 * — "Badr City, Cairo" is far more use to an approver than nothing at all.
 */
function pickAddress(result: Awaited<ReturnType<typeof googleReverseGeocode>>): string | null {
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
 */
export async function resolveEvidenceLocation(input: {
  accuracyMeters?: number | null;
  latitude: number;
  longitude: number;
}): Promise<EvidenceLocationPayload> {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);

  const [geocode, centroids] = await Promise.all([
    googleReverseGeocode({ lat: latitude, lng: longitude })
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
