import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildMarketingRoiReportWorkbook,
  buildMarketingRoiViewSalesWorkbook,
  describeRoiFilters,
} from "../src/lib/export/marketing-roi-workbook.ts";
import { emptyRoiFilterState } from "../src/lib/marketing-requests/roi-report-types.ts";
import type {
  MarketingRoiExportDetail,
  MarketingRoiReport,
  MarketingRoiViewSales,
} from "../src/lib/marketing-requests/roi-report-types.ts";

const META = {
  exportedByName: "A-9",
  exportedByHrId: "A-9",
  role: "CEO",
  exportId: "00000000-0000-0000-0000-000000000001",
  generatedAtIso: "2026-06-20T10:00:00.000Z",
};

function isXlsx(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  // .xlsx is a zip → first two bytes are 'P' 'K' (0x50 0x4B)
  return bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function sampleReport(): MarketingRoiReport {
  return {
    rows: [
      {
        requestId: "r1",
        requestCode: "REQ-0001",
        requesterHrId: "b-157",
        requesterName: "Line NSM",
        line: "Anti Inf",
        region: "Delta",
        customerName: "Dr. Sample",
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
    },
    appliedFilters: { ...emptyRoiFilterState(), line: ["Anti Inf"] },
    // No shared claims in this fixture: one request, so nothing to deduct. The field is required
    // rather than optional precisely so a caller that rebuilds the KPI band has to decide what the
    // claimed-line ledger is — defaulting it to empty is what let the ROI pages read ~52% high.
    attributionLines: [],
    autoAppliedByDimension: {},
    includedRestricted: false,
    generatedAtIso: META.generatedAtIso,
  };
}

function sampleDetail(): MarketingRoiExportDetail {
  return {
    products: [
      { requestId: "r1", requestCode: "REQ-0001", productCode: "GU001", productName: "Guamusin", line: "Anti Inf", factoryPrice: 60.75, forecastQty: 100, expectedValue: 6075, valueShare: 0.6 },
    ],
    pharmacies: [
      { requestId: "r1", requestCode: "REQ-0001", pharmacyName: "Pharmacy One", customerCode: "12345", distributorCode: "IS", trackingStatus: "active" },
    ],
    approvals: [
      { requestId: "r1", requestCode: "REQ-0001", sequence: 1, stepName: "NSM Approval", assignedRole: "National Sales Manager", assignedHrId: "B-157", status: "approved", decisionByHrId: "B-157", decisionAt: "2026-03-02T09:00:00.000Z", decisionNote: "ok", isCc: false },
    ],
  };
}

function sampleViewSales(): MarketingRoiViewSales {
  return {
    context: {
      requestId: "r1",
      requestCode: "REQ-0001",
      customerName: "Dr. Sample",
      requesterHrId: "b-157",
      requesterName: "Line NSM",
      line: "Anti Inf",
      status: "approved",
      requestTypeName: "Doctor Request",
      payDate: "2026-03-01",
      roiDurationMonths: 3,
      roiWindowLabel: "2026-03 → 2026-05",
      estimatedCost: 1000,
      expectedRoiValue: 9000,
      requiredRoiValue: 10000,
      products: [{ code: "GU001", name: "Guamusin" }],
      pharmacies: [{ code: "12345", name: "Pharmacy One" }],
      approverRoleKeys: ["National Sales Manager"],
    },
    range: { from: "2026-03", to: "2026-05", isCustom: false },
    rows: [
      { distributorCode: "IS", distributorName: "Ibn Sina", invoicePeriod: "2026-03", productCode: "GU001", productName: "Guamusin", customerCode: "12345", customerName: "Pharmacy One", regionName: "Delta", qty: 40, value: 12000 },
    ],
    totals: { value: 12000, units: 40, rows: 1 },
    actualValue: 12000,
    coverageRatio: 1.2,
    byMonth: [{ key: "2026-03", label: "2026-03", value: 12000, units: 40 }],
    byProduct: [{ key: "GU001", label: "Guamusin", value: 12000, units: 40 }],
    byPharmacy: [{ key: "12345", label: "Pharmacy One", value: 12000, units: 40 }],
    matrix: [{ customerCode: "12345", customerName: "Pharmacy One", productCode: "GU001", productName: "Guamusin", period: "2026-03", value: 12000, units: 40 }],
    reverseLookup: [],
    includedRestricted: false,
    salesDataAsOf: "2026-05",
    generatedAtIso: META.generatedAtIso,
  };
}

export async function runMarketingRoiExportWorkbookTests() {
  // describeRoiFilters
  assert.match(describeRoiFilters({ ...emptyRoiFilterState(), line: ["Anti Inf"], includeRestricted: true }), /Line: Anti Inf/);
  assert.match(describeRoiFilters({ ...emptyRoiFilterState(), line: ["Anti Inf"], includeRestricted: true }), /confidential/i);
  assert.match(describeRoiFilters(emptyRoiFilterState()), /No filters applied/);

  // report workbook builds a valid xlsx
  const reportBuffer = await buildMarketingRoiReportWorkbook({ report: sampleReport(), detail: sampleDetail(), meta: META });
  assert.ok(isXlsx(reportBuffer), "report workbook must be a valid .xlsx (zip) buffer");

  // view-sales workbook builds a valid xlsx
  const viewBuffer = await buildMarketingRoiViewSalesWorkbook({ data: sampleViewSales(), meta: META });
  assert.ok(isXlsx(viewBuffer), "view-sales workbook must be a valid .xlsx (zip) buffer");

  // Products must always export by NAME — the "Matched Sales" sheet must never carry a raw
  // product-code column (the in-app table already only shows the name).
  const readBack = new ExcelJS.Workbook();
  await readBack.xlsx.load(viewBuffer);
  const matchedSheet = readBack.getWorksheet("Matched Sales");
  assert.ok(matchedSheet, "workbook must contain a Matched Sales sheet");
  const headerRow = matchedSheet!.getRow(2).values as unknown[]; // row 1 is the title banner, row 2 is headers
  const headerLabels = headerRow.filter((value): value is string => typeof value === "string");
  assert.ok(headerLabels.includes("Product"), "Matched Sales sheet must have a Product (name) column");
  assert.ok(!headerLabels.includes("Product code"), "Matched Sales sheet must never expose a raw product-code column");
}
