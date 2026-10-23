import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { adminNavigationSections, attendanceManagementPageItems } from "../src/config/system-navigation.ts";
import { notificationHrefForViewerRole } from "../src/lib/notifications/hrefs.ts";
import { payrollBatchHref, payrollBatchNotificationMetadata } from "../src/lib/payroll/links.ts";
import {
  canAccess,
  canAccessFingerprintReport,
  createAccessContext,
  deadMatrixGrants,
  isRolePermissionWithinHardBoundary,
  permissionActions,
  permissionMatrix,
  permissionResources,
  type PermissionResource,
} from "../src/lib/auth/permissions.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";

// ── 2026-09-05: the hub rows are gone, so seven of these eight were about to become unfailable ──
//
// The owner removed every rail row that opens a page of modules — "I do not want any subtitle to be
// the one that when I press, it redirects me to a page with big modules" — so each hub's cards were
// promoted onto the rail under the hub's own heading. /sales/source-of-sales-tools, /attendance,
// /admin/people-management, /admin/payroll-management, /admin/outstation-expenses,
// /admin/marketing-roi and /leave-management are in NO role's sidebar any more. Asserting the CEO has
// them fails; deleting them would have quietly stopped checking that he can reach those seven
// modules at all, which is the whole point of the list.
//
// So the contract is written the way the rail now writes it: the BAND each hub's heading became, plus
// one real page under it. The band alone would pass on an empty band; the page alone would not notice
// the band vanishing into another domain. The hub PAGES were not deleted or re-gated — they still
// answer by URL, and the page-level assertions further down still exercise them.
const ceoAllowedReadOnlyBands = [
  ["sales-source-of-sales", "/sales"],
  ["attendance-management", "/admin/private-calendars"],
  ["hub-people-management", "/reports/vacancies"],
  ["payroll", "/admin/m-payroll"],
  ["expenses-outstation", "/admin/outstation/expense-command"],
  ["hub-marketing-roi", "/admin/marketing-roi-report"],
  ["leave-management", "/leave-management/vacation-report"],
] as const;

const ceoAllowedReadOnlyRoutes = ["/admin/ceo-command-center"] as const;

const ceoBlockedRedirectRoutes = [
  "/sales/monthly-dashboard",
] as const;

const ceoBlockedHighRiskRoutes = [
  "/employees",
  "/admin/access",
  // The System Audit replaced Data Health on 23 Oct 2026 and is Super Admin only.
  "/admin/system-audit",
  "/attendance/device-user-mapping",
  "/attendance/policies",
  "/payroll",
  "/admin/system-cleanup",
] as const;

// /admin/recruitment-hiring sat in the list above until 2026-09-05. It was the CEO's blocked HUB ROW,
// and with no hub rows left anywhere the assertion could never fail again — every role passes it now.
// What still carries the meaning is the band the promotion created: if the recruiting cards ever
// reach him, they arrive as rows inside this band. His own /recruitment/candidates section is
// untouched and deliberately not named here — he always had it.
const ceoBlockedBands = ["hub-recruitment-hiring"] as const;

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
  const ceoSections = getSections(adminNavigationSections, "admin", lookupForCeo(), "CEO");
  const visibleAdminHrefs = ceoSections.flatMap((section) => section.items.map((item) => item.href));
  const visibleAdminBands = ceoSections.map((section) => section.id);

  for (const href of ceoAllowedReadOnlyRoutes) {
    assert.equal(
      visibleAdminHrefs.includes(href),
      true,
      `CEO navigation must expose the approved read-only route ${href}`,
    );
  }

  for (const [bandId, href] of ceoAllowedReadOnlyBands) {
    assert.equal(
      visibleAdminBands.includes(bandId),
      true,
      `CEO navigation must still carry the "${bandId}" band — it is what the hub row for this module became`,
    );
    assert.equal(
      visibleAdminHrefs.includes(href),
      true,
      `CEO navigation must expose ${href}, the page standing for the "${bandId}" band`,
    );
  }

  for (const bandId of ceoBlockedBands) {
    assert.equal(
      visibleAdminBands.includes(bandId),
      false,
      `CEO navigation must not carry the "${bandId}" band`,
    );
  }

  // Owner, 2026-08-11: the "Sales Analytics" hub row (/admin/analytics) was restricted to
  // Super Admin only in the sidebar, so the CEO's sidebar never carried it.
  //
  // Ruling 11 then removed the module outright — "no analytics module, no sales analytics" — so
  // /admin/analytics is now in NO role's sidebar, and the CEO's own "Sales Analytics" quick-link
  // card in ceo-command-center.tsx went with it. The comment here used to say the CEO kept access
  // "via the dashboard shortcuts in ceo-phase-b.tsx"; that is no longer true of the hub itself.
  // What he keeps is the DATA, not the hub: the Source of Sales and Med-Rep Performance cards on
  // his command center open their dashboards directly. The owner retired the module's pages on
  // 2026-09-17, and the Source of Sales card and ceo-sos-tables.tsx's "Full SoS" link moved to the
  // Monthly Closing page (/sales/monthly-closing), which he opened to the CEO read-only on 2026-09-07.
  assert.equal(
    visibleAdminHrefs.includes("/admin/analytics"),
    false,
    "CEO sidebar must not expose /admin/analytics — module delisted by ruling 11",
  );

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
  // The sidebar exposes the "Source of Sales" hub button to CEO (only Marketing
  // Manager is excluded there) and CEO can open the Source of Sales Dash card,
  // so the hub page must NOT redirect CEO away. Guard the page's own exclusion
  // list directly — the nav-visibility loop above never exercises this runtime
  // redirect, which is how the CEO bounce-to-portal regression slipped through.
  const sourceOfSalesHubSource = readFileSync("app/(admin)/sales/source-of-sales-tools/page.tsx", "utf8");
  const sosExcludedRolesMatch = sourceOfSalesHubSource.match(/SOURCE_OF_SALES_EXCLUDED_ROLES\s*=\s*\[([^\]]*)\]/);
  assert.ok(sosExcludedRolesMatch, "Source of Sales hub must define SOURCE_OF_SALES_EXCLUDED_ROLES");
  assert.doesNotMatch(
    sosExcludedRolesMatch[1],
    /"CEO"/,
    "Source of Sales hub must not exclude CEO — it would redirect CEO to the employee portal despite the sidebar exposing the hub button to CEO",
  );
  assert.match(
    sosExcludedRolesMatch[1],
    /"Marketing Manager"/,
    "Source of Sales hub must still exclude Marketing Manager (excluded from every card + lacks sales:import, so a genuinely empty hub)",
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

  // Fingerprint Report gets a page-scoped exception: CEO can view/export it
  // specifically, without the general employees:read hard boundary moving at
  // all (asserted above via ceoBlockedHighRiskResources).
  assert.equal(
    await canAccessFingerprintReport(ceo),
    true,
    "CEO must be able to view the Fingerprint Report via its page-scoped exception",
  );
  const fingerprintReportCard = attendanceManagementPageItems.find((item) => item.href === "/attendance/fingerprint-report");
  assert.ok(fingerprintReportCard, "Fingerprint Report hub card must exist");
  const fingerprintReportPageSource = readFileSync("app/(admin)/attendance/fingerprint-report/page.tsx", "utf8");
  assert.match(
    fingerprintReportPageSource,
    /canAccessFingerprintReport\(access\)/,
    "Fingerprint Report page must gate via the CEO-aware helper, not raw employees:read",
  );
  const fingerprintExportRouteSourceForCeo = readFileSync("app/api/attendance/fingerprint-report/export/route.ts", "utf8");
  assert.match(
    fingerprintExportRouteSourceForCeo,
    /assertFingerprintReportPermission\(access\)/,
    "Fingerprint Report export route must gate via the CEO-aware helper",
  );
  const attendanceHubPageSource = readFileSync("app/(admin)/attendance/page.tsx", "utf8");
  assert.match(
    attendanceHubPageSource,
    /canAccessFingerprintReport/,
    "Attendance Management hub must use the CEO-aware helper to surface the Fingerprint Report card",
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
  assert.match(ceoPhaseBSource, /href: "\/sales\/monthly-closing"/);
  assert.doesNotMatch(
    ceoSosTablesSource,
    /href="\/sales\/monthly-dashboard"/,
    "CEO SoS tables must not link to the redirecting monthly sales route",
  );
  assert.match(ceoSosTablesSource, /href="\/sales\/monthly-closing"/);
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
  // Audit finding 51: the console lists every salary batch in the company, and `payroll:read` alone
  // is held by self-scope admin roles such as SFE Manager. The sidebar hiding the link is not a
  // boundary, so the page must send a self-scope viewer away before it reads anything.
  assert.match(
    mPayrollPageSource,
    /getPayrollScope\(access\) !== "COMPANY"\) \{\s*redirect\("\/payslips"\);/,
    "the CEO payroll console must redirect a viewer whose payroll scope is not company-wide",
  );
  assert.ok(
    mPayrollPageSource.indexOf('getPayrollScope(access) !== "COMPANY"') > 0 &&
      mPayrollPageSource.indexOf('getPayrollScope(access) !== "COMPANY"') <
        mPayrollPageSource.indexOf("listSalaryBatches("),
    "the scope redirect must come before the batch register is read",
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
  // The CEO's sidebar logo must return them to the CEO Command Center, not the admin shell's
  // generic /admin/access home. This was a hardcoded `currentRole === "CEO"` check; it is now a
  // role set so the SFE Manager gets the same treatment (his landing page is his home too), but
  // the CEO guarantee is unchanged and still asserted here.
  assert.match(
    sidebarSource,
    /const commandCenterHomeRoles = new Set<PhoenixRole>\(\[[^\]]*"CEO"[^\]]*\]\)/,
    "CEO must be in the sidebar command-center home roles",
  );
  assert.match(
    sidebarSource,
    /commandCenterHomeRoles\.has\(currentRole as PhoenixRole\)\s*\n?\s*\?\s*resolveLandingPathForRole\(currentRole\)\s*\n?\s*:\s*navigationHomePathByMode\[mode\]/,
    "sidebar home must resolve through resolveLandingPathForRole for command-center roles and fall back to the shell home otherwise",
  );
  assert.match(sidebarSource, /<SidebarBrand currentRole=\{currentRole\} mode=\{navigationMode\}/);

  // ── The matrix must not CLAIM what the boundary strips ────────────────────────────────────────
  //
  // The CEO block declared `recruitment: ["read"]` and `candidates: ["read"]`. Neither ever took
  // effect — both are capped to isHrAuthorityRole, which the CEO is not — so the assertions above
  // were green while the file said the opposite of what the system does. That is worse than a bug:
  // it is the most authoritative-looking answer in the codebase to "can the CEO read candidates?",
  // and it is wrong. tests/hr-retention-register.test.ts already makes this check for the composed
  // HR seats and calls such a grant "a LIE IN THE WORKBOOK, not a safety net".
  const deadForCeo = deadMatrixGrants().filter((grant) => grant.role === "CEO");
  for (const resource of ["recruitment", "candidates"] as const) {
    assert.equal(
      deadForCeo.some((grant) => grant.resource === resource),
      false,
      `the CEO block must not declare ${resource} — the hard boundary strips it, so the line only misleads`,
    );
  }

  // AND THERE ARE NONE LEFT. 28 such declarations were cleared on 2026-09-05, and the EFFECTIVE
  // matrix was byte-identical before and after — every one of them was inert. support_requests was
  // the largest group and the most misleading: applyHardPermissionBoundaries OVERWRITES that one
  // rather than intersecting it, so whatever a role declared was replaced wholesale, and fifteen
  // roles carried a line that could never take effect.
  //
  // Empty is now the only acceptable answer. A declaration the boundary strips is not a safety net;
  // it is a sentence in a security file that says the opposite of what the system does, in the most
  // authoritative-looking place a reader will check.
  assert.deepEqual(
    deadMatrixGrants(),
    [],
    "a role declares a permission the hard boundary strips — either grant it in hardBoundaryAllowedActions or stop declaring it",
  );
}
