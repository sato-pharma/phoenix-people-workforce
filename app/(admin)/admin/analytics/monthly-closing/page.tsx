import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsKpiCard } from "@/components/analytics/analytics-kpi-card";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadClosingByEmployee } from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { CLOSING_FILTERS } from "@/lib/analytics/sales-filter-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}

async function ClosingDashboardContent({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const filters = parseAnalyticsFilters(searchParams, CLOSING_FILTERS);

  const closingFilters = {
    period:       typeof filters.period       === "string" ? filters.period       : null,
    periodFrom:   typeof filters.periodFrom   === "string" ? filters.periodFrom   : null,
    periodTo:     typeof filters.periodTo     === "string" ? filters.periodTo     : null,
    lines:        Array.isArray(filters.lines)             ? filters.lines         : [],
    employeeHrId: typeof filters.employeeHrId === "string" ? filters.employeeHrId : null,
    territory:    typeof filters.territory    === "string" ? filters.territory    : null,
  };

  const rows = await loadClosingByEmployee(closingFilters).catch(() => []);

  const totalSales  = rows.reduce((s, r) => s + r.salesValue,  0);
  const totalTarget = rows.reduce((s, r) => s + r.targetValue, 0);
  const achievement = totalTarget > 0 ? (totalSales / totalTarget) * 100 : null;
  const empCount    = new Set(rows.map((r) => r.employeeHrId).filter(Boolean)).size;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <AnalyticsKpiCard label="Total Sales"      value={fmt(totalSales)}  prefix="EGP" />
        <AnalyticsKpiCard label="Total Target"     value={fmt(totalTarget)} prefix="EGP" />
        <AnalyticsKpiCard label="Achievement"      value={fmtPct(achievement)} />
        <AnalyticsKpiCard label="Employees"        value={String(empCount)} />
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">Employee Performance</h2>
        {rows.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["employeeName", "employeeHrId", "territory", "line"]}
            columns={[
              { key: "period",         label: "Period",      sortable: true },
              { key: "line",           label: "Line",        sortable: true },
              { key: "employeeHrId",   label: "HR ID",       sortable: true },
              { key: "employeeName",   label: "Name",        sortable: true },
              { key: "managerHrId",    label: "Manager" },
              { key: "territory",      label: "Territory",   sortable: true },
              { key: "salesValue",     label: "Sales",       align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "targetValue",    label: "Target",      align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "achievementPct", label: "Achiev %",    align: "right", sortable: true, format: (v) => fmtPct(v as number | null) },
            ]}
            rows={rows}
            totals={{ salesValue: totalSales, targetValue: totalTarget }}
          />
        )}
      </section>
    </div>
  );
}

export default async function MonthlyClosingAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Monthly Closing Analytics</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Employee-attributed sales vs target. Filter by period, line, employee, or territory.
        </p>
      </div>
      <Suspense fallback={<AppRouteLoadingState />}>
        <ClosingDashboardContent searchParams={resolvedParams} />
      </Suspense>
    </div>
  );
}
