import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsKpiCard } from "@/components/analytics/analytics-kpi-card";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklyFact } from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { WEEKLY_FILTERS } from "@/lib/analytics/sales-filter-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

async function WeeklyDashboardContent({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const filters = parseAnalyticsFilters(searchParams, WEEKLY_FILTERS);

  const weeklyFilters = {
    weekStart:    typeof filters.week         === "string" ? filters.week         : null,
    year:         typeof filters.year         === "string" ? Number(filters.year) : null,
    distributors: Array.isArray(filters.distributors) ? filters.distributors : [],
    lines:        Array.isArray(filters.lines)         ? filters.lines         : [],
    regions:      Array.isArray(filters.regions)       ? filters.regions       : [],
    products:     Array.isArray(filters.products)      ? filters.products      : [],
    families:     Array.isArray(filters.families)      ? filters.families      : [],
  };

  const rows = await loadWeeklyFact(weeklyFilters).catch(() => []);

  const totalSales  = rows.reduce((s, r) => s + r.salesValue, 0);
  const totalQty    = rows.reduce((s, r) => s + r.salesQty,   0);
  const totalStock  = rows.reduce((s, r) => s + r.stockQty,   0);
  const weekCount   = new Set(rows.map((r) => r.weekStart)).size;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <AnalyticsKpiCard label="Total Value"  value={fmt(totalSales)} prefix="EGP" />
        <AnalyticsKpiCard label="Sales Units"  value={fmt(totalQty)} />
        <AnalyticsKpiCard label="Stock Units"  value={fmt(totalStock)} />
        <AnalyticsKpiCard label="Weeks"        value={String(weekCount)} />
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">Weekly Sales Detail</h2>
        {rows.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["weekLabel", "distributorName", "regionName", "productName", "line", "family"]}
            columns={[
              { key: "weekLabel",       label: "Week",        sortable: true },
              { key: "distributorName", label: "Distributor", sortable: true },
              { key: "regionName",      label: "Region",      sortable: true },
              { key: "line",            label: "Line",        sortable: true },
              { key: "family",          label: "Family",      sortable: true },
              { key: "productName",     label: "Product",     sortable: true },
              { key: "salesQty",        label: "Sales Qty",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "salesValue",      label: "Value",       align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "stockQty",        label: "Stock Qty",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
            ]}
            rows={rows}
            totals={{ salesQty: totalQty, salesValue: totalSales, stockQty: totalStock }}
          />
        )}
      </section>
    </div>
  );
}

export default async function WeeklySalesAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Weekly Sales Analytics</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Distributor weekly sell-out and stock by region, branch, product, and line.
          Stock value is intentionally not tracked — units only.
        </p>
      </div>
      <Suspense fallback={<AppRouteLoadingState />}>
        <WeeklyDashboardContent searchParams={resolvedParams} />
      </Suspense>
    </div>
  );
}
