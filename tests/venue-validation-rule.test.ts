import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  pharmacyLicenseFillsTheIdentityGap,
  pharmacyLicensePrompt,
} from "../src/lib/venues/pharmacy-license.ts";
import { VENUE_TYPES } from "../src/lib/venues/venue-type.ts";
import {
  VENUE_LOCATION_REQUIRED_MESSAGE,
  resolveVenueIdentityRoute,
  venueIdentityGapMessage,
  venueIdentityIsEstablished,
} from "../src/lib/venues/venue-validation-rule.ts";

// The owner's rule for validating a venue, and the proof that it FIRES rather than merely existing.
//
// His words, 2026-08-26: "to be validated, of course, a location and a picture, a live picture. This
// is a must. Plus either the pharmacy code, and it is in our database, or the pharmacy license, if
// the pharmacy code is not in our database."
//
//   leg 1  a GPS location   — a must, always
//   leg 2  a live picture    — a must, always
//   leg 3  an identity route — the CODE when it is in our database, otherwise the LICENCE
//
// Only leg 2 was enforced before this. Measured on production 2026-08-26: three validations had been
// APPROVED AS BRAND NEW carrying no licence and no code the master database agrees with — two of
// them nurseries, one of which had been given an invented code instead. Every one of those three
// carried a photograph, which is precisely why leg 2 alone is not enough: a photo proves a shop
// front was in front of a camera, and nothing else.
//
// Losing any of this fails silently and looks like success — a venue is minted, orders flow against
// it, and the identity nobody checked is discovered a year later when a sale cannot be attributed.

const PHARMACY_VALIDATION = "src/lib/direct-orders/pharmacy-validation.ts";
const CAPTURE_SCREEN = "src/components/direct-orders/pharmacy-validation-capture.tsx";

/** Source with comments stripped — a comment naming a call is not a call. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * Leg 3's arithmetic: two routes, and the code wins when both are there.
 *
 * The code winning is not a preference between documents. It keeps the answer STABLE — a venue that
 * resolves by code reads the same before and after somebody happens to attach a licence to it, so a
 * row cannot change what it claims about itself because of an unrelated upload.
 */
function testEitherRouteIdentifiesAVenueAndNeitherIsAGap() {
  assert.equal(
    resolveVenueIdentityRoute({ codesInOurDatabase: 1, hasLicenseOnFile: false, venueType: "pharmacy" }),
    "code",
    "a code the master database agrees with is the primary route",
  );
  assert.equal(
    resolveVenueIdentityRoute({ codesInOurDatabase: 0, hasLicenseOnFile: true, venueType: "pharmacy" }),
    "licence",
    "and the licence is the fallback when there is no such code",
  );
  assert.equal(
    resolveVenueIdentityRoute({ codesInOurDatabase: 1, hasLicenseOnFile: true, venueType: "pharmacy" }),
    "code",
    "the code wins when both exist, so the answer cannot move under an unrelated upload",
  );
  assert.equal(
    resolveVenueIdentityRoute({ codesInOurDatabase: 0, hasLicenseOnFile: false, venueType: "pharmacy" }),
    "none",
    "and neither is the case the whole rule exists for",
  );

  // THE CODE ROUTE IS CLOSED TO A NURSERY, even when the code resolves. Verifying against the master
  // database is not enough by itself: two invented nursery codes were written INTO that database and
  // resolve there exactly like real ones, so a nursery holding a "valid" code is the signature of the
  // very forgery this rule exists to stop, not evidence of identity.
  assert.equal(
    resolveVenueIdentityRoute({ codesInOurDatabase: 1, hasLicenseOnFile: false, venueType: "nursery" }),
    "none",
    "a nursery cannot hold a real distributor code, so a resolving one must not buy it a pass",
  );
  assert.equal(
    resolveVenueIdentityRoute({ codesInOurDatabase: 1, hasLicenseOnFile: true, venueType: "nursery" }),
    "licence",
    "and its licence is what identifies it, never the code beside it",
  );

  // EITHER/OR, never both. A venue that resolves by code must never be asked for a licence as well
  // — that is asking twice, and the owner corrected exactly that reading.
  assert.equal(
    venueIdentityIsEstablished({ codesInOurDatabase: 2, hasLicenseOnFile: false, venueType: "pharmacy" }),
    true,
    "a coded pharmacy is identified WITHOUT a licence — the licence is a route, not evidence",
  );
  assert.equal(
    venueIdentityIsEstablished({ codesInOurDatabase: 0, hasLicenseOnFile: false, venueType: "pharmacy" }),
    false,
  );
}

/**
 * A nursery has ONE route, and it must be told so in its own words.
 *
 * A nursery has no distributor account by its nature, so no code of its can ever be in the master
 * database. The licence is therefore not optional for it — it is the only thing left. That is not a
 * technicality: three invented nursery codes reached production, written by people who had no other
 * way to register a venue, and two of those codes were later written into
 * `source_of_sales_customer_map` where a fabricated code resolves forever.
 */
function testANurseryCanOnlyEverPassByLicence() {
  const gap = venueIdentityGapMessage({
    codesInOurDatabase: 0,
    hasLicenseOnFile: false,
    venueType: "nursery",
  });
  assert.ok(gap, "a nursery with no licence has not established who it is");
  assert.match(gap!, /licence/i, "and the way out it is offered is the licence");
  assert.doesNotMatch(
    gap!,
    /Match it to the real customer/,
    "never the pharmacy sentence — there is no real customer for a nursery to match to",
  );

  assert.equal(
    venueIdentityGapMessage({ codesInOurDatabase: 0, hasLicenseOnFile: true, venueType: "nursery" }),
    null,
    "with the licence on file a nursery is identified and nothing more may be demanded",
  );

  // A nursery carrying a code is not merely unidentified — it is the forgery signature, and the desk
  // is told so in those terms rather than being left to wonder why a resolving code did not count.
  const invented = venueIdentityGapMessage({
    codesInOurDatabase: 1,
    hasLicenseOnFile: false,
    venueType: "nursery",
  });
  assert.ok(invented, "a nursery is not identified by a code however well that code resolves");
  assert.match(invented!, /invented/i, "and the desk is told WHY the code beside it does not count");

  const pharmacyGap = venueIdentityGapMessage({
    codesInOurDatabase: 0,
    hasLicenseOnFile: false,
    venueType: "pharmacy",
  });
  assert.ok(pharmacyGap, "a codeless pharmacy has not established who it is either");
  assert.notEqual(
    pharmacyGap,
    gap,
    "the two venue types have different ways out, so they must not be handed the same sentence",
  );

  assert.equal(
    venueIdentityGapMessage({ codesInOurDatabase: 1, hasLicenseOnFile: false, venueType: "pharmacy" }),
    null,
    "and a coded pharmacy is asked for nothing at all",
  );
}

/**
 * THE DRIFT CHECK. Nothing may be refused that was never asked for.
 *
 * `pharmacyLicenseFillsTheIdentityGap` decides what the capture screen SAYS; `venueIdentityGapMessage`
 * decides what the approval desk REFUSES. They are two halves of one check, and a gate that bites
 * where nothing was ever asked is how a rep gets blocked for a document nobody mentioned. This is
 * the assertion that caught the nursery exemption: the prompt exempted nurseries while the rule left
 * them exactly one route.
 */
function testThePromptAsksForEverythingTheDeskWillRefuse() {
  // Counted, because a loop whose body never runs passes and proves nothing — and every assertion
  // in this one sits behind a `continue`.
  let refusals = 0;

  for (const venueType of VENUE_TYPES) {
    for (const codeCount of [0, 1, 2]) {
      const refused = venueIdentityGapMessage({
        codesInOurDatabase: codeCount,
        hasLicenseOnFile: false,
        venueType,
      });
      if (!refused) continue;
      refusals += 1;

      assert.equal(
        pharmacyLicenseFillsTheIdentityGap({ distributorCodeCount: codeCount, venueType }),
        true,
        `${venueType} with ${codeCount} code(s) is refused at the desk but never prompted at capture`,
      );
      assert.ok(
        pharmacyLicensePrompt({ distributorCodeCount: codeCount, hasLicenseOnFile: false, venueType }),
        `${venueType} with ${codeCount} code(s) is refused at the desk with nothing said on the form`,
      );
    }
  }

  // A codeless pharmacy and a nursery at each of the three code counts: four refusals, and a nursery
  // is refused however many codes are written against it, because every one of them is invented.
  assert.equal(refusals, 4, "the desk must actually refuse something, or this test asserts nothing");

  // The reverse direction is NOT asserted, and deliberately. The prompt may ask where the desk would
  // not refuse — a pharmacy whose only code is `not_found` is worth a licence and is still approvable
  // by matching. Prompting more than you refuse is safe; refusing more than you prompt is not.
}

/**
 * HEADLINE — leg 1 actually refuses. A validation with no pin cannot be filed.
 *
 * The pin is not decoration. It is the only input tying the storefront photo to a PLACE, it is what
 * the area-proximity score reads, and `gps_inside_requester_area` records `false` for a missing pin
 * and for a pin 400km away alike — so a submission with no location arrived on the desk looking
 * exactly like one that failed the proximity check.
 */
function testCaptureRefusesAVenueWithNoLocation() {
  const source = code(PHARMACY_VALIDATION);

  assert.match(
    source,
    /badRequest\(VENUE_LOCATION_REQUIRED_MESSAGE\)/,
    `${PHARMACY_VALIDATION}: filing a validation must refuse a submission carrying no coordinates`,
  );

  // The coordinates must be read through a finite check, not `?? null`. A browser that lost its fix
  // mid-capture sends NaN, which `?? null` passes straight through into the column.
  assert.doesNotMatch(
    source,
    /captured_latitude:\s*input\.capturedLatitude\s*\?\?\s*null/,
    `${PHARMACY_VALIDATION}: the stored latitude must come from the checked value, not raw input`,
  );
  assert.match(
    source,
    /Number\.isFinite\(input\.capturedLatitude\)/,
    `${PHARMACY_VALIDATION}: NaN is not a location`,
  );

  // And the rep is told before the round trip, in the SAME sentence — two ends of one check worded
  // separately is how they drift.
  assert.match(
    code(CAPTURE_SCREEN),
    /setError\(VENUE_LOCATION_REQUIRED_MESSAGE\)/,
    `${CAPTURE_SCREEN}: the form must refuse in the server's own words, not its own paraphrase`,
  );
}

/**
 * HEADLINE — leg 3 actually refuses, and ONLY on `approve`.
 *
 * The asymmetry is the design, not an oversight:
 *   match   → the pair is verified against the master database before it is accepted, so matching
 *             IS the code route. This is the outcome we want most and nothing may make it harder.
 *   reject  → ungated. Refusing to let someone say no is how evidence stops being filed at all.
 *   approve → mints a brand-new identity for a venue the master database does not know.
 */
function testApprovingANewVenueRefusesWithoutAnIdentityRoute() {
  const source = code(PHARMACY_VALIDATION);

  assert.match(
    source,
    /venueIdentityGapMessage\(\{/,
    `${PHARMACY_VALIDATION}: the approval desk must consult the venue rule`,
  );
  assert.match(
    source,
    /if \(gap\) badRequest\(gap\)/,
    `${PHARMACY_VALIDATION}: consulting the rule and not refusing on it is a report, not a gate`,
  );

  // Scoped to `approve`. If this guard is ever widened, a Super Admin can no longer REJECT a venue
  // that has neither route — which is every venue this rule is about.
  assert.match(
    source,
    /if \(input\.decision === "approve"\) \{[\s\S]*?venueIdentityGapMessage/,
    `${PHARMACY_VALIDATION}: the identity gate belongs to approve alone`,
  );

  // The reject branch returns BEFORE the gate. Order matters here and nothing else asserts it.
  const rejectAt = source.indexOf('if (input.decision === "reject")');
  const gateAt = source.indexOf('if (input.decision === "approve")');
  assert.ok(rejectAt >= 0 && gateAt >= 0, "both branches must still exist");
  assert.ok(
    rejectAt < gateAt,
    `${PHARMACY_VALIDATION}: reject must return before the identity gate, or a bad venue becomes undecidable`,
  );

  // The codes are re-checked against the MASTER DATABASE, never counted off the link table. A link
  // row is something Phoenix wrote about itself; three invented codes reached production that way.
  assert.match(
    source,
    /countVenueCodesInMasterDatabase/,
    `${PHARMACY_VALIDATION}: the code route must be verified, not assumed from a link row`,
  );
  assert.match(
    source,
    /from\("source_of_sales_customer_map"\)[\s\S]{0,400}?\.eq\("customer_code", customerCode\)/,
    `${PHARMACY_VALIDATION}: a code counts only when the master database agrees with the whole pair`,
  );
}

export function runVenueValidationRuleTests() {
  testEitherRouteIdentifiesAVenueAndNeitherIsAGap();
  testANurseryCanOnlyEverPassByLicence();
  testThePromptAsksForEverythingTheDeskWillRefuse();
  testCaptureRefusesAVenueWithNoLocation();
  testApprovingANewVenueRefusesWithoutAnIdentityRoute();
}
