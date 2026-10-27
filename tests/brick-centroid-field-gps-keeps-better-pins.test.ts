import assert from "node:assert/strict";

import { fieldGpsMayReplacePin, planFieldGpsUpserts } from "../src/lib/sales/normalizer/brick-centroids.ts";
import type { BrickCentroid } from "../src/lib/sales/normalizer/geo-validate.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The field-GPS pass of "Build geo index" must never replace a better brick pin.
//
// buildBrickCentroids' Pass 1 upserted geocode_provider='field_gps' for every brick with
// pharmacy GPS, without reading the pin already there. It overwrote the owner's own pins
// (provider 'manual') and the pins hand-corrected to google_geocode on 2026-10-27 (B196-1,
// B196-7, B196-10, B195-7, B44-26). Measured on production the same day, one press of the button
// would have replaced 14 better pins — 4 google_geocode (B11-10, B196-11, B201-1, B202-6) and 10
// google_places_hint — with the median of reps' phone GPS.
//
// Owner rule: rep GPS is never ground truth (check-ins can be spoofed). Field GPS may only replace
// a pin the territory map's own ranking, pinConfidence, trusts no more than field GPS (40%).
//
// The headline invariant, and the one that fires if this regresses:
//   a manual pin and a google_geocode pin survive Pass 1; a shared-fallback pin is replaced.
// ─────────────────────────────────────────────────────────────────────────────

const GPS = { lat: 30.5, lng: 31.2 };

function pin(provider: string | null, status = "success"): BrickCentroid {
  return { governorate: null, lat: 30.1, lng: 31.1, markaz: null, provider, status };
}

export function runBrickCentroidFieldGpsKeepsBetterPinsTests() {
  // The headline case, through the planner Pass 1 calls.
  const bricks = [
    { brickId: "B-MANUAL", brickName: "Owner's pin" },
    { brickId: "B-GOOGLE", brickName: "Hand-corrected district" },
    { brickId: "B-SHARED", brickName: "Town-centre fallback" },
  ];
  const fieldGps = new Map(bricks.map((brick) => [brick.brickId, GPS]));
  const existing = new Map<string, BrickCentroid>([
    ["B-MANUAL", pin("manual")],
    ["B-GOOGLE", pin("google_geocode")],
    ["B-SHARED", pin("google_geocode", "shared_fallback")],
  ]);
  const plan = planFieldGpsUpserts(bricks, fieldGps, existing);
  const written = plan.upserts.map((row) => row.source_key);
  assert.deepEqual(
    plan.kept.sort(),
    ["B-GOOGLE", "B-MANUAL"],
    "a person's pin and a named-district geocode must survive the field-GPS pass",
  );
  assert.deepEqual(written, ["B-SHARED"], "a shared-fallback pin locates nothing, so field GPS must replace it");
  assert.equal(plan.upserts[0].geocode_provider, "field_gps");
  assert.equal(plan.upserts[0].geocode_status, "success");
  assert.equal(plan.upserts[0].latitude, GPS.lat);
  assert.equal(plan.upserts[0].longitude, GPS.lng);

  // The ranking is pinConfidence's, not a new one: everything above field GPS (40%) is kept.
  assert.equal(fieldGpsMayReplacePin(pin("manual:b-10")), false, "a 'manual:<hr id>' provider is a person's pin too");
  assert.equal(fieldGpsMayReplacePin(pin("manual", "shared_fallback")), false, "a person's pin is kept whatever its status");
  assert.equal(fieldGpsMayReplacePin(pin("google_places_hint")), false, "a named-place match (70%) outranks field GPS");
  assert.equal(fieldGpsMayReplacePin(pin("google_places")), false, "a named-place match (70%) outranks field GPS");
  assert.equal(fieldGpsMayReplacePin(pin("locationiq")), false, "an unverified geocode (50%) outranks field GPS");

  // ...and everything at or below it, or that failed its gate, is replaced.
  assert.equal(fieldGpsMayReplacePin(undefined), true, "a brick with no pin takes field GPS");
  assert.equal(fieldGpsMayReplacePin(pin("checkin_gps")), true, "check-in GPS (40%) is no better than field GPS");
  assert.equal(fieldGpsMayReplacePin(pin("google_block_centre")), true, "a block centre (40%) is no better than field GPS");
  assert.equal(fieldGpsMayReplacePin(pin("google_area_centre")), true, "an area centre (30%) is worse than field GPS");
  assert.equal(fieldGpsMayReplacePin(pin("field_gps")), true, "an older field-GPS pin is refreshed");
  assert.equal(fieldGpsMayReplacePin(pin("google", "region_mismatch")), true, "a pin that failed the region gate locates nothing");
  assert.equal(fieldGpsMayReplacePin(pin("google_geocode", "region_mismatch")), true, "a named geocode that failed its gate locates nothing");

  // A brick without field GPS is never touched, whatever pin it has.
  const untouched = planFieldGpsUpserts([{ brickId: "B-NOGPS", brickName: "" }], new Map(), new Map([["B-NOGPS", pin("checkin_gps")]]));
  assert.deepEqual(untouched, { kept: [], upserts: [] });
}
