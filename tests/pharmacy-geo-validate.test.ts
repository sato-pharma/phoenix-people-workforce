import assert from "node:assert/strict";

import {
  AMBIGUOUS_GOVERNORATES,
  GOVERNORATE_TO_REGION,
  haversineKm,
  normalizeMarkaz,
  resolveGovernorateRegion,
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

  runGovernorateRegionTests();
}

// Regression: governorate→region used to be an exact lowercase lookup against raw geocoder
// output, so every one of these REAL production spellings (taken from geo_locations rows that
// were rejected as 'region_mismatch') failed to resolve — and a correct coordinate was thrown
// away. centroidPassesRegionGate in brick-centroids.ts is a thin wrapper over the same
// resolveGovernorateRegion, so these cover both call sites.
function runGovernorateRegionTests() {
  // ── Shapes that previously failed ──────────────────────────────────────────
  // "Al-"/"El-" prefixes and hyphens.
  assert.equal(resolveGovernorateRegion("Kafr El-Sheikh").regionCode, "D1");
  assert.equal(resolveGovernorateRegion("Al-Qalyubia").regionCode, "D1");
  assert.equal(resolveGovernorateRegion("Marsa Matrouh").regionCode, "AB");
  assert.equal(resolveGovernorateRegion("The New Valley").regionCode, "OT");

  // Arabic governorate names.
  assert.equal(resolveGovernorateRegion("محافظة الإسكندرية").regionCode, "AB");
  assert.equal(resolveGovernorateRegion("محافظة الجيزة").regionCode, "GZ");
  assert.equal(resolveGovernorateRegion("محافظة الدقهلية").regionCode, "D2");

  // Sharkia stays ambiguous through every spelling — it is split D2/D3, so governorate
  // alone must never resolve a region.
  for (const spelling of ["Al-Sharqia", "Sharqia", "Sharkia", "الشرقية"]) {
    const match = resolveGovernorateRegion(spelling);
    assert.equal(match.ambiguous, true, `${spelling} should be ambiguous`);
    assert.equal(match.regionCode, null, `${spelling} must not resolve a region`);
  }

  // ── Genuine mismatches must STILL be rejected ──────────────────────────────
  // The gate's whole purpose is refusing a coordinate that is provably elsewhere.
  assert.equal(resolveGovernorateRegion("Assiut").regionCode, "UE"); // ≠ AB → still rejected
  assert.equal(resolveGovernorateRegion("Dakahlia").regionCode, "D2"); // ≠ UE → still rejected
  assert.notEqual(resolveGovernorateRegion("Cairo").regionCode, "D2");

  // Unrecognised / empty input resolves to nothing (never a false accept).
  for (const empty of [null, undefined, "", "   ", "Nowhere"]) {
    const match = resolveGovernorateRegion(empty);
    assert.equal(match.regionCode, null, `${String(empty)} must not resolve`);
    assert.equal(match.ambiguous, false);
  }

  // ── End-to-end through scoreCustomerBrick ─────────────────────────────────
  // Previously "Al-Sharqia" fell to the unknown-governorate tier (35); it must now reach the
  // Sharkia ambiguity tier (58) for a D2 brick.
  assert.equal(scoreCustomerBrick(pharmacyAt(30.7, 31.6, "Al-Sharqia"), brick("D2"), undefined).confidence, 58);
  // "Kafr El-Sheikh" must reach the governorate-match tier (70) for a D1 brick.
  assert.equal(scoreCustomerBrick(pharmacyAt(31.1, 30.9, "Kafr El-Sheikh"), brick("D1"), undefined).confidence, 70);
  // ...and still register a mismatch (12) against a brick in another region.
  assert.equal(scoreCustomerBrick(pharmacyAt(31.1, 30.9, "Kafr El-Sheikh"), brick("UE"), undefined).confidence, 12);
}
