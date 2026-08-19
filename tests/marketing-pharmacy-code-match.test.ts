import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  normalizePharmacyCode,
  pharmacyCodeLookupForms,
  pharmacyCodeLookupSet,
} from "../src/lib/marketing-requests/pharmacy-code-match.ts";

/**
 * The live defect this pins, in one line: a customer registered as `1548234` had EGP 8,981 of real
 * trade stored under `0001548234`, and the sales-evidence panel reported it as a customer that had
 * never bought anything — in red, to the approver deciding whether to spend on it.
 */
export function runMarketingPharmacyCodeMatchTests() {
  // ── the defect itself ──────────────────────────────────────────────────────
  assert.deepEqual(
    pharmacyCodeLookupForms("1548234"),
    ["0001548234", "1548234"],
    "the entered short code must also search its ten-digit padded form — this is the whole bug",
  );

  // Symmetric: a customer registered with the padded form must still match sales written bare.
  assert.deepEqual(
    pharmacyCodeLookupForms("0001548234"),
    ["0001548234", "1548234"],
    "padding is formatting, not identity, so both directions resolve to the same pair",
  );

  // A code already at the padded width gains nothing and must not grow a second padded form.
  assert.deepEqual(
    pharmacyCodeLookupForms("1234567890"),
    ["1234567890"],
    "a code already ten digits wide has exactly one spelling",
  );

  // Six-digit codes are the second most common width in Source of Sales.
  assert.deepEqual(
    pharmacyCodeLookupForms("123456"),
    ["0000123456", "123456"],
    "a six-digit code searches both its bare and padded spellings",
  );

  // ── what must NOT be invented ──────────────────────────────────────────────
  assert.deepEqual(
    pharmacyCodeLookupForms("ABC-123"),
    ["ABC-123"],
    "a non-numeric code is never padded — padding it would invent a code nobody holds",
  );

  assert.deepEqual(pharmacyCodeLookupForms(""), [], "an empty code yields no lookup at all");
  assert.deepEqual(pharmacyCodeLookupForms(null), [], "a null code yields no lookup at all");
  assert.deepEqual(pharmacyCodeLookupForms("   "), [], "whitespace is not a code");

  // An all-zero code strips to nothing. Emitting "" would match every blank client_code in the
  // sales table and credit a customer with sales belonging to nobody.
  assert.deepEqual(
    pharmacyCodeLookupForms("0000"),
    ["0000"],
    "an all-zero code keeps itself rather than emitting an empty lookup that matches blanks",
  );

  // ── normalization ──────────────────────────────────────────────────────────
  assert.equal(normalizePharmacyCode("  ab12  "), "AB12", "codes are trimmed and upper-cased");
  assert.equal(normalizePharmacyCode(undefined), "", "undefined normalizes to empty, never 'undefined'");

  // ── the set builder used by the query ──────────────────────────────────────
  assert.deepEqual(
    pharmacyCodeLookupSet(["1548234", "0001548234", "123456"]),
    ["0000123456", "0001548234", "123456", "1548234"],
    "two spellings of one pharmacy collapse to one pair — the IN list never carries duplicates",
  );

  assert.deepEqual(pharmacyCodeLookupSet([]), [], "no registered codes means no lookup");
  assert.deepEqual(
    pharmacyCodeLookupSet([null, "", "  "]),
    [],
    "blank registrations contribute nothing rather than an empty-string match",
  );

  // ── the wiring, so the fix cannot be silently unplugged ────────────────────
  // The forms are only worth building if the sales query actually searches them. A refactor that
  // puts `matchedPharmacyCodes` back into the `.in()` restores the exact defect while every unit
  // assertion above still passes.
  const evidenceSource = readFileSync("src/lib/marketing-requests/sales-evidence.ts", "utf8");
  assert.ok(
    evidenceSource.includes("const lookupPharmacyCodes = pharmacyCodeLookupSet(pharmacyCodes)"),
    "sales-evidence must build the expanded lookup set from the registered codes",
  );
  assert.ok(
    evidenceSource.includes("for (const codeBatch of chunk(lookupPharmacyCodes))"),
    "the sales lookup must batch over the EXPANDED codes, not the codes as entered",
  );
  assert.ok(
    !/\.in\("client_code", *matchedPharmacyCodes\)/.test(evidenceSource),
    "the sales query must never match client_code against the entered spelling alone",
  );

  // The panel must keep showing the approver the code as REGISTERED — the expanded forms are a
  // lookup detail, and printing "0001548234" back at a rep who typed "1548234" reads as a typo.
  const panelSource = readFileSync(
    "src/components/marketing-requests/marketing-sales-evidence-panel.tsx",
    "utf8",
  );
  assert.ok(
    panelSource.includes("data.matchedPharmacyCodes.join(\", \")"),
    "the panel still displays the codes as the rep registered them",
  );
  // The panel may report an empty result; it may not rule on what the emptiness MEANS.
  assert.ok(
    !panelSource.includes("This is an unproven customer, not missing data"),
    "the panel must not assert that a no-match proves the customer never bought — it cannot know that",
  );
}
