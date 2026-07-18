import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// Every /admin/analytics DASHBOARD page must resolve the viewer's scope, fold it into the query via
// scopeAnalyticsFilters, pass scoped.filters to its loader(s), and — CRITICALLY — short-circuit to
// empty when the scope leaves nothing (scoped.empty). The loaders treat an empty lines/regions
// array as "no filter = all", so a page that scoped a viewer to nothing but forgot the
// scoped.empty guard would leak the whole company. This pins the wiring so a future page (or edit)
// that drops the guard fails here instead of shipping a scope hole.
export function runAnalyticsScopeWiringTests() {
  const dashboards = [
    "source-sales/page.tsx",
    "source-sales/by-line/page.tsx",
    "source-sales/by-area/page.tsx",
    "source-sales/by-product/page.tsx",
    "source-sales/by-customer/page.tsx",
    "monthly-closing/page.tsx",
    "monthly-closing/by-employee/page.tsx",
    "monthly-closing/by-line/page.tsx",
    "weekly-sales/page.tsx",
    "weekly-sales/detail/page.tsx",
    "weekly-sales/by-distributor/page.tsx",
    "executive-comparison/page.tsx",
    "reconciliation/page.tsx",
  ];

  for (const rel of dashboards) {
    const src = readSource(`../app/(analytics)/admin/analytics/${rel}`);
    assert.ok(src.includes("resolveAnalyticsViewerScope(access)"), `${rel} must resolve the viewer scope`);
    assert.ok(src.includes("scopeAnalyticsFilters("), `${rel} must fold scope into its filters`);
    assert.ok(/scoped\.empty/.test(src), `${rel} must short-circuit on scoped.empty (fail-closed)`);
    assert.ok(src.includes("scoped.filters"), `${rel} must pass scoped.filters to its loader(s)`);
    assert.ok(src.includes("scope={scope}"), `${rel} must pass the resolved scope to its Content component`);
    // The scope must be resolved AFTER auth (assertPermission), never before.
    const permIdx = src.indexOf("assertPermission(access,");
    const scopeIdx = src.indexOf("resolveAnalyticsViewerScope(access)");
    assert.ok(permIdx > -1 && scopeIdx > permIdx, `${rel} must resolve scope after assertPermission`);
  }

  // The hub landing page has no data loaders → it needs no scoping and must not falsely look scoped.
  const hub = readSource("../app/(analytics)/admin/analytics/page.tsx");
  assert.ok(!hub.includes("scopeAnalyticsFilters("), "hub page has no loaders and needs no scoping");
}
