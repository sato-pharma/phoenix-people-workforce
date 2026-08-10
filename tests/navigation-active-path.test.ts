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
  hubPageItemGroups,
  payrollManagementPageItems,
  type NavigationSection,
  type NavigationSectionItem,
} from "../src/config/system-navigation.ts";
import {
  adminShellEmployeeRoles,
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

// The sidebar collapses most sections into one hub button, so the modules themselves live in
// hubPageItemGroups — rendered as cards on the hub page AND folded back into the Cmd+K palette by
// command-palette.tsx, with exactly these three gates. adminHrefsFor cannot see them, so a card
// removal has to be asserted here or it is not asserted at all.
function hubCardHrefsFor(role: PhoenixRole): string[] {
  const lookup = lookupForRole(role);
  return hubPageItemGroups.flatMap((group) =>
    group.items
      .filter(
        (hubItem) =>
          permissionAllowed(lookup, hubItem.permissions) &&
          roleAllowed(role, hubItem.roles) &&
          roleNotExcluded(role, hubItem.excludedRoles),
      )
      .map((hubItem) => hubItem.href),
  );
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
  // are shared with the CEO (Outstation Expenses / Leave Management hubs), not
  // Super-Admin/Talent-Acquisition-exclusive. (Outstation was shared with the
  // Finance Manager too until 2026-08-10, when the owner excluded him from the
  // module entirely; it is asserted the other way below now.)
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
  // /admin/payroll-management was his payroll-ownership row until the owner hid it later the same
  // day (2026-08-10) — see the exclusion list below. His real payroll execution surface,
  // /admin/automated-payroll/finance ("Payroll — Finance" / "Payroll"), is untouched by that move.
  assertIncludesAll(financeAdmin, ["/admin/automated-payroll/finance"], "Finance Manager must see his payroll execution surface");
  assertExcludesAll(financeAdmin, [...sensitiveHrHrefs, ...systemAdministratorOnlyHrefs], "Finance Manager must not see HR-owned or owner-only modules");

  // ── The rows the owner took off B-185's sidebar on 2026-08-10 ────────────────────────────────
  // Every one of these was reachable because of a grant he still legitimately holds and still
  // needs elsewhere (employee_profile:read is a portal floor, leave:read/approve drives the
  // consolidated Leave Management page he keeps instead, attendance:read feeds payroll,
  // crm_visits:read feeds the manager activity view), so none of them can be re-hidden by
  // trimming the permission matrix — they are held out by name in system-navigation.ts, which is
  // exactly what a well-meaning "the gate already covers this" cleanup would undo. Sidebar removal
  // is a navigation decision, not a revocation: the page guards still admit him by URL,
  // deliberately.
  //
  // Six of these rows joined the list later the same day: "Request Vacation"/"Submit Excuse" (My
  // Requests) and "Leave Approvals"/"Excuse Approvals" (Approvals Hub) were folded into his own
  // "Leave Management" button (financeLeaveManagementVacationItems/
  // financeLeaveManagementExcuseItems — he keeps every one of these duties, only the navigation
  // path moved); "Payroll Management" went the same way as its sibling hubs above once his one
  // reachable card inside it ("Deductions") was excluded by name too (see hubCardHrefsFor below);
  // "Pharmacovigilance" was trimmed to just "Report It", its own direct row now.
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
      "/admin/payroll-management",
      "/workspace/leave-management/vacation-request",
      "/workspace/excuses",
      "/admin/approvals/vacation",
      "/admin/approvals/excuse",
      "/admin/pharmacovigilance",
      // Added when the owner said "exclude him 100% from outstation or expenses" (2026-08-10).
      // Unlike every other row above, this one is NOT held out by name alone — the `outstation` key
      // was deleted from his matrix in the same change, so both gates are shut. It is asserted here
      // because the section has exactly one item, so a regression would silently restore the whole
      // "Outstation Expenses" block to his sidebar.
      "/admin/outstation-expenses",
    ],
    "Finance Manager's sidebar must stay trimmed to his finance remit (owner, 2026-08-10)",
  );
  // The other half of that instruction: the trim must not remove a duty he actually holds — only
  // the navigation path to it. Marketing Approval Inbox is the terminal finance_execution step
  // (see ceo-marketing-approval-inbox.test.ts); vacation/excuse decisions for OF-0001/A-1/A-4 and
  // his own vacation/excuse self-service now live behind the consolidated Leave Management button;
  // Report It is now a direct row instead of a click inside Pharmacovigilance.
  assertIncludesAll(
    financeAdmin,
    [
      "/admin/marketing-requests/inbox",
      "/admin/finance-leave-management",
      "/admin/report-it/new",
      // ── Six modules added 2026-08-10 (owner) ────────────────────────────────────────────────
      // Each of these needed MORE than a matrix grant, and this list is what proves the extra
      // half landed. /organogram in particular is the trap: `organogram: ["read"]` alone gets him
      // past the page's first gate and straight into its redirect, because canAccessCompanyOrganogram
      // is a role allow-list that does not honour company scope. The other four had no sidebar row
      // for him at all — their host hubs (People Management, Attendance, Payroll Management) each
      // carry excludedRoles: ["Finance Manager"], so a grant alone gave him a page with no route.
      "/organogram",
      "/resignations",
      "/admin/company-calendar",
      "/admin/payslips-center",
      "/workspace/fingerprint-report",
      // Monthly Closing: /admin/analytics is the only route to the Export XLSX button, since the
      // upload workspace that also renders it needs sales:import, which he must never hold.
      "/admin/analytics",
      // Source of Sales returns with the restored `sales` grant — owner decision, 2026-08-10.
      "/sales/source-of-sales-tools",
    ],
    "the sidebar trim must not remove a duty the Finance Manager actually holds",
  );

  // Hub CARDS the owner removed on 2026-08-10. Most never appeared in the sidebar — they are cards
  // on a hub page and Cmd+K entries — so adminHrefsFor cannot see them and only hubCardHrefsFor can
  // catch a regression. Most were reachable through a grant he keeps: payroll:read (Automated
  // Payroll finance sheets, bank transfer file) and deductions:read (the surfaces he keeps read
  // that grant too). "Deductions" (/admin/deductions) joined the list later the same day, once
  // /admin/payroll-management itself was hidden from his sidebar — the card has no roles field of
  // its own, so leaving it unexcluded would have kept it one keystroke away in Cmd+K even with the
  // parent hub row gone.
  //
  // The Outstation cards are the exception and the reason this list grew again: they are not held
  // out by name, they are gone because the `outstation` grant itself was deleted. Asserting them
  // here is what catches someone "restoring" the key to fix an unrelated 403.
  const financeHubCards = hubCardHrefsFor("Finance Manager");
  assertExcludesAll(
    financeHubCards,
    [
      "/payroll",
      "/admin/deductions-governance",
      "/admin/outstation/policy",
      "/admin/deductions",
      // The whole Outstation Expenses hub, added when the owner said "exclude him 100% from
      // outstation or expenses" (2026-08-10). Expense Command Center was the ONE card on this hub
      // he could actually open, and the assertion below used to require it to survive — that is the
      // line this change reverses. The others (queue, manual entry, dashboard, historical upload)
      // were already dark for him: they gate on outstation:approve or systemAdministratorNavigation
      // Roles, neither of which he ever held.
      "/admin/outstation/expense-command",
      "/admin/outstation/expense-command?tab=queue",
      "/admin/outstation/expense-command?tab=queue&action=create-manager-expense",
      "/admin/outstation/expenses/dashboard",
      "/admin/outstation/expenses",
      // The last survivor of the marketing trim, found by a pre-handover audit of the account on
      // 2026-08-10. "Marketing & ROI" and "ROI Tracker" were taken off his sidebar earlier that day,
      // but this card sits in archivedMarketingPageItems and has NO sidebar row of its own — so
      // hiding the parent hub achieved nothing and hubPageItemGroups folded it straight back into
      // Cmd+K. adminHrefsFor cannot see it; only this assertion can.
      "/admin/archived-marketing-requests",
      // Resignations, added 2026-08-10 with the grant. He reaches the page through his OWN sidebar
      // row, so the People Management card must stay excluded — otherwise hubPageItemGroups folds
      // it back into his Cmd+K under a "People Management" heading he was removed from, which is
      // exactly how "Archived ROI Tracking" and "/admin/deductions" survived their hubs being hidden.
      "/resignations",
      // Weekly Analytics: he passes canViewAdminCoreAnalytics but holds no weekly_sales grant, so
      // this card would be a guaranteed 403. The two sales-resource analytics cards below are his.
      "/admin/analytics/weekly-sales",
    ],
    "Finance Manager's hub cards must stay trimmed (owner, 2026-08-10)",
  );
  assertIncludesAll(
    financeHubCards,
    [
      // The five actions consolidated into the Leave Management page (financeLeaveManagement
      // VacationItems / financeLeaveManagementExcuseItems) must all still be reachable as cards.
      "/workspace/leave-management/vacation-request",
      "/admin/approvals/vacation",
      "/leave-management/vacation-report",
      "/workspace/excuses",
      "/admin/approvals/excuse",
    ],
    "every consolidated Leave Management action must survive as a hub card",
  );

  // ── A visible sidebar row must never bounce the person who presses it ────────────────────────
  // "Request Vacation" under My Requests is shown to every adminShellEmployeeRole, but its page
  // guard (requireAdminShellEmployeeWorkspaceAccess with action "create") is a PERMISSION check.
  // On 2026-08-10 the Finance Manager was the one role in that list without leave:create, so the
  // row rendered for him and then redirected him to his landing page with no message — and an
  // admin-shell role has no employee portal, so he could not file leave anywhere on the system.
  //
  // Fixed on both sides: he was granted leave:create, and the row now carries the same permission
  // its guard checks. This asserts the two gates agree for EVERY role in the list, so adding a
  // fifth admin-shell role without leave:create fails here instead of shipping a button that
  // throws the user out.
  const VACATION_REQUEST_HREF = "/workspace/leave-management/vacation-request";
  for (const shellRole of adminShellEmployeeRoles) {
    // Finance Manager is intentionally exempt from this loop: his row moved into the consolidated
    // Leave Management page on 2026-08-10 (financeLeaveManagementVacationItems), so the row is
    // absent even though he still holds leave:create — a deliberate navigation decision, not a
    // guard/gate mismatch. hubCardHrefsFor above already asserts the card survives there instead.
    if (shellRole === "Finance Manager") continue;
    const rowIsShown = adminHrefsFor(shellRole).includes(VACATION_REQUEST_HREF);
    const guardWouldAdmit = lookupForRole(shellRole)["leave:create"] === true;
    assert.equal(
      rowIsShown,
      guardWouldAdmit,
      `${shellRole}: the Request Vacation row and its leave:create page guard must agree — ` +
        `row shown=${rowIsShown}, guard admits=${guardWouldAdmit}. A row shown without the grant is a button that redirects.`,
    );
  }
  // And the specific account this started from must actually be able to file leave.
  assert.equal(
    lookupForRole("Finance Manager")["leave:create"],
    true,
    "B-185 is an active employee with no employee portal — losing leave:create leaves him no way to request vacation at all",
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
  // The Finance-Manager-only rows added 2026-08-10 use `roles: ["Finance Manager"]`, which the
  // system-administrator workspace bypasses (isSystemAdministratorWorkspace ignores `roles` but
  // still honours excludedRoles — see getSections) — so both rows carry excludedRoles naming
  // Super Admin explicitly. Without it, Super Admin would see a second "Leave Management" row
  // alongside his own /leave-management, and "Report It" as a direct row alongside the
  // Pharmacovigilance hub he already keeps.
  assertExcludesAll(
    superAdminAuthorityNav,
    ["/admin/finance-leave-management", "/admin/report-it/new"],
    "Super Admin's role bypass must not leak the Finance-Manager-only rows into his own sidebar",
  );
  assertExcludesAll(
    ceoAdmin,
    ["/admin/finance-leave-management", "/admin/report-it/new"],
    "CEO must not pick up the Finance-Manager-only rows either",
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
