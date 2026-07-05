import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { scopeBreakdownRowsToLine } from "../src/lib/sales-marketing-intelligence/service.ts";
import type {
  SalesMarketingDashboardSnapshot,
  SalesMarketingRoiComparisonRow,
} from "../src/lib/sales-marketing-intelligence/types.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// A fully-typed ROI breakdown row with sane defaults; override only what a case needs.
function row(partial: Partial<SalesMarketingRoiComparisonRow>): SalesMarketingRoiComparisonRow {
  return {
    actualRoiCoverage: 0,
    actualSalesUnits: 0,
    actualSalesValue: 0,
    behindRequests: 0,
    coverageGap: 0,
    customerCount: 0,
    exactSalesRows: 0,
    expectedRoiValue: 0,
    fallbackSalesRows: 0,
    label: "row",
    line: null,
    marketingCost: 0,
    noDataRequests: 0,
    onTrackRequests: 0,
    pharmacyCount: 0,
    requestCount: 0,
    requiredRoiValue: 0,
    value: "row",
    ...partial,
  };
}

// Only productRoi / regionRoi / distributorRoi matter to the helper; the rest of the snapshot is
// spread through untouched, so an envelope cast keeps the fixture readable.
function snapshot(parts: {
  productRoi: SalesMarketingRoiComparisonRow[];
  regionRoi: SalesMarketingRoiComparisonRow[];
  distributorRoi: SalesMarketingRoiComparisonRow[];
}): SalesMarketingDashboardSnapshot {
  return { lineRoi: [], ...parts } as unknown as SalesMarketingDashboardSnapshot;
}

// The RPC scopes the marketing-REQUEST side of each breakdown by p_lines but grafts the ACTUAL
// side on via a FULL JOIN to line-agnostic actuals fact tables. That leaked other lines'
// products / regions / distributors into a single-line viewer's ROI reports as actuals-only rows
// (requestCount === 0). scopeBreakdownRowsToLine drops them. This pins the closed leak.
export function runSalesMarketingLineScopeTests() {
  const productRoi = [
    row({ value: "P-PED-REQ", line: "Pedia", requestCount: 2 }),        // in-scope, has a request
    row({ value: "P-PED-NOREQ", line: "Pedia", requestCount: 0 }),      // in-scope line, sales but no request
    row({ value: "P-CNS-LEAK", line: "CNS", requestCount: 0 }),         // other line, actuals-only → LEAK
    row({ value: "P-BLANK-REQ", line: "Unassigned", requestCount: 1 }), // blank line but has an in-scope request
    row({ value: "P-NULL-LEAK", line: null, requestCount: 0 }),         // no line, actuals-only → LEAK
  ];
  const regionRoi = [
    row({ value: "R-IN", line: null, requestCount: 3 }),  // in-scope request footprint
    row({ value: "R-LEAK", line: null, requestCount: 0 }), // actuals-only → LEAK
  ];
  const distributorRoi = [
    row({ value: "D-IN", line: null, requestCount: 1 }),   // in-scope request footprint
    row({ value: "D-LEAK", line: null, requestCount: 0 }), // actuals-only → LEAK
  ];

  // ── Company-wide viewer (allowed === null): nothing is stripped ──
  const wide = scopeBreakdownRowsToLine(snapshot({ productRoi, regionRoi, distributorRoi }), null);
  assert.deepEqual(wide.productRoi.map((r) => r.value), productRoi.map((r) => r.value), "company-wide keeps every product");
  assert.deepEqual(wide.regionRoi.map((r) => r.value), ["R-IN", "R-LEAK"], "company-wide keeps every region");
  assert.deepEqual(wide.distributorRoi.map((r) => r.value), ["D-IN", "D-LEAK"], "company-wide keeps every distributor");

  // ── Line-bounded viewer (Pedia): other lines' actuals-only rows are dropped ──
  const scoped = scopeBreakdownRowsToLine(
    snapshot({ productRoi, regionRoi, distributorRoi }),
    new Set(["Pedia"]),
  );
  assert.deepEqual(
    scoped.productRoi.map((r) => r.value),
    ["P-PED-REQ", "P-PED-NOREQ", "P-BLANK-REQ"],
    "product: keep in-scope-line rows and any row with an in-scope request; drop other lines' actuals-only rows",
  );
  assert.deepEqual(scoped.regionRoi.map((r) => r.value), ["R-IN"], "region: keep only rows with an in-scope request footprint");
  assert.deepEqual(scoped.distributorRoi.map((r) => r.value), ["D-IN"], "distributor: keep only rows with an in-scope request footprint");

  // ── Line matching is normalized (case / whitespace insensitive) ──
  const oddCase = scopeBreakdownRowsToLine(
    snapshot({ productRoi: [row({ value: "P", line: "  PEDIA " })], regionRoi: [], distributorRoi: [] }),
    new Set(["pedia"]),
  );
  assert.deepEqual(oddCase.productRoi.map((r) => r.value), ["P"], "product line match ignores case and surrounding space");

  // ── Fail closed: an unresolved line scope (empty set) hides actuals-only rows entirely ──
  const failClosed = scopeBreakdownRowsToLine(
    snapshot({ productRoi: [row({ value: "P", line: "Pedia", requestCount: 0 })], regionRoi: [], distributorRoi: [] }),
    new Set<string>(),
  );
  assert.deepEqual(failClosed.productRoi.map((r) => r.value), [], "empty scope drops actuals-only product rows (fail closed)");

  // ── Source pin: both dashboard entry points must run the breakdown scope after product filtering ──
  const service = readSource("../src/lib/sales-marketing-intelligence/service.ts");
  assert.ok(
    (service.match(/scopeBreakdownRowsToLine\(/g) ?? []).length >= 3,
    "both live + fast dashboard paths call scopeBreakdownRowsToLine (plus its definition)",
  );
}
