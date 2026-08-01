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
import {
  loadAnalyticsDimensions,
  loadSosByArea,
  type AnalyticsDimensions,
  type SosByAreaRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_FILTERS } from "@/lib/analytics/sales-filter-config";
import { scopeAnalyticsFilters, scopeAnalyticsDimensions, computeAnalyticsFilterVisibility, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoSosByArea } from "@/lib/analytics/demo-fixtures";
import { SOS_TABS } from "@/lib/analytics/module-nav-config";
import { canViewHeadOfficeLine } from "@/lib/sales/access-scope";

async function ByAreaContent({
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
  };
  const scoped = scopeAnalyticsFilters(sosFilters, scope);

  let byArea: SosByAreaRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    byArea = demoSosByArea();
    dimensions = demoAnalyticsDimensions();
  } else if (scoped.empty) {
    byArea = [];
    dimensions = await loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions()));
  } else {
    [byArea, dimensions] = await Promise.all([
      loadSosByArea(scoped.filters).catch(trackFailure(analyticsFailures, "Sales by area", [])),
      loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions())),
    ]);
  }

  // Area is the grain this tab is named for — key by areaCode (not name, which can collide
  // across regions) and carry regionName along for context. Leads the page so "By Area" actually
  // shows areas first; the region rollup below stays as a secondary, coarser view of the same data.
  const areaMap = new Map<string, { areaName: string; regionName: string; units: number; value: number }>();
  for (const r of byArea) {
    const cur = areaMap.get(r.areaCode) ?? { areaName: r.areaName, regionName: r.regionName, units: 0, value: 0 };
    areaMap.set(r.areaCode, { ...cur, units: cur.units + r.units, value: cur.value + r.value });
  }
  const areaTotals = [...areaMap.entries()]
    .map(([areaCode, t]) => ({ areaCode, ...t }))
    .sort((a, b) => b.value - a.value);

  const regionMap = new Map<string, { units: number; value: number }>();
  for (const r of byArea) {
    const cur = regionMap.get(r.regionName) ?? { units: 0, value: 0 };
    regionMap.set(r.regionName, { units: cur.units + r.units, value: cur.value + r.value });
  }
  const regionTotals = [...regionMap.entries()]
    .map(([regionName, t]) => ({ regionName, ...t }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}
      {analyticsFailures.length > 0 ? <AnalyticsErrorState what={analyticsFailures.join(", ")} /> : null}

      <AnalyticsFilterBar
        descriptors={SOS_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/source-sales/by-area`}
      />

      <AnalyticsSection title="Area Summary" count={areaTotals.length}>
        {areaTotals.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["areaName", "regionName"]}
            columns={[
              { key: "areaName",   label: "Area",   sortable: true },
              { key: "regionName", label: "Region", sortable: true },
              { key: "units",      label: "Units",  align: "right", sortable: true, formatKind: "number" },
              { key: "value",      label: "Value (EGP)", align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={areaTotals}
            totals={{ value: areaTotals.reduce((s, r) => s + r.value, 0) }}
            exportTitle="SoS By Area"
            exportSubtitle="Source of Sales aggregated by area"
          />
        )}
      </AnalyticsSection>

      <AnalyticsSection title="Region Summary" count={regionTotals.length}>
        {regionTotals.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["regionName"]}
            columns={[
              { key: "regionName", label: "Region", sortable: true },
              { key: "units",      label: "Units",  align: "right", sortable: true, formatKind: "number" },
              { key: "value",      label: "Value (EGP)", align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={regionTotals}
            totals={{ value: regionTotals.reduce((s, r) => s + r.value, 0) }}
            exportTitle="SoS By Region"
            exportSubtitle="Source of Sales aggregated by region"
          />
        )}
      </AnalyticsSection>

      <AnalyticsSection title="Region / Area Detail" count={byArea.length}>
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
            exportTitle="SoS By Region-Area Detail"
            exportSubtitle="Period-level SoS by region and area"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export function SourceSalesByAreaDashboard({
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
          <h1 className="text-2xl font-bold text-foreground leading-tight">SoS — By Region / Area</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Geography-level SoS breakdown. Drill from region summary to period × area detail.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={SOS_TABS} mountRoot={mountRoot} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByAreaContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
