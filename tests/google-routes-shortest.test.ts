import assert from "node:assert/strict";

import {
  buildGoogleRouteAlternatives,
  selectFastestGoogleRoute,
} from "../src/lib/google-maps/server.ts";

export function runGoogleRoutesShortestTests() {
  const routes = [
    {
      distanceMeters: 82000,
      duration: "4200s",
      polyline: { encodedPolyline: "long-route" },
    },
    {
      distanceMeters: 61000,
      duration: "5100s",
      polyline: { encodedPolyline: "shortest-route" },
    },
    {
      distanceMeters: 70000,
      duration: "3900s",
      polyline: { encodedPolyline: "fast-route" },
    },
  ];
  const selected = selectFastestGoogleRoute(routes);

  assert.equal(selected?.distanceMeters, 70000);
  assert.equal(selected?.duration, "3900s");
  assert.equal(selected?.polyline?.encodedPolyline, "fast-route");

  const selectedWithTraffic = selectFastestGoogleRoute([
    {
      distanceMeters: 70000,
      duration: "3600s",
      staticDuration: "2400s",
      polyline: { encodedPolyline: "traffic-slow" },
    },
    {
      distanceMeters: 86000,
      duration: "3000s",
      staticDuration: "4200s",
      polyline: { encodedPolyline: "traffic-fast" },
    },
  ]);

  assert.equal(selectedWithTraffic?.distanceMeters, 86000);
  assert.equal(selectedWithTraffic?.polyline?.encodedPolyline, "traffic-fast");

  const alternatives = buildGoogleRouteAlternatives(routes);
  assert.equal(alternatives.length, 3);
  assert.equal(alternatives[2]?.isSelected, true);
  assert.equal(alternatives[2]?.distanceMeters, 70000);
  assert.equal(alternatives[2]?.durationSeconds, 3900);
  assert.equal(alternatives[2]?.encodedPolyline, "fast-route");
  assert.equal(alternatives[0]?.isSelected, false);

  const selectedWithInvalidDurations = selectFastestGoogleRoute([
    {
      distanceMeters: 51000,
      polyline: { encodedPolyline: "missing-duration" },
    },
    {
      distanceMeters: 58000,
      duration: "invalid",
      polyline: { encodedPolyline: "invalid-duration" },
    },
    {
      distanceMeters: 92000,
      duration: "3600s",
      polyline: { encodedPolyline: "valid-duration" },
    },
  ]);

  assert.equal(selectedWithInvalidDurations?.distanceMeters, 92000);
  assert.equal(selectedWithInvalidDurations?.polyline?.encodedPolyline, "valid-duration");

  assert.equal(selectFastestGoogleRoute([]), null);
  assert.equal(selectFastestGoogleRoute(null), null);
}
