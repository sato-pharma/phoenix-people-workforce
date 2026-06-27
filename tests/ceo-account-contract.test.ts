import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { adminNavigationSections } from "../src/config/system-navigation.ts";
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
  "/attendance/analytics",
  "/probation",
  "/contracts",
  "/resignations",
  "/admin/m-payroll",
  "/admin/payslips-center",
  "/admin/outstation/expense-command",
  "/admin/analytics",
  "/admin/marketing-requests/roi-tracking",
] as const;

const ceoBlockedHighRiskRoutes = [
  "/employees",
  "/admin/access",
  "/admin/data-health",
  "/attendance/device-user-mapping",
  "/attendance/policies",
  "/recruitment",
  "/cv-database",
  "/offers",
  "/hiring-documents",
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
  assert.match(
    navigationSource,
    /href: "\/attendance\/analytics"[\s\S]{0,120}permissions: \[\{ resource: "attendance", action: "read" \}\]/,
    "Attendance Analytics navigation must be keyed by attendance:read, not employee-master access",
  );
  assert.doesNotMatch(
    navigationSource,
    /href: "\/attendance\/analytics"[\s\S]{0,120}resource: "employees"/,
    "Attendance Analytics navigation must not depend on employees:read",
  );

  const usersRouteSource = readFileSync("app/api/admin/users/route.ts", "utf8");
  const permissionsRouteSource = readFileSync("app/api/admin/permissions/route.ts", "utf8");
  const ceoCommandCenterSource = readFileSync("src/components/admin/ceo-command-center.tsx", "utf8");
  const ceoPhaseBSource = readFileSync("src/components/admin/ceo-phase-b.tsx", "utf8");
  const ceoSosTablesSource = readFileSync("src/components/admin/ceo-sos-tables.tsx", "utf8");
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
