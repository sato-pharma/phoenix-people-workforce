import { redirect } from "next/navigation";

import { MonthlySalesDashboard } from "@/components/sales/monthly-sales-dashboard";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSalesDashboard } from "@/lib/sales/service";
import type { SalesDashboardData } from "@/lib/sales/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function MonthlySalesDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  if (!(await canAccess(access, "sales", "read"))) redirect("/admin/access");
  // Owner, 2026-08-11: revoked for the Finance Manager at the PAGE, not just the sidebar. These
  // three had been hidden from his navigation only, which a live role sweep showed still rendered
  // them on a typed or bookmarked URL — hidden is not revoked. He keeps Monthly Closing and the
  // Marketing Inbox; what goes is sales-management reporting and the legacy Excel ROI set.
  // His `sales:read` satisfies the check above, so this must be its own clause.
  if (access.role === "Finance Manager") redirect("/admin/finance-command-center");

  let initialData: SalesDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getSalesDashboard({}, access);
  } catch (caught) {
    initialError = caught instanceof Error ? caught.message : "Failed to load monthly sales dashboard.";
  }

  return <MonthlySalesDashboard initialData={initialData} initialError={initialError} />;
}
