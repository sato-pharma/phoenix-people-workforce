import {
  EGYPT_COUNTRY_CENTROID,
  isEgyptCountryCentroid,
} from "@/lib/google-maps/geocode-precision";

/**
 * Why a residence -> destination distance could not be measured, in words an admin can act on.
 *
 * Google's Routes API answers HTTP 200 with an EMPTY `routes` array when the destination
 * coordinate has no road near it. A governorate's map centre is exactly that: verified live
 * 2026-08-23 against the production server key, the centres of New Valley, Marsa Matrouh,
 * Red Sea and South Sinai all return zero routes, while every city — Alexandria, Hurghada,
 * Siwa, Sharm El Sheikh, even Riyadh and Dubai — routes fine. Sending the place id or the
 * formatted address instead of the coordinate does not help; Google has no road to reach.
 *
 * Two very different faults used to share one sentence that blamed Google for both: a missing
 * `GOOGLE_MAPS_SERVER_KEY` returns the same all-null result as a genuinely unreachable point,
 * so a configuration outage (which is how every map surface died on 2026-08-01) read as "bad
 * destination" and sent the reader hunting the wrong thing.
 */

export type DistanceFailure = {
  error: "maps_not_configured" | "residence_not_geocoded" | "route_not_found";
  message: string;
  status: 422 | 503;
};

function formatCoordinate(value: number) {
  return value.toFixed(5);
}

/**
 * What Google returns when it geocodes the bare word "Egypt": the country's geometric centre, in
 * the Western Desert with no road anywhere near it. Production holds this exact pair in
 * `employee_locations` for 23 employees (16 of them active) whose address never resolved — stored
 * indistinguishably from a real home. Verified 2026-08-23: a route FROM this point returns zero
 * routes to Ebshaway, Faiyum, Cairo and Alexandria alike, so the failure reads as "the destination
 * is unreachable" no matter where the trip actually went.
 *
 * All 19 active rows were repaired in production on 2026-08-23; only resigned employees still
 * hold it. This check stays because the coordinate is still REACHABLE — anything that writes a
 * geocode can produce it again, which is why `isCountryLevelGeocode` now refuses it at the source.
 */
export { EGYPT_COUNTRY_CENTROID };

/**
 * One definition, in src/lib/google-maps/geocode-precision.ts, so the check that REJECTS this
 * coordinate on the way in and the check that EXPLAINS it on the way out can never drift apart.
 */
export function isUnresolvedResidenceCoordinate(latitude: number, longitude: number) {
  return isEgyptCountryCentroid(latitude, longitude);
}

/** The employee has a stored coordinate, but it is the never-geocoded fallback. */
export function unresolvedResidenceFailure(employeeHrId: string): DistanceFailure {
  return {
    error: "residence_not_geocoded",
    message:
      `The home address on file for ${employeeHrId} was never resolved to a real location — it is `
      + `stored as the geographic centre of Egypt (${formatCoordinate(EGYPT_COUNTRY_CENTROID.lat)}, `
      + `${formatCoordinate(EGYPT_COUNTRY_CENTROID.lng)}), open desert with no road. No distance can `
      + "be measured from it to anywhere. Fix the address in the employee directory — or type the "
      + "distance below.",
    status: 422,
  };
}

/** The server has no Google Maps key at all — nothing about the destination is at fault. */
export function mapsNotConfiguredFailure(): DistanceFailure {
  return {
    error: "maps_not_configured",
    message:
      "Google Maps is not configured on this server, so no distance can be measured. "
      + "Type the distance below to continue, and report this to IT.",
    status: 503,
  };
}

/** Google returned no driving route for these coordinates. */
export function noDrivingRouteFailure(params: {
  destinationIsRegion: boolean;
  destinationLabel: string | null;
  destinationLat: number;
  destinationLng: number;
}): DistanceFailure {
  const label = params.destinationLabel?.trim() || null;
  const coordinates = `${formatCoordinate(params.destinationLat)}, ${formatCoordinate(params.destinationLng)}`;

  if (params.destinationIsRegion) {
    return {
      error: "route_not_found",
      message:
        `${label ?? "The selected destination"} is a region, not a place. Google measures to the `
        + `region's map centre (${coordinates}), which sits in open desert with no road, so there `
        + "is no driving route. Pick a city or an exact location — or type the distance below.",
      status: 422,
    };
  }

  return {
    error: "route_not_found",
    message:
      `Google has no driving route to ${label ? `${label} (${coordinates})` : coordinates}. `
      + "That point is off-road — a map centre, desert or water. Pick a nearby city or an exact "
      + "address — or type the distance below.",
    status: 422,
  };
}
