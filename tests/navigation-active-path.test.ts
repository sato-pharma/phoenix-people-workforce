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
  payrollManagementPageItems,
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
    tmAdmin.find((s) => s.id === "b"),
    undefined,
    "admin mode: excludedRoles also drops the item, emptying section b",
  );

  // System Cleanup (and the other Super-Admin-only tools) moved behind the consolidated
  // "Admin Tools" sidebar button — /admin/admin-tools is now the entry point that must stay
  // robust to a stale/wrong permission-cache read, since it's role-gated (not permission-gated).
  const superAdminCleanupNav = getSections(
    adminNavigationSections,
    "admin",
    { "admin:read": false },
    "Super Admin",
  );
  assert.equal(
    superAdminCleanupNav.some((navSection) =>
      navSection.items.some((navItem) => navItem.href === "/admin/admin-tools"),
    ),
    true,
    "Super Admin must see the Admin Tools sidebar tab even if the dynamic permission cache is stale",
  );

  const ceoCleanupNav = getSections(
    adminNavigationSections,
    "admin",
    { "admin:read": true },
    "CEO",
  );
  assert.equal(
    ceoCleanupNav.some((navSection) =>
      navSection.items.some((navItem) => navItem.href === "/admin/admin-tools"),
    ),
    false,
    "CEO must not see the Admin Tools sidebar tab even if a permission lookup grants admin",
  );

  const ceoPayrollTools = payrollManagementPageItems.filter(
    (item) => roleNotExcluded("CEO", item.excludedRoles),
  );
  assert.deepEqual(
    ceoPayrollTools.filter(
      (item) => item.href.includes("payroll-copilot") || item.href === "/admin/deductions-governance",
    ).map((item) => item.href),
    [],
    "CEO payroll navigation must hide Copilot, Insurance Wages, and Deductions Governance",
  );

  const ceoExecutiveNav = getSections(adminNavigationSections, "admin", { "probation:read": true, "organogram:read": true }, "CEO");
  assert.equal(
    ceoExecutiveNav.find((section) => section.id === "command-center")?.items.map((item) => item.href).join(","),
    "/admin/ceo-command-center,/organogram",
    "CEO command center section must include Organogram as a separate executive tab",
  );
  assert.equal(
    ceoExecutiveNav.some((section) => section.items.some((item) => item.href === "/admin/ceo-probation")),
    true,
    "CEO must see the consolidated Probation sidebar button",
  );
  assert.equal(
    ceoExecutiveNav.some((section) => section.items.some((item) => item.href === "/probation/dashboard")),
    false,
    "CEO must not see the individual probation modules as separate sidebar links",
  );

  // Note: /admin/people-management deliberately isn't in this list — unlike the
  // other consolidated hubs, several of its cards (Vacancies Report, Contract
  // Renewal, Resignations) have no role restriction, so e.g. Finance Manager
  // legitimately reaches the hub even though Employees/Weekly Plans/HR Support
  // Requests within it stay Super-Admin/Talent-Acquisition-only via their own
  // per-card gates. "Other Approvals" moved to the sidebar's Approvals Hub
  // section, and Organogram/Probation/Workforce Compliance moved to direct
  // sidebar links under People Management — none are cards here anymore.
  const sensitiveHrHrefs = ["/admin/recruitment-hiring"] as const;
  // /admin/outstation-expenses and /leave-management moved off this list — both
  // are shared with Finance Manager/CEO now (Outstation Expenses / Leave
  // Management hubs), not Super-Admin/Talent-Acquisition-exclusive.
  const systemAdministratorOnlyHrefs = ["/admin/admin-tools"] as const;

  const marketingManagerPortal = employeePortalHrefsFor("Marketing Manager");
  // Marketing Manager works from the employee portal like PM/GPM, not the admin workspace shell.
  assertIncludesAll(
    marketingManagerPortal,
    [
      "/employee-portals",
      "/employee-portals/source-of-sales",
      "/employee-portals/plans",
      "/employee-portals/organogram",
      "/employee-portals/vacancies",
      "/employee-portals/probation",
      "/employee-portals/marketing-requests",
      "/employee-portals/marketing-requests/inbox",
    ],
    "Marketing Manager reports and marketing requests live in the employee portal",
  );
  assertExcludesAll(
    marketingManagerPortal,
    [
      "/workspace",
      "/workspace/plans",
      "/workspace/marketing-requests",
      "/admin/weekly-plans",
      "/admin/marketing-requests",
      "/admin/marketing-requests/inbox",
      "/admin/marketing-requests/roi-tracking",
      // Retired from the employee-portal sidebar/catalog now that Coverage Report covers the
      // same ground; the underlying page/permission stay live for direct-URL access.
      "/employee-portals/marketing-requests/roi-tracking",
      "/employee-portals/marketing-requests/control",
      "/workspace/incentive",
      ...sensitiveHrHrefs,
      ...systemAdministratorOnlyHrefs,
      "/payroll",
    ],
    "A-9 / Marketing Manager must not see admin authority modules or workspace/admin duplicates",
  );

  const talentAcquisitionAdmin = adminHrefsFor("Talent Acquisition");
  assertIncludesAll(
    talentAcquisitionAdmin,
    ["/admin/people-management", "/admin/recruitment-hiring", "/leave-management"],
    "Talent Acquisition must see HR-owned admin modules",
  );
  assertExcludesAll(talentAcquisitionAdmin, ["/employees", "/payroll"], "Talent Acquisition must not see non-owned company modules");
  assertExcludesAll(talentAcquisitionAdmin, systemAdministratorOnlyHrefs, "Talent Acquisition must not see system-administrator-only modules");

  const financeAdmin = adminHrefsFor("Finance Manager");
  assertIncludesAll(financeAdmin, ["/admin/payroll-management"], "Finance Manager must see payroll ownership");
  assertExcludesAll(financeAdmin, [...sensitiveHrHrefs, ...systemAdministratorOnlyHrefs], "Finance Manager must not see HR-owned or owner-only modules");

  const ceoAdmin = adminHrefsFor("CEO");
  assertIncludesAll(
    ceoAdmin,
    ["/attendance", "/admin/people-management", "/admin/payroll-management"],
    "CEO must keep read-only executive module access",
  );
  assertExcludesAll(ceoAdmin, [...sensitiveHrHrefs, ...systemAdministratorOnlyHrefs], "CEO must not see HR-owned or owner-only modules");

  const superAdminAuthorityNav = adminHrefsFor("Super Admin");
  assertIncludesAll(
    superAdminAuthorityNav,
    [
      ...sensitiveHrHrefs,
      ...systemAdministratorOnlyHrefs,
      "/admin/payroll-management",
      "/admin/marketing-roi",
      "/admin/people-management",
      "/admin/outstation-expenses",
      "/admin/field-coaching",
      "/leave-management",
    ],
    "Super Admin must see full governance modules",
  );
  assertIncludesAll(superAdminAuthorityNav, ["/admin/analytics"], "Sales Analytics Hub must stay visible in sales navigation");
  assertIncludesAll(
    superAdminAuthorityNav,
    ["/sales/source-of-sales-tools"],
    "Source of Sales hub (which contains Sales Import (Advanced) alongside Sales Upload) must stay visible in sales navigation",
  );

  const employeeAdmin = adminHrefsFor("Employee");
  assertExcludesAll(employeeAdmin, [...sensitiveHrHrefs, ...systemAdministratorOnlyHrefs, "/payroll"], "Employee must not see admin-shell authority modules");

  // Approvals Hub › Vacation & Excuse Approvals — visible to the confirmed portal-shell
  // approver roles, hidden from individual contributors who only submit.
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Manager"] as const) {
    assertIncludesAll(
      employeePortalHrefsFor(role),
      ["/employee-portals/approvals/vacation", "/employee-portals/approvals/excuse"],
      `${role} must see the Vacation & Excuse Approvals links in the employee portal`,
    );
  }
  for (const role of ["Employee", "Medical Rep"] as const) {
    assertExcludesAll(
      employeePortalHrefsFor(role),
      ["/employee-portals/approvals/vacation", "/employee-portals/approvals/excuse"],
      `${role} submits requests and must not see the approval links`,
    );
  }
}
