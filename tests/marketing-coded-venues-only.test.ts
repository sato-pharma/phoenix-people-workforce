import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { requestTargetKind } from "@/lib/marketing-requests/code-link-reach";
import {
  VENUE_WITHOUT_DISTRIBUTOR_CODE,
  venueWithoutDistributorCodeMessage,
} from "@/lib/marketing-requests/coded-venues-only";
import { planMarketingVenueForDirectOrders } from "@/lib/marketing-requests/direct-order-venue-sync";
import { normalizeMarketingValidationInput, prepareMarketingRequestDraft } from "@/lib/marketing-requests/service";
import type { MarketingRequestCreateDraft, MarketingValidationInput } from "@/lib/marketing-requests/types";
import { describeMissingSaveRequirement } from "@/lib/marketing-requests/validation-save-gate";
import { LICENSE_ONLY_PHARMACY_NOTE } from "@/lib/venues/pharmacy-license";
import { resolveVenueIdentityRoute, venueIdentityGapMessage } from "@/lib/venues/venue-validation-rule";
import { stripComments } from "./support/comment-strip.ts";

// MARKETING REQUESTS HOLD ONLY VENUES THAT CARRY A DISTRIBUTOR CODE (owner, 2026-10-21):
// "in direct orders we can validate a nursery without a distributor code — any thing with no
// distributor code never reach the marketing requests".
//
// It replaced three older marketing rules: a nursery validated on location + photo alone, a
// licence-only pharmacy saved held and released by a Super Admin or the CEO as a target, and the
// `no_distributor_account` request target ("spend allowed, sales can never be matched"). Every
// marketing door refuses a codeless venue in ONE sentence with ONE code; Direct Orders is untouched.

/** The refusal every marketing door must give: the shared code, the shared sentence, the venue's name. */
function refusedAsCodeless(venueName: string | null) {
  return (error: unknown) => {
    assert.equal(
      (error as { code?: string }).code,
      VENUE_WITHOUT_DISTRIBUTOR_CODE,
      `the stable refusal code (refused with: ${String((error as Error).message)})`,
    );
    assert.equal(String((error as Error).message), venueWithoutDistributorCodeMessage(venueName), "the one shared sentence");
    return true;
  };
}

function testTheSentenceSaysWhereCodelessVenuesGo() {
  assert.equal(VENUE_WITHOUT_DISTRIBUTOR_CODE, "venue_without_distributor_code");
  assert.equal(
    venueWithoutDistributorCodeMessage("حضانة النيل"),
    "\"حضانة النيل\" has no distributor code, so it cannot be in a marketing request. Venues without a distributor code (nurseries included) are validated in Direct Orders.",
  );
  assert.match(venueWithoutDistributorCodeMessage(null), /^This venue has no distributor code/, "an unnamed venue is still a sentence");
}

/** A codeless link is never a request target — whatever the venue and whatever a person ruled. */
function testACodelessLinkIsNeverARequestTarget() {
  for (const status of ["pending", "system_validated", "sfe_validated", "admin_approved"]) {
    assert.equal(requestTargetKind({ distributorCodeId: null, status }), null, `a codeless ${status} link is not a target`);
  }
  assert.equal(requestTargetKind({ distributorCodeId: "code-1", status: "system_validated" }), "coded");
  assert.equal(requestTargetKind({ distributorCodeId: "code-1", status: "pending" }), null, "a coded link still needs a selectable status");
}

/** The server's draft guard refuses a codeless target with the shared code — nursery and licence-only alike. */
function testTheDraftGuardRefusesACodelessTarget() {
  const venueId = "44444444-4444-4444-4444-444444444444";
  const input = {
    customerId: "11111111-1111-1111-1111-111111111111",
    estimatedCost: 1000,
    payDate: "2026-06-01",
    pharmacies: [{ notes: null, targetId: `venue:${venueId}` }],
    products: [{ productId: 1, quantity: 500 }],
    requestDate: "2026-05-21",
    requestTypeId: 1,
    roiDurationMonths: 6,
  } as unknown as MarketingRequestCreateDraft;
  const base = {
    customer: { active: true, area_id: 40, id: "11111111-1111-1111-1111-111111111111", line_id: 7, manager_hr_id: "DM009", owner_hr_id: "MR001" },
    input,
    products: [{ active: true, factory_price: 6, id: 1, line: "Anti infective", product_name: "Saginko" }],
    requestType: { active: true, code: "special_request", description: null, id: 1, name: "Special request", requires_description: false, sort_order: 10 },
    requester: { areaId: 30, hrId: "MR001", lineId: 7, lineName: "Anti infective", managerHrId: "DM001" },
  };
  for (const [venue, notes, status] of [
    [{ active: true, display_name: "حضانة النيل", id: venueId, venue_type: "nursery" }, null, "system_validated"],
    [{ active: true, display_name: "Al Noor Pharmacy", id: venueId, venue_type: "pharmacy" }, LICENSE_ONLY_PHARMACY_NOTE, "admin_approved"],
  ] as const) {
    assert.throws(
      () => prepareMarketingRequestDraft({
        ...base,
        customerLinks: [{ distributorCodeId: null, notes, pharmacyId: venueId, status }],
        venuePharmacies: [venue],
      } as Parameters<typeof prepareMarketingRequestDraft>[0]),
      refusedAsCodeless(venue.display_name),
      `${venue.display_name} (${venue.venue_type}, ${status}) must be refused as a codeless target`,
    );
  }
}

/** The capture save refuses a nursery and a licence-only pharmacy — server-side, before anything is written. */
function testTheCaptureSaveRefusesNurseryAndLicenceOnlyPharmacy() {
  const timestamp = "2026-05-21T10:00:00.000Z";
  const photo = `data:image/jpeg;base64,${Buffer.from("stamped-jpeg").toString("base64")}`;
  const customer = {
    capturedAccuracyMeters: 12,
    capturedAddress: "31.200000, 29.900000",
    capturedAt: timestamp,
    capturedLatitude: 31.2,
    capturedLongitude: 29.9,
    customerType: "clinic",
    displayName: "Test Customer Clinic",
    evidenceHasTimestamp: true,
    evidencePhotoCapturedAt: timestamp,
    evidencePhotoDataUrl: photo,
    evidencePhotoName: "customer-sign.jpg",
    mobileNumber: "01000000000",
  };
  const venue = {
    capturedAccuracyMeters: 8,
    capturedAt: timestamp,
    capturedLatitude: 31.201,
    capturedLongitude: 29.901,
    evidenceHasTimestamp: true,
    evidencePhotoCapturedAt: timestamp,
    evidencePhotoDataUrl: photo,
    evidencePhotoName: "venue-sign.jpg",
  };
  const licence = `data:application/pdf;base64,${Buffer.from("%PDF-1.7 a trade licence").toString("base64")}`;

  assert.throws(
    () => normalizeMarketingValidationInput({
      customers: [{ ...customer, pharmacies: [{ ...venue, displayName: "حضانة النيل", vendorCodes: [], venueType: "nursery" }] }],
    } as unknown as MarketingValidationInput),
    refusedAsCodeless("حضانة النيل"),
    "a nursery is never validated in Marketing",
  );
  assert.throws(
    () => normalizeMarketingValidationInput({
      customers: [{
        ...customer,
        pharmacies: [{ ...venue, displayName: "Al Noor Pharmacy", licenseFileDataUrl: licence, licenseFileName: "licence.pdf", vendorCodes: [], venueType: "pharmacy" }],
      }],
    } as unknown as MarketingValidationInput),
    refusedAsCodeless("Al Noor Pharmacy"),
    "a pharmacy saved on its licence alone is refused — the licence no longer stands in for a code",
  );
  // The pharmacy path still works.
  const saved = normalizeMarketingValidationInput({
    customers: [{
      ...customer,
      pharmacies: [{ ...venue, displayName: "Al Noor Pharmacy", vendorCodes: [{ distributorId: 1, distributorPharmacyCode: "PH-1" }], venueType: "pharmacy" }],
    }],
  } as unknown as MarketingValidationInput);
  assert.equal(saved.customers[0]!.pharmacies[0]!.vendorCodes.length, 1, "a coded pharmacy still saves");

  // The form's own gate agrees, so Save is never offered for what the server refuses.
  const capture = { capturedAt: timestamp, latitude: 31.2, longitude: 29.9, photoCapturedAt: timestamp, photoDataUrl: photo, photoName: "x.jpg" };
  const formCustomer = (pharmacy: Record<string, unknown>) => ({
    capture,
    customerComplete: false,
    name: "Dr Test",
    pharmacies: [{ capture, existingPharmacyId: "", name: "حضانة النيل", source: "new" as const, vendorCodes: [], ...pharmacy }],
  });
  assert.equal(
    describeMissingSaveRequirement([formCustomer({ venueType: "nursery" })] as never, false),
    venueWithoutDistributorCodeMessage("حضانة النيل"),
  );
  assert.match(
    describeMissingSaveRequirement([formCustomer({ license: { dataUrl: licence }, venueType: "pharmacy" })] as never, false) ?? "",
    /needs at least one distributor code\. Venues without a distributor code \(nurseries included\) are validated in Direct Orders\./,
  );

  // The "My Pharmacies" reuse path, the write loops and the promotion sweeps refuse codeless too.
  const service = stripComments(readFileSync("src/lib/marketing-requests/service.ts", "utf8"));
  assert.match(
    service,
    /if \(!hasCode \|\| !venueRequiresDistributorCode\(normalizeVenueType\(row\?\.venue_type\)\)\) \{\s*throw validationError\(\s*venueWithoutDistributorCodeMessage\(/,
    "a reused venue with no code — or a reused nursery — is refused before any customer is written",
  );
  assert.match(
    service,
    /function venueCodeSlots<T>\(codes: T\[\], venueName: string \| null\): Array<T \| null> \{\s*if \(codes\.length > 0\) return codes;\s*throw validationError\(venueWithoutDistributorCodeMessage\(venueName\), VENUE_WITHOUT_DISTRIBUTOR_CODE\);/,
    "the write loops never write a codeless link row",
  );
  assert.equal((service.match(/if \(!codeRow\) continue;/g) ?? []).length, 2, "neither promotion sweep validates a codeless link");
  assert.doesNotMatch(service, /pharmacyRegistersOnLicenseAlone|LICENSE_ONLY_PHARMACY_NOTE|LICENSE_RELEASED_TARGET_NOTE/, "the licence-only route is gone from the service");

  // Customer Pharmacy Mapping's Approve refuses a codeless link.
  const actions = stripComments(readFileSync("src/lib/customer-pharmacy-mapping/actions.ts", "utf8"));
  assert.match(
    actions,
    /if \(!existing\.distributor_code_id\) \{\s*throw validationError\(venueWithoutDistributorCodeMessage\(pharmacyName\), VENUE_WITHOUT_DISTRIBUTOR_CODE\);/,
    "approving a codeless link would validate it in Marketing",
  );
}

/** The automatic carry-over skips a codeless link or a nursery left in Marketing from before the rule. */
function testTheSyncSkipsACodelessLink() {
  const shop = {
    active: true,
    mergedIntoPharmacyId: null,
    displayName: "صيدلية الشفاء",
    hasPhoto: true,
    hasGps: true,
    hasDistributorCode: true,
    venueType: "pharmacy" as const,
  };
  assert.deepEqual(planMarketingVenueForDirectOrders({ pharmacy: shop, linkedVenue: null, codeVenue: null }), { kind: "create" });
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: { ...shop, hasDistributorCode: false }, linkedVenue: null, codeVenue: null }),
    { kind: "skip", reason: "no_distributor_code" },
  );
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: { ...shop, venueType: "nursery" }, linkedVenue: null, codeVenue: null }),
    { kind: "skip", reason: "no_distributor_code" },
  );
}

/** Direct Orders still validates a nursery with no distributor code — the rule narrows Marketing only. */
function testDirectOrdersNurseryValidationIsUntouched() {
  const nurseryWithNoCode = { codesInOurDatabase: 0, hasLicenseOnFile: false, venueType: "nursery" as const };
  assert.equal(resolveVenueIdentityRoute(nurseryWithNoCode), "admin", "the Direct Order desk approves a codeless nursery on its location and photo");
  assert.equal(venueIdentityGapMessage(nurseryWithNoCode), null, "and never refuses it for a missing code");

  for (const path of [
    "src/lib/direct-orders/service.ts",
    "src/lib/direct-orders/pharmacy-validation.ts",
    "src/components/direct-orders/direct-order-submit-form.tsx",
    "src/components/direct-orders/pharmacy-registry-manager.tsx",
  ]) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /coded-venues-only|venue_without_distributor_code/,
      `${path} must not refuse a codeless venue — Direct Orders validates nurseries without a code`,
    );
  }
}

export function runMarketingCodedVenuesOnlyTests() {
  testTheSentenceSaysWhereCodelessVenuesGo();
  testACodelessLinkIsNeverARequestTarget();
  testTheDraftGuardRefusesACodelessTarget();
  testTheCaptureSaveRefusesNurseryAndLicenceOnlyPharmacy();
  testTheSyncSkipsACodelessLink();
  testDirectOrdersNurseryValidationIsUntouched();
}
