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
import {
  loadAnalyticsDimensions,
  loadSosByLine,
  loadSosByProduct,
  loadSosByArea,
  type AnalyticsDimensions,
  type SosByLineRow,
  type SosByProductRow,
  type SosByAreaRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { EXECUTIVE_FILTERS } from "@/lib/analytics/sales-filter-config";
import { scopeAnalyticsFilters, scopeAnalyticsDimensions, computeAnalyticsFilterVisibility, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { safeDividePct } from "@/lib/analytics/validation";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoSosByArea, demoSosByLine, demoSosByProduct } from "@/lib/analytics/demo-fixtures";
import { StackedChart } from "@/components/charts/stacked-chart";

const DONUT_COLORS = ["#F97316", "#0F172A", "#0EA5E9", "#10B981", "#8B5CF6", "#EF4444"];

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

async function ExecComparisonContent({
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
  const filters = parseAnalyticsFilters(searchParams, EXECUTIVE_FILTERS);

  const sosFilters = {
    periodFrom:   typeof filters.periodFrom  === "string" ? filters.periodFrom  : null,
    periodTo:     typeof filters.periodTo    === "string" ? filters.periodTo    : null,
    lines:        Array.isArray(filters.lines)         ? filters.lines         : [],
    regions:      Array.isArray(filters.regions)       ? filters.regions       : [],
    distributors: Array.isArray(filters.distributors)  ? filters.distributors  : [],
    canViewHeadOffice: canViewHeadOfficeLine(role),
  };
  const scoped = scopeAnalyticsFilters(sosFilters, scope);

  let byLine: SosByLineRow[];
  let byProduct: SosByProductRow[];
  let byArea: SosByAreaRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    byLine = demoSosByLine();
    byProduct = demoSosByProduct();
    byArea = demoSosByArea();
    dimensions = demoAnalyticsDimensions();
  } else if (scoped.empty) {
    byLine = [];
    byProduct = [];
    byArea = [];
    dimensions = await loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions()));
  } else {
    [byLine, byProduct, byArea, dimensions] = await Promise.all([
      loadSosByLine(scoped.filters).catch(trackFailure(analyticsFailures, "Sales by line", [])),
      loadSosByProduct(scoped.filters).catch(trackFailure(analyticsFailures, "Sales by product", [])),
      loadSosByArea(scoped.filters).catch(trackFailure(analyticsFailures, "Sales by area", [])),
      loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions())),
    ]);
  }

  const grandTotal = byLine.reduce((s, r) => s + r.value, 0);

  // Aggregate line totals across periods
  const lineMap = new Map<string, { value: number; units: number }>();
  for (const r of byLine) {
    const cur = lineMap.get(r.line) ?? { value: 0, units: 0 };
    lineMap.set(r.line, { value: cur.value + r.value, units: cur.units + r.units });
  }
  const lineRanked = [...lineMap.entries()]
    .map(([line, totals]) => ({ line, ...totals, sharePct: safeDividePct(totals.value, grandTotal) }))
    .sort((a, b) => b.value - a.value);

  // Aggregate product totals
  const prodMap = new Map<string, { productName: string; family: string; line: string; value: number; units: number }>();
  for (const r of byProduct) {
    const cur = prodMap.get(r.productCode) ?? { productName: r.productName, family: r.family, line: r.line, value: 0, units: 0 };
    prodMap.set(r.productCode, { ...cur, value: cur.value + r.value, units: cur.units + r.units });
  }
  const productRanked = [...prodMap.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, 30)
    .map((p) => ({ ...p, sharePct: safeDividePct(p.value, grandTotal) }));

  // Aggregate region totals
  const regionMap = new Map<string, { regionName: string; value: number; units: number }>();
  for (const r of byArea) {
    const cur = regionMap.get(r.regionCode) ?? { regionName: r.regionName, value: 0, units: 0 };
    regionMap.set(r.regionCode, { ...cur, value: cur.value + r.value, units: cur.units + r.units });
  }
  const regionRanked = [...regionMap.values()]
    .sort((a, b) => b.value - a.value)
    .map((r) => ({ ...r, sharePct: safeDividePct(r.value, grandTotal) }));

  const lineDonutData = lineRanked.slice(0, 6).map((row, i) => ({
    name: row.line,
    value: row.value,
    color: DONUT_COLORS[i % DONUT_COLORS.length],
  }));
  const regionDonutData = regionRanked.slice(0, 6).map((row, i) => ({
    name: row.regionName,
    value: row.value,
    color: DONUT_COLORS[i % DONUT_COLORS.length],
  }));

  return (
    <div className="space-y-6">
      {demo ? <AnalyticsDemoBanner /> : null}
      {analyticsFailures.length > 0 ? <AnalyticsErrorState what={analyticsFailures.join(", ")} /> : null}

      <AnalyticsFilterBar
        descriptors={EXECUTIVE_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/executive-comparison`}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <AnalyticsKpiCard label="Grand Total Value" value={fmt(grandTotal)} prefix="EGP" />
        <AnalyticsKpiCard label="Lines"    value={String(lineRanked.length)} />
        <AnalyticsKpiCard label="Products" value={String(productRanked.length)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AnalyticsSection title="Line Share">
          {lineDonutData.length === 0 ? <AnalyticsEmptyState /> : <StackedChart data={lineDonutData} tooltipPrefix="EGP " />}
        </AnalyticsSection>
        <AnalyticsSection title="Region Share">
          {regionDonutData.length === 0 ? <AnalyticsEmptyState /> : <StackedChart data={regionDonutData} tooltipPrefix="EGP " />}
        </AnalyticsSection>
      </div>

      <AnalyticsSection title="Line Contribution Ranking" count={lineRanked.length}>
        {lineRanked.length === 0 ? <AnalyticsEmptyState /> : (
          <AnalyticsDataTable
            searchKeys={["line"]}
            columns={[
              { key: "line",     label: "Line",    sortable: true },
              { key: "units",    label: "Units",   align: "right", sortable: true, formatKind: "number" },
              { key: "value",    label: "Value",   align: "right", sortable: true, formatKind: "number" },
              { key: "sharePct", label: "Share %", align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={lineRanked}
            totals={{ units: byLine.reduce((s, r) => s + r.units, 0), value: grandTotal }}
            exportTitle="Executive Comparison — Line Ranking"
            exportSubtitle="Cross-period line contribution and share"
          />
        )}
      </AnalyticsSection>

      <AnalyticsSection title="Product Contribution (Top 30)" count={productRanked.length}>
        {productRanked.length === 0 ? <AnalyticsEmptyState /> : (
          <AnalyticsDataTable
            searchKeys={["productName", "family", "line"]}
            columns={[
              { key: "line",        label: "Line",    sortable: true },
              { key: "family",      label: "Family",  sortable: true },
              { key: "productName", label: "Product", sortable: true },
              { key: "units",       label: "Units",   align: "right", sortable: true, formatKind: "number" },
              { key: "value",       label: "Value",   align: "right", sortable: true, formatKind: "number" },
              { key: "sharePct",    label: "Share %", align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={productRanked}
            exportTitle="Executive Comparison — Top Products"
            exportSubtitle="Top 30 products by contribution"
          />
        )}
      </AnalyticsSection>

      <AnalyticsSection title="Region Contribution Ranking" count={regionRanked.length}>
        {regionRanked.length === 0 ? <AnalyticsEmptyState /> : (
          <AnalyticsDataTable
            searchKeys={["regionName"]}
            columns={[
              { key: "regionName", label: "Region",  sortable: true },
              { key: "units",      label: "Units",   align: "right", sortable: true, formatKind: "number" },
              { key: "value",      label: "Value",   align: "right", sortable: true, formatKind: "number" },
              { key: "sharePct",   label: "Share %", align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={regionRanked}
            totals={{ value: grandTotal }}
            exportTitle="Executive Comparison — Region Ranking"
            exportSubtitle="Cross-period region contribution and share"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export function ExecutiveComparisonDashboard({
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
          <p className="text-phx-2xs font-bold uppercase tracking-widest text-phx-accent mb-0.5">Exec</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Executive Comparison</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Cross-period, cross-line, cross-region contribution and ranking from Source of Sales data.
          </p>
        </div>
      </div>

      <Suspense fallback={<AppRouteLoadingState />}>
        <ExecComparisonContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
