import { redirect } from "next/navigation";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  canAccessMarketingAdminPage,
  type MarketingAdminPageOptions,
} from "@/lib/marketing-requests/admin-page-access";
import { canViewMarketingCoverageReportInAdminShell } from "@/lib/marketing-requests/coverage-report-access";

/**
 * Page guard for the marketing admin-shell surfaces.
 *
 * The role matrix itself lives in @/lib/marketing-requests/admin-page-access (documented there,
 * pinned by tests/ceo-marketing-approval-inbox.test.ts) — this wrapper only resolves the request's
 * access context and turns a denial into a redirect.
 *
 * Note the redirect target: an admin-shell-only role sent to /employee-portals/marketing-requests
 * is bounced straight back out to /overview by assertEmployeePortalMarketingPageAccess. So a role
 * missing from the matrix does not get a degraded page — it gets no page. Add the role rather than
 * assuming the fallback catches it.
 */
export async function assertMarketingAdminPageAccess(options?: MarketingAdminPageOptions) {
  const access = await resolveAccessContextFromPage();

  if (options?.customerDatabase || options?.systemAdministratorOnly) {
    if (!canAccessSystemAdministratorWorkspace(access)) redirect("/admin/marketing-requests");
    return access;
  }

  if (!canAccessMarketingAdminPage(access.role, options)) {
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
