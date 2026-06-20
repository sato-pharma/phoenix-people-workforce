import { redirect } from "next/navigation";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

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
