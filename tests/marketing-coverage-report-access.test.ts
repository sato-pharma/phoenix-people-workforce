import assert from "node:assert/strict";

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

  // ── Pin the exact 2-role admin-shell set (mirrors ROI Tracking's own admin-nav precedent).
  assert.deepEqual(
    Array.from(coverageReportAdminShellRoles).sort(),
    ["CEO", "Super Admin"].sort(),
    "admin shell must be exactly CEO + Super Admin",
  );
  assert.equal(canViewMarketingCoverageReportInAdminShell("SFE Manager"), false, "SFE Manager reaches the report via the portal shell, not admin");
  assert.equal(canViewMarketingCoverageReportInAdminShell("Marketing Manager"), false, "Marketing Manager reaches the report via the portal shell, not admin");
  assert.equal(canViewMarketingCoverageReportInAdminShell("CEO"), true);
  assert.equal(canViewMarketingCoverageReportInAdminShell("Super Admin"), true);

  // ── Role-parity invariant: every admin-shell role must be a company-wide role
  //    (an admin-shell viewer must never land in a scoped-down view with no
  //    portal fallback), and every company-wide role must be a valid viewer.
  for (const role of coverageReportAdminShellRoles) {
    assert.equal(coverageReportCompanyWideRoles.has(role), true, `admin-shell role ${role} must also be company-wide`);
  }
  for (const role of coverageReportCompanyWideRoles) {
    assert.equal(coverageReportViewerRoles.has(role), true, `company-wide role ${role} must also be a valid viewer`);
  }
}
