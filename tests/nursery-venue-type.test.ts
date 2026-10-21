import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decodeVenueTarget,
  encodeVenueTarget,
} from "../src/lib/marketing-requests/venue-type.ts";
import {
  DEFAULT_VENUE_TYPE,
  VENUE_TYPES,
  normalizeVenueType,
  venueCanAttributeSales,
  venueNonAttributableReason,
  venueRequiresDistributorCode,
  venueTypeLabel,
} from "../src/lib/venues/venue-type.ts";
import { stripComments } from "./support/comment-strip.ts";

// The nursery venue type, and the schema hole it closed.
//
// Until 2026-08-23 both marketing link tables declared `distributor_code_id NOT NULL`, so a venue
// with no distributor account could not be linked to a customer or put on a request at all. The
// only way to save one was to invent a code, and three reached production — `0000` on
// حضانه النيل, `0001000000` on حضانه نور المصطفي, `0001511111` on حضانة زمزم — two of which were
// then written into `source_of_sales_customer_map`, where a fabricated code resolves `exact`
// forever and reads as trustworthy to every later consumer.
//
// These tests pin the two halves of the fix that are cheap to lose: the rule itself (pure, so it
// is exercised for real) and the four write/read paths that must keep honouring it (behind a
// database, so they are pinned at the source).

const SERVICE = "src/lib/marketing-requests/service.ts";
const ROI = "src/lib/marketing-requests/roi-report-service.ts";
const MIGRATION = "supabase/migrations/20260823060000_nursery_venue_type.sql";

function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/**
 * One predicate answers "does this venue have a distributor account?", and everything else reads
 * it. Re-deriving it inline is how the next venue type gets added in one place and missed in five.
 */
function testTheRuleIsOnePredicate() {
  assert.deepEqual([...VENUE_TYPES], ["pharmacy", "nursery"]);
  assert.equal(DEFAULT_VENUE_TYPE, "pharmacy");

  assert.equal(venueRequiresDistributorCode("pharmacy"), true);
  assert.equal(venueRequiresDistributorCode("nursery"), false);
  assert.equal(venueCanAttributeSales("pharmacy"), true);
  assert.equal(venueCanAttributeSales("nursery"), false);

  // A measurable venue has no reason to give, and an unmeasurable one must always give one —
  // an empty ROI cell with no sentence beside it reads as a zero return, which is a different
  // and far more damning claim than "this venue cannot be measured that way".
  assert.equal(venueNonAttributableReason("pharmacy"), null);
  assert.match(String(venueNonAttributableReason("nursery")), /no distributor account/i);

  assert.equal(venueTypeLabel("nursery"), "Nursery");
  assert.equal(venueTypeLabel("pharmacy"), "Pharmacy");
}

/**
 * Every row written before the column existed reads back NULL, and an offline client replaying an
 * old draft sends nothing at all. Both mean "pharmacy", which is what they were — so the
 * normalizer must fall back rather than throw.
 */
function testUnknownVenueTypesFallBackToPharmacy() {
  for (const input of [null, undefined, "", "  ", 7, {}, "hospital", "NURSERY_"]) {
    assert.equal(normalizeVenueType(input), "pharmacy", `${String(input)} must read as a pharmacy`);
  }
  for (const input of ["nursery", "Nursery", "  NURSERY  "]) {
    assert.equal(normalizeVenueType(input), "nursery", `${String(input)} must read as a nursery`);
  }
}

/**
 * The picker's identity had to change — attribution was keyed on the distributor code id, and two
 * codeless nurseries would have collapsed into one option. For a pharmacy the new key is BYTE-FOR-
 * BYTE the old one, so a draft saved before this shipped submits exactly what it always did.
 */
function testAPharmacyTargetIsUnchanged() {
  const distributorCodeId = "7c9f0f4e-0000-4000-8000-00000000abcd";
  assert.equal(encodeVenueTarget({ distributorCodeId, pharmacyId: "ignored" }), distributorCodeId);
  assert.deepEqual(decodeVenueTarget(distributorCodeId), { distributorCodeId, pharmacyId: null });
}

function testACodelessVenueTargetRoundTrips() {
  const pharmacyId = "1f2e3d4c-1111-4111-8111-1111111111ff";
  const encoded = encodeVenueTarget({ distributorCodeId: null, pharmacyId });

  assert.notEqual(encoded, pharmacyId, "a codeless target must be distinguishable from a code id");
  assert.deepEqual(decodeVenueTarget(encoded), { distributorCodeId: null, pharmacyId });

  // Neither a code nor a venue: refuse rather than resolve to an empty id, which would attach the
  // request to whatever row an empty-string lookup happened to find.
  for (const junk of ["", "   ", "venue:", "venue:   ", null, undefined, 42, {}]) {
    assert.equal(decodeVenueTarget(junk), null, `${String(junk)} names no venue`);
  }
}

/**
 * The central trick, and the one that fails SILENTLY if lost.
 *
 * Both write loops used to iterate the vendor codes directly, so a venue with zero codes produced
 * a customer row and a pharmacy row with nothing joining them — a venue that saved successfully
 * and then did not exist. `venueCodeSlots` yielded one NULL slot for a codeless venue so the link
 * was still written. Since 2026-10-21 (owner: "any thing with no distributor code never reach the
 * marketing requests") it REFUSES a codeless venue instead — the write loops still go through it,
 * so a codeless venue can never slip into a link row behind the capture gate.
 */
function testBothWriteLoopsGoThroughVenueCodeSlots() {
  const service = code(SERVICE);

  assert.match(
    service,
    /function venueCodeSlots</,
    "the codeless-slot rule must have exactly one definition",
  );
  // Two CALL sites — the definition reads `venueCodeSlots<T>(`, so it is not one of them.
  assert.equal(
    (service.match(/venueCodeSlots\(/g) ?? []).length,
    2,
    "both write loops (reuse and fresh capture) must call venueCodeSlots, not iterate vendorCodes",
  );
  assert.doesNotMatch(
    service,
    /for \(const (?:vendorCode|codeRow) of (?:normalizedPharmacy\.vendorCodes|reusedCodesByPharmacyId)/,
    "iterating the codes directly is what dropped the link row for a codeless venue",
  );
}

/**
 * Marketing capture refuses every venue without a distributor code (owner, 2026-10-21): a nursery
 * (no distributor account — so it can never carry a code either) and a pharmacy with no code. Both
 * are validated in Direct Orders. A code typed onto a nursery is refused by the same gate, because
 * the nursery is refused before its codes are read.
 */
function testCaptureRefusesBothWrongCombinations() {
  const service = code(SERVICE);

  // Through the one predicate, never an inline `venueType === "pharmacy"` re-derivation.
  assert.match(
    service,
    /if \(!venueRequiresDistributorCode\(venueType\) \|\| vendorCodeInputs\.length === 0\) \{\s*\n\s*throw validationError\(venueWithoutDistributorCodeMessage\(displayName\), VENUE_WITHOUT_DISTRIBUTOR_CODE\);/,
    "a nursery, and a pharmacy with no vendor code, must be refused at marketing capture via the one predicate",
  );
  assert.doesNotMatch(
    service,
    /pharmacy_code_or_license_required/,
    "the 2026-10-14 licence route (a codeless pharmacy saved on its licence) is retired",
  );
}

/**
 * The dead gate.
 *
 * `fetchPharmacyCodes` selected only `id, pharmacy_id, active`, so `reference_status` was
 * `undefined` on every row and the `not_found` refusal — the gate
 * marketing-submission-capture-gates.test.ts pins the existence of — could never once fire. All 22
 * production request targets happen to be `matched`, so nothing was mis-written; the single
 * offerable `not_found` target on 2026-08-23 was the fabricated nursery code `0000`. Losing the
 * column again would disarm the gate silently: no error, no row, and a green suite.
 */
function testTheReferenceStatusGateCanActuallyFire() {
  const service = readFileSync(SERVICE, "utf8");
  const select = service.match(/\.select\("id, pharmacy_id, active[^"]*"\)/);

  assert.ok(select, "fetchPharmacyCodes must still select the pharmacy-code columns");
  assert.match(
    select[0],
    /reference_status/,
    "reference_status must be SELECTED or the not_found capture gate reads undefined and never fires",
  );
}

/**
 * Owner rule: never silent-drop a row — flag it. A codeless target is not a broken row to skip
 * past; the money spent on it is just as real, and dropping it understates how many venues a
 * request paid for. Both ROI paths must skip only a code id that failed to RESOLVE.
 */
function testRoiListsAnUnattributableTargetInsteadOfDroppingIt() {
  const roi = code(ROI);

  assert.equal(
    (roi.match(/if \(link\.distributor_code_id\) continue;/g) ?? []).length,
    2,
    "both ROI loops must skip only an unresolved code id, never a link that names no code at all",
  );
  assert.doesNotMatch(
    roi,
    /const code = codeById\.get\(link\.distributor_code_id\);\s*\n\s*if \(!code\) continue;/,
    "the old unconditional skip made every codeless venue invisible to ROI",
  );
}

/**
 * The schema half. Without the NOT NULL drops the application rule is unenforceable; without the
 * partial unique indexes nothing stops a codeless venue being linked to the same customer twice,
 * because two NULLs never collide in the existing unique index.
 */
function testTheMigrationClosesTheSchemaHole() {
  const sql = readFileSync(MIGRATION, "utf8").toLowerCase();

  for (const table of ["marketing_customer_pharmacies", "marketing_request_pharmacies"]) {
    assert.match(
      sql,
      new RegExp(`alter table[^;]*${table}[^;]*alter column distributor_code_id drop not null`, "s"),
      `${table}.distributor_code_id must become nullable or a nursery cannot be linked at all`,
    );
    assert.match(
      sql,
      new RegExp(`create unique index[^;]*${table}[^;]*where distributor_code_id is null`, "s"),
      `${table} needs a partial unique index — two NULLs do not collide in the existing one`,
    );
  }

  for (const table of ["marketing_pharmacies", "direct_order_pharmacies"]) {
    assert.match(
      sql,
      new RegExp(`alter table[^;]*${table}[^;]*add column if not exists venue_type`, "s"),
      `${table} must carry the venue type`,
    );
  }

  assert.match(
    sql,
    /default 'pharmacy'/,
    "every existing row must read back as what it was — a pharmacy",
  );
}

export function runNurseryVenueTypeTests() {
  testTheRuleIsOnePredicate();
  testUnknownVenueTypesFallBackToPharmacy();
  testAPharmacyTargetIsUnchanged();
  testACodelessVenueTargetRoundTrips();
  testBothWriteLoopsGoThroughVenueCodeSlots();
  testCaptureRefusesBothWrongCombinations();
  testTheReferenceStatusGateCanActuallyFire();
  testRoiListsAnUnattributableTargetInsteadOfDroppingIt();
  testTheMigrationClosesTheSchemaHole();
}
