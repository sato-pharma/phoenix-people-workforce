import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  coordinateKey,
  sharedCoordinateKeys,
  type BrickPin,
} from "../src/lib/territory-management/service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Territory Management — the shared-pin guard (production defect, found 2026-09-22).
//
// A brick whose pin locates nothing must never be drawn as though it does. The module already
// honoured the geocoder's OWN admission of that (`geocode_status = 'shared_fallback'`, demoted to
// 25% and listed as unlocated). What it did not catch was the same failure arriving with a
// `success` stamp: separate successful geocodes that happened to return the SAME coordinate.
//
// Measured on production that day, across the 668 bricks the module shows: 29 bricks sat on 12
// coordinates shared by more than one brick, every one of them stamped `success`. The worst was
// Damietta (D26):
//
//   • دمياط, السراو, المنشاة and سنورس — four bricks on 31.417539, 31.814443 (Damietta city).
//   • بور سعيد and بورفؤاد — two bricks on 31.41367, 31.8176459, which is 48.9 km from the real
//     Port Said (31.2653, 32.3019). Both stamped `success`, rendered at 70% and 85%.
//
// Two harms, and the second is the one that costs money:
//   1. The map drew them as distinct, confident pins over one point.
//   2. They entered the minimum-spanning-tree cost and the 1-median residence search as
//      ZERO-DISTANCE duplicates, pulling "where should a rep hired here live?" toward whichever
//      town the geocoder gave up on. D26's answer was computed against four such duplicates.
//
// What this file pins:
//   1. A coordinate held by more than one successful pin is shared — the pin identifies no brick.
//   2. A coordinate held by ONE pin is never shared, however low its provider's confidence.
//   3. A pin a PERSON placed is exempt, matching saveBrickPin's own rule — but only when EVERY
//      brick on that coordinate is manual. One hand-placed pin does not vouch for a geocoded twin.
//   4. Already-demoted pins do not make a good pin look shared.
//   5. The guard is actually WIRED into loadTerritoryMap, gates the pin push, and is computed over
//      every centroid rather than only the selected areas'.
// ─────────────────────────────────────────────────────────────────────────────

function pin(lat: number, lng: number, provider = "google_geocode", status = "success"): BrickPin {
  return { lat, lng, provider, status };
}

/** The real D26 collision, at the coordinates production held on 2026-09-22. */
const DAMIETTA = { lat: 31.417539, lng: 31.814443 };
const PORT_SAID_PIN = { lat: 31.41367, lng: 31.8176459 };

export function runTerritorySharedPinGuardTests() {
  // ── 1. The production defect ───────────────────────────────────────────────
  const d26 = sharedCoordinateKeys([
    pin(DAMIETTA.lat, DAMIETTA.lng, "google_places_hint"), // دمياط
    pin(DAMIETTA.lat, DAMIETTA.lng), // السراو
    pin(DAMIETTA.lat, DAMIETTA.lng), // المنشاة
    pin(DAMIETTA.lat, DAMIETTA.lng), // سنورس
    pin(PORT_SAID_PIN.lat, PORT_SAID_PIN.lng, "google_places_hint"), // بور سعيد
    pin(PORT_SAID_PIN.lat, PORT_SAID_PIN.lng), // بورفؤاد
    pin(31.503914, 31.838514, "google_places_hint"), // عزبة البرج — its own point
  ]);

  assert.ok(
    d26.has(coordinateKey(DAMIETTA.lat, DAMIETTA.lng)),
    "four bricks on the Damietta city point must be shared — a `success` stamp does not make a reused coordinate locate anything",
  );
  assert.ok(
    d26.has(coordinateKey(PORT_SAID_PIN.lat, PORT_SAID_PIN.lng)),
    "بور سعيد and بورفؤاد share one pin 48.9 km from Port Said — the pair is the tell, not the distance",
  );
  assert.ok(
    !d26.has(coordinateKey(31.503914, 31.838514)),
    "a brick alone on its coordinate stays located — the guard must not empty an area it was meant to clean",
  );
  assert.equal(d26.size, 2, "exactly the two collisions, and nothing invented around them");

  // ── 2. One holder is never shared, whatever the provider ───────────────────
  for (const provider of ["google_area_centre", "google_block_centre", "google_places_hint", "unknown"]) {
    const keys = sharedCoordinateKeys([pin(30.1, 31.2, provider)]);
    assert.equal(
      keys.size,
      0,
      `a single ${provider} pin is low confidence, not shared — confidence is pinConfidence's job and dropping it here would hide real geography`,
    );
  }

  // ── 3. A person's pin outranks the guard, but only unanimously ─────────────
  const allManual = sharedCoordinateKeys([
    pin(30.0444, 31.2357, "manual"),
    pin(30.0444, 31.2357, "manual"),
  ]);
  assert.equal(
    allManual.size,
    0,
    "two bricks a person deliberately placed on one point is a choice, not a geocoder giving up — saveBrickPin says so explicitly",
  );

  const mixed = sharedCoordinateKeys([
    pin(30.0444, 31.2357, "manual"),
    pin(30.0444, 31.2357, "google_geocode"),
  ]);
  assert.ok(
    mixed.has(coordinateKey(30.0444, 31.2357)),
    "a hand-placed pin vouches for ITSELF only — a geocode that collided with it is still a geocode that located nothing",
  );

  // ── 4. An already-demoted pin cannot implicate a good one ──────────────────
  const withDemoted = sharedCoordinateKeys([
    pin(29.5, 30.5, "google_geocode", "shared_fallback"),
    pin(29.5, 30.5, "google_geocode", "region_mismatch"),
    pin(29.5, 30.5, "google_geocode", "success"),
  ]);
  assert.equal(
    withDemoted.size,
    0,
    "only `success` pins count toward sharing — a row the geocoder already gave up on is unlocated on its own terms and must not drag a good pin down with it",
  );

  // Garbage coordinates are skipped rather than colliding with each other on NaN.
  assert.equal(
    sharedCoordinateKeys([
      { lat: Number.NaN, lng: Number.NaN, provider: "google_geocode", status: "success" },
      { lat: Number.NaN, lng: Number.NaN, provider: "google_geocode", status: "success" },
    ]).size,
    0,
    "two unparseable coordinates are two missing pins, never a shared one",
  );

  // ── 5. The guard is wired in, and gates the pin ────────────────────────────
  const service = readFileSync(new URL("../src/lib/territory-management/service.ts", import.meta.url), "utf8");
  const start = service.indexOf("export async function loadTerritoryMap(");
  assert.ok(start > -1, "loadTerritoryMap must still be the map loader this guard protects");
  const rest = service.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type|interface|class) /m);
  const loader = service.slice(start, next >= 0 ? start + 1 + next : service.length);

  const guardAt = loader.indexOf("sharedCoordinateKeys(");
  const reclassifiedAt = loader.indexOf('shared.has(coordinateKey(');
  const pushAt = loader.indexOf("bricks.push(");
  assert.ok(guardAt > -1, "loadTerritoryMap must consult the shared-pin guard — a guard nothing calls is not a guard");
  assert.ok(
    reclassifiedAt > -1 && pushAt > reclassifiedAt,
    "the shared-coordinate check must come BEFORE the pin is pushed — reclassifying afterwards would still have drawn it and still have fed the residence search",
  );
  // Every brick IN FORCE, country-wide (2026-10-27): a moved brick's husk and its successor share
  // the ground, so counting the husk's pin would demote the successor that inherited it.
  assert.match(
    loader,
    /const pins = currentBrickPins\(centroids, await loadBrickHistory\(today\)\);/,
    "the guard's pins must be every centroid, narrowed to the bricks in force — never only the selected areas'",
  );
  assert.match(
    loader,
    /sharedCoordinateKeys\(pins\.values\(\)\)/,
    "the guard must read EVERY brick in force, not just the selected areas' — otherwise a brick's verdict changes with what is on screen, and a twin in an unselected area lets its partner through",
  );
}
