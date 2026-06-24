import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsKpiCard } from "@/components/analytics/analytics-kpi-card";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadSosByPeriod, loadSosByArea, loadSosByProduct } from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_FILTERS } from "@/lib/analytics/sales-filter-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

async function SosDashboardContent({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const filters = parseAnalyticsFilters(searchParams, SOS_FILTERS);

  const sosFilters = {
    period:       typeof filters.period      === "string" ? filters.period      : null,
    periodFrom:   typeof filters.periodFrom  === "string" ? filters.periodFrom  : null,
    periodTo:     typeof filters.periodTo    === "string" ? filters.periodTo    : null,
    channel:      typeof filters.channel     === "string" ? filters.channel     : null,
    distributors: Array.isArray(filters.distributors) ? filters.distributors : [],
    lines:        Array.isArray(filters.lines)         ? filters.lines         : [],
    regions:      Array.isArray(filters.regions)       ? filters.regions       : [],
    areas:        Array.isArray(filters.areas)         ? filters.areas         : [],
    products:     Array.isArray(filters.products)      ? filters.products      : [],
    families:     Array.isArray(filters.families)      ? filters.families      : [],
  };

  const [byPeriod, byArea, byProduct] = await Promise.all([
    loadSosByPeriod(sosFilters).catch(() => []),
    loadSosByArea(sosFilters).catch(() => []),
    loadSosByProduct(sosFilters).catch(() => []),
  ]);

  const totalValue   = byPeriod.reduce((s, r) => s + r.value, 0);
  const totalUnits   = byPeriod.reduce((s, r) => s + r.units, 0);
  const periodCount  = new Set(byPeriod.map((r) => r.period)).size;
  const productCount = new Set(byProduct.map((r) => r.productCode)).size;

  return (
    <div className="space-y-6">
      {/* KPI bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <AnalyticsKpiCard label="Total Value"  value={fmt(totalValue)}  prefix="EGP" />
        <AnalyticsKpiCard label="Total Units"  value={fmt(totalUnits)} />
        <AnalyticsKpiCard label="Periods"      value={String(periodCount)} />
        <AnalyticsKpiCard label="Products"     value={String(productCount)} />
      </div>

      {/* By Period table */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">Trend by Period</h2>
        {byPeriod.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            caption="Monthly sales value and units"
            searchKeys={["period", "channel"]}
            columns={[
              { key: "period",     label: "Period",  sortable: true },
              { key: "channel",    label: "Channel", sortable: true },
              { key: "units",      label: "Units",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "bonusUnits", label: "Bonus",   align: "right",                 format: (v) => fmt(Number(v)) },
              { key: "value",      label: "Value",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
            ]}
            rows={byPeriod}
            totals={{ units: totalUnits, value: totalValue }}
          />
        )}
      </section>

      {/* By Area table */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">By Region / Area</h2>
        {byArea.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["regionName", "areaName"]}
            columns={[
              { key: "period",     label: "Period",  sortable: true },
              { key: "regionName", label: "Region",  sortable: true },
              { key: "areaName",   label: "Area",    sortable: true },
              { key: "channel",    label: "Channel" },
              { key: "units",      label: "Units",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "value",      label: "Value",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
            ]}
            rows={byArea}
          />
        )}
      </section>

      {/* By Product table */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">By Product</h2>
        {byProduct.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["productName", "family", "line"]}
            columns={[
              { key: "period",      label: "Period",   sortable: true },
              { key: "line",        label: "Line",     sortable: true },
              { key: "family",      label: "Family",   sortable: true },
              { key: "productName", label: "Product",  sortable: true },
              { key: "channel",     label: "Channel" },
              { key: "units",       label: "Units",  align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "value",       label: "Value",  align: "right", sortable: true, format: (v) => fmt(Number(v)) },
            ]}
            rows={byProduct}
          />
        )}
      </section>
    </div>
  );
}

export default async function SourceSalesAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Source of Sales Analytics</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Distributor invoice aggregates — bricks, areas, regions, products, families, lines, distributors.
          Confidential products excluded unless you have CEO / Super Admin access.
        </p>
      </div>

      <Suspense fallback={<AppRouteLoadingState />}>
        <SosDashboardContent searchParams={resolvedParams} />
      </Suspense>
    </div>
  );
}
