import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The sales-analytics dashboards render at TWO mounts — admin (/admin/analytics) and portal
// (/employee-portals/sales-analytics) — from ONE shared component each. Scope wiring lives in those
// shared components; auth + scope resolution lives in the thin page wrappers. This pins both halves:
//   - shared component: folds scope via scopeAnalyticsFilters, passes scoped.filters to its loader(s),
//     and CRITICALLY short-circuits on scoped.empty (the loaders treat an empty lines/regions array as
//     "no filter = all", so a viewer scoped to nothing without the guard would leak the whole company);
//   - page wrapper: resolves the viewer scope AFTER assertPermission and passes it to the dashboard.

const DASHBOARD_COMPONENTS = [
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

// Route paths under each mount root (dashboard routes only — the hub has no loaders).
const DASHBOARD_ROUTES = [
  "source-sales",
  "source-sales/by-line",
  "source-sales/by-area",
  "source-sales/by-product",
  "source-sales/by-customer",
  "monthly-closing",
  "monthly-closing/by-employee",
  "monthly-closing/by-line",
  "weekly-sales",
  "weekly-sales/detail",
  "weekly-sales/by-distributor",
  "executive-comparison",
  "reconciliation",
];

const MOUNTS: ReadonlyArray<readonly [string, string]> = [
  ["admin", "app/(admin)/admin/analytics"],
  ["portal", "app/employee-portals/sales-analytics"],
];

export function runAnalyticsScopeWiringTests() {
  // (1) Shared components — the fail-closed scope wiring.
  for (const file of DASHBOARD_COMPONENTS) {
    const src = readFileSync(`src/components/analytics/dashboards/${file}`, "utf8");
    assert.ok(src.includes("scopeAnalyticsFilters("), `${file} must fold scope into its filters`);
    assert.ok(/scoped\.empty/.test(src), `${file} must short-circuit on scoped.empty (fail-closed)`);
    assert.ok(src.includes("scoped.filters"), `${file} must pass scoped.filters to its loader(s)`);
    // The mount only changes the URL — the filter bar's basePath must be derived from mountRoot,
    // never hardcoded to /admin, so the portal never writes an /admin URL.
    assert.ok(src.includes("${mountRoot}"), `${file} must derive its basePath from mountRoot`);
    assert.ok(!/basePath="\/admin\/analytics/.test(src), `${file} must not hardcode an /admin basePath`);
  }

  // (2) Page wrappers (both mounts) — auth before scope, scope handed to the dashboard.
  for (const route of DASHBOARD_ROUTES) {
    for (const [mount, base] of MOUNTS) {
      const rel = `${base}/${route}/page.tsx`;
      const src = readFileSync(rel, "utf8");
      assert.ok(src.includes("resolveAnalyticsViewerScope(access)"), `${mount}:${route} must resolve the viewer scope`);
      assert.ok(src.includes("scope={scope}"), `${mount}:${route} must pass the resolved scope to its dashboard`);
      const permIdx = src.indexOf("assertPermission(access,");
      const scopeIdx = src.indexOf("resolveAnalyticsViewerScope(access)");
      assert.ok(permIdx > -1 && scopeIdx > permIdx, `${mount}:${route} must resolve scope AFTER assertPermission`);
    }
  }

  // (3) Hubs have no data loaders → no scoping, and must not falsely look scoped.
  for (const hub of ["app/(admin)/admin/analytics/page.tsx", "app/employee-portals/sales-analytics/page.tsx"]) {
    const src = readFileSync(hub, "utf8");
    assert.ok(!src.includes("scopeAnalyticsFilters("), `${hub} has no loaders and needs no scoping`);
  }
}
