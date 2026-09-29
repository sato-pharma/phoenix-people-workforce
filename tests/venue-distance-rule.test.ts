import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  VENUE_LINK_MAX_METRES,
  checkCustomerPharmacyDistance,
  venueTooFarMessage,
} from "../src/lib/venues/customer-pharmacy-distance.ts";

// THE 4 KM RULE — owner ruling, 2026-09-29, after being shown what each candidate threshold would
// have refused across the 127 live customer-pharmacy links.
//
// This test pins THREE things, and the third is the one with teeth:
//   1. the arithmetic and the verdict bands,
//   2. that a missing fix refuses NOTHING — a gap in our data is never evidence against a rep,
//   3. that the SERVICE actually calls the check, before any row is written.
//
// (3) matters because the rule is only as real as its call site. The module could be perfect and
// the normalizer could simply never invoke it, which no arithmetic test would notice.

/** The two real production captures behind tonight's incidents. Both are metres apart. */
const SAMAA_CLINIC = { latitude: 30.4952868, longitude: 31.4771601 };
const SAMAA_PHARMACY = { latitude: 30.4954306, longitude: 31.4770646 };
/** Taha's pair: house 74 and house 75 of the same street in 6th of October City. */
const TAHA_CLINIC = { latitude: 29.9601, longitude: 30.9231 };

function runArithmeticTests() {
  // ── The threshold is the owner's number, not a preference ────────────────────
  assert.equal(
    VENUE_LINK_MAX_METRES,
    4000,
    "the 4 km limit is an owner ruling (2026-09-29) — changing it needs him, not a code review",
  );

  // ── Neither real incident trips this rule, and that is the point ──────────────
  // Both were WRONG CODES on shops standing beside the doctor. If a future change makes either of
  // these refuse, the threshold has been tightened into refusing honest field work.
  const samaa = checkCustomerPharmacyDistance(SAMAA_CLINIC, SAMAA_PHARMACY);
  assert.equal(samaa.verdict, "within_range");
  assert.equal(samaa.refused, false, "Samaa's 18 m pair must never be refused by a distance rule");
  assert.ok(
    samaa.distanceMeters !== null && samaa.distanceMeters < 50,
    `expected the real pair ~18 m apart, got ${String(samaa.distanceMeters)}`,
  );

  // ── The worst honest pair in production (1,069 m) still passes, with margin ───
  const farHonest = checkCustomerPharmacyDistance(
    { latitude: 30.5, longitude: 31.0 },
    { latitude: 30.5096, longitude: 31.0 },
  );
  assert.ok(
    farHonest.distanceMeters !== null && farHonest.distanceMeters > 1000,
    "control: this pair must actually be over 1 km for the assertion below to mean anything",
  );
  assert.equal(
    farHonest.refused,
    false,
    "the furthest real capture in production is 1,069 m — it must not be refused",
  );

  // ── Beyond 4 km is refused ───────────────────────────────────────────────────
  // Zagazig against Haram/Faisal, Giza: the two places Samaa's mistyped code sat between, ~60 km.
  const crossCountry = checkCustomerPharmacyDistance(SAMAA_CLINIC, { latitude: 29.99, longitude: 31.18 });
  assert.equal(crossCountry.verdict, "too_far");
  assert.equal(crossCountry.refused, true);

  // Just either side of the line.
  const justUnder = checkCustomerPharmacyDistance(TAHA_CLINIC, { latitude: 29.9601 + 0.0350, longitude: 30.9231 });
  const justOver = checkCustomerPharmacyDistance(TAHA_CLINIC, { latitude: 29.9601 + 0.0370, longitude: 30.9231 });
  assert.ok(
    justUnder.distanceMeters !== null && justUnder.distanceMeters < VENUE_LINK_MAX_METRES,
    "control: the near point must sit inside the limit",
  );
  assert.equal(justUnder.refused, false);
  assert.ok(
    justOver.distanceMeters !== null && justOver.distanceMeters > VENUE_LINK_MAX_METRES,
    "control: the far point must sit outside the limit",
  );
  assert.equal(justOver.refused, true);

  // ── A MISSING FIX REFUSES NOTHING ───────────────────────────────────────────
  // Phoenix's own data gaps must never become evidence against a rep. A desk-entered customer or a
  // handset that refused permission must stay linkable.
  for (const [label, customer, pharmacy] of [
    ["no customer fix", null, SAMAA_PHARMACY],
    ["no pharmacy fix", SAMAA_CLINIC, null],
    ["neither", null, null],
    ["blank coordinates", { latitude: null, longitude: null }, SAMAA_PHARMACY],
  ] as const) {
    const check = checkCustomerPharmacyDistance(customer, pharmacy);
    assert.equal(check.verdict, "not_comparable", `${label}: must be not_comparable`);
    assert.equal(check.refused, false, `${label}: an unmeasurable pair must never be refused`);
    assert.equal(check.distanceMeters, null, `${label}: distance must be null, never 0`);
  }

  // ── The message names the shop and the distance, and accuses nobody ──────────
  const message = venueTooFarMessage({
    customerName: "محمد سعيد الجندي",
    distanceMeters: 61_400,
    pharmacyName: "أسعد الجديدة",
  });
  assert.ok(message.includes("أسعد الجديدة") && message.includes("محمد سعيد الجندي"), "names both sides");
  assert.ok(message.includes("61 km"), `expected a rounded distance, got: ${message}`);
  for (const forbidden of ["fraud", "violation", "suspicious", "recorded", "flagged", "checked against"]) {
    assert.ok(
      !message.toLowerCase().includes(forbidden),
      `the refusal must not imply the rep is under suspicion — found "${forbidden}" in: ${message}`,
    );
  }
}

function runCallSiteTests() {
  // THE RULE IS ONLY AS REAL AS ITS CALL SITE. A perfect module the normalizer never calls refuses
  // nothing, and every arithmetic assertion above would still pass.
  const servicePath = fileURLToPath(
    new URL("../src/lib/marketing-requests/service.ts", import.meta.url),
  );
  const source = readFileSync(servicePath, "utf8");

  // A WORD-BOUNDARY MATCH, NOT `includes`. The first version of this assertion used
  // `source.includes("checkCustomerPharmacyDistance")` and was proven worthless: renaming the call
  // to `DISABLED_checkCustomerPharmacyDistance(` — a one-line way to switch the rule off —
  // still contains that substring, so the test stayed green while the 4 km rule refused nothing.
  // Caught by breaking the fix on purpose, which is the only reason it is written this way.
  // NO LOOKBEHIND AND NO `s` FLAG. Both are ES2018 and this repo's tsconfig targets older, so they
  // fail `tsc` — while `pnpm test` STRIPS types rather than checking them and reports green. That
  // is exactly how this file first reached CI red: the local suite cannot see this class at all.
  // A leading capture group does the same job on every target.
  const callPattern = /(^|[^A-Za-z0-9_$])checkCustomerPharmacyDistance\s*\(/m;
  assert.ok(
    callPattern.test(source),
    "service.ts must CALL checkCustomerPharmacyDistance — without it the 4 km rule refuses nothing",
  );
  assert.ok(
    /import\s*\{[\s\S]*?checkCustomerPharmacyDistance/.test(source),
    "it must be imported by that exact name, so a rename cannot quietly detach the rule",
  );
  assert.ok(
    source.includes("pharmacy_too_far_from_customer"),
    "the refusal must carry its own error code so the client can tell it from any other validation error",
  );

  // It must run in the NORMALIZER, before any insert. Beside the insert instead, a refusal would
  // unwind rows already written — a violent way to say "wrong shop".
  const callIndex = source.search(callPattern);
  const firstInsertIndex = source.indexOf('.from("marketing_customers")');
  assert.ok(callIndex > 0 && firstInsertIndex > 0, "control: both anchors must exist");
  assert.ok(
    callIndex < firstInsertIndex,
    "the distance check must run before the first customer insert, so a refused submission writes nothing",
  );

  // The reuse path is deliberately exempt: an existing pharmacy's capture lives in the database and
  // the client's copy of those fields is meaningless by contract.
  assert.ok(
    source.includes("if (pharmacy.existingPharmacyId) continue;"),
    "an existing (reused) pharmacy must skip the distance check — its coordinates are not on the input",
  );
}

export function runVenueDistanceRuleTests() {
  runArithmeticTests();
  runCallSiteTests();
}
