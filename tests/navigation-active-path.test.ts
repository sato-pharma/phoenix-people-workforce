import assert from "node:assert/strict";

import {
  getActiveHref,
  getSections,
  isActivePath,
  permissionAllowed,
  type PermissionLookup,
  resolveDeepestActiveHref,
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
    "/admin/ceo-command-center,/business-review-s1,/organogram",
    "CEO command center section must include S1 Business Review and Organogram as separate executive tabs",
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
  // Renewal, Resignations) have no role restriction, so a role can legitimately
  // reach the hub even though Employees/Weekly Plans/HR Support
  // Requests within it stay Super-Admin/Talent-Acquisition-only via their own
  // per-card gates. (Finance Manager used to be the example named here; the owner
  // took that hub off his sidebar on 2026-08-10 — it is asserted the other way
  // below now.) "Other Approvals" moved to the sidebar's Approvals Hub
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

  // ── The seven rows the owner took off B-185's sidebar on 2026-08-10 ──────────────────────────
  // Every one of these was reachable because of a grant he still legitimately holds and still
  // needs elsewhere (employee_profile:read is a portal floor, leave:read drives the two approval
  // rows he keeps, attendance:read feeds payroll, crm_visits:read feeds the manager activity
  // view), so none of them can be re-hidden by trimming the permission matrix — they are held out
  // by name in system-navigation.ts, which is exactly what a well-meaning "the gate already covers
  // this" cleanup would undo. Sidebar removal is a navigation decision, not a revocation: the page
  // guards still admit him by URL, deliberately.
  assertExcludesAll(
    financeAdmin,
    [
      "/employee-360",
      "/admin/approvals-hub",
      "/admin/marketing-roi",
      "/admin/marketing-roi-tracker",
      "/admin/people-management",
      "/attendance",
      "/admin/crm-tools",
    ],
    "Finance Manager's sidebar must stay trimmed to his finance remit (owner, 2026-08-10)",
  );
  // The other half of that instruction: the trim must not touch the rungs he actually executes.
  // Marketing Approval Inbox is the terminal finance_execution step (see
  // ceo-marketing-approval-inbox.test.ts), and he decides leave/excuse for OF-0001, A-1 and A-4.
  assertIncludesAll(
    financeAdmin,
    ["/admin/marketing-requests/inbox", "/admin/approvals/vacation", "/admin/approvals/excuse"],
    "the sidebar trim must not remove a duty the Finance Manager actually holds",
  );

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

  // Approvals Hub › Vacation Approvals — visible to the confirmed portal-shell approver roles,
  // hidden from individual contributors who only submit.
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Manager"] as const) {
    assertIncludesAll(
      employeePortalHrefsFor(role),
      ["/employee-portals/approvals/vacation"],
      `${role} must see the Vacation Approvals link in the employee portal`,
    );
  }
  // Excuse Approvals is a NARROWER list than vacation, and the two are deliberately kept as
  // separate role lists in system-navigation.ts. Excuse is a Head-Office / fingerprint-attendance
  // module and is direct-manager-only (no manager-of-manager step), so nobody in the field sales
  // ladder ever has an excuse to decide: NSM never did, and DSM/RM were removed by owner decision
  // on 2026-07-30. The enforcing gate is EXCUSE_EXCLUDED_ROLES in src/lib/excuses/service.ts.
  for (const role of ["Product Manager", "Group Product Manager", "Marketing Manager", "Manager"] as const) {
    assertIncludesAll(
      employeePortalHrefsFor(role),
      ["/employee-portals/approvals/excuse"],
      `${role} must see the Excuse Approvals link in the employee portal`,
    );
  }
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager"] as const) {
    assertExcludesAll(
      employeePortalHrefsFor(role),
      ["/employee-portals/approvals/excuse"],
      `${role} is outside the excuse ladder and must not see the Excuse Approvals link`,
    );
  }
  for (const role of ["Employee", "Medical Rep"] as const) {
    assertExcludesAll(
      employeePortalHrefsFor(role),
      ["/employee-portals/approvals/vacation", "/employee-portals/approvals/excuse"],
      `${role} submits requests and must not see the approval links`,
    );
  }

  // ── Employee-portal sidebar: exactly ONE row highlights, the deepest one ────────────────────
  // Reported 2026-08-09: opening Direct Orders Report lit BOTH "Direct Orders Report" and its
  // parent "Direct Orders". The portal used a bare prefix test with a hand-kept list of parent
  // hrefs pinned to exact-match, and /employee-portals/direct-orders was never added to that list.
  {
    const portalRoot = "/employee-portals";
    const exactOnly = new Set([portalRoot]);
    // A representative slice of the real portal sidebar, including both parent/child pairs.
    const hrefs = [
      portalRoot,
      "/employee-portals/direct-orders",
      "/employee-portals/direct-orders/report",
      "/employee-portals/plans",
      "/employee-portals/plans/calendar",
      "/employee-portals/marketing-requests",
      "/employee-portals/marketing-requests/inbox",
      "/employee-portals/team-calendar",
    ];

    // The headline assertion: the child wins outright, so the parent row is NOT active.
    assert.equal(
      resolveDeepestActiveHref("/employee-portals/direct-orders/report", hrefs, exactOnly),
      "/employee-portals/direct-orders/report",
      "Direct Orders Report must be the active row, not its parent Direct Orders",
    );
    // Same rule for the two parent/child pairs that used to need hardcoded exceptions.
    assert.equal(
      resolveDeepestActiveHref("/employee-portals/plans/calendar", hrefs, exactOnly),
      "/employee-portals/plans/calendar",
      "Planning Calendar wins over its Weekly / Monthly Plan parent",
    );
    assert.equal(
      resolveDeepestActiveHref("/employee-portals/marketing-requests/inbox", hrefs, exactOnly),
      "/employee-portals/marketing-requests/inbox",
      "Marketing Inbox wins over its Marketing Requests parent",
    );

    // A parent on its OWN page still lights up.
    assert.equal(
      resolveDeepestActiveHref("/employee-portals/direct-orders", hrefs, exactOnly),
      "/employee-portals/direct-orders",
      "Direct Orders stays active on its own page",
    );
    // A detail route with no sidebar row of its own lights its nearest ancestor — what those pages want.
    assert.equal(
      resolveDeepestActiveHref("/employee-portals/direct-orders/DO-2026-001", hrefs, exactOnly),
      "/employee-portals/direct-orders",
      "a direct-order detail page keeps its parent row lit",
    );
    assert.equal(
      resolveDeepestActiveHref("/employee-portals/team-calendar/visits/A-9/2026-08-09", hrefs, exactOnly),
      "/employee-portals/team-calendar",
      "a team-calendar visit detail page keeps Team Calendar lit",
    );

    // The portal root is exact-only: destinations with no row of their own must not leave
    // "Command Center" lit behind them.
    assert.equal(
      resolveDeepestActiveHref(portalRoot, hrefs, exactOnly),
      portalRoot,
      "Command Center is active on the portal root itself",
    );
    assert.equal(
      resolveDeepestActiveHref("/employee-portals/profile", hrefs, exactOnly),
      null,
      "a portal page with no sidebar row of its own leaves Command Center unlit",
    );
  }
}
