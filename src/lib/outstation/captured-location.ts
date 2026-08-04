/**
 * Human-readable geography for an outstation request's captured GPS point.
 *
 * Owner request (2026-08-04): the captured location must stop rendering as raw
 * coordinates ("30.0444, 31.2357 (±12m)"), and must carry two extra fields — the BRICK
 * the point falls in, and the level above it (area / region).
 *
 * Resolution reuses the CRM check-in resolver (@/lib/crm/brick-geo) rather than a second
 * implementation: bricks in Phoenix are stored as ONE geocoded centre point each, not as
 * boundaries, so "which brick is this GPS in" is answerable only as nearest-centroid plus
 * the distance that justifies it. That distance is always surfaced as a confidence label
 * (owner decision, same date) — a 40 km match in the desert must never render identically
 * to a 200 m match in Dokki.
 *
 * Deriving at READ time, from the coordinates already stored on the request, is deliberate:
 *   - it costs nothing (the centroid index is cached in-process; the match is pure maths),
 *     unlike a Google reverse-geocode which is a paid call per row;
 *   - it follows the owner's standing geography rule — a point always resolves against
 *     TODAY's brick/area/region tree, never the tree as it stood on the trip date.
 * The consequence, accepted: re-bricking an area changes what an old request reports. That
 * is the intended behaviour for this codebase, not a bug to "fix" later.
 */

import { brickMatchConfidence, loadBrickCentroids, resolveBrickForPoint } from "@/lib/crm/brick-geo";
import type { OutstationCapturedLocationSummary } from "@/lib/outstation/types";

export type OutstationCapturedLocation = OutstationCapturedLocationSummary;

/**
 * Rendered when a point cannot be placed at all (no coordinates, or no centroid within
 * range). It says so in words rather than showing "—" or a zero: an unresolvable capture
 * and a capture in an unknown brick are different facts, and neither is "no location".
 */
const UNRESOLVED: OutstationCapturedLocation = {
  areaLabel: "Not resolved",
  brickLabel: "Not resolved",
  confidence: null,
  label: "Location could not be matched to a Phoenix brick",
  regionLabel: "Not resolved",
};

function clean(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/**
 * Resolve one captured point. Best-effort by design: any failure in the geography read
 * yields UNRESOLVED, because a request must never fail to display (or to email) just
 * because the brick index could not be loaded.
 */
export async function resolveOutstationCapturedLocation(input: {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
}): Promise<OutstationCapturedLocation> {
  const { latitude, longitude } = input;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    // 0,0 is the Gulf of Guinea — it is what a failed browser geolocation writes, never a
    // real Egyptian capture, and nearest-centroid would otherwise "resolve" it to whichever
    // brick happens to sit closest to the prime meridian.
    (latitude === 0 && longitude === 0)
  ) {
    return UNRESOLVED;
  }

  try {
    const centroids = await loadBrickCentroids();
    const match = resolveBrickForPoint(latitude, longitude, centroids);
    if (!match) return UNRESOLVED;

    const brickLabel = clean(match.brickName) || clean(match.brickId) || "Not resolved";
    const regionLabel = clean(match.regionName) || "Not resolved";
    // "The level above the brick" — area is that level; region stands in when a brick has
    // no area attached, so the field is never blank while a real answer exists one rung up.
    const areaLabel = clean(match.areaName) || regionLabel;

    const parts = [brickLabel, areaLabel, regionLabel].filter(
      (part, index, all) => part !== "Not resolved" && all.indexOf(part) === index,
    );

    return {
      areaLabel,
      brickLabel,
      confidence: brickMatchConfidence(match.distanceKm),
      label: parts.length > 0 ? parts.join(" · ") : UNRESOLVED.label,
      regionLabel,
    };
  } catch {
    return UNRESOLVED;
  }
}

/**
 * Attach `capturedLocation` to a whole list of requests. Cheap by construction: the centroid
 * index is loaded once and cached in-process for 5 minutes, and each row is then pure maths,
 * so this stays O(rows) with no extra I/O — enriching a full admin page costs one index load.
 * Never throws; a failed enrichment leaves the row's `capturedLocation` null.
 */
export async function attachOutstationCapturedLocations<
  T extends { capturedLatitude: number; capturedLongitude: number },
>(requests: T[]): Promise<Array<T & { capturedLocation: OutstationCapturedLocation | null }>> {
  if (requests.length === 0) return [];
  return Promise.all(
    requests.map(async (request) => ({
      ...request,
      capturedLocation: await resolveOutstationCapturedLocation({
        latitude: request.capturedLatitude,
        longitude: request.capturedLongitude,
      }),
    })),
  );
}
