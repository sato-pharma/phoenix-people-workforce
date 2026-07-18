import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Phase 3 (dual-mode routing) source pins. The sales-analytics dashboards were moved OUT of the
// `(admin)` route group into `(analytics)` so portal-nav sales roles can reach them, the portal
// bounce was removed from each page, and each page now renders its own chrome via AnalyticsDualShell.
// These are structural assertions — they guarantee the go-live transformation stayed intact and,
// crucially, that removing the group layout did NOT remove the per-page permission boundary.

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ANALYTICS_PAGES = [
  "page.tsx",
  "executive-comparison/page.tsx",
  "reconciliation/page.tsx",
  "monthly-closing/page.tsx",
  "monthly-closing/by-employee/page.tsx",
  "monthly-closing/by-line/page.tsx",
  "source-sales/page.tsx",
  "source-sales/by-area/page.tsx",
  "source-sales/by-customer/page.tsx",
  "source-sales/by-line/page.tsx",
  "source-sales/by-product/page.tsx",
  "weekly-sales/page.tsx",
  "weekly-sales/detail/page.tsx",
  "weekly-sales/by-distributor/page.tsx",
];

export function runAnalyticsRoutingTests() {
  for (const rel of ANALYTICS_PAGES) {
    // The pages must now live at the NEW (analytics) group path. readSource throws if the file is
    // not there — that failure IS the assertion that the route move happened for every page.
    const src = readSource(`../app/(analytics)/admin/analytics/${rel}`);

    // 1. SECURITY: with the group layout gone, each page's own assertPermission is the ONLY gate
    //    (there is no middleware). It must still be present and still require read access.
    assert.ok(
      /assertPermission\(access,\s*"(sales|weekly_sales)",\s*"read"\)/.test(src),
      `${rel}: must still enforce assertPermission(sales|weekly_sales, read) — it is the sole boundary`,
    );

    // 2. The portal bounce must be gone (it is what blocked field roles from their scoped analytics).
    assert.ok(
      !src.includes('redirect("/employee-portals")'),
      `${rel}: must no longer redirect portal users to /employee-portals`,
    );
    assert.ok(
      !src.includes("resolveNavigationMode"),
      `${rel}: resolveNavigationMode (only used by the removed bounce) must be fully removed`,
    );

    // 3. Each page now renders its own chrome via the shared dual shell.
    assert.ok(
      src.includes("<AnalyticsDualShell access={access}>"),
      `${rel}: must wrap its content in <AnalyticsDualShell access={access}>`,
    );
    assert.ok(
      src.includes('from "@/components/analytics/analytics-dual-shell"'),
      `${rel}: must import AnalyticsDualShell`,
    );
  }

  // The (admin) group layout MUST still bounce portal-mode users — it guards payroll / HR / the rest
  // of the admin surface. Moving analytics out must not have weakened that guard.
  const adminLayout = readSource("../app/(admin)/layout.tsx");
  assert.ok(
    adminLayout.includes('resolveNavigationMode(access) === "employee-portal"') &&
      adminLayout.includes('redirect("/employee-portals")'),
    "(admin) group layout must still redirect portal-mode users away from the admin shell",
  );

  // The dual shell selects the chrome by navigation mode and can render either surface.
  const shell = readSource("../src/components/analytics/analytics-dual-shell.tsx");
  assert.ok(
    shell.includes("resolveNavigationMode(access)"),
    "AnalyticsDualShell must branch on the viewer's navigation mode",
  );
  assert.ok(
    shell.includes("EmployeePortalServerShell") && shell.includes("AppShell"),
    "AnalyticsDualShell must be able to render both the portal shell and the admin AppShell",
  );

  // Portal nav surfaces the module for the initial go-live audience (line-scoped managers).
  const nav = readSource("../src/lib/employee-portal/navigation.ts");
  assert.ok(
    /showSalesAnalyticsTab:[\s\S]*isNationalSalesManager[\s\S]*isProductManager[\s\S]*isGroupProductManager[\s\S]*isMarketingManager/.test(nav),
    "resolveEmployeePortalNavVisibility must enable showSalesAnalyticsTab for NSM / PM / GPM / MM",
  );
  const portalLayout = readSource("../src/components/employee-portal/employee-portal-layout.tsx");
  assert.ok(
    portalLayout.includes('showSalesAnalyticsTab ? [{ href: "/admin/analytics"'),
    "portal sidebar must add the /admin/analytics link gated by showSalesAnalyticsTab",
  );
}
