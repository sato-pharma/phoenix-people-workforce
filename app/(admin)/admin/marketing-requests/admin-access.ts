import { redirect } from "next/navigation";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewMarketingCoverageReportInAdminShell } from "@/lib/marketing-requests/coverage-report-access";

export async function assertMarketingAdminPageAccess(options?: {
  customerDatabase?: boolean;
  systemAdministratorOnly?: boolean;
  /**
   * Read-only ROI surfaces (ROI Tracking + its View Sales drill-down) additionally admit the
   * company-wide oversight roles — most importantly the CEO, the executive audience the ROI
   * report is built for. These roles are already treated as company-wide by the ROI service
   * (companyMarketingRoles), so this only aligns the page guard with the data layer; it does
   * NOT widen access to the marketing workflow pages (validation / requests / inbox).
   */
  allowCompanyOversight?: boolean;
}) {
  const access = await resolveAccessContextFromPage();

  if (options?.customerDatabase || options?.systemAdministratorOnly) {
    if (!canAccessSystemAdministratorWorkspace(access)) redirect("/admin/marketing-requests");
    return access;
  }

  const allowed = new Set<string>([
    "SFE Manager",
    "Super Admin",
    "Marketing Manager",
    "Product Manager",
    "Group Product Manager",
  ]);
  if (options?.allowCompanyOversight) {
    allowed.add("CEO");
    allowed.add("Finance Manager");
    allowed.add("Financial Advisor");
  }
  if (!allowed.has(access.role)) {
    redirect("/employee-portals/marketing-requests");
  }

  return access;
}

/**
 * The Marketing Coverage Report's admin-shell gate is intentionally narrower
 * than assertMarketingAdminPageAccess's role sets (which are shaped for the
 * workflow pages) — mirrors ROI Tracking's own admin-nav precedent (Super Admin
 * + CEO only). Every other unrestricted role (SFE Manager, Marketing Manager)
 * still sees the same unrestricted data, just via the employee-portal shell.
 */
export async function assertMarketingCoverageReportAdminPageAccess() {
  const access = await resolveAccessContextFromPage();
  if (!canViewMarketingCoverageReportInAdminShell(access.role)) {
    redirect("/employee-portals/marketing-requests/coverage-report");
  }
  return access;
}
