import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  EGYPT_COUNTRY_CENTROID,
  isUnresolvedResidenceCoordinate,
  mapsNotConfiguredFailure,
  noDrivingRouteFailure,
  unresolvedResidenceFailure,
} from "@/lib/outstation/distance-failure";

/**
 * Reported 2026-08-23, destination "Ebshaway El Fayoum": "Google Maps could not calculate
 * distance / Google Maps could not calculate a driving route to the selected destination."
 *
 * The destination was innocent. Measured live that day from a Cairo residence, Ebshaway routes
 * fine at 109.0 km, as does the Ibsheway markaz centre (109.3 km) and Faiyum Governorate's own
 * centre (116.0 km). What could not be routed was the ORIGIN: 23 rows in employee_locations
 * (16 of them active) store 26.820553, 30.802498 — the coordinate Google returns for the bare
 * word "Egypt", the country's centroid, in roadless Western Desert. From there Google returns
 * zero routes to Ebshaway, Faiyum, Cairo and Alexandria alike, and the old copy reported every
 * one of them as an unreachable destination.
 *
 * Two more faults shared that one sentence: a missing GOOGLE_MAPS_SERVER_KEY (the Routes helper
 * answers with nulls either way, so the 2026-08-01 outage shape would have read as a bad
 * destination), and a "this is a region" warning that fired on any markaz — 0.3 km from the town
 * it was warning about. These tests pin all of them apart.
 */

const routeSource = readFileSync(
  new URL("../app/api/admin/outstation/calculate-manager-distance/route.ts", import.meta.url),
  "utf8",
);
const modalSource = readFileSync(
  new URL("../src/components/outstation/admin-manager-expense-modal.tsx", import.meta.url),
  "utf8",
);
const mapsSource = readFileSync(
  new URL("../src/lib/google-maps/server.ts", import.meta.url),
  "utf8",
);
const placeDetailsSource = readFileSync(
  new URL("../app/api/admin/outstation/place-details/route.ts", import.meta.url),
  "utf8",
);

export function runOutstationDistanceFailureTests() {
  // --- a missing server key is a configuration fault, never a destination fault ---------------
  const notConfigured = mapsNotConfiguredFailure();
  assert.equal(notConfigured.error, "maps_not_configured");
  assert.equal(notConfigured.status, 503, "a missing key is 503, not a 422 about the destination");
  assert.doesNotMatch(
    notConfigured.message,
    /driving route|destination/i,
    "a missing key must not describe the destination as unreachable",
  );
  assert.match(
    notConfigured.message,
    /type the distance below/i,
    "the admin must be told the manual km field still works",
  );

  // --- a region centroid names itself and says what to do instead -----------------------------
  const region = noDrivingRouteFailure({
    destinationIsRegion: true,
    destinationLabel: "Marsa Matrouh Governorate",
    destinationLat: 29.569635,
    destinationLng: 26.419389,
  });
  assert.equal(region.error, "route_not_found");
  assert.equal(region.status, 422);
  assert.match(region.message, /Marsa Matrouh Governorate/, "the region must be named in full");
  assert.match(region.message, /is a region, not a place/, "the cause must be stated plainly");
  assert.match(
    region.message,
    /29\.56964, 26\.41939/,
    "the map centre actually measured must be shown, at the same 5 decimals as the UI",
  );
  assert.match(
    region.message,
    /Pick a city or an exact location/,
    "the admin must be told the action that fixes it",
  );
  assert.doesNotMatch(
    region.message,
    /^Google/,
    "an admin's own choice of a region must not open by blaming Google",
  );

  // An unnamed region still reads as a sentence rather than starting with a blank.
  const unnamedRegion = noDrivingRouteFailure({
    destinationIsRegion: true,
    destinationLabel: "   ",
    destinationLat: 24.6826316,
    destinationLng: 34.1531947,
  });
  assert.match(
    unnamedRegion.message,
    /^The selected destination is a region, not a place\./,
    "a blank label must fall back to a readable subject, not an empty one",
  );

  // --- an ordinary off-road point is a different sentence -------------------------------------
  const offRoad = noDrivingRouteFailure({
    destinationIsRegion: false,
    destinationLabel: "Some Point",
    destinationLat: 27.1234567,
    destinationLng: 33.7654321,
  });
  assert.equal(offRoad.error, "route_not_found");
  assert.equal(offRoad.status, 422);
  assert.match(offRoad.message, /Some Point \(27\.12346, 33\.76543\)/);
  assert.doesNotMatch(
    offRoad.message,
    /is a region, not a place/,
    "a specific place must not be described as a region",
  );

  const offRoadUnlabelled = noDrivingRouteFailure({
    destinationIsRegion: false,
    destinationLabel: null,
    destinationLat: 27.1234567,
    destinationLng: 33.7654321,
  });
  assert.match(
    offRoadUnlabelled.message,
    /no driving route to 27\.12346, 33\.76543\./,
    "with no label the coordinates alone must still read as a sentence",
  );

  // --- a residence that never geocoded is the origin's fault, not the destination's -----------
  assert.equal(EGYPT_COUNTRY_CENTROID.lat, 26.820553);
  assert.equal(EGYPT_COUNTRY_CENTROID.lng, 30.802498);
  assert.equal(
    isUnresolvedResidenceCoordinate(26.820553, 30.802498),
    true,
    "the exact stored fallback must be recognised",
  );
  assert.equal(
    isUnresolvedResidenceCoordinate(26.8206, 30.8024),
    true,
    "a rounded copy of the same fallback must still be recognised",
  );
  for (const [label, lat, lng] of [
    ["Cairo", 30.0444, 31.2357],
    ["Ebshaway, Fayoum", 29.3599615, 30.6890055],
    ["Assiut", 27.1839316, 31.1830756],
    ["Minya, ~150 km north of the centroid", 28.11083, 30.7484795],
  ] as const) {
    assert.equal(
      isUnresolvedResidenceCoordinate(lat, lng),
      false,
      `a real residence (${label}) must never be mistaken for the country centroid`,
    );
  }

  const unresolved = unresolvedResidenceFailure("B-52");
  assert.equal(unresolved.error, "residence_not_geocoded");
  assert.equal(unresolved.status, 422);
  assert.match(unresolved.message, /B-52/, "the employee must be named so HR can fix the address");
  assert.match(
    unresolved.message,
    /26.82055, 30.80250/,
    "the useless coordinate actually stored must be shown",
  );
  assert.doesNotMatch(
    unresolved.message,
    /destination/i,
    "a broken origin must never be reported as a problem with the destination",
  );
  assert.match(
    unresolved.message,
    /employee directory/,
    "the admin must be told where the real fix lives",
  );

  // --- the wiring that makes any of the above reachable ---------------------------------------
  assert.match(
    mapsSource,
    /export function isGoogleMapsServerKeyConfigured\(\)/,
    "the Maps helper must expose whether a server key exists at all",
  );
  assert.match(
    routeSource,
    /if \(!isGoogleMapsServerKeyConfigured\(\)\) \{/,
    "the route must separate a missing key from a missing route BEFORE calling Google",
  );
  assert.doesNotMatch(
    routeSource,
    /Google Maps could not calculate a driving route/,
    "the old catch-all sentence must be gone from the route",
  );
  assert.match(
    routeSource,
    /noDrivingRouteFailure\(\{\s*destinationIsRegion,\s*destinationLabel,\s*destinationLat,\s*destinationLng,\s*\}\)/,
    "the route must build its message from the shared helper, with the region flag and label",
  );

  // The client sends the flag it computed locally — reading the React state in the same tick
  // would always send false, because setDestinationIsRegion has not committed yet.
  assert.match(
    modalSource,
    /const isRegion = Boolean\(placePayload\.isAdministrativeArea\);\s*\n\s*setDestinationIsRegion\(isRegion\);/,
    "the modal must derive one local isRegion and use it for both the banner and the request",
  );
  assert.match(
    modalSource,
    /await calculateDistance\(resolved, hrIdForDistance, isRegion\);/,
    "the first distance call must pass the freshly derived flag, not the stale state",
  );
  assert.match(
    modalSource,
    /void calculateDistance\(dest, hrIdForDistance, destinationIsRegionRef\.current\);/,
    "the HR-ID-change recalculation must read the settled flag through a ref",
  );
  assert.match(
    modalSource,
    /destinationIsRegion: isRegion,\s*\n\s*destinationLabel: dest\.label,/,
    "the request body must carry both the region flag and the human-readable label",
  );
  assert.doesNotMatch(
    modalSource,
    /Google Maps could not calculate distance/,
    "the headline must not blame Google for a missing key or a region the admin picked",
  );

  // The origin guard must run BEFORE Google is called — a centroid origin is knowable without it.
  const guardAt = routeSource.indexOf("isUnresolvedResidenceCoordinate(");
  const callAt = routeSource.indexOf("await googleDirectionsRoute(");
  assert.notEqual(guardAt, -1, "the route must check for a never-geocoded residence");
  assert.ok(
    guardAt < callAt,
    "the never-geocoded residence check must run before the Routes call, not after it",
  );

  // A markaz is a town, not a region — warning on it was 0.3 km of noise.
  const broadRegionBlock = placeDetailsSource.slice(
    placeDetailsSource.indexOf("const BROAD_REGION_TYPES"),
    placeDetailsSource.indexOf("const isAdministrativeArea"),
  );
  assert.ok(
    broadRegionBlock.includes("administrative_area_level_1"),
    "a governorate must still count as a broad region",
  );
  assert.ok(
    broadRegionBlock.includes("country"),
    "a country must still count as a broad region",
  );
  for (const level of [
    "administrative_area_level_2",
    "administrative_area_level_3",
    "administrative_area_level_4",
  ]) {
    assert.ok(
      !broadRegionBlock.includes(level),
      level + " is town-level in Egypt and must not trigger the region warning",
    );
  }
}
