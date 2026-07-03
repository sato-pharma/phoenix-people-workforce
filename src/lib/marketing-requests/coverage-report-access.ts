import type { PhoenixRole } from "@/lib/auth/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Coverage Report — role sets.
//
// Three DISTINCT sets, each answering a different question. Keep them separate:
// widening one must never silently widen another. Pinned by
// tests/marketing-coverage-report-access.test.ts.
//  - coverageReportViewerRoles: who may open the report at all (either shell).
//  - coverageReportCompanyWideRoles: who sees every request unrestricted, scoped
//    in src/lib/marketing-requests/coverage-report-scope.ts (deliberately NARROWER
//    than ROI Tracking's companyMarketingRoles — Finance Manager/Financial Advisor
//    are scoped to their own subtree here, unlike ROI Tracking).
//  - coverageReportAdminShellRoles: who reaches the report via the admin shell nav
//    (mirrors ROI Tracking's own admin-nav precedent: Super Admin + CEO only).
//    Every other unrestricted role (SFE Manager, Marketing Manager) still sees
//    everything unrestricted, but via the employee-portal shell instead.
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
]);

export const coverageReportAdminShellRoles = new Set<PhoenixRole>(["Super Admin", "CEO"]);

export function canViewMarketingCoverageReport(role: string | null | undefined): boolean {
  return Boolean(role) && coverageReportViewerRoles.has(role as PhoenixRole);
}

export function canViewMarketingCoverageReportInAdminShell(role: string | null | undefined): boolean {
  return Boolean(role) && coverageReportAdminShellRoles.has(role as PhoenixRole);
}
