import { Suspense } from "react";

import { emptyAnalyticsDimensions, trackFailure } from "@/lib/analytics/load-result";
import { AnalyticsErrorState } from "@/components/analytics/analytics-error-state";
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
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoWeeklyFact } from "@/lib/analytics/demo-fixtures";
import { WEEKLY_TABS } from "@/lib/analytics/module-nav-config";

// Shared Weekly-Sales full-detail analytics dashboard. Rendered at two mount points via `mountRoot`:
//   - admin  : /admin/analytics             (app/(admin)/admin/analytics/weekly-sales/detail — admin shell)
//   - portal : /employee-portals/sales-analytics  (portal shell; scoped field roles)
// The mount only changes the URL the filter bar / module nav write to; the data, scope, and
// confidential locks are identical (access is enforced by each page's assertPermission + scope).

async function WeeklyDetailContent({
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
  }

  const totalSales = rows.reduce((s, r) => s + r.salesValue, 0);
  const totalQty   = rows.reduce((s, r) => s + r.salesQty,   0);
  const totalStock = rows.reduce((s, r) => s + r.stockQty,   0);

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}
      {analyticsFailures.length > 0 ? <AnalyticsErrorState what={analyticsFailures.join(", ")} /> : null}

      <AnalyticsFilterBar
        descriptors={WEEKLY_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/weekly-sales/detail`}
      />

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
              { key: "salesValue",      label: "Value (EGP)", align: "right", sortable: true, formatKind: "number" },
              { key: "stockQty",        label: "Stock Qty",   align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={rows}
            totals={{ salesQty: totalQty, salesValue: totalSales, stockQty: totalStock }}
            exportTitle="Weekly Sales Detail"
            exportSubtitle="Full weekly sell-out and stock detail"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export function WeeklySalesDetailDashboard({
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
        <div className="w-1 h-12 bg-phx-accent shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-phx-accent mb-0.5">Weekly</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Weekly Sales — Full Detail</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Row-level weekly sell-out and stock data. Filter by week, year, distributor, region, product.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={WEEKLY_TABS} mountRoot={mountRoot} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <WeeklyDetailContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
