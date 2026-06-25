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
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  loadAnalyticsDimensions,
  loadSosByLine,
  type AnalyticsDimensions,
  type SosByLineRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_FILTERS } from "@/lib/analytics/sales-filter-config";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoSosByLine } from "@/lib/analytics/demo-fixtures";
import { SOS_TABS } from "@/lib/analytics/module-nav-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function ByLineContent({
  searchParams,
  role,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
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
  };

  let byLine: SosByLineRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    byLine = demoSosByLine();
    dimensions = demoAnalyticsDimensions();
  } else {
    [byLine, dimensions] = await Promise.all([
      loadSosByLine(sosFilters).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
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

      <AnalyticsFilterBar
        descriptors={SOS_FILTERS}
        values={filters}
        dimensions={dimensions}
        basePath="/admin/analytics/source-sales/by-line"
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

export default async function SosByLinePage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="w-1 h-12 bg-[#F97316] shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#F97316] mb-0.5">SoS</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">SoS — By Line</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Source of Sales aggregated by product line. Filter periods, distributors, and regions.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={SOS_TABS} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByLineContent searchParams={resolvedParams} role={access.role} />
      </Suspense>
    </div>
  );
}
