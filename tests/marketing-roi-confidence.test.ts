import assert from "node:assert/strict";

import { roiConfidenceOf } from "../src/lib/marketing-requests/roi-confidence.ts";
import type { RoiTrackerRow } from "../src/lib/marketing-requests/roi-tracker-service.ts";

// The confidence score answers "can I trust this number", NOT "did the campaign do well". Those
// two must never blur — a genuine failure with clean data is a trustworthy number.

function row(overrides: Partial<RoiTrackerRow>): RoiTrackerRow {
  return {
    actualCoverageRatio: 0,
    actualSalesUnits: 0,
    actualSalesValue: 0,
    approvals: [],
    approverRoleKeys: [],
    attributionGapReason: null,
    attributionQuality: "none",
    coverageGap: 0,
    customerName: "Test pharmacy",
    dataCoverage: "complete",
    distributorCodes: ["PS"],
    estimatedCost: 40_000,
    expectedRoiValue: 400_000,
    forecastCoverageRatio: 1,
    hasSalesData: false,
    line: "Pedia",
    payDate: "2026-03-01",
    pharmacies: [
      { customerCode: "0001", distributorCode: "PS", distributorName: "overseas", pharmacyName: "A", referenceStatus: "matched", referenceSuspect: false, trackingStatus: null },
      { customerCode: "0002", distributorCode: "PS", distributorName: "overseas", pharmacyName: "B", referenceStatus: "matched", referenceSuspect: false, trackingStatus: null },
    ],
    productCodes: ["P1"],
    products: [{ expectedValue: 400_000, factoryPrice: 800, forecastQty: 500, line: "Pedia", productCode: "P1", productName: "Syrup", requestCode: "R", requestId: "r", valueShare: 1 }],
    region: "Upper Egypt",
    requestCode: "REQ-1",
    requestId: "r1",
    requestTypeName: "Campaign",
    requesterHrId: "A-1",
    requesterName: "Tester",
    requiredRoiValue: 400_000,
    resultStatus: "on_track",
    roiDurationMonths: 3,
    roiWindow: "2026-03 → 2026-05",
    salesDataComplete: true,
    status: "approved",
    suspectPharmacyCount: 0,
    ...overrides,
  } as RoiTrackerRow;
}

function testCleanRequestScoresFull() {
  const result = roiConfidenceOf(row({}));
  assert.equal(result.score, 100, "every input present must score 100");
  assert.equal(result.band, "high");
  assert.equal(result.weakest, null, "nothing should be flagged when all inputs are present");
}

function testConfidenceIsAboutMeasurementNotPerformance() {
  // A campaign that badly missed its target, but whose data is complete and verified, is a
  // TRUSTWORTHY number. Confidence must not be dragged down by a bad result.
  const failed = roiConfidenceOf(row({ actualCoverageRatio: 0.05, actualSalesValue: 20_000, resultStatus: "behind" }));
  assert.equal(failed.score, 100, "a reliably-measured failure must still score 100");
  assert.equal(failed.band, "high");
}

function testUnverifiedCodesDominate() {
  // Code health is the heaviest factor because a not_found code has no sales ~21x more often.
  const half = roiConfidenceOf(row({ suspectPharmacyCount: 1 }));
  assert.equal(half.score, 80, "half the codes unverified must cost half of the 40-point weight");
  assert.equal(half.weakest?.key, "pharmacy_codes");

  const none = roiConfidenceOf(row({ suspectPharmacyCount: 2 }));
  assert.equal(none.score, 60, "all codes unverified must cost the full 40 points");
}

function testNoTargetPharmaciesIsTotalFailure() {
  const result = roiConfidenceOf(row({ pharmacies: [], suspectPharmacyCount: 0 }));
  assert.equal(result.score, 60, "no pharmacies at all must forfeit the whole code-health weight");
  assert.equal(result.weakest?.key, "pharmacy_codes");
  assert.match(result.weakest?.detail ?? "", /nothing can attribute/i);
}

function testUnmeasuredWindowLowersConfidence() {
  const pending = roiConfidenceOf(row({ dataCoverage: "partial_pending", salesDataComplete: false }));
  assert.equal(pending.score, 85, "a half-covered window costs half the 30-point weight");

  const none = roiConfidenceOf(row({ dataCoverage: "no_validated_data", salesDataComplete: false }));
  assert.equal(none.score, 70, "an unmeasured window costs the full 30 points");
  assert.equal(none.weakest?.key, "sales_coverage");
}

function testWeakestIsTheCostliestNotTheLowest() {
  // products (weight 15) fully missing = 15 points lost.
  // pharmacy codes (weight 40) half missing = 20 points lost — costlier despite a higher ratio.
  const result = roiConfidenceOf(row({ products: [], suspectPharmacyCount: 1 }));
  assert.equal(result.weakest?.key, "pharmacy_codes", "weakest must be the costliest factor, not the lowest ratio");
}

function testBandThresholds() {
  assert.equal(roiConfidenceOf(row({})).band, "high");
  assert.equal(roiConfidenceOf(row({ dataCoverage: "no_validated_data", suspectPharmacyCount: 1 })).band, "medium");
  assert.equal(
    roiConfidenceOf(row({ dataCoverage: "no_validated_data", payDate: null, pharmacies: [], products: [], roiWindow: null })).band,
    "low",
  );
}

export function runMarketingRoiConfidenceTests() {
  testCleanRequestScoresFull();
  testConfidenceIsAboutMeasurementNotPerformance();
  testUnverifiedCodesDominate();
  testNoTargetPharmaciesIsTotalFailure();
  testUnmeasuredWindowLowersConfidence();
  testWeakestIsTheCostliestNotTheLowest();
  testBandThresholds();
}
