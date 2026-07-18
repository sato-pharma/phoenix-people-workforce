import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { AnalyticsDemoBanner } from "@/components/analytics/analytics-demo-banner";
import { AnalyticsModuleNav } from "@/components/analytics/analytics-module-nav";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  loadAnalyticsDimensions,
  loadSosByArea,
  type AnalyticsDimensions,
  type SosByAreaRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_FILTERS } from "@/lib/analytics/sales-filter-config";
import { resolveAnalyticsViewerScope, scopeAnalyticsFilters, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoSosByArea } from "@/lib/analytics/demo-fixtures";
import { SOS_TABS } from "@/lib/analytics/module-nav-config";
import { canViewHeadOfficeLine } from "@/lib/sales/access-scope";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function ByAreaContent({
  searchParams,
  role,
  scope,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
  scope: AnalyticsViewerScope;
}) {
  const demo = isAnalyticsDemoMode(searchParams);
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
    dimensions = await loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions());
  } else {
    [byArea, dimensions] = await Promise.all([
      loadSosByArea(scoped.filters).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
    ]);
  }

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

      <AnalyticsFilterBar
        descriptors={SOS_FILTERS}
        values={filters}
        dimensions={dimensions}
        basePath="/admin/analytics/source-sales/by-area"
      />

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

export default async function SosByAreaPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "sales", "read");
  const scope = await resolveAnalyticsViewerScope(access);

  const resolvedParams = await searchParams;

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

      <AnalyticsModuleNav tabs={SOS_TABS} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByAreaContent searchParams={resolvedParams} role={access.role} scope={scope} />
      </Suspense>
    </div>
  );
}
