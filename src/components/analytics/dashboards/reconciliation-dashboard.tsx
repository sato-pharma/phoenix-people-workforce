import { Suspense } from "react";

import { emptyAnalyticsDimensions, trackFailure } from "@/lib/analytics/load-result";
import { AnalyticsErrorState } from "@/components/analytics/analytics-error-state";
import { AnalyticsKpiCard } from "@/components/analytics/analytics-kpi-card";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { AnalyticsDemoBanner } from "@/components/analytics/analytics-demo-banner";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { type PhoenixRole } from "@/lib/auth/permissions";
import { canViewHeadOfficeLine } from "@/lib/sales/access-scope";
import { loadAnalyticsDimensions, loadCrossSource, type AnalyticsDimensions, type CrossSourceRow } from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { RECONCILIATION_FILTERS } from "@/lib/analytics/sales-filter-config";
import { scopeAnalyticsFilters, scopeAnalyticsDimensions, computeAnalyticsFilterVisibility, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoCrossSource } from "@/lib/analytics/demo-fixtures";
import { AnalyticsTrendChart } from "@/components/analytics/analytics-trend-chart";

function fmt(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

async function ReconciliationContent({
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
  const filters = parseAnalyticsFilters(searchParams, RECONCILIATION_FILTERS);

  const crossSourceFilters = {
    periodFrom: typeof filters.periodFrom === "string" ? filters.periodFrom : null,
    periodTo:   typeof filters.periodTo   === "string" ? filters.periodTo   : null,
    lines:      Array.isArray(filters.lines) ? filters.lines : [],
    canViewHeadOffice: canViewHeadOfficeLine(role),
  };
  const scoped = scopeAnalyticsFilters(crossSourceFilters, scope);

  let rows: CrossSourceRow[];
  let dimensions: AnalyticsDimensions;

  // analytics_cross_source takes ONLY p_lines. Its view aggregates three legs to (period, line) and
  // the closing leg carries no area dimension at all, so there is nothing to push an area bound down
  // into — a geography-scoped viewer was being served whole-line NATIONAL SoS, Closing, Weekly and
  // TARGET totals on a page that presents itself as their scope, with the region picker hidden by
  // computeAnalyticsFilterVisibility so nothing signalled the widening.
  //
  // Refusing is the honest answer until the view is re-cut at area grain. Showing a manager national
  // figures they will read as their own is worse than showing them nothing.
  if (scope.allowedAreaCodes != null) {
    return (
      <div className="space-y-5">
        <AnalyticsErrorState what="Cross-source reconciliation is not available for your territory" />
        <p className="max-w-prose text-sm text-muted-foreground">
          This report can only be produced for a whole product line — it cannot yet be narrowed to
          your areas, and the national figures are not your numbers. Source of Sales and Monthly
          Closing are scoped to your territory and can be reconciled there.
        </p>
      </div>
    );
  }

  if (demo) {
    rows = demoCrossSource();
    dimensions = demoAnalyticsDimensions();
  } else if (scoped.empty) {
    rows = [];
    dimensions = await loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions()));
  } else {
    [rows, dimensions] = await Promise.all([
      loadCrossSource(scoped.filters).catch(trackFailure(analyticsFailures, "Cross-source reconciliation", [])),
      loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions())),
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
      {analyticsFailures.length > 0 ? <AnalyticsErrorState what={analyticsFailures.join(", ")} /> : null}

      <AnalyticsFilterBar
        descriptors={RECONCILIATION_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/reconciliation`}
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
          <li>Closing = Source of Sales Monthly Closing, attributed down to areas and seats, with targets</li>
          <li>Weekly = distributor weekly sell-out files (branch-level, cumulative, stock-inclusive)</li>
          <li>
            SoS and Closing are the same measurement at line level and will match exactly —
            attribution moves value down a line, never between lines. They separate only at area
            and rep level, which this report does not yet show.
          </li>
          <li>Weekly is a different universe and runs several times larger — do not read it as a variance</li>
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

export function ReconciliationDashboard({
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
          <p className="text-phx-2xs font-bold uppercase tracking-widest text-phx-accent mb-0.5">Recon</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Cross-Source Reconciliation</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Align Source of Sales, Monthly Closing, and Weekly Sales on the same period × line grain.
            Identify gaps and validate pipeline consistency.
          </p>
        </div>
      </div>

      <Suspense fallback={<AppRouteLoadingState />}>
        <ReconciliationContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
