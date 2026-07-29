import assert from "node:assert/strict";

import { draftCaptureConfidence, roiConfidenceOf } from "../src/lib/marketing-requests/roi-confidence.ts";
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

// ── Draft capture score (shown while the request is still being written) ─────────────────────

function testDraftScoresOnlyWhatTheRequesterControls() {
  // A complete draft must be able to reach 100. Sales coverage is unknowable at submission and is
  // not the requester's fault; if it counted, every request would be permanently capped and people
  // would learn to ignore the number entirely.
  const clean = draftCaptureConfidence({
    forecastUnits: 500,
    hasPayDate: true,
    pharmacySuspect: [false, false],
    productCount: 1,
  });
  assert.equal(clean.score, 100, "a fully-formed draft must be able to reach 100");
  assert.equal(clean.band, "high");
  assert.equal(clean.weakest, null);
}

function testDraftPharmacyCodesDominate() {
  const half = draftCaptureConfidence({
    forecastUnits: 500,
    hasPayDate: true,
    pharmacySuspect: [true, false],
    productCount: 1,
  });
  assert.equal(half.score, 70, "half the codes unverified costs half of the 60-point weight");
  assert.equal(half.weakest?.key, "pharmacy_codes");
  assert.match(half.weakest?.detail ?? "", /will not count/i, "must say what the consequence is");
}

function testDraftMissingPiecesEachCost() {
  const noPayDate = draftCaptureConfidence({ forecastUnits: 500, hasPayDate: false, pharmacySuspect: [false], productCount: 1 });
  assert.equal(noPayDate.score, 80, "no pay date costs the 20-point window weight");

  const noForecast = draftCaptureConfidence({ forecastUnits: 0, hasPayDate: true, pharmacySuspect: [false], productCount: 1 });
  assert.equal(noForecast.score, 90, "a product with no forecast costs half the 20-point weight");

  const empty = draftCaptureConfidence({ forecastUnits: 0, hasPayDate: false, pharmacySuspect: [], productCount: 0 });
  assert.equal(empty.score, 0, "an empty draft scores zero");
  assert.equal(empty.weakest?.key, "pharmacy_codes");
}

function testDraftMessagesAreNextActions() {
  // The reason to move this earlier is that it can still be fixed — so every message has to tell
  // the requester what to DO, not merely what is wrong.
  const empty = draftCaptureConfidence({ forecastUnits: 0, hasPayDate: false, pharmacySuspect: [], productCount: 0 });
  const details = empty.factors.map((factor) => factor.detail);
  assert.ok(details.some((d) => /^Add at least one target pharmacy/.test(d)), "pharmacy message must be an instruction");
  assert.ok(details.some((d) => /^Set a pay date/.test(d)), "pay-date message must be an instruction");
  assert.ok(details.some((d) => /^Add at least one promoted product/.test(d)), "product message must be an instruction");
}

function testBothScorersShareOneVocabulary() {
  // Two scores that drift apart is the exact failure this module family exists to prevent.
  const draft = draftCaptureConfidence({ forecastUnits: 500, hasPayDate: true, pharmacySuspect: [false], productCount: 1 });
  assert.equal(draft.band, "high", "both scorers must use the same band thresholds");
  for (const factor of draft.factors) {
    assert.ok(typeof factor.label === "string" && factor.label.length > 0);
    assert.ok(factor.ratio >= 0 && factor.ratio <= 1, "ratios stay normalised in both scorers");
  }
}

export function runMarketingRoiConfidenceTests() {
  testCleanRequestScoresFull();
  testConfidenceIsAboutMeasurementNotPerformance();
  testUnverifiedCodesDominate();
  testNoTargetPharmaciesIsTotalFailure();
  testUnmeasuredWindowLowersConfidence();
  testWeakestIsTheCostliestNotTheLowest();
  testBandThresholds();
  testDraftScoresOnlyWhatTheRequesterControls();
  testDraftPharmacyCodesDominate();
  testDraftMissingPiecesEachCost();
  testDraftMessagesAreNextActions();
  testBothScorersShareOneVocabulary();
}
