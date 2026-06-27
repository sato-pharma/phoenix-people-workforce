import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  const sidebarSource = readFileSync("src/components/layout/sidebar.tsx", "utf8");
  assert.match(usersRouteSource, /assertPermission\(access, "admin_access", "read"\)/);
  assert.match(permissionsRouteSource, /assertPermission\(access, "admin_access", "read"\)/);
  assert.match(sidebarSource, /currentRole === "CEO" \? resolveLandingPathForRole\(currentRole\) : navigationHomePathByMode\[mode\]/);
  assert.match(sidebarSource, /<SidebarBrand currentRole=\{currentRole\} mode=\{navigationMode\}/);
}
