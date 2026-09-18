import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  readDeparturePhotoPosition,
  reviewDepartureEvidence,
} from "../src/lib/outstation/departure-evidence.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A departure photo with NO GPS fix must record the distance as UNKNOWN, never measure it from
// 0°N 0°E.
//
// The web departure card sends `{ latitude: null, longitude: null }` when the browser cannot get a
// fix. The route read that with `Number(body.latitude)`, and `Number(null)` is 0, which is finite,
// so the photo was stored at 0,0 and the review flagged it `far_from_arrival` ("taken well away
// from where the trip was"). One production departure photo, captured 2026-09-01, carries exactly
// that: 4,686.2 km from its arrival photo. The route's own comment always said a device without a
// fix must be able to submit and have the distance recorded as unknown.
//
// The Android app leaves the keys out instead (mobile/src/lib/evidence-photo.ts), which the old
// parse happened to handle; the fix is on the server so every client gets the same answer.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE_SOURCE = fileURLToPath(
  new URL("../app/api/outstation/[id]/departure-photo/route.ts", import.meta.url),
);

const NO_POSITION = { latitude: null, longitude: null };

export function runOutstationDeparturePhotoNullCoordsTests() {
  // ── The headline: what the web card actually posts with no fix ──────────────
  assert.deepEqual(
    readDeparturePhotoPosition({ latitude: null, longitude: null }),
    NO_POSITION,
    "a no-fix web capture posts nulls, and nulls are NO position — never 0,0",
  );

  // Every other way of saying "no number" reads the same.
  assert.deepEqual(readDeparturePhotoPosition({}), NO_POSITION, "keys left out (the Android app) is no position");
  assert.deepEqual(
    readDeparturePhotoPosition({ latitude: undefined, longitude: undefined }),
    NO_POSITION,
    "undefined is no position",
  );
  assert.deepEqual(readDeparturePhotoPosition({ latitude: "", longitude: "" }), NO_POSITION, "empty string is no position");
  assert.deepEqual(readDeparturePhotoPosition({ latitude: "  ", longitude: " " }), NO_POSITION, "blank string is no position");
  for (const junk of ["abc", "30.0.1", Number.NaN, Number.POSITIVE_INFINITY, true, false, {}, [], [30]]) {
    assert.deepEqual(
      readDeparturePhotoPosition({ latitude: junk, longitude: junk }),
      NO_POSITION,
      `a non-numeric coordinate (${JSON.stringify(junk)}) is no position`,
    );
  }

  // ── Real numbers still get through ───────────────────────────────────────────
  assert.deepEqual(
    readDeparturePhotoPosition({ latitude: 30.0444, longitude: 31.2357 }),
    { latitude: 30.0444, longitude: 31.2357 },
    "a real fix is kept exactly as sent",
  );
  assert.deepEqual(
    readDeparturePhotoPosition({ latitude: " 30.0444 ", longitude: "31.2357" }),
    { latitude: 30.0444, longitude: 31.2357 },
    "a non-blank numeric string is a real coordinate",
  );
  assert.deepEqual(
    readDeparturePhotoPosition({ latitude: 0, longitude: 31.2357 }),
    { latitude: 0, longitude: 31.2357 },
    "a single 0 the client really sent is a real coordinate and must survive",
  );
  assert.deepEqual(
    readDeparturePhotoPosition({ latitude: 30.0444, longitude: 0 }),
    { latitude: 30.0444, longitude: 0 },
    "a 0 longitude beside a real latitude is kept too",
  );

  // ── Pairs, not halves; and 0,0 is the failed-fix marker the domain already names ─
  assert.deepEqual(
    readDeparturePhotoPosition({ latitude: 30.0444, longitude: null }),
    NO_POSITION,
    "half a position is no position — it is dropped whole, not half-stored",
  );
  assert.deepEqual(
    readDeparturePhotoPosition({ latitude: 0, longitude: 0 }),
    NO_POSITION,
    "exactly 0,0 is what a failed geolocation writes (captured-location.ts), so it reads as unknown, not as a place",
  );

  // ── End to end through the review: unknown, never 'far away' ─────────────────
  const cairo = { lat: 30.0444, lon: 31.2357 };
  const noFix = readDeparturePhotoPosition({ latitude: null, longitude: null });
  const review = reviewDepartureEvidence({
    arrivalCapturedAt: "2026-09-01T11:10:00.000Z",
    arrivalLatitude: cairo.lat,
    arrivalLongitude: cairo.lon,
    departureCapturedAt: "2026-09-01T14:30:58.000Z",
    departureLatitude: noFix.latitude,
    departureLongitude: noFix.longitude,
    tripEndDate: "2026-09-01",
  });
  assert.equal(review.distanceFromArrivalKm, null, "a no-fix departure photo has an UNKNOWN distance, not thousands of km");
  assert.ok(
    !review.flags.includes("far_from_arrival"),
    "and is never flagged as taken well away from the trip",
  );
  assert.match(review.summary, /distance from the arrival photo unknown/, "the approver reads 'unknown'");

  // A row that already holds 0,0 — stored before this fix, or sent by any client — reviews the
  // same way, on either side of the pair.
  for (const [label, input] of [
    ["departure", { aLat: cairo.lat, aLon: cairo.lon, dLat: 0, dLon: 0 }],
    ["arrival", { aLat: 0, aLon: 0, dLat: cairo.lat, dLon: cairo.lon }],
  ] as const) {
    const zeroZero = reviewDepartureEvidence({
      arrivalCapturedAt: "2026-09-01T11:10:00.000Z",
      arrivalLatitude: input.aLat,
      arrivalLongitude: input.aLon,
      departureCapturedAt: "2026-09-01T14:30:58.000Z",
      departureLatitude: input.dLat,
      departureLongitude: input.dLon,
      tripEndDate: "2026-09-01",
    });
    assert.equal(zeroZero.distanceFromArrivalKm, null, `a ${label} point at 0,0 gives an unknown distance`);
    assert.ok(!zeroZero.flags.includes("far_from_arrival"), `a ${label} point at 0,0 is not 'far from arrival'`);
  }

  // ── The route must use the domain reader, never a bare Number() on the body ──
  // Code only: the route's own comment names the old parse in order to warn against it.
  const route = readFileSync(ROUTE_SOURCE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(
    route,
    /readDeparturePhotoPosition\(body\)/,
    "the departure-photo route reads its coordinates through readDeparturePhotoPosition",
  );
  assert.doesNotMatch(
    route,
    /Number\(\s*body\.(latitude|longitude)\s*\)/,
    "Number(body.latitude) turns null into 0 — the route must not parse coordinates that way",
  );
}
