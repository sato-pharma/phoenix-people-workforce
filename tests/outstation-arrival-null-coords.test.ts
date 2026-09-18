import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MISSING_CAPTURED_COORDINATES,
  parseCarEvidenceMetadata,
} from "../app/api/outstation/request-body.ts";
import { validateLiveArrivalEvidence } from "../src/lib/outstation/car-evidence.ts";
import { readCapturedPosition } from "../src/lib/outstation/captured-coordinates.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// An ARRIVAL body with no GPS fix must be REFUSED, never stored at 0°N 0°E.
//
// Every outstation route read the arrival position with `Number(body.capturedLatitude)`.
// `Number(null)`, `Number("")` and `Number(" ")` are all 0, which is finite, so
// `{ capturedLatitude: null, capturedLongitude: null }` passed capture-location's
// "Captured coordinates are required." 400 and was saved as 0,0 — and calculate, submit and
// sync-offline had no check at all, so the same body was priced and stored there too. The arrival
// photo's metadata had the same parse, and a photo with no fix passed its GPS check stamped at 0,0.
//
// The departure photo had the identical defect and the fix for it (#3991) added the reader these
// routes now share, src/lib/outstation/captured-coordinates.ts. The difference is only what "no
// position" MEANS: the departure photo is optional and records an unknown distance; the arrival
// position is REQUIRED, so every arrival route answers it with capture-location's own 400.
//
// Production held 0 rows at 0,0 when this was fixed (2026-09-18), in both captured_latitude/
// captured_longitude and car_evidence_metadata — the defect was latent, no data was repaired.
// ─────────────────────────────────────────────────────────────────────────────

/** Every route the arrival position enters through, with the service call it must refuse before. */
const ARRIVAL_ROUTES = [
  { path: "app/api/outstation/capture-location/route.ts", service: "captureOutstationLocation(" },
  { path: "app/api/outstation/calculate/route.ts", service: "calculateOutstationExpense(" },
  { path: "app/api/outstation/submit/route.ts", service: "submitOutstationRequest(" },
  { path: "app/api/outstation/sync-offline/route.ts", service: "syncOfflineOutstationRequest(" },
] as const;

const REQUEST_BODY_HELPER = "app/api/outstation/request-body.ts";
const DEPARTURE_EVIDENCE = "src/lib/outstation/departure-evidence.ts";

function arrivalPhoto(capturedLatitude: unknown, capturedLongitude: unknown) {
  return parseCarEvidenceMetadata({
    carEvidenceMetadata: {
      capturedAt: "2026-09-18T08:15:00.000Z",
      capturedLatitude,
      capturedLocationLabel: "El-Geish St, Tanta, Gharbia",
      capturedLongitude,
      employeeHrId: "A-77",
      requestDraftId: "draft-77",
      requestId: null,
      source: "live_camera",
    },
  });
}

export function runOutstationArrivalNullCoordsTests() {
  // ── The headline: the body capture-location let through as 0,0 ─────────────
  assert.equal(
    readCapturedPosition(null, null),
    null,
    "a body with null coordinates has NO position — Number(null) made it 0,0 and it passed the required-coordinates 400",
  );

  // Every other way of saying "no number".
  assert.equal(readCapturedPosition(undefined, undefined), null, "keys left out is no position");
  assert.equal(readCapturedPosition("", ""), null, "empty strings are no position, not 0,0");
  assert.equal(readCapturedPosition("  ", " "), null, "blank strings are no position, not 0,0");
  for (const junk of ["abc", "30.0.1", Number.NaN, Number.POSITIVE_INFINITY, true, false, {}, [], [30]]) {
    assert.equal(
      readCapturedPosition(junk, junk),
      null,
      `a non-numeric coordinate (${JSON.stringify(junk)}) is no position`,
    );
  }

  // ── Real fixes still get through, exactly as sent ─────────────────────────────
  assert.deepEqual(
    readCapturedPosition(30.7865, 31.0004),
    { latitude: 30.7865, longitude: 31.0004 },
    "a real fix is kept exactly as sent",
  );
  assert.deepEqual(
    readCapturedPosition(" 30.7865 ", "31.0004"),
    { latitude: 30.7865, longitude: 31.0004 },
    "a non-blank numeric string is a real coordinate",
  );
  assert.deepEqual(
    readCapturedPosition(0, 31.0004),
    { latitude: 0, longitude: 31.0004 },
    "a single real 0 is a coordinate and survives",
  );

  // ── Pairs, not halves; and 0,0 is the failed-fix marker the domain already names ─
  assert.equal(
    readCapturedPosition(30.7865, null),
    null,
    "half a position is no position — the old parse stored this as (30.7865, 0), on the prime meridian",
  );
  assert.equal(
    readCapturedPosition(0, 0),
    null,
    "exactly 0,0 is what a failed geolocation writes (captured-location.ts), never an arrival",
  );

  // ── The refusal is capture-location's own 400, word for word ──────────────────
  assert.deepEqual(
    MISSING_CAPTURED_COORDINATES,
    { error: "missing_coordinates", message: "Captured coordinates are required." },
    "arrival stays REQUIRED: every arrival route refuses a missing fix with the pair capture-location always returned",
  );

  // ── The arrival photo: no fix is an INCOMPLETE photo, never one stamped at 0,0 ─
  for (const [label, lat, lon] of [
    ["null", null, null],
    ["empty", "", ""],
    ["blank", " ", "  "],
    ["0,0", 0, 0],
    ["half", 30.7865, null],
  ] as const) {
    const metadata = arrivalPhoto(lat, lon);
    assert.ok(metadata, `a ${label}-GPS arrival photo still parses — refusing it is validateLiveArrivalEvidence's call`);
    assert.ok(
      !Number.isFinite(metadata.capturedLatitude) && !Number.isFinite(metadata.capturedLongitude),
      `a ${label}-GPS arrival photo carries no coordinate at all, never a 0 (got ${metadata.capturedLatitude}, ${metadata.capturedLongitude})`,
    );
    const verdict = validateLiveArrivalEvidence({
      carEvidenceMetadata: metadata,
      employeeRole: "District Manager",
      transportationType: "car",
    });
    assert.equal(verdict.isValid, false, `a ${label}-GPS arrival photo is refused`);
    assert.match(verdict.message, /incomplete/, `a ${label}-GPS arrival photo is refused as incomplete (its GPS is missing)`);
  }

  const realPhoto = arrivalPhoto(30.7865, 31.0004);
  assert.ok(realPhoto, "a real arrival photo parses");
  assert.equal(realPhoto.capturedLatitude, 30.7865, "a real arrival photo keeps its latitude");
  assert.equal(realPhoto.capturedLongitude, 31.0004, "a real arrival photo keeps its longitude");
  assert.equal(
    validateLiveArrivalEvidence({
      carEvidenceMetadata: realPhoto,
      employeeRole: "District Manager",
      transportationType: "car",
    }).isValid,
    true,
    "a real arrival photo is still accepted",
  );

  // ── Every arrival route reads through the shared reader and refuses BEFORE the service ─
  // Code only: each route's comment names the old parse in order to warn against it.
  for (const route of ARRIVAL_ROUTES) {
    const code = stripComments(readFileSync(route.path, "utf8"));
    assert.doesNotMatch(
      code,
      /Number\(\s*body\.captured(Latitude|Longitude)\s*\)/,
      `${route.path} must not parse coordinates with Number(body.captured…) — Number(null) is 0`,
    );
    assert.match(
      code,
      /readCapturedPosition\(\s*body\.capturedLatitude,\s*body\.capturedLongitude\s*\)/,
      `${route.path} reads the arrival position through readCapturedPosition`,
    );
    const refusal = code.search(
      /if \(!position\) \{\s*return NextResponse\.json\(MISSING_CAPTURED_COORDINATES, \{ status: 400 \}\);\s*\}/,
    );
    assert.ok(refusal >= 0, `${route.path} answers a missing position with the 400 "Captured coordinates are required."`);
    const serviceCall = code.indexOf(route.service);
    assert.ok(serviceCall >= 0, `${route.path} still calls ${route.service}) — this check is reading the wrong file`);
    assert.ok(refusal < serviceCall, `${route.path} refuses a missing position BEFORE ${route.service}) runs`);
    assert.match(code, /capturedLatitude: position\.latitude/, `${route.path} passes the read latitude on`);
    assert.match(code, /capturedLongitude: position\.longitude/, `${route.path} passes the read longitude on`);
  }

  const helper = stripComments(readFileSync(REQUEST_BODY_HELPER, "utf8"));
  assert.doesNotMatch(
    helper,
    /Number\(\s*raw\.captured(Latitude|Longitude)\s*\)/,
    "the arrival photo's metadata must not parse coordinates with Number(raw.captured…) — Number(null) is 0",
  );
  assert.match(
    helper,
    /readCapturedPosition\(\s*raw\.capturedLatitude,\s*raw\.capturedLongitude\s*\)/,
    "the arrival photo's metadata reads its position through readCapturedPosition",
  );

  // ── One reader, not two: the departure photo uses the same module ─────────────
  const departure = stripComments(readFileSync(DEPARTURE_EVIDENCE, "utf8"));
  assert.match(
    departure,
    /from "@\/lib\/outstation\/captured-coordinates"/,
    "the departure photo reads its position through the shared module",
  );
  assert.doesNotMatch(
    departure,
    /function (coordinateFromBody|usablePosition)\b/,
    "departure-evidence.ts must not carry its own copy of the coordinate reader",
  );
}
