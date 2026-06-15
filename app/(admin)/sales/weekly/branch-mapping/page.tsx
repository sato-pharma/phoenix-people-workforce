import { redirect } from "next/navigation";

import { WeeklyBranchMappingManager } from "@/components/sales/weekly/weekly-branch-mapping-manager";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklyBranchRegionAdmin, type WeeklyBranchRegionAdmin } from "@/lib/sales/weekly/branch-region-map";

export const dynamic = "force-dynamic";

export default async function WeeklyBranchMappingPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  // Managing the branch->region map is an SFE/admin task — gated on weekly_sales:update.
  if (!(await canAccess(access, "weekly_sales", "update"))) redirect("/sales/weekly/dashboard");

  let initial: WeeklyBranchRegionAdmin | null = null;
  let initialError: string | null = null;
  try {
    initial = await loadWeeklyBranchRegionAdmin("IS", "any");
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load branch mapping.";
  }

  return <WeeklyBranchMappingManager initial={initial} initialError={initialError} />;
}
