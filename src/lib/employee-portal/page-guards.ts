import { redirect } from "next/navigation";

import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  canUseEmployeePortalMarketingControl,
  canUseEmployeePortalMarketingCustomerDatabase,
  canUseEmployeePortalMarketingRequests,
} from "@/lib/employee-portal/navigation";

type EmployeePortalMarketingPage = "requests" | "control" | "customer-database";

export async function assertEmployeePortalMarketingPageAccess(page: EmployeePortalMarketingPage) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  const canAccess =
    page === "control"
      ? canUseEmployeePortalMarketingControl(access.role)
      : page === "customer-database"
        ? canUseEmployeePortalMarketingCustomerDatabase(access.role)
        : canUseEmployeePortalMarketingRequests(access.role);

  if (!canAccess) {
    redirect("/employee-portals");
  }

  return access;
}
