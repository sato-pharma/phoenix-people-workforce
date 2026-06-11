import { redirect } from "next/navigation";

import { WeeklyDashboardView } from "@/components/sales/weekly/weekly-dashboard-view";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import type { WeeklyDashboard } from "@/lib/sales/weekly/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function WeeklySalesDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  if (!(await canAccess(access, "weekly_sales", "read"))) redirect("/admin/access");

  let dashboard: WeeklyDashboard | null = null;
  let error: string | null = null;
  try {
    const accessScope = await resolveWeeklyAccessScope(access);
    dashboard = await loadWeeklyDashboard({ accessScope });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Failed to load the weekly dashboard.";
  }

  return <WeeklyDashboardView initial={dashboard} initialError={error} />;
}
