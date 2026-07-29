import { Suspense } from "react";

import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { AnalyticsDemoBanner } from "@/components/analytics/analytics-demo-banner";
import { AnalyticsModuleNav } from "@/components/analytics/analytics-module-nav";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { type PhoenixRole } from "@/lib/auth/permissions";
import { canViewHeadOfficeLine } from "@/lib/sales/access-scope";
import {
  loadAnalyticsDimensions,
  loadClosingByEmployee,
  type AnalyticsDimensions,
  type ClosingByEmployeeRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { CLOSING_FILTERS } from "@/lib/analytics/sales-filter-config";
import { scopeAnalyticsFilters, scopeAnalyticsDimensions, computeAnalyticsFilterVisibility, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { safeDividePct } from "@/lib/analytics/validation";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoClosingByEmployee } from "@/lib/analytics/demo-fixtures";
import { CLOSING_TABS } from "@/lib/analytics/module-nav-config";

async function ByEmployeeContent({
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
  const filters = parseAnalyticsFilters(searchParams, CLOSING_FILTERS);

  const closingFilters = {
    period:       Array.isArray(filters.period)       ? filters.period       : [],
    periodFrom:   typeof filters.periodFrom   === "string" ? filters.periodFrom   : null,
    periodTo:     typeof filters.periodTo     === "string" ? filters.periodTo     : null,
    lines:        Array.isArray(filters.lines)             ? filters.lines         : [],
    products:     Array.isArray(filters.products)          ? filters.products      : [],
    families:     Array.isArray(filters.families)          ? filters.families      : [],
    employeeHrId: typeof filters.employeeHrId === "string" ? filters.employeeHrId : null,
    territory:    typeof filters.territory    === "string" ? filters.territory    : null,
    canViewHeadOffice: canViewHeadOfficeLine(role),
  };
  const scoped = scopeAnalyticsFilters(closingFilters, scope);

  let rows: ClosingByEmployeeRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    rows = demoClosingByEmployee();
    dimensions = demoAnalyticsDimensions();
  } else if (scoped.empty) {
    rows = [];
    dimensions = await loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions());
  } else {
    [rows, dimensions] = await Promise.all([
      loadClosingByEmployee(scoped.filters).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
    ]);
  }

  const totalSales  = rows.reduce((s, r) => s + r.salesValue,  0);
  const totalTarget = rows.reduce((s, r) => s + r.targetValue, 0);

  // Cross-period rollup per employee — mirrors the Summary + period-level Detail pattern used by
  // the SoS by-line/by-area/by-product tabs, so this tab leads with "one row per employee" instead
  // of only the raw period × batch rows.
  const employeeMap = new Map<
    string,
    { employeeName: string | null; managerName: string | null; territory: string | null; line: string; salesValue: number; targetValue: number }
  >();
  for (const r of rows) {
    const key = r.employeeHrId ?? r.employeeName ?? "unknown";
    const cur = employeeMap.get(key) ?? {
      employeeName: r.employeeName,
      managerName: r.managerName,
      territory: r.territory,
      line: r.line,
      salesValue: 0,
      targetValue: 0,
    };
    employeeMap.set(key, { ...cur, salesValue: cur.salesValue + r.salesValue, targetValue: cur.targetValue + r.targetValue });
  }
  const employeeTotals = [...employeeMap.values()]
    .map((t) => ({ ...t, achievementPct: safeDividePct(t.salesValue, t.targetValue) }))
    .sort((a, b) => b.salesValue - a.salesValue);

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}

      <AnalyticsFilterBar
        descriptors={CLOSING_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/monthly-closing/by-employee`}
      />

      <AnalyticsSection title="Employee Summary" count={employeeTotals.length}>
        {employeeTotals.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["employeeName", "managerName", "territory", "line"]}
            columns={[
              { key: "employeeName",   label: "Name",      sortable: true },
              { key: "managerName",    label: "Manager",   sortable: true },
              { key: "territory",      label: "Territory", sortable: true },
              { key: "line",           label: "Line",      sortable: true },
              { key: "salesValue",     label: "Sales (EGP)",  align: "right", sortable: true, formatKind: "number" },
              { key: "targetValue",    label: "Target (EGP)", align: "right", sortable: true, formatKind: "number" },
              { key: "achievementPct", label: "Achiev %",  align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={employeeTotals}
            totals={{ salesValue: totalSales, targetValue: totalTarget }}
            exportTitle="Closing By Employee — Summary"
            exportSubtitle="Cross-period totals per employee"
          />
        )}
      </AnalyticsSection>

      <AnalyticsSection title="Period × Employee Detail" count={rows.length}>
        {rows.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["employeeName", "employeeHrId", "territory", "line"]}
            columns={[
              { key: "period",         label: "Period",    sortable: true },
              { key: "line",           label: "Line",      sortable: true },
              { key: "employeeName",   label: "Name",      sortable: true },
              { key: "managerName",    label: "Manager",   sortable: true },
              { key: "territory",      label: "Territory", sortable: true },
              { key: "salesValue",     label: "Sales (EGP)",  align: "right", sortable: true, formatKind: "number" },
              { key: "targetValue",    label: "Target (EGP)", align: "right", sortable: true, formatKind: "number" },
              { key: "achievementPct", label: "Achiev %",  align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={rows}
            totals={{ salesValue: totalSales, targetValue: totalTarget }}
            exportTitle="Closing By Employee — Detail"
            exportSubtitle="Period-level monthly closing performance per employee"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export function MonthlyClosingByEmployeeDashboard({
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
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#F97316] mb-0.5">Closing</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Closing — By Employee</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Individual employee performance: sales vs target, territory, and achievement %.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={CLOSING_TABS} mountRoot={mountRoot} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByEmployeeContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
