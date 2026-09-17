import { redirect } from "next/navigation";

import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  canUseEmployeePortalMarketingAllRequests,
  canUseEmployeePortalMarketingControl,
  canUseEmployeePortalMarketingCoverageReport,
  canUseEmployeePortalMarketingCustomerDatabase,
  canUseEmployeePortalMarketingRequests,
  canUseEmployeePortalMarketingRoiTracking,
  canUseEmployeePortalMarketingValidation,
} from "@/lib/employee-portal/navigation";

type EmployeePortalMarketingPage =
  | "requests"
  | "validation"
  | "inbox"
  | "control"
  | "customer-database"
  | "roi-tracking"
  | "coverage-report"
  | "all";

export async function assertEmployeePortalMarketingPageAccess(page: EmployeePortalMarketingPage) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  const canAccess =
    page === "all"
      ? canUseEmployeePortalMarketingAllRequests(access.role)
      // Customer Validation is its own key since 2026-09-18 — the Medical Rep keeps the capture
      // screen while "requests" and "inbox" are closed to them (owner instruction).
      : page === "validation"
      ? canUseEmployeePortalMarketingValidation(access.role)
      : page === "roi-tracking"
      ? canUseEmployeePortalMarketingRoiTracking(access.role)
      : page === "coverage-report"
        ? canUseEmployeePortalMarketingCoverageReport(access.role)
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
