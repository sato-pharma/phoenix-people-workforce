import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { WeeklyStockDashboard } from "@/components/sales/weekly/weekly-stock-dashboard";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklyStockDashboard, type WeeklyStockPayload } from "@/lib/sales/weekly/stock-dashboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function AdminWeeklyStockContent({ access }: { access: AccessContext }) {
  let payload: WeeklyStockPayload | null = null;
  let loadError: string | null = null;
  try {
    payload = await loadWeeklyStockDashboard({}, access);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load Weekly Stock.";
  }

  if (payload) {
    return <WeeklyStockDashboard initial={payload} feedPath="/api/sales/weekly/stock" exportPath="/api/sales/weekly/stock/export" />;
  }

  return (
    <div className="border border-amber-200 bg-amber-50 px-5 py-4">
      <p className="text-sm font-black text-amber-900">Weekly Stock unavailable</p>
      <p className="mt-1 text-xs font-medium text-amber-800">
        {loadError ?? "No Weekly Stock data is available yet. This is a data-source state, not a zero."}
      </p>
    </div>
  );
}

export default async function AdminWeeklyStockPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/weekly-stock");
  if (!(await canAccess(access, "weekly_sales", "read"))) redirect("/admin/access");

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-6">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Weekly Sales · Stock</p>
          <h1 className={pageHeaderTitleClassName}>Weekly Stock</h1>
          <p className={pageHeaderDescriptionClassName}>
            Stock on hand for every product at every depot, from each distributor&apos;s latest stock file, with weeks of cover from
            recent sales. Totals across products are values.
          </p>
        </div>
      </div>

      <Suspense fallback={<AppRouteLoadingState title="Loading Weekly Stock" description="Reading the latest stock files." />}>
        <AdminWeeklyStockContent access={access} />
      </Suspense>
    </div>
  );
}
