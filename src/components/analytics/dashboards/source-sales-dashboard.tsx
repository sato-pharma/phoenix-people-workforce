import { Suspense } from "react";

import { AnalyticsKpiCard } from "@/components/analytics/analytics-kpi-card";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { AnalyticsDemoBanner } from "@/components/analytics/analytics-demo-banner";
import { AnalyticsModuleNav } from "@/components/analytics/analytics-module-nav";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { type PhoenixRole } from "@/lib/auth/permissions";
import { canViewHeadOfficeLine } from "@/lib/sales/access-scope";
import {
  loadAnalyticsDimensions,
  loadSosByPeriod,
  loadSosByLine,
  type AnalyticsDimensions,
  type SosKpiRow,
  type SosByLineRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_FILTERS } from "@/lib/analytics/sales-filter-config";
import { scopeAnalyticsFilters, scopeAnalyticsDimensions, computeAnalyticsFilterVisibility, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { computePeriodDelta, shiftPeriod } from "@/lib/analytics/compare";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import {
  demoAnalyticsDimensions,
  demoSosByLine,
  demoSosByPeriod,
} from "@/lib/analytics/demo-fixtures";
import { AnalyticsTrendChart } from "@/components/analytics/analytics-trend-chart";
import { StackedChart } from "@/components/charts/stacked-chart";
import { SOS_TABS } from "@/lib/analytics/module-nav-config";

// Shared Source-of-Sales analytics dashboard. Rendered at two mount points via `mountRoot`:
//   - admin  : /admin/analytics             (app/(admin)/admin/analytics/source-sales — admin shell)
//   - portal : /employee-portals/sales-analytics  (portal shell; scoped field roles)
// The mount only changes the URL the filter bar / module nav write to; the data, scope, and
// confidential locks are identical (access is enforced by each page's assertPermission + scope).

const DONUT_COLORS = ["#F97316", "#0F172A", "#0EA5E9", "#10B981", "#8B5CF6", "#EF4444"];

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

async function SosDashboardContent({
  searchParams,
  role,
  scope,
  mountRoot,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
  scope: AnalyticsViewerScope;
  mountRoot: string;
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
    canViewHeadOffice: canViewHeadOfficeLine(role),
  };
  // Per-viewer scope: fold the caller's allowed lines/regions/products into the query. Company-wide
  // viewers are a no-op; a viewer whose scope leaves nothing (scoped.empty) gets an empty result.
  const scoped = scopeAnalyticsFilters(sosFilters, scope);

  let byPeriod: SosKpiRow[];
  let byLine: SosByLineRow[];
  let dimensions: AnalyticsDimensions;
  let priorTotal: number | null = null;

  if (demo) {
    byPeriod = demoSosByPeriod();
    byLine = demoSosByLine();
    dimensions = demoAnalyticsDimensions();
  } else if (scoped.empty) {
    byPeriod = [];
    byLine = [];
    dimensions = await loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions());
  } else {
    [byPeriod, byLine, dimensions] = await Promise.all([
      loadSosByPeriod(scoped.filters).catch(() => []),
      loadSosByLine(scoped.filters).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
    ]);

    if (scoped.filters.period) {
      const priorPeriod = shiftPeriod(scoped.filters.period, 1);
      const priorRows = await loadSosByPeriod({ ...scoped.filters, period: priorPeriod, periodFrom: null, periodTo: null }).catch(() => []);
      priorTotal = priorRows.reduce((s, r) => s + r.value, 0);
    }
  }

  const totalValue   = byPeriod.reduce((s, r) => s + r.value, 0);
  const totalUnits   = byPeriod.reduce((s, r) => s + r.units, 0);
  const periodCount  = new Set(byPeriod.map((r) => r.period)).size;
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

  return (
    <div className="space-y-6">
      {demo ? <AnalyticsDemoBanner /> : null}

      <AnalyticsFilterBar
        descriptors={SOS_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/source-sales`}
        comparable
      />

      {/* KPI bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <AnalyticsKpiCard label="Total Value" value={fmt(totalValue)} prefix="EGP" growth={delta.pct} />
        <AnalyticsKpiCard label="Total Units"  value={fmt(totalUnits)} />
        <AnalyticsKpiCard label="Periods"      value={String(periodCount)} />
      </div>

      {/* Trend + contribution charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AnalyticsSection title="Value Trend by Period">
          {trendChartData.length === 0 ? (
            <AnalyticsEmptyState />
          ) : (
            <AnalyticsTrendChart
              data={trendChartData}
              xAxisKey="period"
              layers={[{ key: "value", name: "Value", type: "line", color: "#F97316" }]}
            />
          )}
        </AnalyticsSection>
        <AnalyticsSection title="Line Contribution">
          {lineDonutData.length === 0 ? (
            <AnalyticsEmptyState />
          ) : (
            <StackedChart data={lineDonutData} tooltipPrefix="EGP " />
          )}
        </AnalyticsSection>
      </div>

      {compareMode && lineTotals.length >= 2 ? (
        <AnalyticsSection title="Line Comparison" count={lineTotals.length}>
          <AnalyticsDataTable
            searchKeys={["line"]}
            columns={[
              { key: "line",  label: "Line",  sortable: true },
              { key: "units", label: "Units", align: "right", sortable: true, formatKind: "number" },
              { key: "value", label: "Value", align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={lineTotals}
            exportTitle="SoS — Line Comparison"
            exportSubtitle="Units and value by line, current filter selection"
          />
        </AnalyticsSection>
      ) : null}

      <AnalyticsSection title="Trend by Period" count={byPeriod.length}>
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
            exportTitle="SoS Trend by Period"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export function SourceSalesDashboard({
  searchParams,
  role,
  scope,
  mountRoot,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
  scope: AnalyticsViewerScope;
  mountRoot: string;
}) {
  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="w-1 h-12 bg-[#F97316] shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#F97316] mb-0.5">SoS</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Source of Sales Analytics</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Distributor invoice aggregates — bricks, areas, regions, products, families, lines, distributors.
            Confidential products excluded unless you have CEO / Super Admin access.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={SOS_TABS} mountRoot={mountRoot} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <SosDashboardContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
