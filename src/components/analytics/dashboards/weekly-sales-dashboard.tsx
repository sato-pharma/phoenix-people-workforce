import { Suspense } from "react";

import { emptyAnalyticsDimensions, trackFailure } from "@/lib/analytics/load-result";
import { AnalyticsErrorState } from "@/components/analytics/analytics-error-state";
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
  loadWeeklyFact,
  type AnalyticsDimensions,
  type WeeklyFactRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { WEEKLY_FILTERS } from "@/lib/analytics/sales-filter-config";
import { scopeAnalyticsFilters, scopeAnalyticsDimensions, computeAnalyticsFilterVisibility, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { computePeriodDelta, shiftWeek } from "@/lib/analytics/compare";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoWeeklyFact } from "@/lib/analytics/demo-fixtures";
import { AnalyticsTrendChart } from "@/components/analytics/analytics-trend-chart";
import { WEEKLY_TABS } from "@/lib/analytics/module-nav-config";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

// Shared Weekly-Sales analytics dashboard. Rendered at two mount points via `mountRoot`:
//   - admin  : /admin/analytics             (app/(admin)/admin/analytics/weekly-sales — admin shell)
//   - portal : /employee-portals/sales-analytics  (portal shell; scoped field roles)
// The mount only changes the URL the filter bar / module nav write to; the data, scope, and
// confidential locks are identical (access is enforced by each page's assertPermission + scope).

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

async function WeeklyDashboardContent({
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
  // Loads that fail are recorded here, never silently rendered as a zero.
  const analyticsFailures: string[] = [];
  const filters = parseAnalyticsFilters(searchParams, WEEKLY_FILTERS);
  const compareRaw = searchParams.compare;
  const compareMode = (Array.isArray(compareRaw) ? compareRaw[0] : compareRaw) === "1";

  const weeklyFilters = {
    weekStart:    Array.isArray(filters.week)         ? filters.week         : [],
    year:         Array.isArray(filters.year)         ? filters.year.map(Number) : [],
    distributors: Array.isArray(filters.distributors) ? filters.distributors : [],
    lines:        Array.isArray(filters.lines)         ? filters.lines         : [],
    regions:      Array.isArray(filters.regions)       ? filters.regions       : [],
    products:     Array.isArray(filters.products)      ? filters.products      : [],
    families:     Array.isArray(filters.families)      ? filters.families      : [],
    canViewHeadOffice: canViewHeadOfficeLine(role),
  };
  const scoped = scopeAnalyticsFilters(weeklyFilters, scope);

  let rows: WeeklyFactRow[];
  let dimensions: AnalyticsDimensions;
  let priorTotal: number | null = null;

  if (demo) {
    rows = demoWeeklyFact();
    dimensions = demoAnalyticsDimensions();
  } else if (scoped.empty) {
    rows = [];
    dimensions = await loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions()));
  } else {
    [rows, dimensions] = await Promise.all([
      loadWeeklyFact(scoped.filters).catch(trackFailure(analyticsFailures, "Weekly sales", [])),
      loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions())),
    ]);

    if (scoped.filters.weekStart?.length === 1) {
      const priorWeek = shiftWeek(scoped.filters.weekStart[0], 1);
      const priorRows = await loadWeeklyFact({ ...scoped.filters, weekStart: [priorWeek] }).catch(trackFailure(analyticsFailures, "Weekly sales", []));
      priorTotal = priorRows.reduce((s, r) => s + r.salesValue, 0);
    }
  }

  const totalSales  = rows.reduce((s, r) => s + r.salesValue, 0);
  const totalQty    = rows.reduce((s, r) => s + r.salesQty,   0);
  const totalStock  = rows.reduce((s, r) => s + r.stockQty,   0);
  const weekCount   = new Set(rows.map((r) => r.weekStart)).size;
  const delta = computePeriodDelta(totalSales, priorTotal);

  const weekTotalsMap = new Map<string, { weekLabel: string; salesValue: number }>();
  for (const r of rows) {
    const cur = weekTotalsMap.get(r.weekStart) ?? { weekLabel: r.weekLabel, salesValue: 0 };
    weekTotalsMap.set(r.weekStart, { weekLabel: cur.weekLabel, salesValue: cur.salesValue + r.salesValue });
  }
  const weekTrend = [...weekTotalsMap.entries()]
    .map(([weekStart, totals]) => ({ weekStart, ...totals }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  const distributorTotalsMap = new Map<string, { distributorName: string; salesValue: number }>();
  for (const r of rows) {
    const cur = distributorTotalsMap.get(r.distributorCode) ?? { distributorName: r.distributorName, salesValue: 0 };
    distributorTotalsMap.set(r.distributorCode, { distributorName: cur.distributorName, salesValue: cur.salesValue + r.salesValue });
  }
  const distributorTotals = [...distributorTotalsMap.entries()]
    .map(([distributorCode, totals]) => ({ distributorCode, ...totals }))
    .sort((a, b) => b.salesValue - a.salesValue);

  return (
    <div className="space-y-6">
      {demo ? <AnalyticsDemoBanner /> : null}
      {analyticsFailures.length > 0 ? <AnalyticsErrorState what={analyticsFailures.join(", ")} /> : null}

      <AnalyticsFilterBar
        descriptors={WEEKLY_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/weekly-sales`}
        comparable
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <AnalyticsKpiCard label="Total Value"  value={fmt(totalSales)} prefix="EGP" growth={delta.pct} />
        <AnalyticsKpiCard label="Sales Units"  value={fmt(totalQty)} />
        <AnalyticsKpiCard label="Stock Units"  value={fmt(totalStock)} />
        <AnalyticsKpiCard label="Weeks"        value={String(weekCount)} />
      </div>

      <AnalyticsSection title="Value Trend by Week">
        {weekTrend.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsTrendChart
            data={weekTrend.map((r) => ({ week: r.weekLabel, value: r.salesValue }))}
            xAxisKey="week"
            layers={[{ key: "value", name: "Value", type: "line", color: "#F97316" }]}
          />
        )}
      </AnalyticsSection>

      {compareMode && distributorTotals.length >= 2 ? (
        <AnalyticsSection title="Distributor Comparison" count={distributorTotals.length}>
          <AnalyticsDataTable
            searchKeys={["distributorName"]}
            columns={[
              { key: "distributorName", label: "Distributor", sortable: true },
              { key: "salesValue",      label: "Value",       align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={distributorTotals}
            exportTitle="Weekly — Distributor Comparison"
            exportSubtitle="Value by distributor, current filter selection"
          />
        </AnalyticsSection>
      ) : null}

      <AnalyticsSection title="Weekly Sales Detail" count={rows.length}>
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
              { key: "salesQty",        label: "Sales Qty",   align: "right", sortable: true, formatKind: "number" },
              { key: "salesValue",      label: "Value",       align: "right", sortable: true, formatKind: "number" },
              { key: "stockQty",        label: "Stock Qty",   align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={rows}
            totals={{ salesQty: totalQty, salesValue: totalSales, stockQty: totalStock }}
            exportTitle="Weekly Sales Overview"
            exportSubtitle="Weekly sell-out and stock detail"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export function WeeklySalesDashboard({
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
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Weekly</p>
          <h1 className={pageHeaderTitleClassName}>Weekly Sales Analytics</h1>
          <p className={pageHeaderDescriptionClassName}>
            Distributor weekly sell-out and stock by region, branch, product, and line.
            Stock value is intentionally not tracked — units only.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={WEEKLY_TABS} mountRoot={mountRoot} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <WeeklyDashboardContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
