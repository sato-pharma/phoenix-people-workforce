import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { adminNavigationSections, attendanceManagementPageItems } from "../src/config/system-navigation.ts";
import { notificationHrefForViewerRole } from "../src/lib/notifications/hrefs.ts";
import { payrollBatchHref, payrollBatchNotificationMetadata } from "../src/lib/payroll/links.ts";
import {
  canAccess,
  createAccessContext,
  isRolePermissionWithinHardBoundary,
  permissionActions,
  permissionMatrix,
  permissionResources,
  type PermissionResource,
} from "../src/lib/auth/permissions.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";

const ceoAllowedReadOnlyRoutes = [
  "/admin/ceo-command-center",
  "/sales",
  "/attendance",
  "/admin/people-management",
  "/admin/payroll-management",
  "/admin/outstation-expenses",
  "/admin/analytics",
  "/admin/analytics/source-sales",
  "/admin/analytics/monthly-closing",
  "/admin/marketing-roi",
] as const;

const ceoBlockedRedirectRoutes = [
  "/sales/monthly-dashboard",
] as const;

const ceoBlockedHighRiskRoutes = [
  "/employees",
  "/admin/access",
  "/admin/data-health",
  "/attendance/device-user-mapping",
  "/attendance/policies",
  "/admin/recruitment-hiring",
  "/payroll",
  "/admin/system-cleanup",
] as const;

const ceoBlockedHighRiskResources = [
  "admin",
  "employees",
  "admin_access",
  "permission_admin",
  "user_admin",
  "employee_documents",
  "recruitment",
  "candidates",
  "offers",
  "system_cleanup",
] as const satisfies readonly PermissionResource[];

function lookupForCeo(): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = permissionMatrix.CEO[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

export async function runCeoAccountContractTests() {
  const ceo = createAccessContext({ hrId: "CEO-1", role: "CEO" });
  const visibleAdminHrefs = getSections(adminNavigationSections, "admin", lookupForCeo(), "CEO")
    .flatMap((section) => section.items.map((item) => item.href));

  for (const href of ceoAllowedReadOnlyRoutes) {
    assert.equal(
      visibleAdminHrefs.includes(href),
      true,
      `CEO navigation must expose the approved read-only route ${href}`,
    );
  }

  for (const href of ceoBlockedHighRiskRoutes) {
    assert.equal(
      visibleAdminHrefs.includes(href),
      false,
      `CEO navigation must not expose the blocked high-risk route ${href}`,
    );
  }

  for (const href of ceoBlockedRedirectRoutes) {
    assert.equal(
      visibleAdminHrefs.includes(href),
      false,
      `CEO navigation must not expose redirect/bounce route ${href}`,
    );
  }

  assert.equal(await canAccess(ceo, "attendance", "read"), true, "CEO can read attendance analytics");
  assert.equal(await canAccess(ceo, "probation", "read"), true, "CEO can read probation risk");
  assert.equal(await canAccess(ceo, "contracts", "read"), true, "CEO can read contract risk");
  assert.equal(await canAccess(ceo, "payroll", "read"), true, "CEO can read payroll aggregates");
  assert.equal(await canAccess(ceo, "payslips", "read"), true, "CEO can read payslip center");

  for (const resource of ceoBlockedHighRiskResources) {
    assert.equal(
      await canAccess(ceo, resource, "read"),
      false,
      `CEO must not have direct read permission for ${resource}`,
    );
    assert.equal(
      isRolePermissionWithinHardBoundary("CEO", resource, "read"),
      false,
      `CEO must not be grantable ${resource}:read by role overrides`,
    );
  }

  const navigationSource = readFileSync("src/config/system-navigation.ts", "utf8");
  assert.match(
    navigationSource,
    /href: "\/admin\/ceo-command-center"[\s\S]{0,180}roles: \["CEO"\]/,
    "CEO sidebar command-center item must link directly to the dedicated CEO route",
  );
  // Attendance Analytics now lives behind the "Attendance Management" hub (single
  // sidebar entry at /attendance) rather than as its own top-level sidebar item —
  // check its real gate on the exported card list instead of the raw source text.
  const attendanceAnalyticsCard = attendanceManagementPageItems.find((item) => item.href === "/attendance/analytics");
  assert.ok(attendanceAnalyticsCard, "Attendance Analytics hub card must exist");
  assert.deepEqual(
    attendanceAnalyticsCard?.permissions,
    [{ resource: "attendance", action: "read" }],
    "Attendance Analytics navigation must be keyed by attendance:read, not employee-master access",
  );

  const usersRouteSource = readFileSync("app/api/admin/users/route.ts", "utf8");
  const permissionsRouteSource = readFileSync("app/api/admin/permissions/route.ts", "utf8");
  const ceoCommandCenterSource = readFileSync("src/components/admin/ceo-command-center.tsx", "utf8");
  const ceoHeroClockSource = readFileSync("src/components/admin/ceo-hero-clock.tsx", "utf8");
  const ceoPhaseBSource = readFileSync("src/components/admin/ceo-phase-b.tsx", "utf8");
  const ceoSosTablesSource = readFileSync("src/components/admin/ceo-sos-tables.tsx", "utf8");
  const notificationHrefSource = readFileSync("src/lib/notifications/hrefs.ts", "utf8");
  const inAppNotificationSource = readFileSync("src/lib/notifications/in-app.ts", "utf8");
  const notificationSystemSource = readFileSync("src/lib/notifications/system.ts", "utf8");
  const payrollUploadRouteSource = readFileSync("app/api/payroll/upload/route.ts", "utf8");
  const payrollWorkflowRouteSource = readFileSync("app/api/payroll/[id]/workflow/route.ts", "utf8");
  const payrollPageSource = readFileSync("app/(admin)/payroll/page.tsx", "utf8");
  const mPayrollPageSource = readFileSync("app/(admin)/admin/m-payroll/page.tsx", "utf8");
  const probationPageSource = readFileSync("app/(admin)/probation/page.tsx", "utf8");
  const probationTrackerSource = readFileSync("src/components/probation/probation-tracker.tsx", "utf8");
  const sidebarSource = readFileSync("src/components/layout/sidebar.tsx", "utf8");
  assert.match(usersRouteSource, /assertPermission\(access, "admin_access", "read"\)/);
  assert.match(permissionsRouteSource, /assertPermission\(access, "admin_access", "read"\)/);
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /href="\/sales\/weekly"/,
    "CEO Command Center must not link to the redirecting weekly sales route",
  );
  assert.match(
    ceoCommandCenterSource,
    /href="\/sales\/weekly\/dashboard"/,
    "CEO Command Center must link directly to the weekly sales dashboard",
  );
  assert.match(
    ceoCommandCenterSource,
    /timeZone: "Africa\/Cairo"/,
    "CEO generated-at label must use a fixed timezone to avoid server/client text drift",
  );
  assert.match(
    ceoHeroClockSource,
    /useState<Date \| null>\(null\)/,
    "CEO live clock must render the same placeholder on server and initial client render",
  );
  assert.doesNotMatch(
    ceoHeroClockSource,
    /typeof window[\s\S]{0,80}new Date\(\)/,
    "CEO live clock must not initialize client state before hydration",
  );
  assert.doesNotMatch(
    ceoPhaseBSource,
    /href: "\/payroll"/,
    "CEO Phase B smart navigation must not link to operational payroll",
  );
  assert.doesNotMatch(
    ceoPhaseBSource,
    /href: "\/sales\/weekly"/,
    "CEO Phase B smart navigation must not link to the redirecting weekly sales route",
  );
  assert.doesNotMatch(
    ceoPhaseBSource,
    /href: "\/sales\/monthly-dashboard"/,
    "CEO Phase B smart navigation must not link to the redirecting monthly sales route",
  );
  assert.match(ceoPhaseBSource, /href: "\/admin\/m-payroll"/);
  assert.match(ceoPhaseBSource, /href: "\/sales\/weekly\/dashboard"/);
  assert.match(ceoPhaseBSource, /href: "\/admin\/analytics\/monthly-closing"/);
  assert.doesNotMatch(
    ceoSosTablesSource,
    /href="\/sales\/monthly-dashboard"/,
    "CEO SoS tables must not link to the redirecting monthly sales route",
  );
  assert.match(ceoSosTablesSource, /href="\/admin\/analytics\/monthly-closing"/);
  assert.match(
    payrollPageSource,
    /access\.role === "CEO"[\s\S]{0,220}redirect\(target\)/,
    "CEO direct payroll access must redirect to the CEO payroll console",
  );
  assert.doesNotMatch(
    mPayrollPageSource,
    /\/payroll\?batchId/,
    "CEO payroll console batch links must not point back to operational payroll",
  );
  assert.match(
    mPayrollPageSource,
    /\/admin\/m-payroll\?batchId/,
    "CEO payroll console batch links must stay inside the CEO payroll console",
  );
  assert.equal(payrollBatchHref("batch 1"), "/payroll?batchId=batch%201");
  assert.equal(payrollBatchHref("batch 1", "executive"), "/admin/m-payroll?batchId=batch%201");
  assert.equal(
    notificationHrefForViewerRole({
      fallbackHref: payrollBatchHref("batch 1"),
      metadata: payrollBatchNotificationMetadata("batch 1"),
      role: "CEO",
    }),
    "/admin/m-payroll?batchId=batch%201",
    "CEO payroll notification links must resolve directly to the CEO payroll console",
  );
  assert.equal(
    notificationHrefForViewerRole({
      fallbackHref: payrollBatchHref("batch 1"),
      metadata: payrollBatchNotificationMetadata("batch 1"),
      role: "Super Admin",
    }),
    "/payroll?batchId=batch%201",
    "Operational payroll notification links must keep using the operational payroll page",
  );
  assert.match(notificationHrefSource, /roleHrefs/);
  assert.match(inAppNotificationSource, /notificationHrefForViewerRole/);
  assert.match(notificationSystemSource, /notificationHrefForViewerRole[\s\S]{0,220}ctaHref/);
  assert.match(payrollUploadRouteSource, /payrollBatchNotificationMetadata\(result\.batch\.id\)/);
  assert.match(payrollWorkflowRouteSource, /payrollBatchNotificationMetadata\(updated\.id\)/);
  assert.doesNotMatch(
    payrollUploadRouteSource,
    /ctaHref:\s*`\/payroll\?batchId=/,
    "Payroll upload notification email CTA must not hardcode the operational payroll route",
  );
  assert.doesNotMatch(
    payrollWorkflowRouteSource,
    /ctaHref:\s*`\/payroll\?batchId=/,
    "Payroll workflow notification email CTA must not hardcode the operational payroll route",
  );
  assert.equal(
    existsSync("app/(admin)/admin/m.payroll/page.tsx"),
    false,
    "Legacy dotted CEO payroll route must be removed",
  );
  assert.match(
    probationPageSource,
    /viewerMode: access\.role === "CEO" \? "executive" : "hr"/,
    "CEO probation route must pass executive read-only mode",
  );
  assert.match(probationTrackerSource, /Executive read-only/);
  assert.match(sidebarSource, /currentRole === "CEO" \? resolveLandingPathForRole\(currentRole\) : navigationHomePathByMode\[mode\]/);
  assert.match(sidebarSource, /<SidebarBrand currentRole=\{currentRole\} mode=\{navigationMode\}/);
}
