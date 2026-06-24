import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsKpiCard } from "@/components/analytics/analytics-kpi-card";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadSosByLine, loadSosByProduct, loadSosByArea } from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { EXECUTIVE_FILTERS } from "@/lib/analytics/sales-filter-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

async function ExecComparisonContent({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const filters = parseAnalyticsFilters(searchParams, EXECUTIVE_FILTERS);

  const sosFilters = {
    periodFrom:   typeof filters.periodFrom  === "string" ? filters.periodFrom  : null,
    periodTo:     typeof filters.periodTo    === "string" ? filters.periodTo    : null,
    lines:        Array.isArray(filters.lines)         ? filters.lines         : [],
    regions:      Array.isArray(filters.regions)       ? filters.regions       : [],
    distributors: Array.isArray(filters.distributors)  ? filters.distributors  : [],
  };

  const [byLine, byProduct, byArea] = await Promise.all([
    loadSosByLine(sosFilters).catch(() => []),
    loadSosByProduct(sosFilters).catch(() => []),
    loadSosByArea(sosFilters).catch(() => []),
  ]);

  const grandTotal = byLine.reduce((s, r) => s + r.value, 0);

  // Aggregate line totals across periods
  const lineMap = new Map<string, { value: number; units: number }>();
  for (const r of byLine) {
    const cur = lineMap.get(r.line) ?? { value: 0, units: 0 };
    lineMap.set(r.line, { value: cur.value + r.value, units: cur.units + r.units });
  }
  const lineRanked = [...lineMap.entries()]
    .map(([line, totals]) => ({ line, ...totals, sharePct: grandTotal > 0 ? (totals.value / grandTotal) * 100 : 0 }))
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
    .map((p) => ({ ...p, sharePct: grandTotal > 0 ? (p.value / grandTotal) * 100 : 0 }));

  // Aggregate region totals
  const regionMap = new Map<string, { regionName: string; value: number; units: number }>();
  for (const r of byArea) {
    const cur = regionMap.get(r.regionCode) ?? { regionName: r.regionName, value: 0, units: 0 };
    regionMap.set(r.regionCode, { ...cur, value: cur.value + r.value, units: cur.units + r.units });
  }
  const regionRanked = [...regionMap.values()]
    .sort((a, b) => b.value - a.value)
    .map((r) => ({ ...r, sharePct: grandTotal > 0 ? (r.value / grandTotal) * 100 : 0 }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <AnalyticsKpiCard label="Grand Total Value" value={fmt(grandTotal)} prefix="EGP" />
        <AnalyticsKpiCard label="Lines"    value={String(lineRanked.length)} />
        <AnalyticsKpiCard label="Products" value={String(productRanked.length)} />
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">Line Contribution Ranking</h2>
        {lineRanked.length === 0 ? <AnalyticsEmptyState /> : (
          <AnalyticsDataTable
            searchKeys={["line"]}
            columns={[
              { key: "line",     label: "Line",    sortable: true },
              { key: "units",    label: "Units",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "value",    label: "Value",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "sharePct", label: "Share %", align: "right", sortable: true, format: (v) => `${Number(v).toFixed(1)}%` },
            ]}
            rows={lineRanked}
            totals={{ units: byLine.reduce((s, r) => s + r.units, 0), value: grandTotal }}
          />
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">Product Contribution (Top 30)</h2>
        {productRanked.length === 0 ? <AnalyticsEmptyState /> : (
          <AnalyticsDataTable
            searchKeys={["productName", "family", "line"]}
            columns={[
              { key: "line",        label: "Line",    sortable: true },
              { key: "family",      label: "Family",  sortable: true },
              { key: "productName", label: "Product", sortable: true },
              { key: "units",       label: "Units",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "value",       label: "Value",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "sharePct",    label: "Share %", align: "right", sortable: true, format: (v) => `${Number(v).toFixed(1)}%` },
            ]}
            rows={productRanked}
          />
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">Region Contribution Ranking</h2>
        {regionRanked.length === 0 ? <AnalyticsEmptyState /> : (
          <AnalyticsDataTable
            searchKeys={["regionName"]}
            columns={[
              { key: "regionName", label: "Region",  sortable: true },
              { key: "units",      label: "Units",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "value",      label: "Value",   align: "right", sortable: true, format: (v) => fmt(Number(v)) },
              { key: "sharePct",   label: "Share %", align: "right", sortable: true, format: (v) => `${Number(v).toFixed(1)}%` },
            ]}
            rows={regionRanked}
            totals={{ value: grandTotal }}
          />
        )}
      </section>
    </div>
  );
}

export default async function ExecutiveComparisonPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Executive Comparison</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Cross-period, cross-line, cross-region contribution and ranking from Source of Sales data.
        </p>
      </div>
      <Suspense fallback={<AppRouteLoadingState />}>
        <ExecComparisonContent searchParams={resolvedParams} />
      </Suspense>
    </div>
  );
}
