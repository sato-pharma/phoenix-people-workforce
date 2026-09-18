import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readDeparturePhotoPosition } from "../src/lib/outstation/departure-evidence.ts";
import {
  DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE,
  departurePhotoLocationRefusal,
} from "../src/lib/outstation/departure-photo-location.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// No location, no photo: a departure photo with NO position is REFUSED, and nothing is stored.
//
// Owner ruling, 2026-09-18 ("Refuse the photo"). An arrival photo was already refused without GPS
// ("Captured coordinates are required."), but a departure photo with no fix was accepted, stamped
// "no GPS fix", stored with its distance unknown and no review flag, so it cost the employee
// nothing. One production request carried exactly that. Now the service refuses it before the
// upload, the web card and the Android app refuse it before anything is stamped or sent, and the
// message tells the employee to turn location on and take the photo again.
//
// It refuses the ABSENCE of a position only. A far or inaccurate position is still accepted and
// flagged for review, never blocked; that owner decision (2026-08-04) is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE = "src/lib/outstation/service.ts";
const ROUTE = "app/api/outstation/[id]/departure-photo/route.ts";
const WEB_CARD = "src/components/outstation/departure-photo-card.tsx";
const APP_CAPTURE = "mobile/src/lib/evidence-photo.ts";

function read(path: string) {
  return stripComments(readFileSync(path, "utf8"));
}

/** The body of one top-level function, so a pin can target the capture path alone. */
function functionSlice(src: string, declaration: string) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = src.slice(start + declaration.length);
  const ends = [rest.indexOf("\nexport "), rest.indexOf("\nasync function ")].filter((i) => i !== -1);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length);
}

function refusalFor(body: { latitude?: unknown; longitude?: unknown }) {
  const { latitude, longitude } = readDeparturePhotoPosition(body);
  return departurePhotoLocationRefusal(latitude, longitude);
}

export function runOutstationDeparturePhotoRequiresLocationTests() {
  // ── The headline: what a phone or browser with no fix sends is refused ──────
  assert.equal(
    departurePhotoLocationRefusal(null, null),
    DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE,
    "a departure photo with no location must be refused — it used to be stored stamped \"no GPS fix\" with no flag, which cost the employee nothing",
  );

  // Every way a client says "no position" reaches the same refusal, through the route's own reader.
  const noPosition: Array<[string, { latitude?: unknown; longitude?: unknown }]> = [
    ["the web card's nulls", { latitude: null, longitude: null }],
    ["an older app build's missing keys", {}],
    ["undefined", { latitude: undefined, longitude: undefined }],
    ["blank strings", { latitude: "", longitude: " " }],
    ["the failed-fix marker 0,0", { latitude: 0, longitude: 0 }],
    ["half a pair (latitude only)", { latitude: 30.0444, longitude: null }],
    ["half a pair (longitude only)", { longitude: 31.2357 }],
    ["non-numbers", { latitude: "abc", longitude: Number.NaN }],
  ];
  for (const [label, body] of noPosition) {
    assert.equal(
      refusalFor(body),
      DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE,
      `a departure photo posted with ${label} has no location and must be refused`,
    );
  }

  // ── A real position is never refused, however far or rough ───────────────────
  assert.equal(refusalFor({ latitude: 30.0444, longitude: 31.2357 }), null, "a real fix is accepted");
  assert.equal(refusalFor({ latitude: " 30.0444 ", longitude: "31.2357" }), null, "a numeric string is a real fix");
  assert.equal(
    refusalFor({ latitude: 0, longitude: 31.2357 }),
    null,
    "a single 0 is a real coordinate, not a missing one — only the exact pair 0,0 is no position",
  );
  assert.equal(
    refusalFor({ latitude: 24.0889, longitude: 32.8998 }),
    null,
    "a position hundreds of km from the arrival photo is still accepted — distance is flagged, never refused",
  );

  // ── The employee is told what to do, and the route answers 400, not 500 ──────
  assert.match(DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE, /location/i, "the refusal names location");
  assert.match(DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE, /take the photo again/i, "and says to take the photo again");
  assert.ok(
    DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE.toLowerCase().includes("required"),
    "the message must carry \"required\" — that is the word the route's status map reads as a 400",
  );
  const route = read(ROUTE);
  assert.match(
    functionSlice(route, "function departurePhotoStatus"),
    /message\.includes\("required"\)[\s\S]*?return 400;/,
    "the route must answer a missing location with 400, so the app shows the message instead of a server error",
  );

  // ── The service refuses it BEFORE the upload, so nothing is stored ───────────
  const capture = functionSlice(read(SERVICE), "export async function captureOutstationDeparturePhoto");
  const refusalAt = capture.search(
    /departurePhotoLocationRefusal\(input\.latitude,\s*input\.longitude\)[\s\S]{0,120}?if \(\w+\) throw new Error\(\w+\);/,
  );
  const uploadAt = capture.indexOf("uploadOutstationDepartureEvidenceImage(");
  assert.notEqual(refusalAt, -1, "the departure capture must throw the location refusal — the rule lives in the service, which every client reaches");
  assert.notEqual(uploadAt, -1, "expected the capture to upload the photo");
  assert.ok(
    refusalAt < uploadAt,
    "the location refusal must come BEFORE the upload — after it, a refused photo still leaves a stored object behind",
  );

  // ── The web card stops before it stamps or sends ─────────────────────────────
  const card = read(WEB_CARD);
  const cardRefusalAt = card.indexOf("if (!fix) throw new Error(DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE);");
  assert.notEqual(cardRefusalAt, -1, "the web card must refuse a capture with no position, with the server's own words");
  assert.ok(
    cardRefusalAt < card.indexOf("fetch(`/api/outstation/${request.id}/departure-photo`"),
    "the web card must refuse before it uploads",
  );
  assert.ok(!card.includes("evidenceLocationWithoutFix("), "the web card no longer stamps a photo \"no GPS fix\"");

  // ── The Android app stops too, before it stamps or sends ─────────────────────
  const app = read(APP_CAPTURE);
  const appRefusalAt = app.search(/if \(fix\.status !== "fixed"\) return \{[^}]*status: "failed"/);
  assert.notEqual(appRefusalAt, -1, "the app must fail a capture with no fix instead of stamping it");
  assert.ok(appRefusalAt < app.indexOf("burnEvidencePhoto("), "the app must stop before it stamps the photo");
  assert.ok(
    appRefusalAt < app.indexOf("`/api/outstation/${requestId}/departure-photo`"),
    "the app must stop before it uploads the photo",
  );
  assert.match(
    app,
    /if \(!access\.granted\) return \{[^}]*status: "failed"/,
    "with location refused, the app must say so before the camera opens",
  );
  assert.ok(!app.includes("evidenceLocationWithoutFix("), "the app no longer stamps a photo \"no GPS fix\"");
}
