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
  bandSectionIdsFor,
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
  scopeForRole,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { resolvePersonalWorkspaceTabs } from "../src/lib/workspace/personal-workspace-nav.ts";

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

/**
 * The module FAMILIES on a role's rail, by section id.
 *
 * Until 2026-09-05 a family was named here by its hub href — one rail row that opened a page of
 * cards. The owner removed that shape ("I don't want any subtitle to be the one that when I press
 * it redirects me to a page with big modules"), so a hub's cards ARE the rail rows now and no hub
 * href appears on any rail. Naming one in an assertion below would make it vacuously true, which
 * is worse than a wrong assertion: it reads as a live check and can never fail again. So a claim
 * about a whole family is made against its band, and a claim about one page against its own href.
 */
function adminBandsFor(role: PhoenixRole): string[] {
  return getSections(adminNavigationSections, "admin", lookupForRole(role), role).map(
    (navSection) => navSection.id,
  );
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
  assert.equal(roleAllowed("HR Advisory", ["Super Admin"]), false);
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

  // HR Advisory: access item (Super Admin only) filtered out of section a.
  const hrAdvisory = getSections(sections, "admin", {}, "HR Advisory");
  assert.deepEqual(
    hrAdvisory[0].items.map((i) => i.href),
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

  // System Cleanup and the other Super-Admin-only tools sit in the "Admin Tools" BAND. It carried
  // this guarantee as a single /admin/admin-tools row until 2026-09-05; the row is gone and the
  // band inherited its gate (NavigationSection.gate), which is role-gated, not permission-gated —
  // so a stale or wrong permission-cache read must not empty it.
  //
  // The band became FOUR sections later the same day (the rebalance split Admin Tools at 17 rows).
  // Resolved through `bandSectionIdsFor` rather than by naming them, because the failure mode of
  // hardcoding one is silent: `find(id === "admin-tools")` still matches a real section, so the
  // assertion keeps passing while covering a quarter of what it claims to. System Cleanup moved
  // into the "Data & Maintenance" quarter, which is how this was caught.
  const adminToolsBandIds = bandSectionIdsFor("admin-tools");
  const superAdminCleanupNav = getSections(
    adminNavigationSections,
    "admin",
    { "admin:read": false },
    "Super Admin",
  );
  const superAdminAdminTools = superAdminCleanupNav.filter((navSection) =>
    adminToolsBandIds.includes(navSection.id),
  );
  assert.equal(
    superAdminAdminTools.reduce((total, navSection) => total + navSection.items.length, 0) > 0,
    true,
    "Super Admin must see the Admin Tools band even if the dynamic permission cache is stale",
  );
  assert.equal(
    superAdminAdminTools.some((navSection) =>
      navSection.items.some((navItem) => navItem.href === "/admin/system-cleanup"),
    ),
    true,
    "…and System Cleanup specifically: it is role-gated with no permission of its own, so it is the " +
      "row that proves the stale `admin:read` did not quietly empty the band down to its permissioned tools",
  );

  const ceoCleanupNav = getSections(
    adminNavigationSections,
    "admin",
    { "admin:read": true },
    "CEO",
  );
  assert.equal(
    ceoCleanupNav.some((navSection) => adminToolsBandIds.includes(navSection.id)),
    false,
    "CEO must not see the Admin Tools band — any of its four sections — even if a permission lookup grants admin",
  );
  // Admin Tools cards that name the CEO (Email Control Center, CEO Email Composer — System Issues
  // was one until it retired into the Super-Admin-only System Audit on 23 Oct 2026) still stay off
  // his rail, because the band's gate is Super-Admin-only, exactly as the hub row was. Promoting the
  // cards on their own gates alone is what would have put them there, which is the whole reason
  // the band carries a gate of its own.
  assert.equal(
    ceoCleanupNav.some((navSection) =>
      navSection.items.some((navItem) => navItem.href === "/admin/email-control-center"),
    ),
    false,
    "CEO must not reach an Admin Tools module his hub could never open",
  );

  const ceoPayrollTools = payrollManagementPageItems.filter(
    (item) => roleNotExcluded("CEO", item.excludedRoles),
  );
  assert.deepEqual(
    ceoPayrollTools.filter(
      (item) => item.href.includes("payroll-copilot"),
    ).map((item) => item.href),
    [],
    "CEO payroll navigation must hide Copilot and Insurance Wages",
  );

  const ceoExecutiveNav = getSections(adminNavigationSections, "admin", { "probation:read": true, "organogram:read": true }, "CEO");
  assert.equal(
    ceoExecutiveNav.find((section) => section.id === "command-center")?.items.map((item) => item.href).join(","),
    "/admin/ceo-command-center,/business-review",
    "CEO command center section must include Business Review as a separate executive tab",
  );
  // Organogram left this section on 2026-08-30 for a top-level slot of its own — ruling 10, "Layer 1
  // = Approvals + Organogram only". It is still on the CEO's rail, one row higher up, and the
  // assertion below is what proves that rather than assuming it. Merging the two copies (the other
  // lived in People Management under a mutually-exclusive gate) is what implementing the ruling
  // looked like; tests/organogram-nav-link-exists-for-every-role-that-can-open-it.test.ts covers
  // every OTHER role's link.
  assert.equal(
    ceoExecutiveNav.some((section) => section.id === "organogram" && section.items.some((item) => item.href === "/organogram")),
    true,
    "CEO must still reach the Organogram — as its own top-level section since ruling 10",
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
  // Named as PAGES since 2026-09-05, not as the hub that used to front them. The hub href is on
  // nobody's rail now, so a list holding it would exclude a string that cannot appear — three
  // recruiting pages that really are on HR Advisory's and Super Admin's rails are what make these
  // assertions capable of failing again.
  const sensitiveHrHrefs = ["/recruitment", "/cv-database", "/offers"] as const;
  // /admin/outstation-expenses and /leave-management moved off this list — both
  // are shared with the CEO (Outstation Expenses / Leave Management hubs), not
  // Super-Admin/Talent-Acquisition-exclusive. (Outstation was shared with the
  // Finance Manager too until 2026-08-10, when the owner excluded him from the
  // module entirely; it is asserted the other way below now.)
  // Same move, same reason: three Admin Tools pages that are role-gated to Super Admin with no
  // permission of their own, so no grant anywhere can make them appear for another role.
  const systemAdministratorOnlyHrefs = [
    "/admin/system-cleanup",
    "/admin/data-backup",
    "/admin/module-locks",
  ] as const;

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

  // The retired Talent Acquisition seat held all three of these at once. Its two
  // successors do not, and asserting them separately is the point: a bundle that
  // silently inherited the whole retired sidebar would pass a merged assertion and
  // fail these. Recruitment belonged to HR Advisory until the owner moved it to the Talent
  // Acquisition seat on 2026-10-08, and the same evening retired HR Advisory altogether ("no more HR
  // business partner"); Leave Management is HR Operations'; People Management is permission-gated,
  // so each live seat reaches it through its own grants. The retired key reaches none of the three.
  assertExcludesAll(
    adminBandsFor("HR Advisory"),
    ["hub-people-management", "hub-recruitment-hiring", "leave-management"],
    "the retired HR Business Partner key must reach no HR module band",
  );
  assert.ok(
    adminBandsFor("HR Resourcing").includes("hub-recruitment-hiring"),
    "the Talent Acquisition seat must see Recruitment & Hiring — the pipeline is hers",
  );
  assertIncludesAll(
    adminBandsFor("HR Operations"),
    ["hub-people-management", "leave-management"],
    "HR Operations must see the records-and-time admin modules",
  );
  assert.ok(
    !adminBandsFor("HR Operations").includes("hub-recruitment-hiring"),
    "HR Operations must NOT see Recruitment & Hiring — it is the Talent Acquisition seat's module",
  );
  // …and not a single one of its pages by another door. She holds `employee_documents`, which is
  // the grant Hiring Documents and HR Forms are gated on, so those two cards would have promoted
  // onto her rail on their own gates alone even though she cannot open the hub that offers them.
  assertExcludesAll(
    adminHrefsFor("HR Operations"),
    ["/recruitment", "/cv-database", "/hiring-documents", "/hiring-pack", "/offers"],
    "HR Operations must not reach a recruiting page whose hub she cannot open",
  );
  for (const role of ["HR Advisory", "HR Operations"] as const) {
    assertExcludesAll(adminHrefsFor(role), systemAdministratorOnlyHrefs, `${role} must not see system-administrator-only modules`);
  }
  // `/employees` and `/payroll` used to be asserted absent for BOTH seats. That was a statement
  // about the old rail's shape rather than about reach: HR Operations passes the People Management
  // and Payroll Management gates, so both pages were always one click away for her, as cards on
  // those hubs. Promoting the cards makes that visible instead of hidden — the reach did not
  // change. It stays asserted for HR Advisory, whose gates genuinely do not admit her to either.
  assertExcludesAll(adminHrefsFor("HR Advisory"), ["/employees", "/payroll"], "HR Advisory must not see non-owned company modules");
  assertIncludesAll(adminHrefsFor("HR Operations"), ["/employees", "/payroll"], "HR Operations reaches both through her own grants, and the rail now says so");

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
  // The seven hub hrefs this list used to carry are gone from every rail, so each is now asserted
  // as its BAND — see `adminBandsFor`. Left as hrefs: the rows that were never hubs.
  assertExcludesAll(
    adminBandsFor("Finance Manager"),
    [
      "hub-marketing-roi",
      "hub-people-management",
      "attendance-management",
      "crm",
      "payroll",
      "hub-pharmacovigilance",
      "expenses-outstation",
    ],
    "Finance Manager's sidebar must not carry the module families the owner took off it (2026-08-10)",
  );
  assertExcludesAll(
    financeAdmin,
    [
      "/employee-360",
      "/admin/approvals-hub",
      "/admin/marketing-roi-tracker",
      "/workspace/leave-management/vacation-request",
      "/workspace/excuses",
      "/admin/approvals/vacation",
      "/admin/approvals/excuse",
      // Added when the owner said "exclude him 100% from outstation or expenses" (2026-08-10).
      // Unlike every other row above, this one is NOT held out by name alone — the `outstation` key
      // was deleted from his matrix in the same change, so both gates are shut. It is asserted here
      // because the section has exactly one item, so a regression would silently restore the whole
      // "Outstation Expenses" block to his sidebar.
      "/admin/outstation-expenses",
      // Owner, 2026-08-11: /admin/analytics restricted to Super Admin only, sidebar-wide. This was
      // his ONLY route to /admin/analytics/monthly-closing/details and its Monthly Closing Export
      // XLSX button; he now reaches it through his own dedicated row instead (see
      // finance-manager-monthly-closing-row.test.ts), so this shared hub stays excluded.
      //
      // Ruling 11 has since delisted /admin/analytics for EVERY role, so this line is now true of
      // everyone rather than specific to him. Keeping it: it still holds, and it is the assertion
      // that would catch the hub reappearing in exactly the sidebar it was first removed from.
      "/admin/analytics",
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
      // Was "/admin/company-calendar" until 2026-08-11, when the owner swapped his calendar row
      // from event AUTHORING to company READING. The authoring page was never the right one for
      // him: canPublishCompanyWide is false for a line-scoped manager, so the events he created
      // reached head-office staff only, while the page's hero promised a company-wide audience.
      // The planning calendar is the one he needs, and he passes BOTH of its gates —
      // weekly_plans:read for the page, and the unrestricted default in isPlanItemVisibleToViewer
      // for the data. tests/finance-manager-calendar-row.test.ts pins both halves.
      "/admin/weekly-plans/calendar",
      "/admin/payslips-center",
      "/workspace/fingerprint-report",
      // Source of Sales returns with the restored `sales` grant — owner decision, 2026-08-10.
      // Named as the page since 2026-09-05: the hub row is gone and his two Source of Sales rows
      // are the cards themselves.
      "/sales",
      "/sales/truth-check",
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
      // Weekly Analytics: he held no weekly_sales grant, so this card would have been a guaranteed
      // 403. The Sales Analytics module was retired on 2026-09-17; this keeps the card from returning.
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

  // ── A visible entry must never bounce the person who presses it ──────────────────────────────
  // "Request Vacation" is offered to every adminShellEmployeeRole, but its page guard
  // (requireAdminShellEmployeeWorkspaceAccess with action "create") is a PERMISSION check.
  // On 2026-08-10 the Finance Manager was the one role in that list without leave:create, so the
  // entry rendered for him and then redirected him to his landing page with no message — and an
  // admin-shell role has no employee portal, so he could not file leave anywhere on the system.
  //
  // Fixed on both sides: he was granted leave:create, and the entry now carries the same permission
  // its guard checks. This asserts the two gates agree for EVERY role in the list, so adding a
  // fifth admin-shell role without leave:create fails here instead of shipping a button that
  // throws the user out.
  //
  // 2026-08-30 (phase 4): the SURFACE making that promise moved. The sidebar's "My Requests"
  // section is gone and this page is now a tab in the personal workspace strip, so the assertion
  // reads resolvePersonalWorkspaceTabs instead of adminHrefsFor. The promise itself is unchanged —
  // and it now covers the Finance Manager too, the very role the 2026-08-10 incident was about. He
  // was exempt from the old loop because his rail row had been folded into his consolidated Leave
  // Management page (financeLeaveManagementVacationItems, still asserted by hubCardHrefsFor above);
  // the tab strip is offered to every adminShellEmployeeRole alike, so the exemption is gone and
  // this loop is strictly stronger than the one it replaces.
  const VACATION_REQUEST_HREF = "/workspace/leave-management/vacation-request";
  for (const shellRole of adminShellEmployeeRoles) {
    const lookup = lookupForRole(shellRole);
    const entryIsShown = resolvePersonalWorkspaceTabs({ role: shellRole, scope: scopeForRole(shellRole) }, lookup).some(
      (tab) => tab.href === VACATION_REQUEST_HREF,
    );
    const guardWouldAdmit = lookup["leave:create"] === true;
    assert.equal(
      entryIsShown,
      guardWouldAdmit,
      `${shellRole}: the Request Vacation tab and its leave:create page guard must agree — ` +
        `tab shown=${entryIsShown}, guard admits=${guardWouldAdmit}. Shown without the grant is a button that ` +
        `redirects; hidden with the grant is a role that can file leave nowhere on the system.`,
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
    adminBandsFor("CEO"),
    ["attendance-management", "hub-people-management", "payroll"],
    "CEO must keep read-only executive module access",
  );
  // The bands above are one row each for him in two cases, so name the pages too: a band that
  // survives with a different single row would still satisfy the ids alone.
  assertIncludesAll(
    ceoAdmin,
    ["/admin/private-calendars", "/reports/vacancies", "/admin/payslips-center"],
    "…and specifically the executive read surfaces inside them",
  );
  assertExcludesAll(ceoAdmin, [...sensitiveHrHrefs, ...systemAdministratorOnlyHrefs], "CEO must not see HR-owned or owner-only modules");

  const superAdminAuthorityNav = adminHrefsFor("Super Admin");
  assertIncludesAll(
    superAdminAuthorityNav,
    [
      ...sensitiveHrHrefs,
      ...systemAdministratorOnlyHrefs,
      "/payroll",
      "/admin/marketing-roi-report",
      "/employees",
      "/admin/outstation/expense-command",
      "/coaching",
      "/leave-management/vacation-report",
    ],
    "Super Admin must see full governance modules",
  );
  // The Finance-Manager-only rows added 2026-08-10 use `roles: ["Finance Manager"]`, which the
  // system administrator's waiver skips (navigationItemVisible ignores `roles` for that role but
  // still honours excludedRoles) — so both rows carry excludedRoles naming
  // Super Admin explicitly. Without it, Super Admin would see a second "Leave Management" row
  // alongside his own /leave-management, and "Report It" as a direct row alongside the
  // Pharmacovigilance hub he already keeps.
  // Asserted by BAND since 2026-09-05. `/admin/report-it/new` is no longer his alone: it is also a
  // card on the Pharmacovigilance hub, which both these roles can open, so it is now a row in their
  // `hub-pharmacovigilance` band and an href test would fail on the wrong evidence. The claim was
  // always about the Finance-Manager-only SECTIONS, and those are what is named here.
  assertExcludesAll(
    adminBandsFor("Super Admin"),
    ["finance-leave-management", "pharmacovigilance"],
    "Super Admin's role bypass must not leak the Finance-Manager-only sections into his own sidebar",
  );
  assertExcludesAll(
    adminBandsFor("CEO"),
    ["finance-leave-management", "pharmacovigilance"],
    "CEO must not pick up the Finance-Manager-only sections either",
  );
  assertExcludesAll(
    superAdminAuthorityNav,
    ["/admin/finance-leave-management"],
    "…and not the Finance-Manager-only Leave Management page itself, which no other section offers",
  );
  // INVERTED by ruling 11 — "no analytics module, no sales analytics", the owner's words, said
  // three times. This assertion previously REQUIRED the Sales Analytics hub row in Super Admin's
  // sidebar; it was the last thing that would have kept the module alive after the config change,
  // and a test demanding the very row a ruling deletes reads as "your change is wrong" rather than
  // "this pin is stale". Super Admin is the strongest case to assert: he held the only remaining
  // rail row, so if it is gone for him it is gone for everyone.
  assertExcludesAll(
    superAdminAuthorityNav,
    ["/admin/analytics"],
    "Sales Analytics hub must NOT appear in any sidebar — ruling 11 delisted the analytics module",
  );
  assertIncludesAll(
    superAdminAuthorityNav,
    ["/sales/import", "/sales/upload"],
    "Source of Sales must stay visible in sales navigation — Sales Import (Advanced) alongside Sales Upload, " +
      "which were cards on its hub until the hub row was removed and are rail rows in its band now",
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
