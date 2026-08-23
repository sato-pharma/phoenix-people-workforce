// When a Google geocode answer is too coarse to be an address.
//
// The Geocoding API always answers something. Ask it for a street it cannot find and it falls
// back up the hierarchy until something matches -- and because every query in this repo appends
// ", Egypt", the last thing left to match is the country itself. Google then returns the
// country's geometric centre with `types: ["country", "political"]` and `status: "OK"`, which is
// indistinguishable from a real result to any caller that reads `results[0].geometry.location`.
//
// That is not a hypothesis. On 2026-08-23, 23 rows of `employee_locations` in production held
// exactly 26.820553, 30.802498 -- 16 of them active employees -- each stored with
// `geocode_status = 'success'`. Every outstation distance measured from one of those homes failed,
// because the point is open desert in the Western Sahara with no road: the Routes API answers
// HTTP 200 with an EMPTY routes array, and the error message blamed the DESTINATION. The owner
// spent that failure hunting a town that was never the problem.
//
// `residenceGeocodeQuery` in src/lib/employees/residence-geocode-policy.ts already guards the
// narrower version of this -- all three address parts empty, leaving the literal string "Egypt".
// This module guards the general case: parts present, but nothing in them resolved.

/** What Google returns for the bare word "Egypt": the country's geometric centre. */
export const EGYPT_COUNTRY_CENTROID = { lat: 26.820553, lng: 30.802498 } as const;

/** ~100 m. No real home sits that close to the centre of the Western Desert. */
const CENTROID_TOLERANCE_DEGREES = 0.001;

export function isEgyptCountryCentroid(latitude: number, longitude: number) {
  return (
    Math.abs(latitude - EGYPT_COUNTRY_CENTROID.lat) < CENTROID_TOLERANCE_DEGREES
    && Math.abs(longitude - EGYPT_COUNTRY_CENTROID.lng) < CENTROID_TOLERANCE_DEGREES
  );
}

export type GeocodeCandidate = {
  lat: number;
  lng: number;
  types?: string[] | null;
};

/**
 * True when the only thing Google matched was the country, so the coordinate says nothing about
 * the address that was asked for.
 *
 * Deliberately narrow. `administrative_area_level_1` is NOT rejected: a governorate is a
 * legitimate answer for `destination-geocode.ts`, which geocodes governorate names on purpose,
 * and most Egyptian governorate centres sit near a road (measured: Faiyum's centre routes to
 * Cairo in 135 km). Only `country` -- and the centroid coordinate itself, in case a future
 * response omits the types array -- means "nothing you asked for was found".
 */
export function isCountryLevelGeocode(candidate: GeocodeCandidate) {
  if (candidate.types?.includes("country")) return true;
  return isEgyptCountryCentroid(candidate.lat, candidate.lng);
}
