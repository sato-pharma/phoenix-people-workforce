import { redirect } from "next/navigation";

import { resolveAccessContextFromPage } from "@/lib/auth/server";

export async function assertMarketingAdminPageAccess(options?: { customerDatabase?: boolean }) {
  const access = await resolveAccessContextFromPage();

  if (options?.customerDatabase) {
    if (access.role !== "Super Admin") redirect("/admin/marketing-requests");
    return access;
  }

  if (access.role !== "SFE Manager" && access.role !== "Super Admin") {
    redirect("/employee-portals/marketing-requests");
  }

  return access;
}
