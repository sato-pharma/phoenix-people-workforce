import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsKpiCard } from "@/components/analytics/analytics-kpi-card";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { AnalyticsDemoBanner } from "@/components/analytics/analytics-demo-banner";
import { AnalyticsModuleNav } from "@/components/analytics/analytics-module-nav";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canViewHeadOfficeLine } from "@/lib/sales/access-scope";
import {
  loadAnalyticsDimensions,
  loadClosingByEmployee,
  type AnalyticsDimensions,
  type ClosingByEmployeeRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { CLOSING_FILTERS } from "@/lib/analytics/sales-filter-config";
import { computePeriodDelta, shiftPeriod } from "@/lib/analytics/compare";
import { formatPctOrDash, safeDividePct } from "@/lib/analytics/validation";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoClosingByEmployee } from "@/lib/analytics/demo-fixtures";
import { AnalyticsTrendChart } from "@/components/analytics/analytics-trend-chart";
import { CLOSING_TABS } from "@/lib/analytics/module-nav-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

async function ClosingDashboardContent({
  searchParams,
  role,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
}) {
  const demo = isAnalyticsDemoMode(searchParams);
  const filters = parseAnalyticsFilters(searchParams, CLOSING_FILTERS);
  const compareRaw = searchParams.compare;
  const compareMode = (Array.isArray(compareRaw) ? compareRaw[0] : compareRaw) === "1";

  const closingFilters = {
    period:       typeof filters.period       === "string" ? filters.period       : null,
    periodFrom:   typeof filters.periodFrom   === "string" ? filters.periodFrom   : null,
    periodTo:     typeof filters.periodTo     === "string" ? filters.periodTo     : null,
    lines:        Array.isArray(filters.lines)             ? filters.lines         : [],
    products:     Array.isArray(filters.products)          ? filters.products      : [],
    families:     Array.isArray(filters.families)          ? filters.families      : [],
    employeeHrId: typeof filters.employeeHrId === "string" ? filters.employeeHrId : null,
    territory:    typeof filters.territory    === "string" ? filters.territory    : null,
    batchId:      typeof filters.batchId      === "string" ? filters.batchId      : null,
    canViewHeadOffice: canViewHeadOfficeLine(role),
  };

  let rows: ClosingByEmployeeRow[];
  let dimensions: AnalyticsDimensions;
  let priorTotal: number | null = null;

  if (demo) {
    rows = demoClosingByEmployee();
    dimensions = demoAnalyticsDimensions();
  } else {
    [rows, dimensions] = await Promise.all([
      loadClosingByEmployee(closingFilters).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
    ]);

    if (closingFilters.period) {
      const priorPeriod = shiftPeriod(closingFilters.period, 1);
      const priorRows = await loadClosingByEmployee({ ...closingFilters, period: priorPeriod, periodFrom: null, periodTo: null }).catch(() => []);
      priorTotal = priorRows.reduce((s, r) => s + r.salesValue, 0);
    }
  }

  const totalSales  = rows.reduce((s, r) => s + r.salesValue,  0);
  const totalTarget = rows.reduce((s, r) => s + r.targetValue, 0);
  const achievement = safeDividePct(totalSales, totalTarget);
  const empCount    = new Set(rows.map((r) => r.employeeHrId).filter(Boolean)).size;
  const delta = computePeriodDelta(totalSales, priorTotal);

  // Line totals — feeds the sales-vs-target bar chart and (in compare mode) the comparison table.
  const lineTotalsMap = new Map<string, { salesValue: number; targetValue: number }>();
  for (const r of rows) {
    const cur = lineTotalsMap.get(r.line) ?? { salesValue: 0, targetValue: 0 };
    lineTotalsMap.set(r.line, { salesValue: cur.salesValue + r.salesValue, targetValue: cur.targetValue + r.targetValue });
  }
  const lineTotals = [...lineTotalsMap.entries()]
    .map(([line, totals]) => ({
      line,
      ...totals,
      achievementPct: safeDividePct(totals.salesValue, totals.targetValue),
    }))
    .sort((a, b) => b.salesValue - a.salesValue);
  const chartData = lineTotals.map((row) => ({ line: row.line, sales: row.salesValue, target: row.targetValue }));

  return (
    <div className="space-y-6">
      {demo ? <AnalyticsDemoBanner /> : null}

      <AnalyticsFilterBar
        descriptors={CLOSING_FILTERS}
        values={filters}
        dimensions={dimensions}
        basePath="/admin/analytics/monthly-closing"
        comparable
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <AnalyticsKpiCard label="Total Sales"      value={fmt(totalSales)}  prefix="EGP" growth={delta.pct} />
        <AnalyticsKpiCard label="Total Target"     value={fmt(totalTarget)} prefix="EGP" />
        <AnalyticsKpiCard label="Achievement"      value={formatPctOrDash(achievement)} />
        <AnalyticsKpiCard label="Employees"        value={String(empCount)} />
      </div>

      <AnalyticsSection title="Sales vs Target by Line">
        {chartData.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsTrendChart
            data={chartData}
            xAxisKey="line"
            layers={[
              { key: "sales", name: "Sales", type: "bar", color: "#F97316" },
              { key: "target", name: "Target", type: "bar", color: "#0F172A" },
            ]}
          />
        )}
      </AnalyticsSection>

      {compareMode && lineTotals.length >= 2 ? (
        <AnalyticsSection title="Line Comparison" count={lineTotals.length}>
          <AnalyticsDataTable
            searchKeys={["line"]}
            columns={[
              { key: "line",           label: "Line",       sortable: true },
              { key: "salesValue",     label: "Sales",      align: "right", sortable: true, formatKind: "number" },
              { key: "targetValue",    label: "Target",     align: "right", sortable: true, formatKind: "number" },
              { key: "achievementPct", label: "Achiev %",   align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={lineTotals}
            exportTitle="Closing — Line Comparison"
            exportSubtitle="Sales vs target by line, current filter selection"
          />
        </AnalyticsSection>
      ) : null}

      <AnalyticsSection title="Employee Performance" count={rows.length}>
        {rows.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["employeeName", "employeeHrId", "territory", "line"]}
            columns={[
              { key: "period",         label: "Period",      sortable: true },
              { key: "line",           label: "Line",        sortable: true },
              { key: "employeeHrId",   label: "HR ID",       sortable: true },
              { key: "employeeName",   label: "Name",        sortable: true },
              { key: "managerName",    label: "Manager",     sortable: true },
              { key: "territory",      label: "Territory",   sortable: true },
              { key: "salesValue",     label: "Sales",       align: "right", sortable: true, formatKind: "number" },
              { key: "targetValue",    label: "Target",      align: "right", sortable: true, formatKind: "number" },
              { key: "achievementPct", label: "Achiev %",    align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={rows}
            totals={{ salesValue: totalSales, targetValue: totalTarget }}
            exportTitle="Monthly Closing — Employee Performance"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export default async function MonthlyClosingAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="w-1 h-12 bg-[#F97316] shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#F97316] mb-0.5">Closing</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Monthly Closing Analytics</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Employee-attributed sales vs target — approved closing batches only. Filter by period, line, employee, territory, or batch.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={CLOSING_TABS} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ClosingDashboardContent searchParams={resolvedParams} role={access.role} />
      </Suspense>
    </div>
  );
}
