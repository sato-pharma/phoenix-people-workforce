import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ROI_MAIN_PROBLEM_LABEL,
  ROI_NEXT_ACTION_LABEL,
  SIMPLE_ROI_STATUS_LABEL,
  buildRoiBusinessRow,
  groupRoiRowsByCustomer,
  groupRoiRowsByRequester,
  resolveMainProblemFallback,
  resolveMainProblemFromExplainReason,
  resolveNextAction,
} from "../src/lib/marketing-requests/roi-business-report.ts";
import type { MarketingRoiReportRow } from "../src/lib/marketing-requests/roi-report-types.ts";

function row(overrides: Partial<MarketingRoiReportRow>): MarketingRoiReportRow {
  return {
    actualCoverageRatio: 0,
    actualSalesUnits: 0,
    actualSalesValue: 0,
    approverRoleKeys: [],
    attributionGapReason: null,
    attributionQuality: "no_sales",
    customerName: "Dr. Sample",
    dataCoverage: "complete",
    distributorCodes: ["IS"],
    estimatedCost: 1000,
    expectedRoiValue: 9000,
    forecastCoverageRatio: 0.9,
    hasSalesData: false,
    line: "Anti Inf",
    payDate: "2026-04-01",
    productCodes: ["GU001"],
    region: "Delta",
    requestCode: "REQ-0001",
    requestId: "r1",
    requestTypeName: "Doctor Request",
    requesterHrId: "b-157",
    requesterName: "Line NSM",
    requiredRoiValue: 10000,
    resultStatus: "no_data",
    roiDurationMonths: 3,
    roiWindow: "2026-04 → 2026-06",
    salesDataComplete: true,
    status: "approved",
    ...overrides,
  };
}

function testMainProblemFallback() {
  assert.deepEqual(resolveMainProblemFallback(row({ dataCoverage: "partial_pending" })), { problem: "data_pending", status: "data_pending" });
  assert.deepEqual(resolveMainProblemFallback(row({ dataCoverage: "no_validated_data" })), { problem: "no_validated_sos_data", status: "data_pending" });
  assert.deepEqual(
    resolveMainProblemFallback(row({ dataCoverage: "complete", distributorCodes: [], hasSalesData: false })),
    { problem: "pharmacy_code_missing", status: "needs_review" },
  );
  assert.deepEqual(
    resolveMainProblemFallback(row({ dataCoverage: "complete", distributorCodes: ["IS"], hasSalesData: false, productCodes: [] })),
    { problem: "product_mapping_issue", status: "needs_review" },
  );
  assert.deepEqual(
    resolveMainProblemFallback(row({ dataCoverage: "complete", hasSalesData: false, distributorCodes: ["IS"], productCodes: ["GU001"] })),
    { problem: "no_sales_for_target_products", status: "no_sales" },
  );
  assert.deepEqual(
    resolveMainProblemFallback(row({ dataCoverage: "complete", hasSalesData: true, actualSalesValue: 12000, requiredRoiValue: 10000 })),
    { problem: "sales_found", status: "good" },
  );
  assert.deepEqual(
    resolveMainProblemFallback(row({ dataCoverage: "complete", hasSalesData: true, actualSalesValue: 4000, requiredRoiValue: 10000 })),
    { problem: "sales_found", status: "behind" },
  );
}

function testMainProblemFromExplainReason() {
  const base = row({});
  assert.deepEqual(resolveMainProblemFromExplainReason("missing_pharmacy_code", base), { problem: "pharmacy_code_missing", status: "needs_review" });
  assert.deepEqual(resolveMainProblemFromExplainReason("product_bridge_issue", base), { problem: "product_mapping_issue", status: "needs_review" });
  assert.deepEqual(resolveMainProblemFromExplainReason("pharmacy_no_product_sales", base), { problem: "no_sales_for_target_products", status: "no_sales" });
  assert.deepEqual(resolveMainProblemFromExplainReason("no_validated_coverage", base), { problem: "no_validated_sos_data", status: "data_pending" });
  assert.deepEqual(resolveMainProblemFromExplainReason("partial_data_pending", base), { problem: "data_pending", status: "data_pending" });
  assert.deepEqual(
    resolveMainProblemFromExplainReason("attributed", row({ actualSalesValue: 12000, requiredRoiValue: 10000 })),
    { problem: "sales_found", status: "good" },
  );
  assert.deepEqual(
    resolveMainProblemFromExplainReason("attributed", row({ actualSalesValue: 4000, requiredRoiValue: 10000 })),
    { problem: "sales_found", status: "behind" },
  );
}

function testNextAction() {
  assert.equal(resolveNextAction("sales_found"), "no_action");
  assert.equal(resolveNextAction("data_pending"), "wait_for_next_sos_upload");
  assert.equal(resolveNextAction("no_validated_sos_data"), "wait_for_next_sos_upload");
  assert.equal(resolveNextAction("pharmacy_code_missing"), "review_pharmacy_code");
  assert.equal(resolveNextAction("product_mapping_issue"), "review_product_mapping");
  assert.equal(resolveNextAction("no_sales_for_target_products"), "investigate_low_sales");
}

function testBuildRoiBusinessRow() {
  // No explain reason fetched (row already had sales) → falls back to bulk classification.
  const withSales = buildRoiBusinessRow(
    row({ actualSalesValue: 12000, dataCoverage: "complete", hasSalesData: true, requiredRoiValue: 10000 }),
    null,
  );
  assert.equal(withSales.simpleStatus, "good");
  assert.equal(withSales.mainProblem, "sales_found");
  assert.equal(withSales.nextAction, "no_action");
  assert.equal(withSales.explainReason, null);
  // the row's own fields must still be present (composition, not replacement)
  assert.equal(withSales.requestCode, "REQ-0001");

  // Explain reason fetched (zero-sales row) → takes precedence over the coarser fallback.
  const missingPharmacy = buildRoiBusinessRow(row({ dataCoverage: "complete", distributorCodes: ["IS"], hasSalesData: false }), "missing_pharmacy_code");
  assert.equal(missingPharmacy.mainProblem, "pharmacy_code_missing");
  assert.equal(missingPharmacy.simpleStatus, "needs_review");
  assert.equal(missingPharmacy.nextAction, "review_pharmacy_code");
  assert.equal(missingPharmacy.explainReason, "missing_pharmacy_code");
}

function testGroupByRequester() {
  const rows = [
    row({ requestCode: "REQ-1", requesterHrId: "b-157", requesterName: "Omar" }),
    row({ requestCode: "REQ-2", requesterHrId: "b-157", requesterName: "Omar" }),
    row({ requestCode: "REQ-3", requesterHrId: "a-9", requesterName: "Amina" }),
  ];
  const requesters = groupRoiRowsByRequester(rows);
  assert.equal(requesters.length, 2, "deduped to distinct requesters");
  assert.deepEqual(requesters.map((r) => r.name), ["Amina", "Omar"], "sorted by name");
  assert.equal(requesters.find((r) => r.hrId === "b-157")?.requestCount, 2);
  assert.equal(requesters.find((r) => r.hrId === "a-9")?.requestCount, 1);

  // null requesterName falls back to the HR_ID so the dropdown never shows "null".
  const noName = groupRoiRowsByRequester([row({ requesterHrId: "c-1", requesterName: null })]);
  assert.equal(noName[0].name, "c-1");
}

function testGroupByCustomer() {
  const rows = [
    row({ customerName: "Dr. Sample", requestCode: "REQ-1" }),
    row({ customerName: "Dr. Sample", requestCode: "REQ-2" }),
    row({ customerName: "Al Salam Pharmacy", requestCode: "REQ-3" }),
  ];
  const customers = groupRoiRowsByCustomer(rows);
  assert.equal(customers.length, 2, "deduped to distinct customers");
  assert.deepEqual(customers.map((c) => c.name), ["Al Salam Pharmacy", "Dr. Sample"], "sorted by name");
  assert.equal(customers.find((c) => c.name === "Dr. Sample")?.requestCount, 2);
}

// Every business enum value must have a wired, non-technical display label.
function testLabelCoverage() {
  for (const status of ["good", "behind", "data_pending", "no_sales", "needs_review"] as const) {
    assert.ok(SIMPLE_ROI_STATUS_LABEL[status], `missing label for status ${status}`);
    assert.doesNotMatch(SIMPLE_ROI_STATUS_LABEL[status], /_/, "status labels must be business wording, not snake_case");
  }
  for (const problem of [
    "data_pending",
    "no_validated_sos_data",
    "pharmacy_code_missing",
    "no_sales_for_target_products",
    "product_mapping_issue",
    "sales_found",
  ] as const) {
    assert.ok(ROI_MAIN_PROBLEM_LABEL[problem], `missing label for problem ${problem}`);
    assert.doesNotMatch(ROI_MAIN_PROBLEM_LABEL[problem], /_/, "problem labels must be business wording");
  }
  for (const action of [
    "no_action",
    "wait_for_next_sos_upload",
    "review_pharmacy_code",
    "review_product_mapping",
    "investigate_low_sales",
  ] as const) {
    assert.ok(ROI_NEXT_ACTION_LABEL[action], `missing label for action ${action}`);
    assert.doesNotMatch(ROI_NEXT_ACTION_LABEL[action], /_/, "next-action labels must be business wording");
  }
}

// Source-level guards on the new page/component/service — the technical enum names and
// sos_row_id must never leak into the always-visible main table.
function testSurfaceSourceGuards() {
  const workspace = readFileSync("src/components/marketing-requests/marketing-roi-report-workspace.tsx", "utf8");
  assert.match(workspace, /SIMPLE_ROI_STATUS_LABEL|ROI_MAIN_PROBLEM_LABEL|ROI_NEXT_ACTION_LABEL/, "workspace must render via the business label maps");
  assert.doesNotMatch(workspace, /"pharmacy_no_product_sales"|"no_validated_coverage"|"partial_data_pending"/, "raw explain-reason enum values must not be rendered as literal strings");
  // the ledger (and its sos_row_id column) must be inside a collapsible <details>, collapsed by default
  const detailsIndex = workspace.indexOf("<details");
  const sosRowIdIndex = workspace.indexOf("sosRowId");
  assert.ok(detailsIndex >= 0, "detail view must wrap the ledger in a collapsible <details> element");
  assert.ok(sosRowIdIndex > detailsIndex, "sosRowId must only render inside the collapsed <details> block");
  assert.doesNotMatch(workspace, /<details[^>]*\sopen\b/, "the Explain ROI ledger must be collapsed by default (no `open` attribute)");
  // Products must always render by name — never the raw Source-of-Sales product code.
  assert.match(workspace, /\{ledgerRow\.productName\}/, "the ledger must render the product NAME, never the code");
  assert.doesNotMatch(workspace, /\{ledgerRow\.productCode\}/, "the ledger must never render the raw product code");

  const service = readFileSync("src/lib/marketing-requests/roi-business-report-service.ts", "utf8");
  assert.match(service, /getMarketingRoiReport\(/, "service must reuse the existing ROI report service, not reimplement attribution");
  assert.match(service, /explainMarketingRequestRoi\(/, "service must reuse the existing Explain ROI service for the precise diagnostic");
  assert.doesNotMatch(service, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/, "service must be strictly read-only");

  const route = readFileSync("app/api/marketing-requests/roi-business-report/route.ts", "utf8");
  assert.match(route, /export async function GET/, "route must be read-only (GET)");
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/, "route must not expose any mutating method");
}

export function runMarketingRoiBusinessReportTests() {
  testMainProblemFallback();
  testMainProblemFromExplainReason();
  testNextAction();
  testBuildRoiBusinessRow();
  testGroupByRequester();
  testGroupByCustomer();
  testLabelCoverage();
  testSurfaceSourceGuards();
}
