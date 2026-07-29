import assert from "node:assert/strict";

import {
  isJudgeableNow,
  roiJudgementMonth,
  roiLifecycleStage,
} from "../src/lib/marketing-requests/roi-live-stages.ts";
import type { RoiTrackerRow } from "../src/lib/marketing-requests/roi-tracker-service.ts";

// These two rules decide which bucket every committed EGP lands in on the live ROI Tracker, and
// which month it is promised to become judgeable. They are the whole organising idea of that
// surface, so they are tested rather than eyeballed.

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
    dataCoverage: "no_validated_data",
    distributorCodes: [],
    estimatedCost: 40_000,
    expectedRoiValue: 0,
    forecastCoverageRatio: 0,
    hasSalesData: false,
    line: "Pedia",
    payDate: "2026-03-01",
    pharmacies: [],
    productCodes: [],
    products: [],
    region: "Upper Egypt",
    requestCode: "REQ-0001",
    requestId: "id-1",
    requestTypeName: "Campaign",
    requesterHrId: "A-1",
    requesterName: "Tester",
    requiredRoiValue: 400_000,
    resultStatus: "awaiting_data",
    roiDurationMonths: 3,
    roiWindow: "2026-03 → 2026-05",
    salesDataComplete: false,
    status: "approved",
    suspectPharmacyCount: 0,
    ...overrides,
  } as RoiTrackerRow;
}

function testRejectedNeverCountsAsCommitted() {
  // Production carries rejected requests that still have a pay date — one of them dated in the
  // future. If the pay date were tested before the status, refused spend would be promoted into
  // the pipeline and inflate committed money.
  assert.equal(
    roiLifecycleStage(row({ payDate: "2026-02-01", status: "rejected" }), "2026-06"),
    "rejected",
    "a rejected request with a past pay date must stay rejected, never 'measuring'",
  );
  assert.equal(
    roiLifecycleStage(row({ payDate: "2026-08-01", status: "rejected" }), "2026-06"),
    "rejected",
    "a rejected request with a FUTURE pay date must stay rejected, never 'not yet paid'",
  );
}

function testAwaitingApprovalStages() {
  const statuses = ["draft", "pending_validation", "pending_approval", "returned", "finance_hold"] as const;
  for (const status of statuses) {
    assert.equal(
      roiLifecycleStage(row({ status }), "2026-06"),
      "awaiting_approval",
      `${status} must read as awaiting approval — the money is not committed yet`,
    );
  }
}

function testClockHasNotStarted() {
  assert.equal(
    roiLifecycleStage(row({ payDate: null, roiWindow: null }), "2026-06"),
    "approved_unpaid",
    "an approved request with no pay date has not started its ROI clock",
  );
  assert.equal(
    roiLifecycleStage(row({ payDate: "2026-09-01" }), "2026-06"),
    "approved_unpaid",
    "a pay date beyond the validated-data frontier means the clock has not started",
  );
}

function testMeasuringVersusJudged() {
  assert.equal(
    roiLifecycleStage(row({ dataCoverage: "partial_pending" }), "2026-06"),
    "measuring",
    "a partially covered window is still measuring — too early to judge",
  );
  assert.equal(
    roiLifecycleStage(row({ dataCoverage: "no_validated_data" }), "2026-06"),
    "measuring",
    "a paid request with no covering data is measuring, not judged",
  );
  assert.equal(
    roiLifecycleStage(row({ dataCoverage: "complete" }), "2026-06"),
    "judged",
    "only a fully covered window is judged",
  );
}

function testJudgementMonthComesFromTheEngineWindow() {
  assert.equal(roiJudgementMonth(row({ roiWindow: "2026-08 → 2027-03" })), "2027-03");
  assert.equal(roiJudgementMonth(row({ roiWindow: "2026-03 → 2026-05" })), "2026-05");
  assert.equal(roiJudgementMonth(row({ roiWindow: null })), null, "no window means no promised month");
  assert.equal(roiJudgementMonth(row({ roiWindow: "garbage" })), null, "a malformed window must not yield a month");
}

function testJudgeableOnlyOnceDataReachesTheMonth() {
  const request = row({ roiWindow: "2026-03 → 2026-05" });
  assert.equal(isJudgeableNow(request, "2026-06"), true, "data past the window end means it can be judged");
  assert.equal(isJudgeableNow(request, "2026-05"), true, "data exactly at the window end is enough");
  assert.equal(isJudgeableNow(request, "2026-04"), false, "data short of the window end is not enough");
  assert.equal(isJudgeableNow(request, null), false, "with no validated data nothing is judgeable");
}

export function runMarketingRoiLiveStagesTests() {
  testRejectedNeverCountsAsCommitted();
  testAwaitingApprovalStages();
  testClockHasNotStarted();
  testMeasuringVersusJudged();
  testJudgementMonthComesFromTheEngineWindow();
  testJudgeableOnlyOnceDataReachesTheMonth();
}
