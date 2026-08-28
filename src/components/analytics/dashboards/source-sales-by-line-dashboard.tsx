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
import { canViewHeadOfficeLine, canViewRestrictedProducts } from "@/lib/sales/access-scope";
import {
  loadAnalyticsDimensions,
  loadSosByLine,
  type AnalyticsDimensions,
  type SosByLineRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_FILTERS } from "@/lib/analytics/sales-filter-config";
import { scopeAnalyticsFilters, scopeAnalyticsDimensions, computeAnalyticsFilterVisibility, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoSosByLine } from "@/lib/analytics/demo-fixtures";
import { SOS_TABS } from "@/lib/analytics/module-nav-config";

async function ByLineContent({
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
  const filters = parseAnalyticsFilters(searchParams, SOS_FILTERS);

  const sosFilters = {
    period:       Array.isArray(filters.period)      ? filters.period      : [],
    periodFrom:   typeof filters.periodFrom  === "string" ? filters.periodFrom  : null,
    periodTo:     typeof filters.periodTo    === "string" ? filters.periodTo    : null,
    channel:      Array.isArray(filters.channel)     ? filters.channel     : [],
    distributors: Array.isArray(filters.distributors) ? filters.distributors : [],
    lines:        Array.isArray(filters.lines)         ? filters.lines         : [],
    regions:      Array.isArray(filters.regions)       ? filters.regions       : [],
    areas:        Array.isArray(filters.areas)         ? filters.areas         : [],
    products:     Array.isArray(filters.products)      ? filters.products      : [],
    families:     Array.isArray(filters.families)      ? filters.families      : [],
    clientCodes:  Array.isArray(filters.clientCodes)   ? filters.clientCodes   : [],
    canViewHeadOffice: canViewHeadOfficeLine(role),
    canViewRestrictedProducts: canViewRestrictedProducts(role),
  };
  const scoped = scopeAnalyticsFilters(sosFilters, scope);

  let byLine: SosByLineRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    byLine = demoSosByLine();
    dimensions = demoAnalyticsDimensions();
  } else if (scoped.empty) {
    byLine = [];
    dimensions = await loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions()));
  } else {
    [byLine, dimensions] = await Promise.all([
      loadSosByLine(scoped.filters).catch(trackFailure(analyticsFailures, "Sales by line", [])),
      loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions())),
    ]);
  }

  const lineTotalsMap = new Map<string, { units: number; value: number }>();
  for (const r of byLine) {
    const cur = lineTotalsMap.get(r.line) ?? { units: 0, value: 0 };
    lineTotalsMap.set(r.line, { units: cur.units + r.units, value: cur.value + r.value });
  }
  const lineTotals = [...lineTotalsMap.entries()]
    .map(([line, t]) => ({ line, ...t }))
    .sort((a, b) => b.value - a.value);

  const grandTotal = lineTotals.reduce((s, r) => s + r.value, 0);

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}
      {analyticsFailures.length > 0 ? <AnalyticsErrorState what={analyticsFailures.join(", ")} /> : null}

      <AnalyticsFilterBar
        descriptors={SOS_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/source-sales/by-line`}
      />

      <AnalyticsSection title="Line Totals (Aggregated)" count={lineTotals.length}>
        {lineTotals.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["line"]}
            columns={[
              { key: "line",  label: "Line",  sortable: true },
              { key: "units", label: "Units", align: "right", sortable: true, formatKind: "number" },
              { key: "value", label: "Value (EGP)", align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={lineTotals}
            totals={{ value: grandTotal }}
            exportTitle="SoS By Line"
            exportSubtitle="Source of Sales aggregated by product line"
          />
        )}
      </AnalyticsSection>

      <AnalyticsSection title="Period × Line Detail" count={byLine.length}>
        {byLine.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["line", "period"]}
            columns={[
              { key: "period",      label: "Period",  sortable: true },
              { key: "line",        label: "Line",    sortable: true },
              { key: "channel",     label: "Channel", sortable: true },
              { key: "units",       label: "Units",   align: "right", sortable: true, formatKind: "number" },
              { key: "value",       label: "Value",   align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={byLine}
            exportTitle="SoS By Line — Detail"
            exportSubtitle="Period-level SoS breakdown by line"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export function SourceSalesByLineDashboard({
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
          <p className="text-[10px] font-bold uppercase tracking-widest text-phx-accent mb-0.5">SoS</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">SoS — By Line</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Source of Sales aggregated by product line. Filter periods, distributors, and regions.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={SOS_TABS} mountRoot={mountRoot} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByLineContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
