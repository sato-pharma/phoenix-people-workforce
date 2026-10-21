import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildMarketingVenuePhoenixCode,
  isRetryableMarketingVenueSkip,
  planMarketingVenueForDirectOrders,
} from "../src/lib/marketing-requests/direct-order-venue-sync.ts";
import { stripComments } from "./support/comment-strip.ts";

// A CUSTOMER VALIDATED FOR MARKETING IS VALIDATED IN DIRECT ORDERS TOO (owner, 2026-10-21): "every
// one validates a customer for marketing requests is automatic validated in his direct orders and is
// appearing in his venues validated", and the approvers see "the validation photo of pharmacy and
// customer with its 100% full detailed data — never hide a picture if available".
//
// Measured before the fix: 93 validated customers on 114 validated pharmacies, and 4 had ever reached
// Direct Orders — each by a Super Admin's manual Transfer, each for its first pharmacy only.

const SHOP = {
  active: true,
  mergedIntoPharmacyId: null,
  displayName: "صيدلية الشفاء",
  hasPhoto: true,
  hasGps: true,
  customerCode: "1234",
  distributorCode: "POS",
};
const venue = (verificationStatus: string, extra: Partial<{ active: boolean; mergedIntoPharmacyId: string | null }> = {}) => ({
  id: "venue-1",
  active: extra.active ?? true,
  verificationStatus,
  mergedIntoPharmacyId: extra.mergedIntoPharmacyId ?? null,
});

export async function runMarketingVenueDirectOrderSyncTests() {
  // A validated shop Direct Orders does not know yet is CREATED.
  assert.deepEqual(planMarketingVenueForDirectOrders({ pharmacy: SHOP, linkedVenue: null, codeVenue: null }), { kind: "create" });

  // Already across: nothing is written twice.
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: SHOP, linkedVenue: venue("verified"), codeVenue: null }),
    { kind: "linked", directOrderPharmacyId: "venue-1" },
  );
  // A venue a person retired (a reverted Transfer, a merge) is honoured, never re-minted.
  for (const retired of [venue("verified", { active: false }), venue("verified", { mergedIntoPharmacyId: "other" })]) {
    assert.deepEqual(
      planMarketingVenueForDirectOrders({ pharmacy: SHOP, linkedVenue: retired, codeVenue: null }),
      { kind: "skip", reason: "direct_order_venue_retired" },
      "a retired Direct Order venue must not be brought back by a machine",
    );
  }

  // The same shop already on the Direct Order side under its registered code is REUSED, not copied.
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: SHOP, linkedVenue: null, codeVenue: venue("verified") }),
    { kind: "reuse", directOrderPharmacyId: "venue-1" },
  );
  // …but a machine settles neither the desk's open question nor a person's ruling that it is false.
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: SHOP, linkedVenue: null, codeVenue: venue("pending_review") }),
    { kind: "skip", reason: "direct_order_venue_pending_review" },
  );
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: SHOP, linkedVenue: null, codeVenue: venue("rejected") }),
    { kind: "skip", reason: "direct_order_venue_rejected" },
  );

  // The venue rule: GPS + a live picture of the VENUE, always — a doctor's photo is never borrowed.
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: { ...SHOP, hasPhoto: false }, linkedVenue: null, codeVenue: null }),
    { kind: "skip", reason: "no_venue_photo" },
  );
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: { ...SHOP, hasGps: false }, linkedVenue: null, codeVenue: null }),
    { kind: "skip", reason: "no_venue_gps" },
  );
  // A wholesaler / makhzan is never a venue, in either module (owner, 2026-09-22).
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: { ...SHOP, displayName: "مخزن الأمل للأدوية" }, linkedVenue: null, codeVenue: null }),
    { kind: "skip", reason: "wholesaler" },
  );
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: { ...SHOP, active: false }, linkedVenue: null, codeVenue: null }),
    { kind: "skip", reason: "pharmacy_inactive" },
  );
  assert.deepEqual(
    planMarketingVenueForDirectOrders({ pharmacy: { ...SHOP, mergedIntoPharmacyId: "x" }, linkedVenue: null, codeVenue: null }),
    { kind: "skip", reason: "pharmacy_merged" },
  );

  // Phoenix codes: distinct from a manual Transfer's PHX-MT-, and a collision gets a suffix.
  assert.equal(buildMarketingVenuePhoenixCode("MP-00012", "6c1f0000-0000-0000-0000-00000000abcd"), "PHX-MP-MP00012");
  assert.equal(buildMarketingVenuePhoenixCode(null, "6c1f0000-0000-0000-0000-00000000abcd"), "PHX-MP-000000ABCD");
  assert.equal(buildMarketingVenuePhoenixCode("MP-00012", "x", 1), "PHX-MP-MP00012-2");

  // A failed READ is retried, never read as "no venue holds this code" (that mints a duplicate).
  assert.equal(isRetryableMarketingVenueSkip("read_failed"), true);
  assert.equal(isRetryableMarketingVenueSkip("brick_map_unavailable"), true);
  assert.equal(isRetryableMarketingVenueSkip("no_venue_photo"), false);

  // WIRING — each pinned on the CALL, comments stripped, so deleting the call goes red.
  const marketingService = stripComments(readFileSync("src/lib/marketing-requests/service.ts", "utf8"));
  assert.match(
    marketingService,
    /syncMarketingValidationToDirectOrdersQuietly\(rows\.map\(/,
    "a marketing validation save must carry its customers into Direct Orders",
  );
  const directOrderService = stripComments(readFileSync("src/lib/direct-orders/service.ts", "utf8"));
  assert.match(
    directOrderService,
    /await listDirectOrderVenueIdsFromMyMarketingValidations\(access\.hrId\)/,
    "My venues must list the venues the rep's own marketing validations brought across",
  );
  assert.match(
    directOrderService,
    /const venueValidationPhotos = await loadDirectOrderVenueValidationPhotos\(request\.pharmacyId\)/,
    "the approval detail must load every validation photo of the venue",
  );
  const detail = stripComments(readFileSync("src/components/approvals-hub/direct-order-request-detail.tsx", "utf8"));
  assert.match(
    detail,
    /<DirectOrderVenueValidationPhotos photos=\{venueValidationPhotos\} \/>/,
    "the approval window must render the venue's validation photos",
  );
  const transfer = stripComments(readFileSync("src/lib/marketing-requests/validated-customer-transfer.ts", "utf8"));
  assert.match(
    transfer,
    /from\("marketing_pharmacy_direct_order_venues"\)\s*\.insert\(/,
    "a manual Transfer must record the venue it created, or the hand-over mints the shop twice",
  );

  // The photo loader keeps every photo: no `.limit(1)` on the claims, and the marketing photos are
  // read for the pharmacy AND the customer.
  const photos = stripComments(readFileSync("src/lib/direct-orders/venue-validation-photos.ts", "utf8"));
  assert.doesNotMatch(photos, /\.limit\(1\)/, "the approval window must never fall back to one photo");
  assert.match(photos, /entity_type: "pharmacy", evidence_type: "location_photo"/);
  assert.match(photos, /entity_type: "customer", evidence_type: "location_photo"/);
}
