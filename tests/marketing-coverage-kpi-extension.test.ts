import assert from "node:assert/strict";

import { countDistinctCoverage } from "../src/lib/marketing-requests/coverage-report-service.ts";
import type { MarketingCoverageReportRow } from "../src/lib/marketing-requests/roi-report-types.ts";

function row(overrides: Partial<MarketingCoverageReportRow>): MarketingCoverageReportRow {
  return {
    requestId: "r1",
    requestCode: "REQ-0001",
    requesterHrId: "rep-1",
    requesterName: "Rep One",
    line: "Pedia",
    region: "Delta",
    areaName: "Cairo",
    requesterTier: "Medical Rep",
    customerName: "Dr. Smith Clinic",
    customerId: "cust-1",
    status: "approved",
    requestTypeName: "Doctor Request",
    payDate: "2026-03-01",
    roiWindow: "2026-03 → 2026-05",
    roiDurationMonths: 3,
    estimatedCost: 1000,
    expectedRoiValue: 10000,
    requiredRoiValue: 10000,
    actualSalesValue: 500,
    actualSalesUnits: 5,
    actualCoverageRatio: 0.05,
    forecastCoverageRatio: 1,
    dataCoverage: "complete",
    resultStatus: "behind",
    attributionQuality: "exact_customer",
    hasSalesData: true,
    salesDataComplete: true,
    attributionGapReason: null,
    approverRoleKeys: [],
    productCodes: ["P1"],
    distributorCodes: ["IS"],
    pharmacyKeys: ["ph-1"],
    ...overrides,
  };
}

export function runMarketingCoverageKpiExtensionTests() {
  // ── Dedup across requests: 2 requests sharing the same customer and one
  //    overlapping pharmacy must count that customer once and that pharmacy once.
  {
    const rows: MarketingCoverageReportRow[] = [
      row({ requestId: "a", customerId: "cust-1", pharmacyKeys: ["ph-1", "ph-2"] }),
      row({ requestId: "b", customerId: "cust-1", pharmacyKeys: ["ph-2", "ph-3"] }),
      row({ requestId: "c", customerId: "cust-2", pharmacyKeys: ["ph-4"] }),
    ];
    const { distinctPharmacyCount, distinctCustomerCount } = countDistinctCoverage(rows);
    assert.equal(distinctPharmacyCount, 4, "ph-1, ph-2, ph-3, ph-4 — deduped, not summed");
    assert.equal(distinctCustomerCount, 2, "cust-1 counted once despite 2 requests");
  }

  // ── Keyed by identity (customerId), not display name — two different customers
  //    that happen to share a display name must still count as 2.
  {
    const rows: MarketingCoverageReportRow[] = [
      row({ requestId: "a", customerId: "cust-1", customerName: "City Pharmacy" }),
      row({ requestId: "b", customerId: "cust-9", customerName: "City Pharmacy" }),
    ];
    const { distinctCustomerCount } = countDistinctCoverage(rows);
    assert.equal(distinctCustomerCount, 2, "distinct ids must not collapse just because names match");
  }

  // ── A request with no target pharmacies contributes 0 pharmacies, never throws.
  {
    const rows: MarketingCoverageReportRow[] = [row({ requestId: "a", pharmacyKeys: [] })];
    const { distinctPharmacyCount, distinctCustomerCount } = countDistinctCoverage(rows);
    assert.equal(distinctPharmacyCount, 0);
    assert.equal(distinctCustomerCount, 1);
  }

  // ── Empty input → zero counts.
  assert.deepEqual(countDistinctCoverage([]), { distinctPharmacyCount: 0, distinctCustomerCount: 0 });
}
