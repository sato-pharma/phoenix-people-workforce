import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readEvidenceLocationStamp } from "../src/components/outstation/evidence-watermark.ts";
import { parseEvidenceLocationBody } from "../src/lib/evidence/location-service.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A blank latitude or longitude on an evidence photo is NO position, never 0°N 0°E.
//
// The four evidence-location endpoints (outstation, direct orders, marketing, Phoenix CRM) share
// parseEvidenceLocationBody, which read each coordinate as `Number(value)`. `Number(null)`,
// `Number("")` and `Number(" ")` are all 0, which is finite and inside the bounds check, so a
// request with a blank pair was answered with a stamp at 0°N 0°E, in the Gulf of Guinea, and the
// phone burned "GPS: 0.000000°N, 0.000000°E" into the photo as the rep's position. A missing key
// was already refused (`Number(undefined)` is NaN); a blank one now takes the same refusal.
//
// Nothing new is decided here: each endpoint already answered a null parse with a refusal, the
// phone already falls back to its own "lookup unavailable" stamp when a lookup is refused, and the
// existing bounds check is kept as it was. The coordinate is read with readCoordinateInput
// (src/lib/geo/coordinate-input.ts, shared since #3995), not a new copy.
//
// Production on 2026-09-18: 75 arrival and 48 departure photo labels on outstation claims, plus the
// direct-order and marketing captured addresses; none at 0°N 0°E and none "Unresolved location",
// and no claim stores a 0 coordinate. The defect was latent; no data was repaired.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTES = [
  "app/api/outstation/reverse-geocode/route.ts",
  "app/api/direct-orders/reverse-geocode/route.ts",
  "app/api/marketing-requests/reverse-geocode/route.ts",
  "app/api/phoenix-crm/location/route.ts",
];
const SERVICE = "src/lib/evidence/location-service.ts";

const BLANKS = [
  ["null", null],
  ["undefined", undefined],
  ["empty", ""],
  ["blank", " "],
  ["tab and newline", "\t\n"],
] as const;

const CAIRO = { latitude: 30.0444, longitude: 31.2357 };

function read(path: string) {
  return stripComments(readFileSync(path, "utf8"));
}

export function runEvidenceStampBlankCoordinatesTests() {
  // ── The headline: a blank pair is no position, never a pin at 0°N 0°E ────────
  for (const [label, value] of BLANKS) {
    assert.equal(
      parseEvidenceLocationBody({ latitude: value, longitude: value }),
      null,
      `an evidence stamp whose latitude and longitude are ${label} has no position — Number(...) read it as 0°N 0°E and stamped the photo in the Gulf of Guinea`,
    );
  }

  // ── Half a pair is no position either, as a missing key always was ────────────
  for (const [label, value] of BLANKS) {
    assert.equal(
      parseEvidenceLocationBody({ latitude: value, longitude: CAIRO.longitude }),
      null,
      `a ${label} latitude is no position, even beside a real longitude`,
    );
    assert.equal(
      parseEvidenceLocationBody({ latitude: CAIRO.latitude, longitude: value }),
      null,
      `a ${label} longitude is no position, even beside a real latitude`,
    );
  }
  assert.equal(parseEvidenceLocationBody({ latitude: "north", longitude: CAIRO.longitude }), null, "a word is not a coordinate");

  // ── A real pin reads exactly as before ────────────────────────────────────────
  assert.deepEqual(
    parseEvidenceLocationBody({ accuracyMeters: 12, latitude: CAIRO.latitude, longitude: CAIRO.longitude }),
    { accuracyMeters: 12, latitude: 30.0444, longitude: 31.2357 },
  );
  assert.deepEqual(
    parseEvidenceLocationBody({ latitude: " 30.0444 ", longitude: "31.2357" }),
    { accuracyMeters: null, latitude: 30.0444, longitude: 31.2357 },
    "a numeric string, padded or not, is still read",
  );
  assert.equal(
    parseEvidenceLocationBody({ latitude: 91, longitude: CAIRO.longitude }),
    null,
    "the existing bounds check still refuses a pin past the pole",
  );
  assert.equal(parseEvidenceLocationBody({ latitude: CAIRO.latitude, longitude: 181 }), null);

  // ── The parser uses the shared reader, not a copy ─────────────────────────────
  const service = read(SERVICE);
  assert.match(
    service,
    /import \{ readAccuracyInput, readCoordinateInput \} from "@\/lib\/geo\/coordinate-input";/,
    "the evidence parser uses the shared coordinate reader",
  );
  assert.match(service, /const latitude = readCoordinateInput\(body\.latitude\);/);
  assert.match(service, /const longitude = readCoordinateInput\(body\.longitude\);/);
  assert.doesNotMatch(service, /finiteOrNull/, "the Number()-based finiteOrNull must not come back");

  // ── Every endpoint answers "no position" with its existing refusal ────────────
  for (const path of ROUTES) {
    const route = read(path);
    assert.match(route, /const parsed = parseEvidenceLocationBody\(/, `${path} reads the body with the shared parser`);
    assert.match(route, /if \(!parsed\)/, `${path} refuses a request with no position instead of stamping one`);
  }

  // ── The phone keeps its photo when the lookup is refused ──────────────────────
  const fallback = readEvidenceLocationStamp(null, CAIRO.latitude, CAIRO.longitude, 12);
  assert.equal(fallback.lines[0], "Address: lookup unavailable at capture time");
  assert.match(fallback.label, /^Unresolved location at 30\.044400°N, 31\.235700°E/);
  assert.doesNotMatch(fallback.lines.join("\n"), /0\.000000°N, 0\.000000°E/);
}
