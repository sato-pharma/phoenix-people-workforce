import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { buildMarketingCoverageReportWorkbook, describeCoverageFilters } from "../src/lib/export/marketing-coverage-workbook.ts";
import { emptyMarketingCoverageFilterState } from "../src/lib/marketing-requests/roi-report-types.ts";
import type {
  MarketingCoverageExportSalesDetailRow,
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
      actualsDegraded: { count: 0, requestIds: [] },
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

function sampleSalesDetail(): MarketingCoverageExportSalesDetailRow[] {
  return [
    // Only "Pharmacy One" (12345) has a matched sale — "Pharmacy Two" (67890) has none,
    // and must simply be absent here (its zero is already recorded in Target Pharmacies).
    {
      requestId: "r1",
      requestCode: "REQ-0001",
      customerCode: "12345",
      distributorCode: "IS",
      distributorName: "Ibnsina",
      productCode: "GU001",
      productName: "Gutrin",
      invoicePeriod: "2026-03",
      qty: 40,
      value: 12000,
    },
  ];
}

export async function runMarketingCoverageExportWorkbookTests() {
  assert.match(describeCoverageFilters({ ...emptyMarketingCoverageFilterState(), area: ["Cairo"] }), /Area: Cairo/);
  assert.match(describeCoverageFilters(emptyMarketingCoverageFilterState()), /No filters applied/);

  const buffer = await buildMarketingCoverageReportWorkbook({
    report: sampleReport(),
    detail: sampleDetail(),
    salesDetail: sampleSalesDetail(),
    meta: META,
  });
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

  // ── Status column carries real Excel conditional formatting (Approved/Rejected/Pending),
  //    not just a static fill — matches the on-screen green/red/yellow badge. ExcelJS's
  //    read-back doesn't preserve a separate `text` field for containsText rules (Excel's
  //    XML embeds it only inside the SEARCH() formula), so assert against `formulae` instead.
  const conditionalFormattings =
    (requestSheet as unknown as { conditionalFormattings?: Array<{ ref: string; rules: Array<{ formulae?: string[]; style?: { fill?: { bgColor?: { argb?: string } } } }> }> })
      .conditionalFormattings ?? [];
  const statusColIndex = requestHeaders.indexOf("Status") + 1;
  const statusColLetter = requestSheet!.getColumn(statusColIndex).letter;
  const statusFormat = conditionalFormattings.find((cf) => cf.ref.startsWith(`${statusColLetter}3:`));
  assert.ok(statusFormat, "Status column must have a conditional-formatting rule set starting at row 3 (first data row)");
  const ruleFormulae = statusFormat!.rules.map((rule) => rule.formulae?.[0] ?? "");
  assert.ok(ruleFormulae.some((f) => f.includes('"Approved"')));
  assert.ok(ruleFormulae.some((f) => f.includes('"Rejected"')));
  assert.ok(ruleFormulae.some((f) => f.includes('"Pending"')), "one rule matches both Pending validation and Pending approval via containsText");
  // ── The 3 fill colors are Excel's own built-in Good/Bad/Neutral palette (green/red/yellow).
  const fillColors = statusFormat!.rules.map((rule) => rule.style?.fill?.bgColor?.argb);
  assert.deepEqual(fillColors, ["FFC6EFCE", "FFFFC7CE", "FFFFEB9C"], "green (Approved), red (Rejected), yellow (Pending), in that priority order");

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

  // ── Sales Detail sheet: one row per matched sale, pharmacy name resolved via
  //    detail.pharmacies (never a third lookup query) — and the zero-sales pharmacy has
  //    no row here (its zero already lives in Target Pharmacies, never fabricated here).
  // Filters by string-typed cell values (not row index) — same robust pattern as the
  // Target Pharmacies check above, so the trailing note row (which only ever sets column 1,
  // leaving column 2 an untyped empty cell) can never be mistaken for a data row.
  const salesDetailSheet = readBack.getWorksheet("Sales Detail");
  assert.ok(salesDetailSheet, "workbook must contain a Sales Detail sheet");
  const salesDetailPharmacyNames: string[] = [];
  const salesDetailProductNames: string[] = [];
  salesDetailSheet!.eachRow((sheetRow) => {
    const pharmacy = sheetRow.getCell(2).value;
    const product = sheetRow.getCell(5).value;
    if (typeof pharmacy === "string" && typeof product === "string") {
      salesDetailPharmacyNames.push(pharmacy);
      salesDetailProductNames.push(product);
    }
  });
  assert.ok(
    salesDetailPharmacyNames.includes("Pharmacy One"),
    "resolved from detail.pharmacies by (requestId, customerCode)",
  );
  assert.ok(salesDetailProductNames.includes("Gutrin"));
  assert.ok(
    !salesDetailPharmacyNames.includes("Pharmacy Two (no sales)"),
    "the zero-sales pharmacy must never get a fabricated Sales Detail row",
  );
}
