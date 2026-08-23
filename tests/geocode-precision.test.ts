import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  EGYPT_COUNTRY_CENTROID,
  isCountryLevelGeocode,
  isEgyptCountryCentroid,
} from "@/lib/google-maps/geocode-precision";

/**
 * The generator of the 2026-08-23 outstation incident, not just its symptom.
 *
 * 23 rows of employee_locations in production held 26.820553, 30.802498 with
 * `geocode_status = 'success'`. Nothing wrote that on purpose: googleGeocodeAddress read
 * `results[0]` unconditionally, and the Geocoding API answers `status: OK` with the COUNTRY
 * centroid when nothing else in the query matched. Every query in this repo ends in ", Egypt",
 * so that fallback is always available. Repairing the rows without closing this would have
 * regenerated them one expense claim at a time.
 *
 * The guard has to be narrow. `destination-geocode.ts` geocodes governorate names deliberately
 * and must keep working, and most Egyptian governorate centres sit near a road — Faiyum's centre
 * routed to Cairo in 135 km, measured the same day. Only `country` is refused.
 */

export function runGeocodePrecisionTests() {
  // --- the coordinate itself -------------------------------------------------------------------

  assert.equal(EGYPT_COUNTRY_CENTROID.lat, 26.820553);
  assert.equal(EGYPT_COUNTRY_CENTROID.lng, 30.802498);

  assert.equal(
    isEgyptCountryCentroid(26.820553, 30.802498),
    true,
    "the exact stored pair must be recognised",
  );
  assert.equal(
    isEgyptCountryCentroid(26.8206, 30.8025),
    true,
    "a rounded copy of the same point must still be recognised",
  );
  assert.equal(
    isEgyptCountryCentroid(30.0444, 31.2357),
    false,
    "central Cairo is not the country centroid",
  );
  assert.equal(
    isEgyptCountryCentroid(29.35647, 30.61999),
    false,
    "the Faiyum governorate centre is a real place and routes normally",
  );

  // --- what the geocoder is allowed to return ---------------------------------------------------

  assert.equal(
    isCountryLevelGeocode({ lat: 26.820553, lng: 30.802498, types: ["country", "political"] }),
    true,
    "a country-typed result is never an address answer",
  );

  assert.equal(
    isCountryLevelGeocode({ lat: 26.820553, lng: 30.802498 }),
    true,
    "the centroid must be refused even when the response carries no types array",
  );

  assert.equal(
    isCountryLevelGeocode({
      lat: 29.35647,
      lng: 30.61999,
      types: ["administrative_area_level_1", "political"],
    }),
    false,
    "a governorate must still geocode — destination-geocode.ts asks for governorates on purpose",
  );

  assert.equal(
    isCountryLevelGeocode({
      lat: 30.10093,
      lng: 31.37471,
      types: ["administrative_area_level_3", "political"],
    }),
    false,
    "a district (Sheraton Al Matar) is a legitimate residence answer",
  );

  assert.equal(
    isCountryLevelGeocode({ lat: 30.07272, lng: 31.21844, types: ["street_address"] }),
    false,
    "a real street address must pass",
  );

  // --- the guard is actually wired into the geocoder ---------------------------------------------

  const serverSource = readFileSync(
    new URL("../src/lib/google-maps/server.ts", import.meta.url),
    "utf8",
  );

  const geocodeFn = serverSource.slice(serverSource.indexOf("export async function googleGeocodeAddress"));

  // Deliberately scoped to the function body, not the file: an unused import at the top would
  // satisfy a whole-file `includes` while the guard did nothing.
  assert.ok(
    geocodeFn.includes("isCountryLevelGeocode("),
    "googleGeocodeAddress must CALL the precision guard, or the fallback returns silently",
  );
  const guardAt = geocodeFn.indexOf("isCountryLevelGeocode(");
  const returnAt = geocodeFn.indexOf("return { lat, lng };");
  assert.ok(guardAt > 0 && returnAt > 0, "expected both the guard and the success return to exist");
  assert.ok(
    guardAt < returnAt,
    "the guard must run BEFORE the coordinate is returned, or callers store the centroid anyway",
  );

  // The three callers all treat null as "nothing found", which is the whole reason returning null is
  // safe here: employee-directory marks the row 'failed' and omits the coordinate columns,
  // destination-geocode skips caching so it retries, and getResidenceLocationForEmployee leaves the
  // coordinate NULL so the route answers 'missing_residence' instead of an unreachable destination.
  const directorySource = readFileSync(
    new URL("../src/lib/employees/employee-directory.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    directorySource.includes("residenceCoordinateColumns(geocoded)"),
    "employee-directory must keep omitting the coordinate columns when the geocode yields nothing",
  );

  const destinationSource = readFileSync(
    new URL("../src/lib/outstation/destination-geocode.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    destinationSource.includes("if (!coords) return;"),
    "destination-geocode must keep refusing to cache a failed lookup",
  );
}
