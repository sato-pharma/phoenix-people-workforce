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
import { canViewHeadOfficeLine, canViewRestrictedProducts } from "@/lib/sales/access-scope";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

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
    canViewRestrictedProducts: canViewRestrictedProducts(role),
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

  // Every "Region" on this page is the ORGANOGRAM region — the DM district that owns the area on
  // that line in that month, which is what the Monthly Closing publishes. It is NOT the geographic
  // region the area sits in; those disagree for 23 (line, area) pairs on production, worth EGP
  // 705,076 of July's 10,370,361. The geographic code is still on every row as `regionCode`, and it
  // stays the dimension the viewer's access bound was applied in — see SosByAreaRow.
  //
  // Area is the grain this tab is named for, but 15 of 48 areas are owned by TWO districts —
  // different lines, different DMs — so keying on areaCode alone would silently show one district's
  // label over both districts' money. Key on (area, owning district) instead: such an area appears
  // once per district, each row carrying its own value, exactly as the closing reports it. Areas
  // with a single owner are unaffected and still produce exactly one row.
  const areaMap = new Map<string, { areaName: string; regionName: string; units: number; value: number }>();
  for (const r of byArea) {
    const key = `${r.areaCode}\u0000${r.operationalRegionCode}`;
    const cur = areaMap.get(key) ?? { areaName: r.areaName, regionName: r.operationalRegionName, units: 0, value: 0 };
    areaMap.set(key, { ...cur, units: cur.units + r.units, value: cur.value + r.value });
  }
  const areaTotals = [...areaMap.entries()]
    .map(([key, t]) => ({ areaCode: key.split("\u0000")[0]!, ...t }))
    .sort((a, b) => b.value - a.value);

  const regionMap = new Map<string, { units: number; value: number }>();
  for (const r of byArea) {
    const cur = regionMap.get(r.operationalRegionName) ?? { units: 0, value: 0 };
    regionMap.set(r.operationalRegionName, { units: cur.units + r.units, value: cur.value + r.value });
  }
  const regionTotals = [...regionMap.entries()]
    .map(([regionName, t]) => ({ regionName, ...t }))
    .sort((a, b) => b.value - a.value);

  // The detail table renders `regionName`; show the owning district there too, so all three tables
  // on this page agree with each other and with the closing.
  const byAreaDetail = byArea.map((r) => ({ ...r, regionName: r.operationalRegionName }));

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
            rows={byAreaDetail}
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
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>SoS</p>
          <h1 className={pageHeaderTitleClassName}>SoS — By Region / Area</h1>
          <p className={pageHeaderDescriptionClassName}>
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
