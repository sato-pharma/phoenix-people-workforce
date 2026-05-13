import assert from "node:assert/strict";

import { selectShortestGoogleRoute } from "../src/lib/geo-intelligence/google.ts";

export function runGoogleRoutesShortestTests() {
  const selected = selectShortestGoogleRoute([
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
  ]);

  assert.equal(selected?.distanceMeters, 61000);
  assert.equal(selected?.duration, "5100s");
  assert.equal(selected?.polyline?.encodedPolyline, "shortest-route");

  const selectedWithInvalidDistances = selectShortestGoogleRoute([
    {
      duration: "3000s",
      polyline: { encodedPolyline: "missing-distance" },
    },
    {
      distanceMeters: Number.NaN,
      duration: "2400s",
      polyline: { encodedPolyline: "invalid-distance" },
    },
    {
      distanceMeters: 58000,
      duration: "3600s",
      polyline: { encodedPolyline: "valid-distance" },
    },
  ]);

  assert.equal(selectedWithInvalidDistances?.distanceMeters, 58000);
  assert.equal(selectedWithInvalidDistances?.polyline?.encodedPolyline, "valid-distance");

  assert.equal(selectShortestGoogleRoute([]), null);
  assert.equal(selectShortestGoogleRoute(null), null);
}
