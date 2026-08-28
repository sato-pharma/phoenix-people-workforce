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

async function ByLineContent({
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
  const filters = parseAnalyticsFilters(searchParams, CLOSING_FILTERS);

  const closingFilters = {
    period:       Array.isArray(filters.period)       ? filters.period       : [],
    periodFrom:   typeof filters.periodFrom   === "string" ? filters.periodFrom   : null,
    periodTo:     typeof filters.periodTo     === "string" ? filters.periodTo     : null,
    lines:        Array.isArray(filters.lines)             ? filters.lines         : [],
    products:     Array.isArray(filters.products)          ? filters.products      : [],
    families:     Array.isArray(filters.families)          ? filters.families      : [],
    // Declared so scopeAnalyticsFilters' geography bound is carried on the TYPE, not just spread
    // onto the object at runtime — loadClosingByEmployee reads both.
    regions:      Array.isArray(filters.regions)           ? filters.regions       : [],
    areas:        Array.isArray(filters.areas)             ? filters.areas         : [],
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
    dimensions = await loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions()));
  } else {
    [rows, dimensions] = await Promise.all([
      loadClosingByEmployee(scoped.filters).catch(trackFailure(analyticsFailures, "Monthly closing by rep", [])),
      loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions())),
    ]);
  }

  const lineTotalsMap = new Map<string, { salesValue: number; targetValue: number }>();
  for (const r of rows) {
    const cur = lineTotalsMap.get(r.line) ?? { salesValue: 0, targetValue: 0 };
    lineTotalsMap.set(r.line, { salesValue: cur.salesValue + r.salesValue, targetValue: cur.targetValue + r.targetValue });
  }
  const lineTotals = [...lineTotalsMap.entries()]
    .map(([line, t]) => ({
      line,
      ...t,
      achievementPct: safeDividePct(t.salesValue, t.targetValue),
    }))
    .sort((a, b) => b.salesValue - a.salesValue);

  // Period-level detail — mirrors the Summary + period-level Detail pattern used by the SoS
  // by-line/by-area/by-product tabs, so this tab isn't just a single all-time rollup.
  const periodLineMap = new Map<string, { period: string; line: string; salesValue: number; targetValue: number }>();
  for (const r of rows) {
    const key = `${r.period}||${r.line}`;
    const cur = periodLineMap.get(key) ?? { period: r.period, line: r.line, salesValue: 0, targetValue: 0 };
    periodLineMap.set(key, { ...cur, salesValue: cur.salesValue + r.salesValue, targetValue: cur.targetValue + r.targetValue });
  }
  const periodLineRows = [...periodLineMap.values()]
    .map((t) => ({ ...t, achievementPct: safeDividePct(t.salesValue, t.targetValue) }))
    .sort((a, b) => a.period.localeCompare(b.period) || b.salesValue - a.salesValue);

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}
      {analyticsFailures.length > 0 ? <AnalyticsErrorState what={analyticsFailures.join(", ")} /> : null}

      <AnalyticsFilterBar
        descriptors={CLOSING_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/monthly-closing/by-line`}
      />

      <AnalyticsSection title="Line Comparison" count={lineTotals.length}>
        {lineTotals.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["line"]}
            columns={[
              { key: "line",           label: "Line",    sortable: true },
              { key: "salesValue",     label: "Sales (EGP)",  align: "right", sortable: true, formatKind: "number" },
              { key: "targetValue",    label: "Target (EGP)", align: "right", sortable: true, formatKind: "number" },
              { key: "achievementPct", label: "Achiev %", align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={lineTotals}
            totals={{
              salesValue:  lineTotals.reduce((s, r) => s + r.salesValue,  0),
              targetValue: lineTotals.reduce((s, r) => s + r.targetValue, 0),
            }}
            exportTitle="Closing By Line"
            exportSubtitle="Monthly closing sales vs target by product line"
          />
        )}
      </AnalyticsSection>

      <AnalyticsSection title="Period × Line Detail" count={periodLineRows.length}>
        {periodLineRows.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["line", "period"]}
            columns={[
              { key: "period",         label: "Period",   sortable: true },
              { key: "line",           label: "Line",      sortable: true },
              { key: "salesValue",     label: "Sales (EGP)",  align: "right", sortable: true, formatKind: "number" },
              { key: "targetValue",    label: "Target (EGP)", align: "right", sortable: true, formatKind: "number" },
              { key: "achievementPct", label: "Achiev %", align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={periodLineRows}
            exportTitle="Closing By Line — Detail"
            exportSubtitle="Period-level monthly closing sales vs target by product line"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export function MonthlyClosingByLineDashboard({
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
          <p className="text-phx-2xs font-bold uppercase tracking-widest text-phx-accent mb-0.5">Closing</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Closing — By Line</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Sales vs target aggregated by product line. Achievement % per line.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={CLOSING_TABS} mountRoot={mountRoot} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByLineContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
