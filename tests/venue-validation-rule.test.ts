import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  pharmacyLicenseFillsTheIdentityGap,
  pharmacyLicensePrompt,
} from "../src/lib/venues/pharmacy-license.ts";
import { VENUE_TYPES } from "../src/lib/venues/venue-type.ts";
import {
  resolveVenueIdentityRoute,
  venueAdminRouteEvidenceGapMessage,
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
  //
  // This survives the 2026-08-29 amendment unchanged and it is the half that must never be softened.
  // The answer moved from `none` to `admin`, but for the same reason and with the same consequence:
  // the code beside it still buys it nothing.
  assert.equal(
    resolveVenueIdentityRoute({ codesInOurDatabase: 1, hasLicenseOnFile: false, venueType: "nursery" }),
    "admin",
    "a nursery cannot hold a real distributor code, so a resolving one must never take the code route",
  );
  assert.equal(
    resolveVenueIdentityRoute({ codesInOurDatabase: 1, hasLicenseOnFile: true, venueType: "nursery" }),
    "licence",
    "and a document, on the rare venue that has one, is still what the row records",
  );

  // AND `none` IS UNREACHABLE FOR IT. This is the assertion the amendment turns on: the ordinary
  // nursery — no code, no licence, a pin and a photograph — is a POSITIVE answer, not a gap. Were
  // this to read `none` again, `venueIdentityGapMessage` would refuse it, and refusing a venue that
  // can never produce a document is refusing it permanently. That is not a hypothetical regression:
  // it is the state that stranded validation 05c97d18 and its held order on 2026-08-29.
  assert.equal(
    resolveVenueIdentityRoute({ codesInOurDatabase: 0, hasLicenseOnFile: false, venueType: "nursery" }),
    "admin",
    "a nursery with neither is the admin's judgement on the pin and the photo, never an unidentified venue",
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
 * HEADLINE — a nursery is never refused for a document, and the pharmacy rule is untouched.
 *
 * The owner, 2026-08-29: "pharmacy is the one that have distributor and distributor code. Nursery
 * does not have distributor code or license. So nursery, they are validated by location and live
 * photo, and then it's approval depends on the admin."
 *
 * Both routes of leg 3 are documents of the pharmacy trade. A venue outside that trade holds
 * NEITHER, so the answer to "it has no route" is that it is not judged by routes — not that the
 * route it cannot take becomes mandatory. The previous reading demanded a licence of the one venue
 * type that has none, which is a permanent refusal worded as an instruction: validation 05c97d18
 * arrived with a 20m pin and a live photo, could not be approved, and its direct order stayed held.
 *
 * The second half matters as much as the first. This amendment is about VENUES WITH NO DISTRIBUTOR
 * ACCOUNT and nothing else — a codeless pharmacy must still be refused, or the change quietly
 * repeals the rule it is amending.
 */
function testANurseryIsJudgedOnItsEvidenceAndNeverOnADocument() {
  assert.equal(
    venueIdentityGapMessage({ codesInOurDatabase: 0, hasLicenseOnFile: false, venueType: "nursery" }),
    null,
    "the ordinary nursery — no code, no licence — must be approvable, or its orders stay held forever",
  );
  assert.equal(
    venueIdentityGapMessage({ codesInOurDatabase: 0, hasLicenseOnFile: true, venueType: "nursery" }),
    null,
    "and a nursery that happens to carry a document is no more identified and no less",
  );
  assert.equal(
    venueIdentityGapMessage({ codesInOurDatabase: 1, hasLicenseOnFile: false, venueType: "nursery" }),
    null,
    "nor is one carrying an invented code refused — the code buys it nothing, but it costs it nothing either",
  );

  // THE PHARMACY RULE IS UNTOUCHED. If this ever goes null, the amendment has been over-applied and
  // leg 3 has been repealed rather than scoped.
  const pharmacyGap = venueIdentityGapMessage({
    codesInOurDatabase: 0,
    hasLicenseOnFile: false,
    venueType: "pharmacy",
  });
  assert.ok(pharmacyGap, "a codeless pharmacy has still not established who it is");
  assert.match(pharmacyGap!, /licence/i, "and it is still offered both of its ways out");
  assert.match(pharmacyGap!, /Match it to the real customer/);

  assert.equal(
    venueIdentityGapMessage({ codesInOurDatabase: 1, hasLicenseOnFile: false, venueType: "pharmacy" }),
    null,
    "and a coded pharmacy is asked for nothing at all",
  );
}

/**
 * HEADLINE — what replaces leg 3 for a nursery has to be REAL: the two legs it can satisfy.
 *
 * "Validated by location and live photo" is the whole of the owner's rule for this venue, so a desk
 * that would approve one carrying neither is not applying that rule — it is applying nothing. This
 * is the guard that keeps the amendment from reading as "nurseries are waved through".
 *
 * It must also stay silent for a pharmacy: a pharmacy's identity is the code or the licence, and a
 * second gate here would refuse venues `venueIdentityGapMessage` has already cleared.
 */
function testTheAdminRouteStillDemandsTheTwoLegsItRestsOn() {
  assert.equal(
    venueAdminRouteEvidenceGapMessage({
      venueType: "nursery",
      hasLocationOnFile: true,
      hasLivePhotoOnFile: true,
    }),
    null,
    "the ordinary nursery submission — pin and photo — passes",
  );

  const noPhoto = venueAdminRouteEvidenceGapMessage({
    venueType: "nursery",
    hasLocationOnFile: true,
    hasLivePhotoOnFile: false,
  });
  assert.ok(noPhoto, "a nursery with no photo has nothing an admin could be judging");
  assert.match(noPhoto!, /live photo/i);

  const noPin = venueAdminRouteEvidenceGapMessage({
    venueType: "nursery",
    hasLocationOnFile: false,
    hasLivePhotoOnFile: true,
  });
  assert.ok(noPin, "and a nursery with no pin is a photograph of somewhere");
  assert.match(noPin!, /location/i);
  assert.notEqual(noPin, noPhoto, "the two say which one is actually missing");

  // Never a licence. The whole point is that this venue is not short of a document, and a message
  // that mentions one sends the admin looking for it again.
  for (const message of [noPhoto!, noPin!]) {
    assert.doesNotMatch(message, /licence/i, "the admin route must never send anyone after a document");
  }

  // Silent for a pharmacy, at every combination — including the one that looks alarming.
  for (const hasLocationOnFile of [true, false]) {
    for (const hasLivePhotoOnFile of [true, false]) {
      assert.equal(
        venueAdminRouteEvidenceGapMessage({ venueType: "pharmacy", hasLocationOnFile, hasLivePhotoOnFile }),
        null,
        "a pharmacy is identified by its code or its licence — this gate is not about it",
      );
    }
  }
}

/**
 * THE DRIFT CHECK. Nothing may be refused that was never asked for.
 *
 * `pharmacyLicenseFillsTheIdentityGap` decides what the capture screen SAYS; `venueIdentityGapMessage`
 * decides what the approval desk REFUSES. They are two halves of one check, and a gate that bites
 * where nothing was ever asked is how a rep gets blocked for a document nobody mentioned. This is
 * the assertion that caught the nursery exemption in 2026-08-26, when the prompt exempted nurseries
 * while the rule left them exactly one route.
 *
 * It holds through the 2026-08-29 amendment by moving in the other direction: the desk refuses no
 * nursery, so the form asks no nursery for anything. The check is not "both mention the licence" —
 * it is "nothing is refused that was never asked", and both readings satisfy it.
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

  // ONE refusal: the codeless pharmacy. It was FOUR until 2026-08-29, and the three that went were
  // the nursery at each code count — the amendment, counted. Asserted as a number rather than left
  // implicit because every assertion in the loop sits behind a `continue`, so a version of this
  // test that refuses nothing at all would pass in silence and prove nothing.
  assert.equal(refusals, 1, "the desk must actually refuse something, or this test asserts nothing");

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

/**
 * HEADLINE — `match` is closed to a venue with no distributor account, and the admin route is gated.
 *
 * MATCH IS THE FORGERY PATH, and it was the door left open when the venue type shipped. Matching
 * inserts a real distributor/customer pair into `direct_order_pharmacy_distributor_codes` for this
 * venue — a nursery holding a distributor code, which is the exact shape the venue type exists to
 * prevent. Registration already refuses to write one; the master database already refuses to
 * identify a nursery by one; this desk could still attach one with a click.
 *
 * Worse than the three invented codes it resembles: a code arriving this way RESOLVES, because it
 * genuinely belongs to a real customer — somebody else's. It would look more trustworthy than the
 * fabrications, not less.
 *
 * Pinned in the source because the refusal is a server-side branch with no pure function to call:
 * losing it fails silently and looks exactly like success.
 */
function testMatchingIsClosedToAVenueWithNoDistributorAccount() {
  const source = code(PHARMACY_VALIDATION);

  assert.match(
    source,
    /if \(input\.decision === "match" && !venueRequiresDistributorCode\(venueType\)\)/,
    `${PHARMACY_VALIDATION}: matching must be refused for a venue that cannot hold a distributor code`,
  );

  // It must sit ABOVE the match branch that does the insert, or it refuses nothing.
  const guardAt = source.indexOf('if (input.decision === "match" && !venueRequiresDistributorCode(venueType))');
  const matchAt = source.indexOf('if (input.decision === "match") {');
  assert.ok(guardAt >= 0 && matchAt >= 0, "both the guard and the match branch must still exist");
  assert.ok(guardAt < matchAt, `${PHARMACY_VALIDATION}: the guard must run before the code is written`);

  // And the admin route's evidence gate is actually consulted at the desk, not merely exported.
  assert.match(
    source,
    /venueAdminRouteEvidenceGapMessage\(\{/,
    `${PHARMACY_VALIDATION}: the desk must check the two legs a nursery approval rests on`,
  );
  assert.match(
    source,
    /if \(evidenceGap\) badRequest\(evidenceGap\)/,
    `${PHARMACY_VALIDATION}: consulting it and not refusing on it is a report, not a gate`,
  );
}

export function runVenueValidationRuleTests() {
  testEitherRouteIdentifiesAVenueAndNeitherIsAGap();
  testANurseryIsJudgedOnItsEvidenceAndNeverOnADocument();
  testTheAdminRouteStillDemandsTheTwoLegsItRestsOn();
  testThePromptAsksForEverythingTheDeskWillRefuse();
  testCaptureRefusesAVenueWithNoLocation();
  testApprovingANewVenueRefusesWithoutAnIdentityRoute();
  testMatchingIsClosedToAVenueWithNoDistributorAccount();
}
