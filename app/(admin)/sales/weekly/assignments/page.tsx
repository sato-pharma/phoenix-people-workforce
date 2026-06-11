import { redirect } from "next/navigation";

import { WeeklyScopeManager } from "@/components/sales/weekly/weekly-scope-manager";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklyProductScopeAdmin } from "@/lib/sales/weekly/service";
import type { WeeklyProductScopeAdmin } from "@/lib/sales/weekly/types";

export const dynamic = "force-dynamic";

export default async function WeeklySalesAssignmentsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  // Managing product access is an SFE/admin task — gated on weekly_sales:update.
  if (!(await canAccess(access, "weekly_sales", "update"))) redirect("/sales/weekly/dashboard");

  let initial: WeeklyProductScopeAdmin | null = null;
  let initialError: string | null = null;
  try {
    initial = await loadWeeklyProductScopeAdmin();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load product access.";
  }

  return <WeeklyScopeManager initial={initial} initialError={initialError} />;
}
