import assert from "node:assert/strict";

import { normalizeAmpm } from "../src/lib/crm/sync.ts";

// Measured against the live production mirror on 2026-08-21: of 122,814 visits, 97 carry a
// mis-cased half-day marker — "Pm" (58), "Am" (23), "pm" (16) — against 94,689 "PM" and 25,229
// "AM". iReports360 has the same inconsistent-casing habit on contactGrade, which sync.ts already
// normalized; ampm was passed through raw. Two readers take the value literally:
//   * the CRM master AM/PM filter does an exact .eq("ampm", ...), so a mis-cased row is invisible;
//   * the day-count logic in master.ts treats any marker that is not exactly "AM"/"PM" as a FULL
//     day, so a lone "Pm" scored 1.0 day instead of 0.5.
const VENDOR_CASING = [
  { expected: "PM", input: "Pm", rows: 58 },
  { expected: "AM", input: "Am", rows: 23 },
  { expected: "PM", input: "pm", rows: 16 },
];

export function runCrmAmpmNormalizationTests() {
  // The headline: every casing variant the vendor actually sends folds onto the canonical marker.
  for (const variant of VENDOR_CASING) {
    assert.equal(
      normalizeAmpm(variant.input),
      variant.expected,
      `the vendor's "${variant.input}" (${variant.rows} live rows) must normalize to "${variant.expected}", or the AM/PM filter and the half-day count both miss it`,
    );
  }

  // Canonical values pass through untouched.
  assert.equal(normalizeAmpm("AM"), "AM", "a canonical AM must be unchanged");
  assert.equal(normalizeAmpm("PM"), "PM", "a canonical PM must be unchanged");

  // Stray whitespace is this vendor's other habit on the same class of field.
  assert.equal(normalizeAmpm(" PM "), "PM", "surrounding whitespace must be trimmed");
  assert.equal(normalizeAmpm("\tam\n"), "AM", "tabs and newlines must be trimmed too");

  // Blank means "no half-day marker" — the convention every other optional CRM field uses, and
  // what the day-count logic already reads as a full day. 1,166 live rows send "" and 1,633 send
  // null; both must land on ONE representation so the two are never counted as different markers.
  assert.equal(normalizeAmpm(""), null, "an empty string must become null, not stay empty");
  assert.equal(normalizeAmpm("   "), null, "a whitespace-only value must become null");
  assert.equal(normalizeAmpm(null), null, "null stays null");
  assert.equal(normalizeAmpm(undefined), null, "undefined becomes null");

  // An unrecognized marker is NOT discarded. Owner rule: never silent-drop vendor data — surface
  // it. master.ts already counts anything non-AM/PM as a full day, so keeping it is safe AND
  // visible, whereas nulling it would hide a vendor change behind a blank.
  assert.equal(
    normalizeAmpm("Evening"),
    "EVENING",
    "an unrecognized marker must be kept (uppercased), never silently discarded",
  );
}
