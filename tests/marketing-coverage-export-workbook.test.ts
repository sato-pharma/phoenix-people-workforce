import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { buildMarketingCoverageReportWorkbook, describeCoverageFilters } from "../src/lib/export/marketing-coverage-workbook.ts";
import { emptyMarketingCoverageFilterState } from "../src/lib/marketing-requests/roi-report-types.ts";
import type {
  MarketingCoverageReport,
  MarketingRoiExportDetail,
} from "../src/lib/marketing-requests/roi-report-types.ts";

const META = {
  exportedByName: "A-9",
  exportedByHrId: "A-9",
  role: "CEO",
  exportId: "00000000-0000-0000-0000-000000000002",
  generatedAtIso: "2026-07-04T10:00:00.000Z",
};

function isXlsx(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  return bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function sampleReport(): MarketingCoverageReport {
  return {
    rows: [
      {
        requestId: "r1",
        requestCode: "REQ-0001",
        requesterHrId: "b-157",
        requesterName: "Line NSM",
        line: "Anti Inf",
        region: "Delta",
        areaName: "Cairo",
        requesterTier: "National Sales Manager",
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
        actualSalesValue: 12000,
        actualSalesUnits: 40,
        actualCoverageRatio: 1.2,
        forecastCoverageRatio: 0.9,
        dataCoverage: "complete",
        resultStatus: "on_track",
        attributionQuality: "exact_customer",
        hasSalesData: true,
        salesDataComplete: true,
        attributionGapReason: null,
        approverRoleKeys: ["National Sales Manager"],
        productCodes: ["GU001"],
        distributorCodes: ["IS"],
        pharmacyKeys: ["12345", "67890"],
      },
    ],
    kpi: {
      requestCount: 1,
      totalEstimatedCost: 1000,
      totalExpectedRoi: 9000,
      totalRequiredRoi: 10000,
      totalActualValue: 12000,
      coverageRatio: 1.2,
      onTrackCount: 1,
      behindCount: 0,
      awaitingDataCount: 0,
      noDataCount: 0,
      approvedValue: 12000,
      pendingValue: 0,
      salesDataAsOf: "2026-05",
      incompleteWindowCount: 0,
      restrictedExcludedCount: 0,
      distinctPharmacyCount: 2,
      distinctCustomerCount: 1,
    },
    appliedFilters: { ...emptyMarketingCoverageFilterState(), area: ["Cairo"] },
    autoAppliedByDimension: {},
    includedRestricted: false,
    generatedAtIso: META.generatedAtIso,
    distributorRollup: [],
  };
}

function sampleDetail(): MarketingRoiExportDetail {
  return {
    products: [],
    pharmacies: [
      // The zero-sales pharmacy must appear in the export exactly like every other
      // target — this list is bulk-loaded from marketing_request_pharmacies, not
      // filtered by attribution, so it can never silently omit one.
      { requestId: "r1", requestCode: "REQ-0001", pharmacyName: "Pharmacy One", customerCode: "12345", distributorCode: "IS", trackingStatus: "active" },
      { requestId: "r1", requestCode: "REQ-0001", pharmacyName: "Pharmacy Two (no sales)", customerCode: "67890", distributorCode: "IS", trackingStatus: "active" },
    ],
    approvals: [],
  };
}

export async function runMarketingCoverageExportWorkbookTests() {
  assert.match(describeCoverageFilters({ ...emptyMarketingCoverageFilterState(), area: ["Cairo"] }), /Area: Cairo/);
  assert.match(describeCoverageFilters(emptyMarketingCoverageFilterState()), /No filters applied/);

  const buffer = await buildMarketingCoverageReportWorkbook({ report: sampleReport(), detail: sampleDetail(), meta: META });
  assert.ok(isXlsx(buffer), "coverage report workbook must be a valid .xlsx (zip) buffer");

  const readBack = new ExcelJS.Workbook();
  await readBack.xlsx.load(buffer);

  // ── Cover sheet carries the 2 KPI counts unique to this report.
  const coverSheet = readBack.getWorksheet("Cover");
  assert.ok(coverSheet, "workbook must contain a Cover sheet");
  const coverText = coverSheet!
    .getSheetValues()
    .flat()
    .filter((value): value is string => typeof value === "string")
    .join(" | ");
  assert.match(coverText, /Distinct target pharmacies/);
  assert.match(coverText, /Distinct customers/);

  // ── Requests sheet carries the requester-tier + area columns.
  const requestSheet = readBack.getWorksheet("Requests");
  assert.ok(requestSheet, "workbook must contain a Requests sheet");
  const requestHeaderRow = requestSheet!.getRow(2).values as unknown[];
  const requestHeaders = requestHeaderRow.filter((value): value is string => typeof value === "string");
  assert.ok(requestHeaders.includes("Requester tier"));
  assert.ok(requestHeaders.includes("Area"));

  // ── Target Pharmacies sheet includes BOTH pharmacies from detail.pharmacies —
  //    the zero-sales one must never be silently dropped from the export either.
  const pharmacySheet = readBack.getWorksheet("Target Pharmacies");
  assert.ok(pharmacySheet, "workbook must contain a Target Pharmacies sheet");
  const pharmacyNames: string[] = [];
  pharmacySheet!.eachRow((sheetRow) => {
    const value = sheetRow.getCell(2).value;
    if (typeof value === "string") pharmacyNames.push(value);
  });
  assert.ok(pharmacyNames.includes("Pharmacy One"));
  assert.ok(pharmacyNames.includes("Pharmacy Two (no sales)"), "the zero-sales pharmacy must still appear in the export");
}
