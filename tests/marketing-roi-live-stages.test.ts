import assert from "node:assert/strict";

import {
  isJudgeableNow,
  isUncommittedStage,
  ROI_LIVE_TRACKER_STATUSES,
  roiJudgementMonth,
  roiLifecycleStage,
} from "../src/lib/marketing-requests/roi-live-stages.ts";
import type { RoiTrackerRow } from "../src/lib/marketing-requests/roi-tracker-service.ts";
import { singleProductUnits } from "../src/lib/marketing-requests/roi-units.ts";

/** The second argument of roiLifecycleStage is TODAY in Cairo — pinned so the tests never age. */
const TODAY = "2026-06-15";

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
    roiLifecycleStage(row({ payDate: "2026-02-01", status: "rejected" }), TODAY),
    "rejected",
    "a rejected request with a past pay date must stay rejected, never 'measuring'",
  );
  assert.equal(
    roiLifecycleStage(row({ payDate: "2026-08-01", status: "rejected" }), TODAY),
    "rejected",
    "a rejected request with a FUTURE pay date must stay rejected, never 'not yet paid'",
  );
}

function testAwaitingApprovalStages() {
  const statuses = ["draft", "pending_validation", "pending_approval", "returned", "finance_hold"] as const;
  for (const status of statuses) {
    assert.equal(
      roiLifecycleStage(row({ status }), TODAY),
      "awaiting_approval",
      `${status} must read as awaiting approval — the money is not committed yet`,
    );
  }
}

function testClockHasNotStarted() {
  assert.equal(
    roiLifecycleStage(row({ payDate: null, roiWindow: null }), TODAY),
    "approved_unpaid",
    "an approved request with no pay date has not started its ROI clock",
  );
  assert.equal(
    roiLifecycleStage(row({ payDate: "2026-09-01" }), TODAY),
    "approved_unpaid",
    "a pay date still in the future means the money has not been paid",
  );
}

function testPaidMeansPaidWhateverTheSalesFilesSay() {
  // 🔴 2026-10-09: "Not yet paid" used to mean "pay month beyond the validated-data frontier" —
  // a fact about the SALES FILES. All 15 requests on that tile had been paid, one with EGP 35,751
  // already attributed. A request whose pay date has passed is measuring, however far the
  // validated data reaches.
  assert.equal(
    roiLifecycleStage(row({ dataCoverage: "no_validated_data", payDate: "2026-06-01" }), TODAY),
    "measuring",
    "paid on 1 June, read on 15 June, data not there yet — measuring, never 'not yet paid'",
  );
  assert.equal(
    roiLifecycleStage(row({ dataCoverage: "no_validated_data", payDate: TODAY }), TODAY),
    "measuring",
    "paid today is paid",
  );
  assert.equal(
    roiLifecycleStage(row({ dataCoverage: "no_validated_data", payDate: "2026-06-16" }), TODAY),
    "approved_unpaid",
    "paid tomorrow is not paid yet",
  );
}

function testTheTrackerAsksForEveryStatusButDraft() {
  // 🔴 An empty status list is the report's executive default (approved money only), so the live
  // tracker's approval queue, rejected and cancelled tiles could never hold a request — 27 of 52 on
  // production, 2026-10-09. The tracker names its statuses explicitly.
  for (const status of ["pending_validation", "pending_approval", "returned", "finance_hold", "rejected", "cancelled"] as const) {
    assert.ok(ROI_LIVE_TRACKER_STATUSES.includes(status), `${status} must be requested by the live tracker`);
  }
  assert.ok(!ROI_LIVE_TRACKER_STATUSES.includes("draft"), "a draft is the requester's own unsubmitted work");
  assert.ok(ROI_LIVE_TRACKER_STATUSES.length > 0, "an empty list would fall back to approved-only");
}

function testUncommittedStagesStayOutOfCommittedMoney() {
  assert.equal(isUncommittedStage("rejected"), true);
  assert.equal(isUncommittedStage("cancelled"), true);
  assert.equal(isUncommittedStage("awaiting_approval"), true);
  assert.equal(isUncommittedStage("approved_unpaid"), false);
  assert.equal(isUncommittedStage("measuring"), false);
  assert.equal(isUncommittedStage("judged"), false);
}

function testUnitsOnlyForOneProduct() {
  // 🔒 Units of different products or concentrations are never added.
  const single = singleProductUnits({
    actualSalesUnits: 120,
    products: [{ forecastQty: 400, productCode: "gu001" }],
  });
  assert.deepEqual(single, { actualUnits: 120, forecastUnits: 400 });
  const sameCodeTwice = singleProductUnits({
    actualSalesUnits: 50,
    products: [{ forecastQty: 100, productCode: "GU001" }, { forecastQty: 60, productCode: " gu001 " }],
  });
  assert.deepEqual(sameCodeTwice, { actualUnits: 50, forecastUnits: 160 }, "one product code listed twice is still one product");
  assert.equal(
    singleProductUnits({
      actualSalesUnits: 321,
      products: [{ forecastQty: 1000, productCode: "TB040" }, { forecastQty: 1600, productCode: "TB080" }],
    }),
    null,
    "two concentrations have no unit total — 321 of 2,600 units meant nothing",
  );
  assert.equal(singleProductUnits({ actualSalesUnits: 0, products: [] }), null, "no product, no units");
}

function testMeasuringVersusJudged() {
  assert.equal(
    roiLifecycleStage(row({ dataCoverage: "partial_pending" }), TODAY),
    "measuring",
    "a partially covered window is still measuring — too early to judge",
  );
  assert.equal(
    roiLifecycleStage(row({ dataCoverage: "no_validated_data" }), TODAY),
    "measuring",
    "a paid request with no covering data is measuring, not judged",
  );
  assert.equal(
    roiLifecycleStage(row({ dataCoverage: "complete" }), TODAY),
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
  testPaidMeansPaidWhateverTheSalesFilesSay();
  testTheTrackerAsksForEveryStatusButDraft();
  testUncommittedStagesStayOutOfCommittedMoney();
  testUnitsOnlyForOneProduct();
  testMeasuringVersusJudged();
  testJudgementMonthComesFromTheEngineWindow();
  testJudgeableOnlyOnceDataReachesTheMonth();
}
