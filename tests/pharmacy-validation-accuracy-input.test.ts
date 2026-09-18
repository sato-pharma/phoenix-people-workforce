import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readAccuracyInput } from "../src/lib/geo/coordinate-input.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A blank GPS accuracy on a direct-order pharmacy claim is NO accuracy, never a perfect 0 m fix.
//
// #3995 stopped the pharmacy validation route coercing the PIN, but the accuracy on the next line
// kept `body.capturedAccuracyMeters == null ? null : Number(body.capturedAccuracyMeters)`: null was
// handled, "" and " " became 0, and the service stored that 0 in captured_accuracy_meters as a fix
// the device never reported. The route now passes the value through untouched and the service reads
// it with readAccuracyInput, the same one-value parse as the pin (src/lib/geo/coordinate-input.ts).
//
// The accuracy decides nothing on this path. It is only stored, so there is no range check and no
// refusal: a claim with no accuracy is filed exactly as before, with null.
//
// Production held 0 rows at 0 m when this was fixed (2026-09-18): the 8 field claims carry 2 to 100
// m and the one invoice claim carries none. The defect was latent; no data was repaired.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE = "app/api/direct-orders/pharmacy-validations/route.ts";
const SERVICE = "src/lib/direct-orders/pharmacy-validation.ts";

export function runPharmacyValidationAccuracyInputTests() {
  // ── The route: the headline ───────────────────────────────────────────────────
  const route = stripComments(readFileSync(ROUTE, "utf8"));
  assert.doesNotMatch(
    route,
    /Number\(\s*body\.capturedAccuracyMeters\s*\)/,
    "the pharmacy validation route must not coerce the accuracy — Number(\"\") and Number(\" \") are 0, which stored a blank accuracy as a perfect 0 m fix",
  );
  assert.match(
    route,
    /capturedAccuracyMeters:\s*body\.capturedAccuracyMeters,/,
    "the route passes the accuracy through exactly as posted",
  );

  // ── The service reads it, and stores only what it read ────────────────────────
  const service = stripComments(readFileSync(SERVICE, "utf8"));
  assert.match(
    service,
    /import \{[^}]*\breadAccuracyInput\b[^}]*\} from "@\/lib\/geo\/coordinate-input";/,
    "the direct-orders service reads the accuracy with the shared reader",
  );
  assert.match(
    service,
    /const capturedAccuracyMeters = readAccuracyInput\(input\.capturedAccuracyMeters\);/,
    "a blank accuracy reaches the insert as null",
  );
  assert.match(
    service,
    /captured_accuracy_meters:\s*capturedAccuracyMeters,/,
    "the row stores the parsed accuracy",
  );
  assert.doesNotMatch(
    service,
    /captured_accuracy_meters:\s*input\.capturedAccuracyMeters/,
    "the row never stores the raw posted accuracy",
  );

  // ── The reader ────────────────────────────────────────────────────────────────
  for (const [label, value] of [
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["blank", " "],
    ["tab and newline", "\t\n"],
  ] as const) {
    assert.equal(readAccuracyInput(value), null, `${label} is no accuracy — Number(...) made it a perfect 0 m`);
  }
  for (const junk of ["abc", "12 m", Number.NaN, Number.POSITIVE_INFINITY, true, false, {}, [], [12]]) {
    assert.equal(readAccuracyInput(junk), null, `a non-numeric value (${JSON.stringify(junk)}) is no accuracy`);
  }
  assert.equal(readAccuracyInput(12.4), 12.4, "a real accuracy is kept exactly");
  assert.equal(readAccuracyInput(" 35 "), 35, "a non-blank numeric string is read");
  assert.equal(readAccuracyInput(0), 0, "a device that really reports 0 m keeps it; no rule is invented here");
}
