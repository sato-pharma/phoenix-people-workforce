import { redirect } from "next/navigation";

import { SalesOpsDashboard } from "@/components/sales-operations/sales-ops-dashboard";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listSalesOpsPeriods, loadSalesOpsDashboard, loadSalesOpsTrend } from "@/lib/sales-operations/dashboard";

export const dynamic = "force-dynamic";

// Rollup-backed dashboard — reads only the pre-aggregated sales_ops rollup tables (no live fact scans).
export default async function SalesOpsDashboardPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  try {
    await assertPermission(accessContext, "sales", "read");
  } catch {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  const { period: periodParam } = await searchParams;
  const periods = await listSalesOpsPeriods();
  const selected = periodParam && periods.includes(periodParam) ? periodParam : (periods[0] ?? null);
  const [data, trend] = await Promise.all([loadSalesOpsDashboard(selected), loadSalesOpsTrend()]);

  return (
    <div className="p-4">
      <SalesOpsDashboard data={data} trend={trend} periods={periods} selected={selected} />
    </div>
  );
}
