import { ExpenseRouteMap } from "@/components/geo/expense-route-map";
import { GeoFilters } from "@/components/geo/geo-filters";
import { TripAnomalyTable } from "@/components/geo/trip-anomaly-table";
import { AppShell } from "@/components/layout/app-shell";
import { Card } from "@/components/ui/card";
import { redirect } from "next/navigation";

import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getGeoDashboardData } from "@/lib/geo-intelligence/service";

export const dynamic = "force-dynamic";

export default async function GeoExpenseRoutesPage(
  props: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "geo_intelligence", "read")) {
    redirect("/employee-portals");
  }
  const searchParams = await props.searchParams;
  const data = await getGeoDashboardData(access, {
    area: typeof searchParams.area === "string" ? searchParams.area : null,
    employeeHrId:
      typeof searchParams.employeeHrId === "string" ? searchParams.employeeHrId : null,
    line: typeof searchParams.line === "string" ? searchParams.line : null,
    month: typeof searchParams.month === "string" ? searchParams.month : null,
    status: typeof searchParams.status === "string" ? searchParams.status as "" | "normal" | "review_required" | "high_risk" : "",
  });

  return (
    <AppShell showTopbar={false}>
      <div className="space-y-6">
        <Card className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-orange-500">
            Geo Intelligence
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.05em] text-slate-950">
            Expense Routes
          </h1>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            Validate claimed expenses against Google route distance, travel time, and expected cost per kilometer.
          </p>
        </Card>
        <GeoFilters current={data.filters} options={data.filterOptions} />
        <ExpenseRouteMap routes={data.expenseRoutes} />
        <TripAnomalyTable routes={data.expenseRoutes.slice(0, 50)} title="Route validation details" />
      </div>
    </AppShell>
  );
}
