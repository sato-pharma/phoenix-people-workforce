import { redirect } from "next/navigation";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export async function assertMarketingAdminPageAccess(options?: { customerDatabase?: boolean; systemAdministratorOnly?: boolean }) {
  const access = await resolveAccessContextFromPage();

  if (options?.customerDatabase || options?.systemAdministratorOnly) {
    if (!canAccessSystemAdministratorWorkspace(access)) redirect("/admin/marketing-requests");
    return access;
  }

  if (
    access.role !== "SFE Manager" &&
    access.role !== "Super Admin" &&
    access.role !== "Marketing Manager" &&
    access.role !== "Product Manager" &&
    access.role !== "Group Product Manager"
  ) {
    redirect("/employee-portals/marketing-requests");
  }

  return access;
}
