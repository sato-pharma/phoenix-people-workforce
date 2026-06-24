import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsKpiCard } from "@/components/analytics/analytics-kpi-card";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadCrossSource } from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { EXECUTIVE_FILTERS } from "@/lib/analytics/sales-filter-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function fmt(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}

async function ReconciliationContent({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const filters = parseAnalyticsFilters(searchParams, EXECUTIVE_FILTERS);

  const rows = await loadCrossSource({
    periodFrom: typeof filters.periodFrom === "string" ? filters.periodFrom : null,
    periodTo:   typeof filters.periodTo   === "string" ? filters.periodTo   : null,
    lines:      Array.isArray(filters.lines) ? filters.lines : [],
  }).catch(() => []);

  const totalSos     = rows.reduce((s, r) => s + (r.sosValue ?? 0), 0);
  const totalClosing = rows.reduce((s, r) => s + (r.closingValue ?? 0), 0);
  const totalWeekly  = rows.reduce((s, r) => s + (r.weeklyValue ?? 0), 0);
  const totalTarget  = rows.reduce((s, r) => s + (r.targetValue ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <AnalyticsKpiCard label="SoS Total"     value={fmt(totalSos)}     prefix="EGP" />
        <AnalyticsKpiCard label="Closing Total" value={fmt(totalClosing)} prefix="EGP" />
        <AnalyticsKpiCard label="Weekly Total"  value={fmt(totalWeekly)}  prefix="EGP" />
        <AnalyticsKpiCard label="Target Total"  value={fmt(totalTarget)}  prefix="EGP" />
      </div>

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

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">Period × Line Reconciliation</h2>
        {rows.length === 0 ? (
          <AnalyticsEmptyState message="No data available. Real sales data must be uploaded first." />
        ) : (
          <AnalyticsDataTable
            searchKeys={["period", "line"]}
            columns={[
              { key: "period",                label: "Period",          sortable: true },
              { key: "line",                  label: "Line",            sortable: true },
              { key: "sosValue",              label: "SoS Value",       align: "right", sortable: true, format: (v) => fmt(v as number | null) },
              { key: "closingValue",          label: "Closing Value",   align: "right", sortable: true, format: (v) => fmt(v as number | null) },
              { key: "targetValue",           label: "Target",          align: "right", sortable: true, format: (v) => fmt(v as number | null) },
              { key: "weeklyValue",           label: "Weekly Value",    align: "right", sortable: true, format: (v) => fmt(v as number | null) },
              { key: "closingAchievementPct", label: "Closing Achiev%", align: "right", sortable: true, format: (v) => fmtPct(v as number | null) },
              { key: "closingVsSosGapPct",    label: "Close vs SoS %",  align: "right", sortable: true, format: (v) => fmtPct(v as number | null) },
            ]}
            rows={rows}
          />
        )}
      </section>
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
      <div>
        <h1 className="text-xl font-bold text-foreground">Cross-Source Reconciliation</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Align Source of Sales, Monthly Closing, and Weekly Sales on the same period × line grain.
          Identify gaps and validate pipeline consistency.
        </p>
      </div>
      <Suspense fallback={<AppRouteLoadingState />}>
        <ReconciliationContent searchParams={resolvedParams} />
      </Suspense>
    </div>
  );
}
