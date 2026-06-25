import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsKpiCard } from "@/components/analytics/analytics-kpi-card";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { AnalyticsDemoBanner } from "@/components/analytics/analytics-demo-banner";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  loadAnalyticsDimensions,
  loadSosByPeriod,
  loadSosByArea,
  loadSosByProduct,
  loadSosByLine,
  loadSosByCustomer,
  type AnalyticsDimensions,
  type SosKpiRow,
  type SosByAreaRow,
  type SosByProductRow,
  type SosByLineRow,
  type SosByCustomerRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_FILTERS } from "@/lib/analytics/sales-filter-config";
import { computePeriodDelta, shiftPeriod } from "@/lib/analytics/compare";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import {
  demoAnalyticsDimensions,
  demoSosByArea,
  demoSosByCustomer,
  demoSosByLine,
  demoSosByPeriod,
  demoSosByProduct,
} from "@/lib/analytics/demo-fixtures";
import { AnalyticsTrendChart } from "@/components/analytics/analytics-trend-chart";
import { StackedChart } from "@/components/charts/stacked-chart";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DONUT_COLORS = ["#F97316", "#0F172A", "#0EA5E9", "#10B981", "#8B5CF6", "#EF4444"];

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

async function SosDashboardContent({
  searchParams,
  role,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
}) {
  const demo = isAnalyticsDemoMode(searchParams);
  const filters = parseAnalyticsFilters(searchParams, SOS_FILTERS);
  const compareRaw = searchParams.compare;
  const compareMode = (Array.isArray(compareRaw) ? compareRaw[0] : compareRaw) === "1";

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
    clientCodes:  Array.isArray(filters.clientCodes)   ? filters.clientCodes   : [],
  };

  let byPeriod: SosKpiRow[];
  let byArea: SosByAreaRow[];
  let byProduct: SosByProductRow[];
  let byLine: SosByLineRow[];
  let byCustomer: SosByCustomerRow[];
  let dimensions: AnalyticsDimensions;
  let priorTotal: number | null = null;

  if (demo) {
    byPeriod = demoSosByPeriod();
    byArea = demoSosByArea();
    byProduct = demoSosByProduct();
    byLine = demoSosByLine();
    byCustomer = demoSosByCustomer();
    dimensions = demoAnalyticsDimensions();
  } else {
    [byPeriod, byArea, byProduct, byLine, byCustomer, dimensions] = await Promise.all([
      loadSosByPeriod(sosFilters).catch(() => []),
      loadSosByArea(sosFilters).catch(() => []),
      loadSosByProduct(sosFilters).catch(() => []),
      loadSosByLine(sosFilters).catch(() => []),
      loadSosByCustomer(sosFilters).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
    ]);

    if (sosFilters.period) {
      const priorPeriod = shiftPeriod(sosFilters.period, 1);
      const priorRows = await loadSosByPeriod({ ...sosFilters, period: priorPeriod, periodFrom: null, periodTo: null }).catch(() => []);
      priorTotal = priorRows.reduce((s, r) => s + r.value, 0);
    }
  }

  const totalValue   = byPeriod.reduce((s, r) => s + r.value, 0);
  const totalUnits   = byPeriod.reduce((s, r) => s + r.units, 0);
  const periodCount  = new Set(byPeriod.map((r) => r.period)).size;
  const productCount = new Set(byProduct.map((r) => r.productCode)).size;
  const delta = computePeriodDelta(totalValue, priorTotal);

  // Line totals across the filtered range — feeds both the contribution donut
  // and (when 2+ lines are selected with ?compare=1) the comparison table.
  const lineTotalsMap = new Map<string, { units: number; value: number }>();
  for (const r of byLine) {
    const cur = lineTotalsMap.get(r.line) ?? { units: 0, value: 0 };
    lineTotalsMap.set(r.line, { units: cur.units + r.units, value: cur.value + r.value });
  }
  const lineTotals = [...lineTotalsMap.entries()]
    .map(([line, totals]) => ({ line, ...totals }))
    .sort((a, b) => b.value - a.value);
  const lineDonutData = lineTotals.slice(0, 6).map((row, i) => ({
    name: row.line,
    value: row.value,
    color: DONUT_COLORS[i % DONUT_COLORS.length],
  }));

  const trendChartData = byPeriod.map((r) => ({ period: r.period, value: r.value }));

  const customerOptions = [...new Map(byCustomer.map((c) => [c.clientCode, c.clientCode])).keys()]
    .map((code) => ({ code, label: code }));

  return (
    <div className="space-y-6">
      {demo ? <AnalyticsDemoBanner /> : null}

      <AnalyticsFilterBar
        descriptors={SOS_FILTERS}
        values={filters}
        dimensions={dimensions}
        basePath="/admin/analytics/source-sales"
        customers={customerOptions}
      />

      {/* KPI bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <AnalyticsKpiCard label="Total Value" value={fmt(totalValue)} prefix="EGP" growth={delta.pct} />
        <AnalyticsKpiCard label="Total Units"  value={fmt(totalUnits)} />
        <AnalyticsKpiCard label="Periods"      value={String(periodCount)} />
        <AnalyticsKpiCard label="Products"     value={String(productCount)} />
      </div>

      {/* Trend + contribution charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="border border-border bg-card p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide mb-3">Value Trend by Period</h2>
          {trendChartData.length === 0 ? (
            <AnalyticsEmptyState />
          ) : (
            <AnalyticsTrendChart
              data={trendChartData}
              xAxisKey="period"
              layers={[{ key: "value", name: "Value", type: "line", color: "#F97316" }]}
            />
          )}
        </section>
        <section className="border border-border bg-card p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide mb-3">Line Contribution</h2>
          {lineDonutData.length === 0 ? (
            <AnalyticsEmptyState />
          ) : (
            <StackedChart data={lineDonutData} tooltipPrefix="EGP " />
          )}
        </section>
      </div>

      {compareMode && lineTotals.length >= 2 ? (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">Line Comparison</h2>
          <AnalyticsDataTable
            searchKeys={["line"]}
            columns={[
              { key: "line",  label: "Line",  sortable: true },
              { key: "units", label: "Units", align: "right", sortable: true, formatKind: "number" },
              { key: "value", label: "Value", align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={lineTotals}
          />
        </section>
      ) : null}

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
              { key: "units",      label: "Units",   align: "right", sortable: true, formatKind: "number" },
              { key: "bonusUnits", label: "Bonus",   align: "right",                 formatKind: "number" },
              { key: "value",      label: "Value",   align: "right", sortable: true, formatKind: "number" },
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
              { key: "units",      label: "Units",   align: "right", sortable: true, formatKind: "number" },
              { key: "value",      label: "Value",   align: "right", sortable: true, formatKind: "number" },
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
              { key: "units",       label: "Units",  align: "right", sortable: true, formatKind: "number" },
              { key: "value",       label: "Value",  align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={byProduct}
          />
        )}
      </section>

      {/* By Customer (presence) table */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">Customer Presence</h2>
        {byCustomer.length === 0 ? (
          <AnalyticsEmptyState message="No customer presence data for the current filters." />
        ) : (
          <AnalyticsDataTable
            searchKeys={["clientCode", "regionName", "line"]}
            columns={[
              { key: "period",        label: "Period",        sortable: true },
              { key: "clientCode",     label: "Customer Code", sortable: true },
              { key: "line",           label: "Line",          sortable: true },
              { key: "regionName",     label: "Region",        sortable: true },
              { key: "activeBatches",  label: "Active Batches", align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={byCustomer}
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
        <SosDashboardContent searchParams={resolvedParams} role={access.role} />
      </Suspense>
    </div>
  );
}
