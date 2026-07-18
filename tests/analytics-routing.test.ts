import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Separate-URL routing for the sales-analytics module (owner security directive: portal/employee
// roles must NOT reach analytics through an /admin URL). Two mounts render the SAME shared dashboards:
//   - admin  : app/(admin)/admin/analytics/*         — admin shell + portal bounce (the (admin) layout)
//   - portal : app/employee-portals/sales-analytics/* — portal shell (the employee-portal layout)
// There is no middleware, so each page's assertPermission is the boundary; the portal Executive
// Comparison + Reconciliation pages additionally gate on canViewPortalDetailedAnalytics (tile matrix:
// Medical Rep + District Manager get the core three only).

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

const PERM = /assertPermission\(access,\s*"(sales|weekly_sales)",\s*"read"\)/;

export function runAnalyticsRoutingTests() {
  // (1) Admin mount — every dashboard + hub exists and enforces assertPermission. Living in the
  //     (admin) group means the group layout supplies the admin shell AND bounces portal users.
  for (const route of [...DASHBOARD_ROUTES, ""]) {
    const rel = `app/(admin)/admin/analytics/${route ? route + "/" : ""}page.tsx`;
    const src = readFileSync(rel, "utf8");
    assert.ok(PERM.test(src), `${rel} must enforce assertPermission (sole boundary — no middleware)`);
  }

  // (2) Portal mount — every dashboard + hub exists, enforces assertPermission, mounts at the portal
  //     root (never /admin), and does not reference the /admin analytics URL space.
  for (const route of [...DASHBOARD_ROUTES, ""]) {
    const rel = `app/employee-portals/sales-analytics/${route ? route + "/" : ""}page.tsx`;
    const src = readFileSync(rel, "utf8");
    assert.ok(PERM.test(src), `${rel} must enforce assertPermission`);
    if (route) {
      assert.ok(
        src.includes('mountRoot="/employee-portals/sales-analytics"'),
        `${rel} must mount its dashboard at the portal root`,
      );
      assert.ok(!src.includes("/admin/analytics"), `${rel} must not reference an /admin analytics URL`);
    }
  }

  // (3) The two DETAILED-tier portal pages gate Medical Rep / District Manager out and send them to the hub.
  for (const route of ["executive-comparison", "reconciliation"]) {
    const src = readFileSync(`app/employee-portals/sales-analytics/${route}/page.tsx`, "utf8");
    assert.ok(
      src.includes("canViewPortalDetailedAnalytics(access.role)"),
      `portal ${route} must gate on canViewPortalDetailedAnalytics`,
    );
    assert.ok(
      src.includes('redirect("/employee-portals/sales-analytics")'),
      `portal ${route} must redirect non-detailed roles back to the hub`,
    );
  }

  // (4) The (admin) group layout must still bounce portal-mode users — it now also guards /admin/analytics.
  const adminLayout = readFileSync("app/(admin)/layout.tsx", "utf8");
  assert.ok(
    adminLayout.includes('resolveNavigationMode(access) === "employee-portal"') &&
      adminLayout.includes('redirect("/employee-portals")'),
    "(admin) group layout must still redirect portal-mode users away from the admin shell",
  );

  // (5) Portal sidebar links to the PORTAL analytics module (never into /admin), for every sales role.
  const nav = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
  assert.ok(
    /showSalesAnalyticsTab:[\s\S]*isMedicalRep[\s\S]*isDistrictManager[\s\S]*Regional Manager[\s\S]*isNationalSalesManager[\s\S]*isProductManager[\s\S]*isGroupProductManager[\s\S]*isMarketingManager/.test(nav),
    "showSalesAnalyticsTab must be enabled for every sales portal role (MR/DSM/RM/NSM/PM/GPM/MM)",
  );
  const layout = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  assert.ok(
    layout.includes('showSalesAnalyticsTab ? [{ href: "/employee-portals/sales-analytics"'),
    "portal sidebar must link Sales Analytics to /employee-portals/sales-analytics",
  );
  assert.ok(
    !layout.includes('href: "/admin/analytics"'),
    "portal sidebar must not link into the /admin analytics URL space",
  );

  // (6) The dual shell was removed entirely (superseded by the separate-URL design).
  let dualShellExists = true;
  try {
    readFileSync("src/components/analytics/analytics-dual-shell.tsx", "utf8");
  } catch {
    dualShellExists = false;
  }
  assert.ok(!dualShellExists, "AnalyticsDualShell must be deleted (separate-URL design supersedes dual-mode)");
}
