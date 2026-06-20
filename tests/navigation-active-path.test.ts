import assert from "node:assert/strict";

import {
  getActiveHref,
  getSections,
  isActivePath,
  permissionAllowed,
  type PermissionLookup,
  roleAllowed,
  roleNotExcluded,
} from "../src/lib/navigation/active-path.ts";
import {
  adminNavigationSections,
  employeePortalNavigationSections,
  type NavigationSection,
  type NavigationSectionItem,
} from "../src/config/system-navigation.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

// Minimal typed fixture builders — the matcher functions only read href/exact/
// activeTab/permissions/roles/excludedRoles, so we synthesise items without real
// lucide icons while keeping role/permission fields type-checked.
function item(href: string, extra: Partial<NavigationSectionItem> = {}): NavigationSectionItem {
  return { href, label: href, ...extra } as unknown as NavigationSectionItem;
}
function section(id: string, items: NavigationSectionItem[]): NavigationSection {
  return { id, label: id, items } as unknown as NavigationSection;
}

function lookupForRole(role: PhoenixRole): PermissionLookup {
  const rolePermissions = permissionMatrix[role];
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = rolePermissions[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

function adminHrefsFor(role: PhoenixRole): string[] {
  return getSections(adminNavigationSections, "admin", lookupForRole(role), role)
    .flatMap((navSection) => navSection.items.map((navItem) => navItem.href));
}

function employeePortalHrefsFor(role: PhoenixRole): string[] {
  return getSections(employeePortalNavigationSections, "employee-portal", lookupForRole(role), role)
    .flatMap((navSection) => navSection.items.map((navItem) => navItem.href));
}

function assertIncludesAll(actual: readonly string[], expected: readonly string[], message: string) {
  for (const href of expected) {
    assert.equal(actual.includes(href), true, `${message}: expected ${href}`);
  }
}

function assertExcludesAll(actual: readonly string[], expected: readonly string[], message: string) {
  for (const href of expected) {
    assert.equal(actual.includes(href), false, `${message}: unexpected ${href}`);
  }
}

export function runNavigationActivePathTests() {
  // ── isActivePath: default prefix matching ──────────────────────────────────
  assert.equal(isActivePath("/employees", item("/employees"), null), true);
  assert.equal(isActivePath("/employees/123", item("/employees"), null), true);
  assert.equal(isActivePath("/employees-archive", item("/employees"), null), false);
  assert.equal(isActivePath("/other", item("/employees"), null), false);

  // ── isActivePath: exact blocks child routes ────────────────────────────────
  assert.equal(isActivePath("/sales", item("/sales", { exact: true }), null), true);
  assert.equal(isActivePath("/sales/import", item("/sales", { exact: true }), null), false);
  assert.equal(isActivePath("/payroll/expenses", item("/payroll", { exact: true }), null), false);

  // ── isActivePath: activeTab gating (two items share a path, differ by tab) ──
  const manualExpense = item("/admin/outstation/requests?action=create-manager-expense", {
    activeTab: "create-manager-expense",
  });
  assert.equal(isActivePath("/admin/outstation/requests", manualExpense, "create-manager-expense"), true);
  assert.equal(isActivePath("/admin/outstation/requests", manualExpense, null), false);
  assert.equal(isActivePath("/admin/outstation/requests", manualExpense, "other"), false);

  // ── getActiveHref: longest exact base wins; prefix bleed is prevented ───────
  const navSections = [
    section("payroll", [
      item("/payroll", { exact: true }),
      item("/payroll/expenses", { exact: true }),
      item("/payroll/expenses/dashboard"),
    ]),
  ];
  assert.equal(getActiveHref("/payroll", navSections, null), "/payroll");
  assert.equal(getActiveHref("/payroll/expenses", navSections, null), "/payroll/expenses");
  assert.equal(getActiveHref("/payroll/expenses/dashboard", navSections, null), "/payroll/expenses/dashboard");
  assert.equal(getActiveHref("/unknown", navSections, null), null);

  // ── permissionAllowed: undefined permission / lookup defaults to allow ──────
  assert.equal(permissionAllowed(undefined, undefined), true);
  assert.equal(permissionAllowed({}, [{ resource: "sales" }]), true); // key absent → allow
  assert.equal(permissionAllowed({ "sales:read": false }, [{ resource: "sales" }]), false);
  assert.equal(permissionAllowed({ "sales:read": true }, [{ resource: "sales" }]), true);
  assert.equal(permissionAllowed({ "sales:update": false }, [{ resource: "sales", action: "update" }]), false);
  // "some" semantics: any allowed permission grants visibility.
  assert.equal(
    permissionAllowed({ "sales:read": false, "payroll:read": true }, [{ resource: "sales" }, { resource: "payroll" }]),
    true,
  );

  // ── roleAllowed ────────────────────────────────────────────────────────────
  assert.equal(roleAllowed("Super Admin", undefined), true);
  assert.equal(roleAllowed("Super Admin", ["Super Admin"]), true);
  assert.equal(roleAllowed("Talent Acquisition", ["Super Admin"]), false);
  assert.equal(roleAllowed(undefined, ["Super Admin"]), false);

  // ── roleNotExcluded ────────────────────────────────────────────────────────
  assert.equal(roleNotExcluded("Medical Rep", undefined), true);
  assert.equal(roleNotExcluded("Training Manager", ["Training Manager"]), false);
  assert.equal(roleNotExcluded("Medical Rep", ["Training Manager"]), true);
  assert.equal(roleNotExcluded(undefined, ["Training Manager"]), true);

  // ── getSections: permission/role/excludedRole filtering + empty-section drop ─
  const sections = [
    section("a", [
      item("/sales", { permissions: [{ resource: "sales" }] }),
      item("/admin/access", { roles: ["Super Admin"] }),
    ]),
    section("b", [item("/employee-portals/sales", { excludedRoles: ["Training Manager"] })]),
  ];

  // Super Admin with sales blocked: sales item filtered, access item kept.
  const superAdminAdmin = getSections(sections, "admin", { "sales:read": false }, "Super Admin");
  assert.equal(superAdminAdmin.length, 2);
  assert.deepEqual(
    superAdminAdmin[0].items.map((i) => i.href),
    ["/admin/access"],
  );

  // Talent Acquisition: access item (Super Admin only) filtered out of section a.
  const talentAcquisition = getSections(sections, "admin", {}, "Talent Acquisition");
  assert.deepEqual(
    talentAcquisition[0].items.map((i) => i.href),
    ["/sales"],
  );

  // excludedRoles only applies in employee-portal mode.
  const tmPortal = getSections(sections, "employee-portal", {}, "Training Manager");
  assert.equal(
    tmPortal.find((s) => s.id === "b"),
    undefined,
    "employee-portal: excluded role drops the item, emptying section b",
  );
  const tmAdmin = getSections(sections, "admin", {}, "Training Manager");
  assert.equal(
    tmAdmin.find((s) => s.id === "b")?.items.length,
    1,
    "admin mode: excludedRoles ignored, item retained",
  );

  const superAdminCleanupNav = getSections(
    adminNavigationSections,
    "admin",
    { "system_cleanup:read": false },
    "Super Admin",
  );
  assert.equal(
    superAdminCleanupNav.some((navSection) =>
      navSection.items.some((navItem) => navItem.href === "/admin/system-cleanup"),
    ),
    true,
    "Super Admin must see the System Cleanup sidebar tab even if the dynamic permission cache is stale",
  );

  const ceoCleanupNav = getSections(
    adminNavigationSections,
    "admin",
    { "system_cleanup:read": true },
    "CEO",
  );
  assert.equal(
    ceoCleanupNav.some((navSection) =>
      navSection.items.some((navItem) => navItem.href === "/admin/system-cleanup"),
    ),
    false,
    "CEO must not see the System Cleanup sidebar tab even if a permission lookup grants system_cleanup",
  );

  const sensitiveHrHrefs = [
    "/employees",
    "/admin/support-requests",
    "/recruitment",
    "/cv-database",
    "/offers",
    "/hiring-documents",
    "/leave-management/vacation-control",
  ] as const;
  const systemAdministratorOnlyHrefs = [
    "/attendance/exceptions",
    "/leave-management/vacation-action-center",
    "/payroll/expenses/dashboard",
    "/payroll/expenses",
    "/admin/marketing-requests/control",
  ] as const;

  const marketingManagerAdmin = adminHrefsFor("Marketing Manager");
  // De-duplicated: the Marketing Manager works out of its single /workspace home, never the
  // org-wide /admin duplicates of the same modules.
  assertIncludesAll(
    marketingManagerAdmin,
    ["/workspace/plans", "/workspace/marketing-requests"],
    "Marketing Manager plans + marketing requests live in the /workspace home",
  );
  assertExcludesAll(
    marketingManagerAdmin,
    [
      "/admin/weekly-plans",
      "/admin/marketing-requests",
      "/admin/marketing-requests/inbox",
      "/admin/marketing-requests/roi-tracking",
      "/workspace/incentive",
      "/leave-management/vacation-request",
      "/leave-management/vacation-report",
      ...sensitiveHrHrefs,
      ...systemAdministratorOnlyHrefs,
      "/payroll",
    ],
    "A-9 / Marketing Manager must not see admin authority modules or /admin duplicates of its workspace",
  );

  const talentAcquisitionAdmin = adminHrefsFor("Talent Acquisition");
  assertIncludesAll(
    talentAcquisitionAdmin,
    ["/admin/support-requests", "/recruitment", "/cv-database", "/offers", "/hiring-documents", "/leave-management/vacation-control"],
    "Talent Acquisition must see HR-owned admin modules",
  );
  assertExcludesAll(talentAcquisitionAdmin, ["/employees", "/payroll"], "Talent Acquisition must not see non-owned company modules");
  assertExcludesAll(talentAcquisitionAdmin, systemAdministratorOnlyHrefs, "Talent Acquisition must not see system-administrator-only modules");

  const financeAdmin = adminHrefsFor("Finance Manager");
  assertIncludesAll(financeAdmin, ["/payroll"], "Finance Manager must see payroll ownership");
  assertExcludesAll(financeAdmin, [...sensitiveHrHrefs, ...systemAdministratorOnlyHrefs], "Finance Manager must not see HR-owned or owner-only modules");

  const ceoAdmin = adminHrefsFor("CEO");
  assertIncludesAll(ceoAdmin, ["/payroll"], "CEO must keep read-only payroll reporting");
  assertExcludesAll(ceoAdmin, [...sensitiveHrHrefs, ...systemAdministratorOnlyHrefs], "CEO must not see HR-owned or owner-only modules");

  const superAdminAuthorityNav = adminHrefsFor("Super Admin");
  assertIncludesAll(
    superAdminAuthorityNav,
    [...sensitiveHrHrefs, ...systemAdministratorOnlyHrefs, "/payroll"],
    "Super Admin must see full governance modules",
  );
  assertIncludesAll(superAdminAuthorityNav, ["/sales"], "Sales Dashboard must stay visible in sales navigation");
  assertExcludesAll(
    superAdminAuthorityNav,
    ["/sales/import"],
    "Legacy Source of Sales import route must be hidden from visible sidebar navigation",
  );

  const employeeAdmin = adminHrefsFor("Employee");
  assertExcludesAll(employeeAdmin, [...sensitiveHrHrefs, ...systemAdministratorOnlyHrefs, "/payroll"], "Employee must not see admin-shell authority modules");

  for (const role of ["District Manager", "Regional Manager", "National Sales Manager", "Manager", "Finance Manager"] as const) {
    assertExcludesAll(
      employeePortalHrefsFor(role),
      ["/leave-management/vacation-action-center"],
      `${role} must not see the system-administrator-only Vacation Action Center in the employee portal`,
    );
  }
}
