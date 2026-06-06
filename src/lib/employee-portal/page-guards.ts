import { redirect } from "next/navigation";

import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  canUseEmployeePortalMarketingControl,
  canUseEmployeePortalMarketingCustomerDatabase,
  canUseEmployeePortalMarketingRequests,
  canUseEmployeePortalMarketingRoiTracking,
} from "@/lib/employee-portal/navigation";

type EmployeePortalMarketingPage = "requests" | "inbox" | "control" | "customer-database" | "roi-tracking";

export async function assertEmployeePortalMarketingPageAccess(page: EmployeePortalMarketingPage) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  const canAccess =
    page === "roi-tracking"
      ? canUseEmployeePortalMarketingRoiTracking(access.role)
      : page === "control"
        ? canUseEmployeePortalMarketingControl(access.role)
        : page === "customer-database"
          ? canUseEmployeePortalMarketingCustomerDatabase(access.role)
          : page === "inbox"
            ? canUseEmployeePortalMarketingRequests(access.role)
            : canUseEmployeePortalMarketingRequests(access.role);

  if (!canAccess) {
    redirect("/employee-portals");
  }

  return access;
}
