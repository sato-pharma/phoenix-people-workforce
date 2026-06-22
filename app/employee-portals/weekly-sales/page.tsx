import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { WeeklyMiniDashboardView } from "@/components/sales/weekly/weekly-mini-dashboard-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import type { WeeklyDashboard } from "@/lib/sales/weekly/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sales Intelligence section is Product / Group Product Managers only. resolveWeeklyAccessScope
// returns the product tier (their assigned product codes from weekly_sales_product_scope), and
// applyWeeklyAccessScope inside loadWeeklyDashboard keeps only those products and strips
// confidential codes (LA003/LA004/SS001).
const WEEKLY_PORTAL_ROLES = new Set(["Product Manager", "Group Product Manager", "Marketing Manager"]);

export default async function PortalWeeklySalesPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!WEEKLY_PORTAL_ROLES.has(access.role) || !(await canAccess(access, "weekly_sales", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  let dashboard: WeeklyDashboard | null = null;
  let error: string | null = null;
  try {
    const accessScope = await resolveWeeklyAccessScope(access);
    dashboard = await loadWeeklyDashboard({ accessScope });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Failed to load your weekly sales.";
  }

  return (
    <EmployeePortalPageShell
      badge="Sales Intelligence"
      description="Your products' weekly sales — value, units, stock, week-over-week trend, and top branches."
      errorBoundaryTitle="Weekly Sales unavailable"
      title="Weekly Sales"
    >
      <WeeklyMiniDashboardView initial={dashboard} initialError={error} />
    </EmployeePortalPageShell>
  );
}
