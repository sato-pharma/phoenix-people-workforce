import assert from "node:assert/strict";

import {
  AMBIGUOUS_GOVERNORATES,
  GOVERNORATE_TO_REGION,
  haversineKm,
  normalizeMarkaz,
  scoreCustomerBrick,
  type BrickCentroid,
} from "../src/lib/sales/normalizer/geo-validate.ts";
import type { SalesBrickReference } from "../src/lib/sales/monthly-distributor-import.ts";
import type { PharmacyGeo } from "../src/lib/sales/normalizer/pharmacy-geocode.ts";

function brick(regionCode: string): SalesBrickReference {
  return {
    areaCode: "A1",
    areaName: "Test Area",
    blockCode: "B1",
    blockName: "Test Block",
    brickId: "BR001",
    brickName: "Test Brick",
    regionCode,
    regionName: "Test Region",
  };
}

// Offsets chosen so haversine distance lands just inside/outside each tier.
// 1 degree latitude ≈ 111.2 km → 0.001 deg ≈ 0.11 km.
function pharmacyAt(lat: number, lng: number, governorate: string | null = "Dakahlia", markaz: string | null = null): PharmacyGeo {
  return { governorate, lat, lng, markaz };
}

function centroidAt(lat: number, lng: number, status = "success", markaz: string | null = null): BrickCentroid {
  return { governorate: "Dakahlia", lat, lng, markaz, status };
}

export function runPharmacyGeoValidateTests() {
  // Haversine sanity: Cairo (30.044, 31.236) → Alexandria (31.200, 29.919) ≈ 180 km.
  const cairoAlex = haversineKm(30.044, 31.236, 31.2, 29.919);
  assert.ok(cairoAlex > 160 && cairoAlex < 200, `Cairo→Alex was ${cairoAlex}`);

  // Not geocoded → 25.
  const failed = scoreCustomerBrick(null, brick("D2"), centroidAt(31, 31));
  assert.equal(failed.confidence, 25);
  assert.equal(failed.signals.geocoded, false);

  // Distance tier boundaries. 4.9 km ≈ 0.0441 deg lat, 5.1 km ≈ 0.0459 deg.
  const under5 = scoreCustomerBrick(pharmacyAt(31.0, 31.0), brick("D2"), centroidAt(31.0441, 31.0));
  assert.equal(under5.confidence, 95);
  assert.ok(under5.signals.distanceKm != null && under5.signals.distanceKm < 5);

  const over5 = scoreCustomerBrick(pharmacyAt(31.0, 31.0), brick("D2"), centroidAt(31.0459, 31.0));
  assert.equal(over5.confidence, 85);

  const under15 = scoreCustomerBrick(pharmacyAt(31.0, 31.0), brick("D2"), centroidAt(31.134, 31.0));
  assert.equal(under15.confidence, 85);

  // 15.1 km ≈ 0.1358 deg → falls out of distance tiers; governorate (Dakahlia→D2) match → 70.
  const over15 = scoreCustomerBrick(pharmacyAt(31.0, 31.0), brick("D2"), centroidAt(31.1358, 31.0));
  assert.equal(over15.confidence, 70);
  assert.equal(over15.signals.governorateMatch, true);

  // Markaz match beats governorate tier when distance is unavailable (mismatched centroid).
  const markazMatch = scoreCustomerBrick(
    pharmacyAt(31.0, 31.0, "Dakahlia", "Markaz Talkha"),
    brick("D2"),
    { governorate: "Dakahlia", lat: 31.0, lng: 31.0, markaz: "Talkha", status: "region_mismatch" },
  );
  assert.equal(markazMatch.confidence, 80);
  assert.equal(markazMatch.signals.markazMatch, true);
  assert.equal(markazMatch.signals.distanceKm, null); // mismatched centroid never yields distance

  // A non-success centroid NEVER drives distance tiers even at 0 km.
  const mismatchedCentroid = scoreCustomerBrick(
    pharmacyAt(31.0, 31.0),
    brick("D2"),
    centroidAt(31.0, 31.0, "region_mismatch"),
  );
  assert.equal(mismatchedCentroid.signals.distanceKm, null);
  assert.equal(mismatchedCentroid.confidence, 70); // falls to governorate tier

  // No centroid at all → governorate tier.
  const noCentroid = scoreCustomerBrick(pharmacyAt(31.0, 31.0), brick("D2"), undefined);
  assert.equal(noCentroid.confidence, 70);

  // Sharkia ambiguity: D2/D3 brick → 58; other region → mismatch is NOT asserted (sharqia is
  // not in GOVERNORATE_TO_REGION) so it lands in the unknown-governorate tier 35.
  assert.ok(AMBIGUOUS_GOVERNORATES.has("sharqia"));
  const sharkiaD3 = scoreCustomerBrick(pharmacyAt(30.6, 31.5, "Sharqia"), brick("D3"), undefined);
  assert.equal(sharkiaD3.confidence, 58);
  const sharkiaCA = scoreCustomerBrick(pharmacyAt(30.6, 31.5, "Sharqia"), brick("CA"), undefined);
  assert.equal(sharkiaCA.confidence, 35);

  // Region mismatch: Cairo pharmacy against a D2 brick → 12; with >50km distance → 10.
  assert.equal(GOVERNORATE_TO_REGION["cairo"], "CA");
  const mismatchNear = scoreCustomerBrick(pharmacyAt(30.05, 31.24, "Cairo"), brick("D2"), undefined);
  assert.equal(mismatchNear.confidence, 12);
  const mismatchFar = scoreCustomerBrick(
    pharmacyAt(30.05, 31.24, "Cairo"),
    brick("D2"),
    centroidAt(31.05, 31.38), // Mansoura-ish, ~120 km away
  );
  assert.equal(mismatchFar.confidence, 10);
  assert.ok(mismatchFar.signals.distanceKm != null && mismatchFar.signals.distanceKm > 50);

  // Unknown governorate → 35.
  const unknownGov = scoreCustomerBrick(pharmacyAt(31.0, 31.0, "Nowhere"), brick("D2"), undefined);
  assert.equal(unknownGov.confidence, 35);
  const nullGov = scoreCustomerBrick(pharmacyAt(31.0, 31.0, null), brick("D2"), undefined);
  assert.equal(nullGov.confidence, 35);

  // Markaz normalization.
  assert.equal(normalizeMarkaz("Markaz Talkha"), "talkha");
  assert.equal(normalizeMarkaz("Qesm El Mansoura"), normalizeMarkaz("Mansoura"));
  assert.equal(normalizeMarkaz(null), "");
  // Empty markaz never matches empty markaz.
  const emptyMarkaz = scoreCustomerBrick(
    pharmacyAt(31.0, 31.0, "Nowhere", null),
    brick("D2"),
    { governorate: null, lat: 0, lng: 0, markaz: null, status: "region_mismatch" },
  );
  assert.equal(emptyMarkaz.signals.markazMatch, false);
}
