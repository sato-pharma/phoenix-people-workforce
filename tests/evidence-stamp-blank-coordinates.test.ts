import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readEvidenceLocationStamp } from "../src/components/outstation/evidence-watermark.ts";
import {
  REVERSE_GEOCODE_CELL_DECIMALS,
  REVERSE_GEOCODE_MAX_ENTRIES,
  REVERSE_GEOCODE_TTL_MS,
  memoizeReverseGeocode,
  parseEvidenceLocationBody,
  reverseGeocodeCell,
} from "../src/lib/evidence/location-service.ts";
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

type FakeAddress = { area: string | null; city: string | null; formattedAddress: string | null; governorate: string | null; lat: number; lng: number };

function addressAt(location: { lat: number; lng: number }, label: string): FakeAddress {
  return { area: label, city: "Cairo", formattedAddress: `${label}, Cairo`, governorate: "Cairo", lat: location.lat, lng: location.lng };
}

/**
 * The reverse-geocode memo (Phoenix CRM performance audit, 2026-10-16). Every evidence photo asked
 * Google for the address of where the rep stood, and a rep at the same door asked the same question
 * again and again. The memo answers a capture in the same ~11 m cell from memory for a few hours —
 * and each rule below is silent when broken: a remembered failure blanks every later stamp in that
 * cell, a missing bound grows the process without limit, and a miss that asked for the cell's rounded
 * corner would give the FIRST capture a different address from the one it always got.
 */
async function runReverseGeocodeMemoTests() {
  assert.equal(REVERSE_GEOCODE_CELL_DECIMALS, 4, "four decimals — about 11 m, inside the error of any phone fix");
  assert.equal(reverseGeocodeCell(30.04441, 31.23569), "30.0444,31.2357");
  assert.equal(reverseGeocodeCell(30.04436, 31.23574), "30.0444,31.2357", "two pins a metre apart share a cell");
  assert.notEqual(reverseGeocodeCell(30.0444, 31.2357), reverseGeocodeCell(30.0454, 31.2357), "a pin ~110 m north is a different cell");
  assert.ok(REVERSE_GEOCODE_TTL_MS <= 24 * 60 * 60 * 1000, "an address is remembered for hours, never for days");
  assert.ok(REVERSE_GEOCODE_MAX_ENTRIES > 0 && REVERSE_GEOCODE_MAX_ENTRIES <= 10_000, "and the memo is bounded");

  // Same cell, one call — and the miss asked for the capture's OWN coordinates.
  {
    const asked: Array<{ lat: number; lng: number }> = [];
    const lookup = async (location: { lat: number; lng: number }) => {
      asked.push(location);
      return addressAt(location, `call ${asked.length}`);
    };
    const memo = memoizeReverseGeocode(lookup, { maxEntries: 10, ttlMs: 1000, now: () => 0 });
    const first = await memo(30.04441, 31.23569);
    const second = await memo(30.04436, 31.23574);
    assert.equal(asked.length, 1, "a second capture in the same cell does not ask Google again");
    assert.deepEqual(asked[0], { lat: 30.04441, lng: 31.23569 }, "the first capture is looked up at its exact pin, never the cell's corner");
    assert.equal(second?.formattedAddress, first?.formattedAddress, "and the second gets the first one's address");
    await memo(30.0454, 31.2357);
    assert.equal(asked.length, 2, "a different cell asks again");
  }

  // A missing key (null) and a Google failure (a throw) are never remembered.
  {
    let calls = 0;
    let answer: "null" | "throw" | "address" = "null";
    const lookup = async (location: { lat: number; lng: number }) => {
      calls += 1;
      if (answer === "throw") throw new Error("Google Reverse Geocoding API failed with 503.");
      return answer === "null" ? null : addressAt(location, "Tahrir");
    };
    const memo = memoizeReverseGeocode(lookup, { maxEntries: 10, ttlMs: 1000, now: () => 0 });
    assert.equal(await memo(30.0444, 31.2357), null);
    assert.equal(await memo(30.0444, 31.2357), null);
    assert.equal(calls, 2, "a null answer is asked again — the key may be back on the next capture");
    answer = "throw";
    await assert.rejects(memo(30.0444, 31.2357), /503/, "a Google failure still reaches the caller, which turns it into 'lookup unavailable'");
    answer = "address";
    assert.equal((await memo(30.0444, 31.2357))?.formattedAddress, "Tahrir, Cairo", "and the capture after a failure asks again and gets the real address");
    assert.equal(calls, 4);
  }

  // It expires.
  {
    let clock = 0;
    let calls = 0;
    const memo = memoizeReverseGeocode(async (location) => addressAt(location, `call ${++calls}`), { maxEntries: 10, ttlMs: 1000, now: () => clock });
    await memo(30.0444, 31.2357);
    clock = 999;
    await memo(30.0444, 31.2357);
    assert.equal(calls, 1, "inside the window the cell is answered from memory");
    clock = 1000;
    assert.equal((await memo(30.0444, 31.2357))?.formattedAddress, "call 2, Cairo", "at the window's end the cell is asked again");
  }

  // It is bounded, and the least recently USED cell goes first.
  {
    let calls = 0;
    const memo = memoizeReverseGeocode(async (location) => addressAt(location, `call ${++calls}`), { maxEntries: 2, ttlMs: 1000, now: () => 0 });
    await memo(30.0001, 31.0001); // A
    await memo(30.0002, 31.0002); // B
    await memo(30.0001, 31.0001); // A again: from memory, and now the newest
    assert.equal(calls, 2);
    await memo(30.0003, 31.0003); // C: over the bound, so B (the least recently used) goes
    assert.equal(calls, 3);
    await memo(30.0001, 31.0001); // A: still remembered
    assert.equal(calls, 3, "the cell used most recently survives the eviction");
    await memo(30.0002, 31.0002); // B: evicted, so asked again
    assert.equal(calls, 4, "the least recently used cell was the one evicted");
  }

  // The stamp still uses the capture's own coordinates — the memo holds only Google's address.
  const service = read(SERVICE);
  assert.match(service, /reverseGeocodeNearby\(latitude, longitude\)\s*\.catch\(\(\) => null\)/, "the endpoint still turns any lookup failure into no address");
  assert.match(service, /const brick = resolveBrickForPoint\(latitude, longitude, centroids\);/, "the brick is resolved from the exact pin");
  assert.match(service, /\blatitude,\s+longitude,\s+regionName:/, "and the stamp carries the exact pin");
}

export async function runEvidenceStampBlankCoordinatesTests() {
  await runReverseGeocodeMemoTests();

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
