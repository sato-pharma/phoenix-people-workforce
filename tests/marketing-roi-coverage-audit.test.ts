import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  buildMarketingCoverageReportWorkbook,
  coverageCodeNames,
  describeCoverageFilters,
} from "../src/lib/export/marketing-coverage-workbook.ts";
import {
  computeCoverageRollupByDimension,
  computeCoverageTrend,
} from "../src/lib/marketing-requests/coverage-report-analytics.ts";
import { marketingRequestStatusLabel, resolveRoiDataCoverage } from "../src/lib/marketing-requests/roi-labels.ts";
import { mergePharmacyCoverage } from "../src/lib/marketing-requests/coverage-report-service.ts";
import { aggregateViewSales } from "../src/lib/marketing-requests/roi-report-service.ts";
import type {
  MarketingCoverageReportRow,
  MarketingRoiViewSalesRow,
  RoiAttributionLine,
} from "../src/lib/marketing-requests/roi-report-types.ts";
import { emptyMarketingCoverageFilterState, emptyRoiFilterState } from "../src/lib/marketing-requests/roi-report-types.ts";
import { getMarketingRoiTracker } from "../src/lib/marketing-requests/roi-tracker-service.ts";
import { META, sampleDetail, sampleReport, sampleSalesDetail } from "./marketing-coverage-export-workbook.test.ts";

// The ROI Tracker + Marketing Coverage Report audit, 2026-10-09. Every assertion here was a defect
// measured on production that day; each names the number it was.

function coverageRow(overrides: Partial<MarketingCoverageReportRow>): MarketingCoverageReportRow {
  return {
    requestId: "r",
    requestCode: "REQ-0001",
    requesterHrId: "r1",
    requesterName: "Rep One",
    line: "Pedia",
    region: "Delta",
    areaName: "Tanta",
    requesterTier: "Medical Rep",
    customerName: "Dr. Sample",
    customerId: "cust-1",
    status: "active",
    requestTypeName: "Doctor Request",
    payDate: "2026-08-01",
    roiWindow: "2026-08 → 2026-10",
    roiDurationMonths: 3,
    estimatedCost: 1000,
    expectedRoiValue: 9000,
    requiredRoiValue: 10000,
    actualSalesValue: 0,
    actualSalesUnits: 0,
    actualCoverageRatio: 0,
    forecastCoverageRatio: 0.9,
    dataCoverage: "partial_pending",
    resultStatus: "awaiting_data",
    attributionQuality: "exact_customer",
    hasSalesData: true,
    salesDataComplete: false,
    attributionGapReason: null,
    approverRoleKeys: [],
    productCodes: ["GU001"],
    distributorCodes: ["IS"],
    productNames: ["Gutrin"],
    distributorNames: ["Ibnsina"],
    pharmacyKeys: ["12345"],
    pharmacyIds: ["pharmacy-1"],
    ...overrides,
  } as MarketingCoverageReportRow;
}

function line(requestId: string, value: number): RoiAttributionLine {
  return { customerCode: "12345", distributorCode: "IS", invoicePeriod: "2026-08", productCode: "GU001", qty: 10, requestId, value };
}

function testAttributedSalesAreNeverNoData() {
  // MKT-REQ-20260915-385247AE: EGP 35,751 of September sales attributed, validated data through
  // August, and the live tracker printed "—" beside "No validated SoS data".
  assert.equal(
    resolveRoiDataCoverage({ windowStart: "2026-09", windowEnd: "2026-11", salesDataAsOf: "2026-08", hasAttributedSales: true }),
    "partial_pending",
    "a window holding attributed sales is partial — data is arriving — never 'no validated data'",
  );
  assert.equal(
    resolveRoiDataCoverage({ windowStart: "2026-09", windowEnd: "2026-11", salesDataAsOf: "2026-08", hasAttributedSales: false }),
    "no_validated_data",
    "with nothing attributed, a window past the frontier still has no data",
  );
  assert.equal(
    resolveRoiDataCoverage({ windowStart: "2026-09", windowEnd: "2026-11", salesDataAsOf: null, hasAttributedSales: true }),
    "partial_pending",
    "attributed sales are partial even when no validated period is known",
  );
}

function testBreakdownAndTrendCountASharedSaleOnce() {
  // Two campaigns in one line both claim the same 600 EGP sale. Each row is right to show it; the
  // line's total is not. Production: breakdown 45,153.88 against the deduped headline 42,433.56.
  const rows = [
    coverageRow({ requestId: "a", actualSalesValue: 600 }),
    coverageRow({ requestId: "b", actualSalesValue: 600 }),
  ];
  const lines = [line("a", 600), line("b", 600)];
  const [pedia] = computeCoverageRollupByDimension(rows, "line", lines);
  assert.equal(pedia.totalActualValue, 600, "one sale claimed by two campaigns in the same line is 600, not 1,200");
  const [august] = computeCoverageTrend(rows, lines);
  assert.equal(august.totalActualValue, 600, "the monthly trend counts it once too");
  assert.equal(
    computeCoverageRollupByDimension(rows, "line")[0].totalActualValue,
    1200,
    "without the ledger the plain sum is what remains — the default is not a dedupe",
  );
  // Different buckets never deduct from each other.
  const split = computeCoverageRollupByDimension(
    [coverageRow({ requestId: "a", actualSalesValue: 600, line: "Pedia" }), coverageRow({ requestId: "b", actualSalesValue: 600, line: "CNS" })],
    "line",
    lines,
  );
  assert.deepEqual(split.map((bucket) => bucket.totalActualValue).sort(), [600, 600], "each line keeps its own claim");
}

async function testWorkbookTotalIsTheDedupedHeadline() {
  const report = sampleReport();
  report.kpi = { ...report.kpi, totalActualValue: 9000 };
  const buffer = await buildMarketingCoverageReportWorkbook({ report, detail: sampleDetail(), salesDetail: sampleSalesDetail(), meta: META });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheet = book.getWorksheet("Requests");
  assert.ok(sheet, "Requests sheet");
  let total: unknown = null;
  sheet!.eachRow((row) => {
    if (row.getCell(1).value === "TOTAL") total = row.getCell(14).value;
  });
  assert.equal(total, 9000, "the actual-sales TOTAL is the page's deduped headline, not the column added up");
  const cover = book.getWorksheet("Cover");
  let exportedBy: unknown = null;
  cover!.eachRow((row) => {
    row.eachCell((cell, column) => {
      if (cell.value === "Exported by") exportedBy = row.getCell(column + 1).value;
    });
  });
  assert.equal(exportedBy, META.exportedByName, "the cover names the exporter, never 'name (HR id)'");
}

async function testWorkbookPrintsProductAndDistributorNames() {
  // Owner, 2026-10-09: "fix the Coverage workbook's product and distributor columns to show names".
  // The Requests sheet printed GU001 / IS, Target Pharmacies printed IS, and the cover's filter line
  // printed the selected codes.
  const report = sampleReport();
  const buffer = await buildMarketingCoverageReportWorkbook({ report, detail: sampleDetail(), salesDetail: sampleSalesDetail(), meta: META });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const cellsUnder = (sheetName: string, header: string): unknown[] => {
    const sheet = book.getWorksheet(sheetName);
    assert.ok(sheet, `${sheetName} sheet`);
    let column = 0;
    const values: unknown[] = [];
    sheet!.eachRow((row) => {
      if (column === 0) {
        row.eachCell((cell, index) => {
          if (cell.value === header) column = index;
        });
        return;
      }
      const value = row.getCell(column).value;
      if (value !== null && value !== undefined && row.getCell(1).value !== "TOTAL") values.push(value);
    });
    assert.ok(column > 0, `${sheetName} has a ${header} column`);
    return values;
  };
  assert.deepEqual(cellsUnder("Requests", "Products"), ["Gutrin"], "the Requests sheet names its products, never GU001");
  assert.deepEqual(cellsUnder("Requests", "Distributors"), ["Ibnsina"], "the Requests sheet names its distributors, never IS");
  assert.deepEqual(cellsUnder("Target Pharmacies", "Distributor"), ["Ibnsina", "Ibnsina"], "each target pharmacy names its distributor");
  assert.deepEqual(cellsUnder("Sales Detail", "Distributor"), ["Ibnsina"], "the sales detail names its distributor");

  const filters = { ...emptyMarketingCoverageFilterState(), product: ["GU001"], distributor: ["IS"] };
  const described = describeCoverageFilters(filters, coverageCodeNames(report.rows));
  assert.match(described, /Product: Gutrin/, "the cover's filter line names the product");
  assert.match(described, /Distributor: Ibnsina/, "the cover's filter line names the distributor");
  assert.doesNotMatch(described, /GU001|: IS(?![A-Za-z])/, "no code survives on the cover");
}

function testViewSalesNeverAddsUnitsAcrossProducts() {
  const sale = (productCode: string, qty: number, invoicePeriod = "2026-08"): MarketingRoiViewSalesRow => ({
    customerCode: "12345",
    customerName: "Pharmacy One",
    distributorCode: "IS",
    distributorName: "Ibnsina",
    invoicePeriod,
    productCode,
    productName: productCode,
    qty,
    regionName: null,
    value: qty * 10,
  });
  const rows = [sale("TB040", 100), sale("TB080", 50), sale("TB040", 20, "2026-09")];
  const byMonth = aggregateViewSales(rows, (row) => ({ key: row.invoicePeriod, label: row.invoicePeriod }));
  const august = byMonth.find((bucket) => bucket.key === "2026-08");
  const september = byMonth.find((bucket) => bucket.key === "2026-09");
  assert.equal(august?.units, null, "August sold two concentrations — it has no unit total");
  assert.equal(august?.value, 1500, "its value still adds");
  assert.equal(september?.units, 20, "one product in a bucket keeps its units");
  const byProduct = aggregateViewSales(rows, (row) => ({ key: row.productCode, label: row.productName }));
  assert.equal(byProduct.find((bucket) => bucket.key === "TB040")?.units, 120, "per product, units always add");
  // The Coverage drill-down's pharmacy row carries the same null through — never a 0 or a sum.
  const byPharmacy = aggregateViewSales(rows, (row) => ({ key: row.customerCode, label: row.customerName ?? row.customerCode }));
  const [pharmacy] = mergePharmacyCoverage(
    [{ code: "12345", name: "Pharmacy One" }],
    new Map(byPharmacy.map((bucket) => [bucket.key, bucket] as const)),
    new Map(),
    new Map(),
  );
  assert.equal(pharmacy.salesUnits, null, "a pharmacy that bought two concentrations has no unit total");
  assert.equal(pharmacy.salesValue, 1700, "its value still adds");
}

async function testFinanceManagerCannotReadTheArchivedExcelSet() {
  // Owner, 2026-08-11: revoked. The page redirected him; the API answered anyone.
  await assert.rejects(
    getMarketingRoiTracker(
      { hrId: "F-1", loginId: "finance", role: "Finance Manager" } as Parameters<typeof getMarketingRoiTracker>[0],
      emptyRoiFilterState(),
      "2026-10-09T09:00:00.000Z",
      "xlsx_import",
    ),
    /^Error: Forbidden:/,
    "the Finance Manager is refused the archived Excel ROI set at the API, before any read",
  );
}

function testStatusLabelsAreShared() {
  assert.equal(marketingRequestStatusLabel("cancelled"), "Cancelled", "the Coverage workbook had no 'cancelled' and printed the raw word");
  assert.equal(marketingRequestStatusLabel("finance_hold"), "Finance hold");
  assert.equal(marketingRequestStatusLabel("not_a_status"), "Unknown status", "never the raw enum");
}

function testSourcePins() {
  const coverage = readFileSync("src/lib/marketing-requests/coverage-report-service.ts", "utf8");
  assert.match(
    coverage,
    /status: resolveRoiStatusScope\(filters\.status\)/,
    "the Coverage Report applies the ROI report's default status scope (approved money) — 276,057 vs 138,107 EGP of cost without it",
  );
  assert.match(
    coverage,
    /\.filter\(\(requestId\) => !withheldRequestIds\.has\(requestId\)\)/,
    "the ledger leaves out WITHHELD rows (which add 0), never the degraded rows that carry real actuals",
  );
  assert.match(
    coverage,
    /entries\.some\(\(entry\) => entry\.requestId === requestId\)/,
    "the pharmacy drill-down is admitted by the Coverage index, not by View Sales' wider ROI scope",
  );
  const tracker = readFileSync("src/components/marketing-requests/marketing-roi-live-tracker.tsx", "utf8");
  assert.match(
    tracker,
    /status: \[\.\.\.ROI_LIVE_TRACKER_STATUSES\]/,
    "the live tracker names its statuses — an empty list is approved-only, which hid 27 of 52 requests",
  );
  const viewSales = readFileSync("src/lib/marketing-requests/roi-report-service.ts", "utf8");
  assert.match(
    viewSales,
    /visible = territoryRouteAdmitsRequest\(scope,/,
    "View Sales admits a rep's territory rows by the same area-AND-line rule the report uses",
  );
  const pm = readFileSync("src/lib/employee-360/pm-marketing.ts", "utf8");
  assert.match(pm, /buildKpiBand\(rows, report\.kpi\.salesDataAsOf, 0, report\.attributionLines\)/, "the PM card dedupes shared sales");
}

export async function runMarketingRoiCoverageAuditTests() {
  testAttributedSalesAreNeverNoData();
  testBreakdownAndTrendCountASharedSaleOnce();
  await testWorkbookTotalIsTheDedupedHeadline();
  await testWorkbookPrintsProductAndDistributorNames();
  testViewSalesNeverAddsUnitsAcrossProducts();
  await testFinanceManagerCannotReadTheArchivedExcelSet();
  testStatusLabelsAreShared();
  testSourcePins();
}
