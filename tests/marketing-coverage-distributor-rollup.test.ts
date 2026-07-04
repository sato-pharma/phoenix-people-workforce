import assert from "node:assert/strict";

import { computeDistributorRollup } from "../src/lib/marketing-requests/coverage-report-service.ts";
import type {
  MarketingCoverageReportRow,
  MarketingCoverageRequestIndexEntry,
} from "../src/lib/marketing-requests/roi-report-types.ts";

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

function entry(overrides: Partial<MarketingCoverageRequestIndexEntry>): MarketingCoverageRequestIndexEntry {
  return {
    requestId: "r",
    requestCode: "REQ-0001",
    requesterHrId: "r1",
    requesterName: "Rep One",
    managerHrId: "d1",
    status: "approved",
    requestTypeId: 1,
    requestTypeName: "Doctor Request",
    payDate: "2026-03-01",
    roiDurationMonths: 3,
    lineName: "Anti Inf",
    regionName: "Delta",
    areaName: "Cairo",
    requesterTier: "Medical Rep",
    dmHrId: "d1",
    dmName: "DM One",
    nsmHrId: "n1",
    nsmName: "NSM One",
    rsmHrId: null,
    rsmName: null,
    approverRoleKeys: ["Medical Rep"],
    distributorCodes: ["IS"],
    productCodes: ["GU001"],
    productNames: ["Guamusin"],
    pharmacyKeys: ["ph-1"],
    pharmacyNames: ["Pharmacy One"],
    hasRestrictedProduct: false,
    distributorWeights: [{ distributorCode: "IS", weight: 1 }],
    ...overrides,
  };
}

export function runMarketingCoverageDistributorRollupTests() {
  // ── Real weighted split: 3 pharmacies at A, 2 at B → 0.6/0.4, summing to 1.
  {
    const rows: MarketingCoverageReportRow[] = [row({ requestId: "r1", estimatedCost: 1000, requiredRoiValue: 2000 })];
    const entryById = new Map([
      [
        "r1",
        entry({
          requestId: "r1",
          distributorCodes: ["A", "B"],
          distributorWeights: [
            { distributorCode: "A", weight: 0.6 },
            { distributorCode: "B", weight: 0.4 },
          ],
        }),
      ],
    ]);
    const distributorNameByCode = new Map([
      ["A", "Distributor A"],
      ["B", "Distributor B"],
    ]);
    const result = computeDistributorRollup(rows, entryById, distributorNameByCode);
    assert.equal(result.length, 2);
    const a = result.find((r) => r.distributorCode === "A")!;
    const b = result.find((r) => r.distributorCode === "B")!;
    assert.equal(a.allocatedCost, 600, "1000 * 0.6");
    assert.equal(a.allocatedRequiredRoi, 1200, "2000 * 0.6");
    assert.equal(b.allocatedCost, 400, "1000 * 0.4");
    assert.equal(b.allocatedRequiredRoi, 800, "2000 * 0.4");
    assert.equal(a.requestCount, 1);
    assert.equal(b.requestCount, 1);
    assert.equal(a.distributorName, "Distributor A");
  }

  // ── requestCount is unweighted: 2 requests both touching distributor A → count 2, not summed weights.
  {
    const rows: MarketingCoverageReportRow[] = [
      row({ requestId: "r1", estimatedCost: 1000, requiredRoiValue: 1000 }),
      row({ requestId: "r2", estimatedCost: 500, requiredRoiValue: 500 }),
    ];
    const entryById = new Map([
      ["r1", entry({ requestId: "r1", distributorWeights: [{ distributorCode: "A", weight: 1 }] })],
      ["r2", entry({ requestId: "r2", distributorWeights: [{ distributorCode: "A", weight: 1 }] })],
    ]);
    const result = computeDistributorRollup(rows, entryById, new Map());
    assert.equal(result.length, 1);
    assert.equal(result[0].requestCount, 2);
    assert.equal(result[0].allocatedCost, 1500);
    assert.equal(result[0].distributorName, null, "no name entry → null, not a crash");
  }

  // ── A request with zero resolvable targets (distributorWeights: []) contributes to no bucket
  //    at all — not silently split evenly across whatever distributors exist elsewhere.
  {
    const rows: MarketingCoverageReportRow[] = [
      row({ requestId: "r1", estimatedCost: 1000, requiredRoiValue: 1000 }),
      row({ requestId: "r2", estimatedCost: 999, requiredRoiValue: 999 }),
    ];
    const entryById = new Map([
      ["r1", entry({ requestId: "r1", distributorWeights: [{ distributorCode: "A", weight: 1 }] })],
      ["r2", entry({ requestId: "r2", distributorWeights: [] })],
    ]);
    const result = computeDistributorRollup(rows, entryById, new Map());
    assert.equal(result.length, 1, "only distributor A appears; r2 contributes nowhere");
    assert.equal(result[0].allocatedCost, 1000, "r2's cost is never folded into A's bucket");
  }

  // ── A row whose requestId has no matching index entry is skipped, never throws.
  {
    const rows: MarketingCoverageReportRow[] = [row({ requestId: "orphan" })];
    assert.deepEqual(computeDistributorRollup(rows, new Map(), new Map()), []);
  }

  // ── Sorted by allocated cost descending.
  {
    const rows: MarketingCoverageReportRow[] = [
      row({ requestId: "r1", estimatedCost: 100, requiredRoiValue: 100 }),
      row({ requestId: "r2", estimatedCost: 9000, requiredRoiValue: 9000 }),
    ];
    const entryById = new Map([
      ["r1", entry({ requestId: "r1", distributorWeights: [{ distributorCode: "SMALL", weight: 1 }] })],
      ["r2", entry({ requestId: "r2", distributorWeights: [{ distributorCode: "BIG", weight: 1 }] })],
    ]);
    const result = computeDistributorRollup(rows, entryById, new Map());
    assert.deepEqual(
      result.map((r) => r.distributorCode),
      ["BIG", "SMALL"],
    );
  }

  // ── Empty input → empty output.
  assert.deepEqual(computeDistributorRollup([], new Map(), new Map()), []);
}
