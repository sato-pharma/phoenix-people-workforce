// Unit tests for buildRoiCohorts — the ROI-weighted cohort engine (items 11/12/13).
// Pure + IO-free, so the aggregation, the efficiency/coverage/forecast-accuracy ratios, and the
// multi-valued approver-role fan-out are all checked directly with fixtures.

import assert from "node:assert/strict";

import { buildRoiCohorts } from "../src/lib/marketing-requests/roi-business-report.ts";
import type { MarketingRoiReportRow } from "../src/lib/marketing-requests/roi-report-types.ts";

// A plausible base row; every test overrides only the fields it exercises. Cast through unknown so
// the fixture need not restate the ~30 fields (and their exact enum literals) irrelevant to cohorts.
function row(over: Partial<MarketingRoiReportRow>): MarketingRoiReportRow {
  return {
    requestId: "req",
    requestCode: "MR-1",
    requesterHrId: "H1",
    requesterName: "Alice",
    line: "Pedia",
    region: "Cairo",
    customerName: "Customer",
    status: "approved",
    requestTypeName: "Activity",
    payDate: "2026-08-01",
    roiWindow: "2026-08 → 2026-10",
    roiDurationMonths: 3,
    estimatedCost: 0,
    expectedRoiValue: 0,
    requiredRoiValue: 0,
    actualSalesValue: 0,
    actualSalesUnits: 0,
    actualCoverageRatio: 0,
    forecastCoverageRatio: 0,
    dataCoverage: "complete",
    resultStatus: "on_track",
    attributionQuality: "exact_customer",
    hasSalesData: true,
    salesDataComplete: true,
    attributionGapReason: null,
    approverRoleKeys: [],
    productCodes: [],
    distributorCodes: [],
    ...over,
  } as unknown as MarketingRoiReportRow;
}

export function runMarketingRoiCohortsTests() {
  // Empty input → every dimension is an empty array (never throws / never null).
  const empty = buildRoiCohorts([]);
  assert.deepEqual(empty.byRequester, []);
  assert.deepEqual(empty.byLine, []);
  assert.deepEqual(empty.byApproverRole, []);

  // Aggregation + the three derived ratios, on a requester with two requests.
  const cohorts = buildRoiCohorts([
    row({ requesterHrId: "H1", requesterName: "Alice", estimatedCost: 100, requiredRoiValue: 1000, expectedRoiValue: 800, actualSalesValue: 600 }),
    row({ requesterHrId: "H1", requesterName: "Alice", estimatedCost: 100, requiredRoiValue: 1000, expectedRoiValue: 200, actualSalesValue: 400 }),
    row({ requesterHrId: "H2", requesterName: "Bob", estimatedCost: 50, requiredRoiValue: 500, expectedRoiValue: 0, actualSalesValue: 250 }),
  ]);

  const alice = cohorts.byRequester.find((r) => r.key === "H1");
  assert.ok(alice, "Alice cohort present");
  assert.equal(alice.requestCount, 2);
  assert.equal(alice.totalCost, 200);
  assert.equal(alice.totalActual, 1000);
  assert.equal(alice.efficiencyRatio, 5); // 1000 returned / 200 spent = 5 EGP per EGP
  assert.equal(alice.coverageRatio, 0.5); // 1000 actual / 2000 required
  assert.equal(alice.forecastAccuracyRatio, 1); // 1000 actual / 1000 forecast = spot on

  // Forecast accuracy is null when there is no forecast to score against.
  const bob = cohorts.byRequester.find((r) => r.key === "H2");
  assert.ok(bob, "Bob cohort present");
  assert.equal(bob.forecastAccuracyRatio, null);

  // byRequester sorted by realized actual, desc (Alice 1000 before Bob 250).
  assert.equal(cohorts.byRequester[0].key, "H1");

  // Approver role is multi-valued: a request approved by two roles lands in BOTH cohorts.
  const multi = buildRoiCohorts([row({ approverRoleKeys: ["MM", "DM"], estimatedCost: 100, actualSalesValue: 300 })]);
  assert.equal(multi.byApproverRole.length, 2);
  assert.ok(multi.byApproverRole.find((r) => r.key === "MM"));
  assert.ok(multi.byApproverRole.find((r) => r.key === "DM"));

  // Efficiency league: byLine ranks by actual/cost, desc.
  const league = buildRoiCohorts([
    row({ line: "Line A", estimatedCost: 100, actualSalesValue: 100 }), // efficiency 1.0
    row({ line: "Line B", estimatedCost: 100, actualSalesValue: 500 }), // efficiency 5.0
  ]);
  assert.equal(league.byLine[0].key, "Line B");
  assert.equal(league.byLine[0].efficiencyRatio, 5);

  // Zero cost must not divide-by-zero — efficiency degrades to 0.
  const zeroCost = buildRoiCohorts([row({ line: "Line Z", estimatedCost: 0, actualSalesValue: 100 })]);
  assert.equal(zeroCost.byLine[0].efficiencyRatio, 0);
}
