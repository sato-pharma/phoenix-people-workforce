import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ROI_EXPLAIN_MATCH_REASON,
  ROI_EXPLAIN_REASON_LABEL,
  classifyRoiExplainReason,
  roiExplainReasonLabel,
} from "../src/lib/marketing-requests/roi-explain.ts";

// The diagnostic classifier is the heart of the feature — cover every required case.
function testDiagnosticClassifier() {
  // High-confidence exact attributed row → attributed (actual > 0 short-circuits everything).
  assert.equal(
    classifyRoiExplainReason({ actualValue: 1476, productsTargeted: 2, productsMatched: 2, pharmaciesFound: 5, monthsCovered: 3, salesDataAsOf: "2026-06" }),
    "attributed",
  );

  // Product bridge missing → product_bridge_issue (nothing can attribute without a SoS product).
  assert.equal(
    classifyRoiExplainReason({ actualValue: 0, productsTargeted: 2, productsMatched: 0, pharmaciesFound: 3, monthsCovered: 3, salesDataAsOf: "2026-06" }),
    "product_bridge_issue",
  );

  // No validated coverage: nothing validated anywhere (salesDataAsOf null).
  assert.equal(
    classifyRoiExplainReason({ actualValue: 0, productsTargeted: 2, productsMatched: 2, pharmaciesFound: 0, monthsCovered: 0, salesDataAsOf: null }),
    "no_validated_coverage",
  );

  // Partial ROI window pending: data exists globally but none of THIS window's months are loaded.
  assert.equal(
    classifyRoiExplainReason({ actualValue: 0, productsTargeted: 2, productsMatched: 2, pharmaciesFound: 1, monthsCovered: 0, salesDataAsOf: "2026-06" }),
    "partial_data_pending",
  );

  // Missing pharmacy code: products bridge, window validated, but no target pharmacy is in SoS.
  assert.equal(
    classifyRoiExplainReason({ actualValue: 0, productsTargeted: 2, productsMatched: 2, pharmaciesFound: 0, monthsCovered: 3, salesDataAsOf: "2026-06" }),
    "missing_pharmacy_code",
  );

  // Pharmacy found but no targeted product sales: everything lines up, real zero.
  assert.equal(
    classifyRoiExplainReason({ actualValue: 0, productsTargeted: 2, productsMatched: 2, pharmaciesFound: 4, monthsCovered: 3, salesDataAsOf: "2026-06" }),
    "pharmacy_no_product_sales",
  );

  // product_bridge_issue takes precedence over a pharmacy/coverage gap when nothing bridges.
  assert.equal(
    classifyRoiExplainReason({ actualValue: 0, productsTargeted: 1, productsMatched: 0, pharmaciesFound: 0, monthsCovered: 0, salesDataAsOf: null }),
    "product_bridge_issue",
  );

  // Every reason has a distinct, human-readable label.
  const labels = Object.values(ROI_EXPLAIN_REASON_LABEL);
  assert.equal(new Set(labels).size, labels.length, "reason labels must be unique");
  assert.equal(roiExplainReasonLabel("missing_pharmacy_code"), ROI_EXPLAIN_REASON_LABEL.missing_pharmacy_code);
  assert.match(ROI_EXPLAIN_MATCH_REASON, /distributor.*pharmacy.*product.*period/i);
}

// Source-guards (repo convention): the IO service + route stay read-only and reuse the gated
// view-sales service; the route is GET-only.
function testExplainServiceIsReadOnly() {
  const service = readFileSync("src/lib/marketing-requests/roi-explain-service.ts", "utf8");
  // Reuses the access-gated, confidential-masked view-sales service (no re-implemented gate).
  assert.match(service, /getMarketingRequestViewSales\(access,/, "explain service must reuse the gated view-sales service");
  // Read-only: never writes.
  assert.doesNotMatch(service, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/, "explain service must never mutate data");
  // Delegates the reason to the pure classifier.
  assert.match(service, /classifyRoiExplainReason\(/, "explain service must classify via the pure module");
  // sos_row_id recovery is read-only and only trusted when it reconciles to the RPC actual value.
  assert.match(service, /source_of_sales_import_rows/, "ledger id recovery reads source rows");
  assert.match(
    service,
    /=== roundMarketingMoney\(viewSales\.actualValue\)/,
    "ledger id recovery must reconcile to the RPC actual value before it is adopted",
  );

  const route = readFileSync("app/api/marketing-requests/[id]/roi-explain/route.ts", "utf8");
  assert.match(route, /export async function GET\(/, "roi-explain route must expose GET");
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)\(/, "roi-explain route must be GET-only");
  assert.match(route, /explainMarketingRequestRoi\(access,/, "route must delegate to the explain service");
}

export function runMarketingRoiExplainTests() {
  testDiagnosticClassifier();
  testExplainServiceIsReadOnly();
}
