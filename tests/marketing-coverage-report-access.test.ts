import assert from "node:assert/strict";

import { createAccessContext, resolveNavigationMode } from "../src/lib/auth/permissions.ts";
import {
  canUseEmployeePortalMarketingCoverageReport,
} from "../src/lib/employee-portal/navigation.ts";
import {
  canViewMarketingCoverageReport,
  canViewMarketingCoverageReportInAdminShell,
  coverageReportAdminShellRoles,
  coverageReportCompanyWideRoles,
  coverageReportViewerRoles,
} from "../src/lib/marketing-requests/coverage-report-access.ts";

export function runMarketingCoverageReportAccessTests() {
  // ── Pin the exact 12-role viewer set (broadly open to the whole hierarchy).
  const expectedViewerRoles = [
    "Medical Rep",
    "District Manager",
    "Regional Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
    "SFE Manager",
    "Finance Manager",
    "Financial Advisor",
    "CEO",
    "Super Admin",
  ];
  assert.equal(coverageReportViewerRoles.size, expectedViewerRoles.length);
  for (const role of expectedViewerRoles) {
    assert.equal(canViewMarketingCoverageReport(role), true, `${role} must be able to view the coverage report`);
  }
  assert.equal(canViewMarketingCoverageReport("Employee"), false, "an unlisted role must not view the report");
  assert.equal(canViewMarketingCoverageReport(null), false, "a null role must not view the report");

  // ── Pin the exact 4-role unrestricted (company-wide) set — deliberately
  //    NARROWER than ROI Tracking's companyMarketingRoles: Finance Manager and
  //    Financial Advisor are NOT unrestricted here.
  const expectedCompanyWide = ["CEO", "Super Admin", "SFE Manager", "Marketing Manager"];
  assert.equal(coverageReportCompanyWideRoles.size, expectedCompanyWide.length);
  for (const role of expectedCompanyWide) {
    assert.equal(coverageReportCompanyWideRoles.has(role as never), true, `${role} must be company-wide`);
  }
  assert.equal(coverageReportCompanyWideRoles.has("Finance Manager" as never), false, "Finance Manager must NOT be company-wide here (diverges from ROI Tracking)");
  assert.equal(coverageReportCompanyWideRoles.has("Financial Advisor" as never), false, "Financial Advisor must NOT be company-wide here (diverges from ROI Tracking)");

  // ── Pin the exact 5-role admin-shell set: every viewer role whose
  //    resolveNavigationMode() is "admin" (CEO, Super Admin, and the three
  //    adminShellEmployeeRoles viewers: SFE Manager, Finance Manager, Financial
  //    Advisor). These roles have NO working /employee-portals/** route at all
  //    (assertEmployeePortalMarketingPageAccess redirects any non-"employee-portal"
  //    navigationMode role away unconditionally), so admin-shell PAGE access is
  //    their only route — narrower here would strand them with a dead bounce.
  //    Marketing Manager and Product/Group Product Manager stay portal-only:
  //    their navigationMode is "employee-portal".
  assert.deepEqual(
    Array.from(coverageReportAdminShellRoles).sort(),
    ["CEO", "Super Admin", "SFE Manager", "Finance Manager", "Financial Advisor"].sort(),
    "admin shell must be exactly CEO + Super Admin + SFE Manager + Finance Manager + Financial Advisor",
  );
  assert.equal(canViewMarketingCoverageReportInAdminShell("SFE Manager"), true, "SFE Manager's navigationMode is admin — it has no portal-shell route");
  assert.equal(canViewMarketingCoverageReportInAdminShell("Finance Manager"), true, "Finance Manager's navigationMode is admin — it has no portal-shell route");
  assert.equal(canViewMarketingCoverageReportInAdminShell("Financial Advisor"), true, "Financial Advisor's navigationMode is admin — it has no portal-shell route");
  assert.equal(canViewMarketingCoverageReportInAdminShell("Marketing Manager"), false, "Marketing Manager reaches the report via the portal shell, not admin");
  assert.equal(canViewMarketingCoverageReportInAdminShell("CEO"), true);
  assert.equal(canViewMarketingCoverageReportInAdminShell("Super Admin"), true);

  // ── Role-parity invariant: every company-wide role must be a valid viewer.
  //    (NOT the inverse: admin-shell roles are no longer guaranteed to be
  //    company-wide — Finance Manager/Financial Advisor are admin-shell viewers
  //    that are deliberately scoped, not company-wide, which is exactly the
  //    point of this report's divergence from ROI Tracking.)
  for (const role of coverageReportCompanyWideRoles) {
    assert.equal(coverageReportViewerRoles.has(role), true, `company-wide role ${role} must also be a valid viewer`);
  }
  for (const role of coverageReportAdminShellRoles) {
    assert.equal(coverageReportViewerRoles.has(role), true, `admin-shell role ${role} must also be a valid viewer`);
  }
}

// ── Regression test for the real bug this file's fix addresses: a viewer role
//    whose resolveNavigationMode() is "employee-portal" but is missing from
//    coverageReportAdminShellRoles (harmless — it has a working portal route),
//    OR whose navigationMode is "admin" but is missing from
//    coverageReportAdminShellRoles (a dead bounce — assertEmployeePortalMarketingPageAccess
//    redirects any non-"employee-portal"-navigationMode role away from every
//    /employee-portals/** page unconditionally, so the admin shell is its ONLY
//    possible route). This derives reachability from the real resolveNavigationMode()
//    function rather than a second hand-maintained role list, so it can't drift
//    the same way the original coverageReportAdminShellRoles set did.
export function runMarketingCoverageReportReachabilityTests() {
  for (const role of coverageReportViewerRoles) {
    const access = createAccessContext({ hrId: "TEST-1", role });
    const navigationMode = resolveNavigationMode(access);
    if (navigationMode === "employee-portal") {
      assert.equal(
        canUseEmployeePortalMarketingCoverageReport(role),
        true,
        `${role}'s navigationMode is employee-portal but it's not portal-visible`,
      );
    } else {
      assert.equal(
        canViewMarketingCoverageReportInAdminShell(role),
        true,
        `${role}'s navigationMode is "${navigationMode}" (not employee-portal), so it has no portal route — ` +
          `it must be in coverageReportAdminShellRoles or it has NO way to reach this report`,
      );
    }
  }
}
