import assert from "node:assert/strict";

import {
  computeCoverageRollupByDimension,
  computeCoverageTrend,
  findWorstZeroSalesOutlier,
  sortRequestRows,
} from "../src/lib/marketing-requests/coverage-report-analytics.ts";
import type { MarketingCoverageReportRow } from "../src/lib/marketing-requests/roi-report-types.ts";

function row(overrides: Partial<MarketingCoverageReportRow>): MarketingCoverageReportRow {
  return {
    requestId: "r",
    requestCode: "REQ-0001",
    requesterHrId: "r1",
    requesterName: "Rep One",
    line: "Anti Inf",
    region: "Delta",
    areaName: "Cairo",
    requesterTier: "Medical Rep",
    customerName: "Dr. Sample",
    customerId: "cust-1",
    status: "approved",
    requestTypeName: "Doctor Request",
    payDate: "2026-03-01",
    roiWindow: "2026-03 → 2026-05",
    roiDurationMonths: 3,
    estimatedCost: 1000,
    expectedRoiValue: 9000,
    requiredRoiValue: 10000,
    actualSalesValue: 0,
    actualSalesUnits: 0,
    actualCoverageRatio: 0,
    forecastCoverageRatio: 0.9,
    dataCoverage: "complete",
    resultStatus: "on_track",
    attributionQuality: "exact_customer",
    hasSalesData: true,
    salesDataComplete: true,
    attributionGapReason: null,
    approverRoleKeys: ["Medical Rep"],
    productCodes: ["GU001"],
    distributorCodes: ["IS"],
    pharmacyKeys: ["12345"],
    ...overrides,
  } as MarketingCoverageReportRow;
}

export function runMarketingCoverageReportAnalyticsTests() {
  // ── computeCoverageRollupByDimension: groups, null/blank falls back to "Unassigned".
  {
    const rows = [
      row({ requestId: "a", line: "Anti Inf", requiredRoiValue: 10000, actualSalesValue: 12000, resultStatus: "on_track" }),
      row({ requestId: "b", line: "Anti Inf", requiredRoiValue: 10000, actualSalesValue: 4000, resultStatus: "behind" }),
      row({ requestId: "c", line: "CNS", requiredRoiValue: 5000, actualSalesValue: 0, resultStatus: "no_data" }),
      row({ requestId: "d", line: null as unknown as string, requiredRoiValue: 1000, actualSalesValue: 0, resultStatus: "awaiting_data" }),
      row({ requestId: "e", line: "", requiredRoiValue: 1000, actualSalesValue: 500, resultStatus: "on_track" }),
    ];

    const byLine = computeCoverageRollupByDimension(rows, "line");
    assert.equal(byLine.length, 3, "3 distinct line buckets incl. Unassigned");

    const antiInf = byLine.find((b) => b.key === "Anti Inf");
    assert.ok(antiInf);
    assert.equal(antiInf!.requestCount, 2);
    assert.equal(antiInf!.totalRequiredRoi, 20000);
    assert.equal(antiInf!.totalActualValue, 16000);
    assert.equal(antiInf!.onTrackCount, 1);
    assert.equal(antiInf!.behindCount, 1);

    const unassigned = byLine.find((b) => b.key === "Unassigned");
    assert.ok(unassigned, "null and blank line both fall back to Unassigned");
    assert.equal(unassigned!.requestCount, 2, "both the null-line and blank-line row are merged into Unassigned");

    // ── Sorted ascending by coverage ratio (worst first), then cost descending.
    const cns = byLine.find((b) => b.key === "CNS")!;
    assert.equal(cns.coverageRatio, 0, "zero required-ROI-covered actual → 0 ratio (not the div-by-zero 1 branch, since totalActualValue is also 0)");
    const worstIndex = byLine.findIndex((b) => b.key === "CNS");
    const bestIndex = byLine.findIndex((b) => b.key === "Anti Inf");
    assert.ok(worstIndex < bestIndex, "CNS (0% coverage) must sort before Anti Inf (80% coverage)");
  }

  // ── Div-by-zero guard: zero required-ROI but nonzero actual → ratio 1, not NaN/Infinity.
  {
    const rows = [row({ requestId: "z", region: "Sinai", requiredRoiValue: 0, actualSalesValue: 500 })];
    const byRegion = computeCoverageRollupByDimension(rows, "region");
    assert.equal(byRegion[0].coverageRatio, 1);
  }

  // ── computeCoverageTrend: groups by YYYY-MM, sorts ascending, ignores unparsable dates.
  {
    const rows = [
      row({ requestId: "a", payDate: "2026-05-15", estimatedCost: 100 }),
      row({ requestId: "b", payDate: "2026-05-02", estimatedCost: 200 }),
      row({ requestId: "c", payDate: "2026-03-10", estimatedCost: 50 }),
      row({ requestId: "d", payDate: null as unknown as string, estimatedCost: 999 }),
    ];
    const trend = computeCoverageTrend(rows);
    assert.equal(trend.length, 2, "the null-payDate row is dropped, not bucketed");
    assert.deepEqual(
      trend.map((t) => t.month),
      ["2026-03", "2026-05"],
      "months sorted ascending",
    );
    const may = trend.find((t) => t.month === "2026-05")!;
    assert.equal(may.requestCount, 2);
    assert.equal(may.totalCost, 300);
  }

  // ── findWorstZeroSalesOutlier: only ever "no_data", never "awaiting_data"; highest cost wins.
  {
    const rows = [
      row({ requestId: "a", resultStatus: "awaiting_data", estimatedCost: 999999, actualSalesValue: 0 }),
      row({ requestId: "b", resultStatus: "no_data", estimatedCost: 5000, actualSalesValue: 0 }),
      row({ requestId: "c", resultStatus: "no_data", estimatedCost: 8000, actualSalesValue: 0 }),
      row({ requestId: "d", resultStatus: "on_track", estimatedCost: 20000, actualSalesValue: 20000 }),
    ];
    const outlier = findWorstZeroSalesOutlier(rows);
    assert.ok(outlier, "a no_data row exists, so an outlier must be found");
    assert.equal(outlier!.requestId, "c", "highest-cost genuinely-zero (no_data) row wins, never the awaiting_data one despite its higher cost");
  }

  // ── findWorstZeroSalesOutlier: null when nothing qualifies (only awaiting_data/on_track present).
  {
    const rows = [
      row({ requestId: "a", resultStatus: "awaiting_data", estimatedCost: 999999 }),
      row({ requestId: "b", resultStatus: "on_track", estimatedCost: 500, actualSalesValue: 500 }),
    ];
    assert.equal(findWorstZeroSalesOutlier(rows), null);
  }

  // ── findWorstZeroSalesOutlier: null on an empty row set.
  assert.equal(findWorstZeroSalesOutlier([]), null);

  // ── sortRequestRows: numeric column, both directions.
  {
    const rows = [
      row({ requestId: "a", estimatedCost: 300 }),
      row({ requestId: "b", estimatedCost: 100 }),
      row({ requestId: "c", estimatedCost: 200 }),
    ];
    const asc = sortRequestRows(rows, "estimatedCost", "asc");
    assert.deepEqual(asc.map((r) => r.requestId), ["b", "c", "a"]);
    const desc = sortRequestRows(rows, "estimatedCost", "desc");
    assert.deepEqual(desc.map((r) => r.requestId), ["a", "c", "b"]);
    // ── original array is never mutated.
    assert.deepEqual(rows.map((r) => r.requestId), ["a", "b", "c"], "sortRequestRows must not mutate its input");
  }

  // ── sortRequestRows: string column, case/locale-aware compare.
  {
    const rows = [
      row({ requestId: "a", requestCode: "REQ-0003" }),
      row({ requestId: "b", requestCode: "REQ-0001" }),
      row({ requestId: "c", requestCode: "REQ-0002" }),
    ];
    const asc = sortRequestRows(rows, "requestCode", "asc");
    assert.deepEqual(asc.map((r) => r.requestId), ["b", "c", "a"]);
  }

  // ── sortRequestRows: null-safe — a null field sorts as an empty string, never throws.
  {
    const rows = [
      row({ requestId: "a", requesterName: "Zaid" }),
      row({ requestId: "b", requesterName: null }),
      row({ requestId: "c", requesterName: "Amr" }),
    ];
    const asc = sortRequestRows(rows, "requesterName", "asc");
    assert.deepEqual(asc.map((r) => r.requestId), ["b", "c", "a"], "null (→ '') sorts before any non-empty name");
  }
}
