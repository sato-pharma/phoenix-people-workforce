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
  loadWeeklyFact,
  type AnalyticsDimensions,
  type WeeklyFactRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { WEEKLY_FILTERS } from "@/lib/analytics/sales-filter-config";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoWeeklyFact } from "@/lib/analytics/demo-fixtures";
import { WEEKLY_TABS } from "@/lib/analytics/module-nav-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function ByDistributorContent({
  searchParams,
  role,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
}) {
  const demo = isAnalyticsDemoMode(searchParams);
  const filters = parseAnalyticsFilters(searchParams, WEEKLY_FILTERS);

  const weeklyFilters = {
    weekStart:    typeof filters.week         === "string" ? filters.week         : null,
    year:         typeof filters.year         === "string" ? Number(filters.year) : null,
    distributors: Array.isArray(filters.distributors) ? filters.distributors : [],
    lines:        Array.isArray(filters.lines)         ? filters.lines         : [],
    regions:      Array.isArray(filters.regions)       ? filters.regions       : [],
    products:     Array.isArray(filters.products)      ? filters.products      : [],
    families:     Array.isArray(filters.families)      ? filters.families      : [],
  };

  let rows: WeeklyFactRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    rows = demoWeeklyFact();
    dimensions = demoAnalyticsDimensions();
  } else {
    [rows, dimensions] = await Promise.all([
      loadWeeklyFact(weeklyFilters).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
    ]);
  }

  const distributorMap = new Map<string, { distributorName: string; salesValue: number; salesQty: number; stockQty: number }>();
  for (const r of rows) {
    const cur = distributorMap.get(r.distributorCode) ?? { distributorName: r.distributorName, salesValue: 0, salesQty: 0, stockQty: 0 };
    distributorMap.set(r.distributorCode, {
      distributorName: cur.distributorName,
      salesValue: cur.salesValue + r.salesValue,
      salesQty:   cur.salesQty   + r.salesQty,
      stockQty:   cur.stockQty   + r.stockQty,
    });
  }
  const distributorTotals = [...distributorMap.entries()]
    .map(([distributorCode, t]) => ({ distributorCode, ...t }))
    .sort((a, b) => b.salesValue - a.salesValue);

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}

      <AnalyticsFilterBar
        descriptors={WEEKLY_FILTERS}
        values={filters}
        dimensions={dimensions}
        basePath="/admin/analytics/weekly-sales/by-distributor"
      />

      <AnalyticsSection title="Distributor Breakdown" count={distributorTotals.length}>
        {distributorTotals.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["distributorName", "distributorCode"]}
            columns={[
              { key: "distributorName", label: "Distributor", sortable: true },
              { key: "salesValue",      label: "Value (EGP)", align: "right", sortable: true, formatKind: "number" },
              { key: "salesQty",        label: "Sales Qty",   align: "right", sortable: true, formatKind: "number" },
              { key: "stockQty",        label: "Stock Qty",   align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={distributorTotals}
            totals={{
              salesValue: distributorTotals.reduce((s, r) => s + r.salesValue, 0),
              salesQty:   distributorTotals.reduce((s, r) => s + r.salesQty,   0),
              stockQty:   distributorTotals.reduce((s, r) => s + r.stockQty,   0),
            }}
            exportTitle="Weekly Sales By Distributor"
            exportSubtitle="Weekly sell-out aggregated by distributor"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export default async function WeeklyByDistributorPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "weekly_sales", "read");

  const resolvedParams = await searchParams;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="w-1 h-12 bg-[#F97316] shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#F97316] mb-0.5">Weekly</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Weekly — By Distributor</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Aggregated sell-out and stock position ranked by distributor performance.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={WEEKLY_TABS} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByDistributorContent searchParams={resolvedParams} role={access.role} />
      </Suspense>
    </div>
  );
}
