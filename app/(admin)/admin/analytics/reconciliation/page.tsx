import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsKpiCard } from "@/components/analytics/analytics-kpi-card";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { AnalyticsDemoBanner } from "@/components/analytics/analytics-demo-banner";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadAnalyticsDimensions, loadCrossSource, type AnalyticsDimensions, type CrossSourceRow } from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { EXECUTIVE_FILTERS } from "@/lib/analytics/sales-filter-config";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoCrossSource } from "@/lib/analytics/demo-fixtures";
import { AnalyticsTrendChart } from "@/components/analytics/analytics-trend-chart";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function fmt(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

async function ReconciliationContent({
  searchParams,
  role,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
}) {
  const demo = isAnalyticsDemoMode(searchParams);
  const filters = parseAnalyticsFilters(searchParams, EXECUTIVE_FILTERS);

  let rows: CrossSourceRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    rows = demoCrossSource();
    dimensions = demoAnalyticsDimensions();
  } else {
    [rows, dimensions] = await Promise.all([
      loadCrossSource({
        periodFrom: typeof filters.periodFrom === "string" ? filters.periodFrom : null,
        periodTo:   typeof filters.periodTo   === "string" ? filters.periodTo   : null,
        lines:      Array.isArray(filters.lines) ? filters.lines : [],
      }).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
    ]);
  }

  const totalSos     = rows.reduce((s, r) => s + (r.sosValue ?? 0), 0);
  const totalClosing = rows.reduce((s, r) => s + (r.closingValue ?? 0), 0);
  const totalWeekly  = rows.reduce((s, r) => s + (r.weeklyValue ?? 0), 0);
  const totalTarget  = rows.reduce((s, r) => s + (r.targetValue ?? 0), 0);

  // Aggregate by period for the comparison bar chart (across all filtered lines).
  const periodMap = new Map<string, { sos: number; closing: number; weekly: number }>();
  for (const r of rows) {
    const cur = periodMap.get(r.period) ?? { sos: 0, closing: 0, weekly: 0 };
    periodMap.set(r.period, {
      sos: cur.sos + (r.sosValue ?? 0),
      closing: cur.closing + (r.closingValue ?? 0),
      weekly: cur.weekly + (r.weeklyValue ?? 0),
    });
  }
  const chartData = [...periodMap.entries()]
    .map(([period, totals]) => ({ period, ...totals }))
    .sort((a, b) => a.period.localeCompare(b.period));

  return (
    <div className="space-y-6">
      {demo ? <AnalyticsDemoBanner /> : null}

      <AnalyticsFilterBar
        descriptors={EXECUTIVE_FILTERS}
        values={filters}
        dimensions={dimensions}
        basePath="/admin/analytics/reconciliation"
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <AnalyticsKpiCard label="SoS Total"     value={fmt(totalSos)}     prefix="EGP" />
        <AnalyticsKpiCard label="Closing Total" value={fmt(totalClosing)} prefix="EGP" />
        <AnalyticsKpiCard label="Weekly Total"  value={fmt(totalWeekly)}  prefix="EGP" />
        <AnalyticsKpiCard label="Target Total"  value={fmt(totalTarget)}  prefix="EGP" />
      </div>

      <AnalyticsSection title="SoS vs Closing vs Weekly by Period">
        {chartData.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsTrendChart
            data={chartData}
            xAxisKey="period"
            layers={[
              { key: "sos", name: "SoS", type: "bar", color: "#F97316" },
              { key: "closing", name: "Closing", type: "bar", color: "#0F172A" },
              { key: "weekly", name: "Weekly", type: "bar", color: "#0EA5E9" },
            ]}
          />
        )}
      </AnalyticsSection>

      <div className="border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 space-y-1">
        <p className="font-semibold">Cross-source comparison notes</p>
        <ul className="list-disc list-inside space-y-0.5 ml-1">
          <li>SoS = distributor invoice aggregates (geography-centric, no employee attribution)</li>
          <li>Closing = employee-attributed approved closing batches (sales records)</li>
          <li>Weekly = distributor weekly sell-out files (branch-level, no employee attribution)</li>
          <li>Gaps between pipelines are expected — they measure different things at different grains</li>
          <li>Blank cells mean no data for that pipeline in the given period × line combination</li>
        </ul>
      </div>

      <AnalyticsSection title="Period × Line Reconciliation" count={rows.length}>
        {rows.length === 0 ? (
          <AnalyticsEmptyState message="No data available. Real sales data must be uploaded first." />
        ) : (
          <AnalyticsDataTable
            searchKeys={["period", "line"]}
            columns={[
              { key: "period",                label: "Period",          sortable: true },
              { key: "line",                  label: "Line",            sortable: true },
              { key: "sosValue",              label: "SoS Value",       align: "right", sortable: true, formatKind: "number" },
              { key: "closingValue",          label: "Closing Value",   align: "right", sortable: true, formatKind: "number" },
              { key: "targetValue",           label: "Target",          align: "right", sortable: true, formatKind: "number" },
              { key: "weeklyValue",           label: "Weekly Value",    align: "right", sortable: true, formatKind: "number" },
              { key: "closingAchievementPct", label: "Closing Achiev%", align: "right", sortable: true, formatKind: "percent" },
              { key: "closingVsSosGapPct",    label: "Close vs SoS %",  align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={rows}
            exportTitle="Cross-Source Reconciliation"
            exportSubtitle="SoS vs Closing vs Weekly by period and line"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export default async function ReconciliationPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="w-1 h-12 bg-[#F97316] shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#F97316] mb-0.5">Recon</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Cross-Source Reconciliation</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Align Source of Sales, Monthly Closing, and Weekly Sales on the same period × line grain.
            Identify gaps and validate pipeline consistency.
          </p>
        </div>
      </div>

      <Suspense fallback={<AppRouteLoadingState />}>
        <ReconciliationContent searchParams={resolvedParams} role={access.role} />
      </Suspense>
    </div>
  );
}
