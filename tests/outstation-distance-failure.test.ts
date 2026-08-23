import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  mapsNotConfiguredFailure,
  noDrivingRouteFailure,
} from "@/lib/outstation/distance-failure";

/**
 * Reported 2026-08-23: adding a manager outstation expense showed "Google Maps could not
 * calculate distance / Google Maps could not calculate a driving route to the selected
 * destination." The production Maps key was healthy at the time (Cairo -> Alexandria answered
 * 218.4 km, HTTP 200), and all 132 employee residences on record sit inside Egypt — so nothing
 * was broken. Google simply returns HTTP 200 with an EMPTY routes array when the destination
 * has no road near it, which is what a governorate's map centre is: New Valley, Marsa Matrouh,
 * Red Sea and South Sinai centres all answer zero routes, while every city routes fine.
 *
 * The old copy blamed Google for a destination the admin chose, and — worse — said exactly the
 * same thing when GOOGLE_MAPS_SERVER_KEY was missing, because the Routes helper answers with
 * nulls in both cases. These tests pin the two failures apart.
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
}
