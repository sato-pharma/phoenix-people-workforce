import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AnalyticsDimensions } from "../src/lib/analytics/service.ts";
import {
  computeAnalyticsFilterVisibility,
  scopeAnalyticsDimensions,
  type AnalyticsViewerScope,
} from "../src/lib/analytics/scope.ts";

const company: AnalyticsViewerScope = { canViewAllSales: true, allowedLineNames: null, allowedRegionCodes: null, allowedProductCodes: null };
const oneLine: AnalyticsViewerScope = { canViewAllSales: false, allowedLineNames: new Set(["Pedia"]), allowedRegionCodes: null, allowedProductCodes: null };
const twoLines: AnalyticsViewerScope = { canViewAllSales: false, allowedLineNames: new Set(["Pedia", "CNS"]), allowedRegionCodes: null, allowedProductCodes: null };
const oneRegion: AnalyticsViewerScope = { canViewAllSales: false, allowedLineNames: null, allowedRegionCodes: new Set(["CAI"]), allowedProductCodes: null };

const DIMS: AnalyticsDimensions = {
  periods: [],
  weeks: [],
  distributors: [{ code: "D1", name: "Dist One" }],
  lines: ["Pedia", "CNS", "Anti infective"],
  families: ["FamA", "FamB"],
  regions: [{ code: "CAI", name: "Cairo" }, { code: "GIZ", name: "Giza" }],
  areas: [
    { areaCode: "A1", areaName: "Area 1", regionCode: "CAI", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area 2", regionCode: "GIZ", regionName: "Giza" },
  ],
  products: [
    { code: "P1", name: "Prod 1", line: "Pedia", family: "FamA" },
    { code: "P2", name: "Prod 2", line: "CNS", family: "FamB" },
  ],
};

export function runAnalyticsFilterContextualizationTests() {
  // ── computeAnalyticsFilterVisibility ────────────────────────────────────────
  assert.deepEqual(computeAnalyticsFilterVisibility(company), { line: true, region: true }, "company sees both pickers");
  assert.equal(computeAnalyticsFilterVisibility(oneLine).line, false, "single-line viewer: hide Line picker");
  assert.equal(computeAnalyticsFilterVisibility(oneLine).region, true, "single-line viewer keeps Region picker");
  assert.equal(computeAnalyticsFilterVisibility(twoLines).line, true, "2+ lines: keep Line picker");
  assert.equal(computeAnalyticsFilterVisibility(oneRegion).region, false, "single-region viewer: hide Region picker");

  // ── scopeAnalyticsDimensions ────────────────────────────────────────────────
  assert.equal(scopeAnalyticsDimensions(DIMS, company), DIMS, "company gets the full (same) dimensions");

  const byLine = scopeAnalyticsDimensions(DIMS, oneLine);
  assert.deepEqual(byLine.lines, ["Pedia"], "line-scoped: lines trimmed to the viewer's line");
  assert.deepEqual(byLine.products.map((p) => p.code), ["P1"], "line-scoped: products trimmed to the line");
  assert.deepEqual(byLine.families, ["FamA"], "line-scoped: families re-derived from the trimmed products");
  assert.equal(byLine.regions.length, 2, "line-only scope does not trim regions");

  const byRegion = scopeAnalyticsDimensions(DIMS, oneRegion);
  assert.deepEqual(byRegion.regions.map((r) => r.code), ["CAI"], "region-scoped: regions trimmed");
  assert.deepEqual(byRegion.areas.map((a) => a.areaCode), ["A1"], "region-scoped: areas trimmed to in-scope regions");
  assert.equal(byRegion.lines.length, 3, "region-only scope does not trim lines");

  // ── Source-pin: every shared dashboard contextualises its filter bar ─────────
  // The filter bar lives in the shared dashboard component (rendered at both the admin and portal
  // mounts), so the pin reads those components rather than the thin page wrappers.
  const dashboardComponents = [
    "source-sales-dashboard.tsx",
    "source-sales-by-line-dashboard.tsx",
    "source-sales-by-area-dashboard.tsx",
    "source-sales-by-product-dashboard.tsx",
    "source-sales-by-customer-dashboard.tsx",
    "monthly-closing-dashboard.tsx",
    "monthly-closing-by-employee-dashboard.tsx",
    "monthly-closing-by-line-dashboard.tsx",
    "weekly-sales-dashboard.tsx",
    "weekly-sales-detail-dashboard.tsx",
    "weekly-sales-by-distributor-dashboard.tsx",
    "executive-comparison-dashboard.tsx",
    "reconciliation-dashboard.tsx",
  ];
  for (const file of dashboardComponents) {
    const src = readFileSync(`src/components/analytics/dashboards/${file}`, "utf8");
    assert.ok(src.includes("scopeAnalyticsDimensions(dimensions, scope)"), `${file} must trim its filter dropdowns to scope`);
    assert.ok(src.includes("computeAnalyticsFilterVisibility(scope)"), `${file} must pass per-viewer filter visibility`);
    // The raw, untrimmed dimensions must NOT reach the filter bar.
    assert.ok(!/dimensions=\{dimensions\}/.test(src), `${file} must not pass raw (untrimmed) dimensions to the filter bar`);
  }
}
