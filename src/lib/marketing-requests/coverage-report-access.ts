import type { PhoenixRole } from "@/lib/auth/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Coverage Report — role sets.
//
// Three DISTINCT sets, each answering a different question. Keep them separate:
// widening one must never silently widen another. Pinned by
// tests/marketing-coverage-report-access.test.ts.
//  - coverageReportViewerRoles: who may open the report at all (either shell).
//  - coverageReportCompanyWideRoles: who sees every request unrestricted, scoped
//    in src/lib/marketing-requests/coverage-report-scope.ts. The SAME six roles as
//    ROI Tracking's companyMarketingRoles (owner, 2026-10-09). It once left out the
//    Finance Manager and Financial Advisor, so the Finance Manager opened a report
//    reading 0 of 52 requests while ROI Tracking — and its View Sales, which shows
//    the same pharmacies and sales — gave him all 52. Narrowing hid nothing and
//    left him an empty page.
//  - coverageReportAdminShellRoles: who reaches the report's PAGE via the admin
//    shell — this must be every viewer role whose resolveNavigationMode() is
//    "admin" (CEO, Super Admin, and the adminShellEmployeeRoles subset: SFE
//    Manager, Finance Manager, Financial Advisor), or that role has NO working
//    route at all: assertEmployeePortalMarketingPageAccess unconditionally
//    redirects any non-"employee-portal"-navigationMode role away from every
//    /employee-portals/** page, admin-shell-side or not. Mirrors ROI Tracking's
//    own actual page gate (assertMarketingAdminPageAccess({allowCompanyOversight:
//    true})), which is broader than its admin-nav SIDEBAR LINK's role list
//    (Super Admin + CEO only, kept narrow for discoverability — Modules Control
//    can grant a visible link to the other roles per-user, same as ROI Tracking).
// ─────────────────────────────────────────────────────────────────────────────

export const coverageReportViewerRoles = new Set<PhoenixRole>([
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
]);

export const coverageReportCompanyWideRoles = new Set<PhoenixRole>([
  "CEO",
  "Super Admin",
  "SFE Manager",
  "Marketing Manager",
  "Finance Manager",
  "Financial Advisor",
]);

export const coverageReportAdminShellRoles = new Set<PhoenixRole>([
  "Super Admin",
  "CEO",
  "SFE Manager",
  "Finance Manager",
  "Financial Advisor",
]);

export function canViewMarketingCoverageReport(role: string | null | undefined): boolean {
  return Boolean(role) && coverageReportViewerRoles.has(role as PhoenixRole);
}

export function canViewMarketingCoverageReportInAdminShell(role: string | null | undefined): boolean {
  return Boolean(role) && coverageReportAdminShellRoles.has(role as PhoenixRole);
}
