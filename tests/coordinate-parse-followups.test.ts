import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readCoordinateInput } from "../src/lib/geo/coordinate-input.ts";
import { buildManagerExpenseAdminPatch } from "../src/lib/outstation/manager-expense-input.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A blank or missing coordinate is NO coordinate, never 0 — the two write paths #3993 left out.
//
// `Number(null)`, `Number("")` and `Number(" ")` are all 0, which is finite, so a missing value
// passed every `Number.isFinite` check and was stored at 0°N 0°E. #3991 and #3993 fixed the
// outstation arrival and departure routes with a shared reader. Two paths still coerced:
//
//   1. The admin manager-expense EDIT (manager-expense-input.ts `readDestination`) read the
//      destination with `Number(value.latitude)`, so `{ latitude: null, longitude: null }` or
//      blanks became a 0,0 destination, and updateManagerExpenseAsAdmin writes those two straight
//      into the trip's captured_latitude/captured_longitude. It now reads through the outstation
//      reader, and a null result is refused exactly as before.
//   2. The direct-order pharmacy validation route handled null but turned "" and " " into 0, a
//      finite pin that passed the service's missing-pin refusal. The route now passes the pin
//      through untouched and the service reads it, so a blank pin is missing and a field claim is
//      refused with VENUE_LOCATION_REQUIRED_MESSAGE, as a null one always was.
//
// The one-value parse lives in src/lib/geo/coordinate-input.ts and both domains share it. What a
// missing value MEANS stays each domain's own: outstation drops half pairs and 0,0, direct orders
// keeps each coordinate on its own, and neither has a range check.
//
// Production held 0 rows at 0,0 on either path when this was fixed (2026-09-18): 115 outstation
// requests and 9 pharmacy validations, the one validation with no pin being an invoice-route
// claim, which needs none. The defect was latent; no data was repaired.
// ─────────────────────────────────────────────────────────────────────────────

const DIRECT_ORDER_ROUTE = "app/api/direct-orders/pharmacy-validations/route.ts";
const DIRECT_ORDER_SERVICE = "src/lib/direct-orders/pharmacy-validation.ts";
const OUTSTATION_READER = "src/lib/outstation/captured-coordinates.ts";

const DESTINATION_REFUSAL = {
  error: "invalid_destination",
  message: "Provided destination must have valid coordinates.",
  ok: false,
} as const;

/** An admin edit that touches only the destination, as the edit modal would post it. */
function editDestination(latitude: unknown, longitude: unknown) {
  return buildManagerExpenseAdminPatch({
    destination: {
      area: "El-Geish",
      city: "Tanta",
      country: "Egypt",
      label: "El-Geish St, Tanta, Gharbia",
      latitude,
      longitude,
      placeId: "place-tanta-77",
    },
  });
}

export function runCoordinateParseFollowupsTests() {
  // ── 1. The admin edit: the headline ───────────────────────────────────────────
  assert.deepEqual(
    editDestination(null, null),
    DESTINATION_REFUSAL,
    "an admin edit whose destination has null coordinates must be REFUSED — Number(null) is 0, so it was accepted and saved at 0,0",
  );

  for (const [label, lat, lon] of [
    ["keys left out", undefined, undefined],
    ["empty", "", ""],
    ["blank", " ", "  "],
    ["half (longitude missing)", 30.7865, null],
    ["half (latitude blank)", "", 31.0004],
    ["exactly 0,0", 0, 0],
    ["non-numeric", "abc", "def"],
  ] as const) {
    assert.deepEqual(
      editDestination(lat, lon),
      DESTINATION_REFUSAL,
      `an admin edit with a ${label} destination is refused with the same message as before, never saved at 0,0`,
    );
  }

  // Real destinations still get through, exactly as sent.
  const real = editDestination(30.7865, 31.0004);
  assert.equal(real.ok, true, "a real destination is accepted");
  const realDestination = real.ok ? real.input.destination : undefined;
  assert.equal(realDestination?.latitude, 30.7865, "the latitude is kept exactly");
  assert.equal(realDestination?.longitude, 31.0004, "the longitude is kept exactly");
  assert.equal(realDestination?.label, "El-Geish St, Tanta, Gharbia", "the label rides along");

  const typed = editDestination("30.7865", " 31.0004 ");
  assert.equal(typed.ok, true, "non-blank numeric strings are real coordinates");
  const typedDestination = typed.ok ? typed.input.destination : undefined;
  assert.equal(typedDestination?.latitude, 30.7865);
  assert.equal(typedDestination?.longitude, 31.0004);

  const singleZero = editDestination(0, 31.0004);
  assert.equal(singleZero.ok, true, "a single real 0 is a coordinate and survives");
  assert.equal(singleZero.ok ? singleZero.input.destination?.latitude : undefined, 0);

  // An edit that never mentions the destination leaves the stored one alone, as before.
  const untouched = buildManagerExpenseAdminPatch({ notes: "only this changed" });
  assert.equal(untouched.ok, true);
  const untouchedInput = untouched.ok ? untouched.input : {};
  assert.equal("destination" in untouchedInput, false, "no destination key when none was sent");

  // ── The shared one-value reader ───────────────────────────────────────────────
  for (const [label, value] of [
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["blank", " "],
    ["tab and newline", "\t\n"],
  ] as const) {
    assert.equal(readCoordinateInput(value), null, `${label} is no coordinate — Number(...) made it 0`);
  }
  for (const junk of ["abc", "30.0.1", Number.NaN, Number.POSITIVE_INFINITY, true, false, {}, [], [30]]) {
    assert.equal(
      readCoordinateInput(junk),
      null,
      `a non-numeric value (${JSON.stringify(junk)}) is no coordinate`,
    );
  }
  assert.equal(readCoordinateInput(30.7865), 30.7865, "a real number is kept exactly");
  assert.equal(readCoordinateInput(" 30.7865 "), 30.7865, "a non-blank numeric string is read");
  assert.equal(readCoordinateInput(0), 0, "a real 0 is a coordinate");
  assert.equal(readCoordinateInput("0"), 0, "a typed 0 is a coordinate");

  // ── 2. The direct-order pharmacy validation ───────────────────────────────────
  const route = stripComments(readFileSync(DIRECT_ORDER_ROUTE, "utf8"));
  assert.doesNotMatch(
    route,
    /Number\(\s*body\.captured(?:Latitude|Longitude)\s*\)/,
    "the pharmacy validation route must not coerce the pin — Number(\"\") and Number(\" \") are 0, which filed a blank pin at 0,0 and passed the missing-pin refusal",
  );
  assert.match(
    route,
    /capturedLatitude:\s*body\.capturedLatitude,/,
    "the route passes the latitude through exactly as posted",
  );
  assert.match(
    route,
    /capturedLongitude:\s*body\.capturedLongitude,/,
    "the route passes the longitude through exactly as posted",
  );

  const service = stripComments(readFileSync(DIRECT_ORDER_SERVICE, "utf8"));
  assert.match(
    service,
    /import \{ readCoordinateInput \} from "@\/lib\/geo\/coordinate-input";/,
    "the direct-orders service reads the pin with the shared reader",
  );
  assert.match(
    service,
    /const capturedLatitude = readCoordinateInput\(input\.capturedLatitude\);/,
    "a blank latitude reaches the missing-pin refusal as null",
  );
  assert.match(
    service,
    /const capturedLongitude = readCoordinateInput\(input\.capturedLongitude\);/,
    "a blank longitude reaches the missing-pin refusal as null",
  );

  // ── One reader, not two ───────────────────────────────────────────────────────
  const outstation = stripComments(readFileSync(OUTSTATION_READER, "utf8"));
  assert.match(
    outstation,
    /import \{ readCoordinateInput \} from "@\/lib\/geo\/coordinate-input";/,
    "the outstation reader parses each value with the same shared reader",
  );
  assert.doesNotMatch(
    outstation,
    /function coordinateFromBody\b/,
    "captured-coordinates.ts must not carry its own copy of the one-value parse",
  );
}
