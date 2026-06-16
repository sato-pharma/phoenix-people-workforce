"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertCircle, RefreshCw, Radar } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { ExpenseLeaderboards } from "@/components/outstation/expense-command/expense-leaderboards";
import { ExpenseRiskPanel } from "@/components/outstation/expense-command/expense-risk-panel";
import {
  ExpenseHeatmapLayer,
  type ExpenseBubbleInput,
} from "@/components/outstation/expense-heatmap-layer";
import { ExpenseBreakdownCharts } from "@/components/outstation/expense-shared/expense-breakdown-charts";
import { ExpenseDetailTable } from "@/components/outstation/expense-shared/expense-detail-table";
import { ExpenseExportButton } from "@/components/outstation/expense-shared/expense-export-button";
import { ExpenseFilterBar } from "@/components/outstation/expense-shared/expense-filter-bar";
import { ExpenseKpiRow } from "@/components/outstation/expense-shared/expense-kpi-row";
import { ExpenseSavedViews } from "@/components/outstation/expense-shared/expense-saved-views";
import { ExpenseTrendChart } from "@/components/outstation/expense-shared/expense-trend-chart";
import { egp, expenseFiltersToQueryString } from "@/components/outstation/expense-shared/formatters";
import type {
  ExpenseCommandFilters,
  ExpenseDashboardVariant,
  ExpenseSource,
  OutstationExpenseCommandData,
} from "@/components/outstation/expense-shared/types";

const DEFAULT_DATA_PATH = "/api/admin/outstation/expense-command";
const DEFAULT_EXPORT_PATH = "/api/admin/outstation/expense-command/export";

export function ExpenseCommandDashboard({
  initialData,
  initialError,
  initialFilters,
  mapsBrowserKey,
  variant = "admin",
  dataBasePath = DEFAULT_DATA_PATH,
  exportBasePath = DEFAULT_EXPORT_PATH,
}: {
  initialData: OutstationExpenseCommandData | null;
  initialError: string | null;
  initialFilters: ExpenseCommandFilters;
  mapsBrowserKey: string;
  variant?: ExpenseDashboardVariant;
  dataBasePath?: string;
  exportBasePath?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [data, setData] = useState<OutstationExpenseCommandData | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<ExpenseCommandFilters>(initialFilters);
  const [refreshKey, setRefreshKey] = useState(0);

  const skipNextFetch = useRef(initialData !== null);
  const filtersKey = useMemo(() => expenseFiltersToQueryString(filters), [filters]);

  useEffect(() => {
    router.replace(filtersKey ? `${pathname}?${filtersKey}` : pathname, { scroll: false });

    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }

    let cancelled = false;
    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      try {
        const response = await fetch(`${dataBasePath}?${filtersKey}`, { cache: "no-store" });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { message?: string };
          throw new Error(body?.message || `Request failed (${response.status})`);
        }
        const payload = (await response.json()) as OutstationExpenseCommandData;
        if (cancelled) return;
        setData(payload);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Could not load expense intelligence.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filtersKey, refreshKey, dataBasePath, pathname, router]);

  const updateFilters = useCallback((patch: Partial<ExpenseCommandFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ preset: "all" });
  }, []);

  const heatPoints: ExpenseBubbleInput[] = useMemo(
    () =>
      (data?.heatPoints ?? []).map((point) => ({
        id: point.id,
        lat: point.latitude,
        lng: point.longitude,
        weight: point.weight,
        region: point.region,
        count: point.count,
      })),
    [data?.heatPoints],
  );

  const unmappedAmount = useMemo(
    () => (data?.rows ?? []).filter((row) => !row.mappable).reduce((sum, row) => sum + (row.total || 0), 0),
    [data?.rows],
  );

  const exportHref = `${exportBasePath}?${filtersKey}`;
  const hasRows = (data?.kpis.totalRows ?? 0) > 0;
  const isAdmin = variant === "admin";

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Outstation Intelligence"
        icon={<Radar className="h-3.5 w-3.5 text-orange-300" />}
        title="Outstation Expense Command Center"
        description="Every outstation expense — historical uploads, live employee submissions, and admin manual entries — unified with a live Google Maps heatmap, cross-filters, and one-click export."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRefreshKey((key) => key + 1)}
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-200 transition-colors hover:border-white/30"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
            </button>
            <ExpenseExportButton href={exportHref} disabled={!hasRows} />
          </div>
        }
        badges={
          data ? (
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip tone="slate">Window: {data.windowLabel}</AdminInsightChip>
              <AdminInsightChip tone="orange">Spend: {egp(data.kpis.totalAmount)}</AdminInsightChip>
              <AdminInsightChip tone="emerald">{data.kpis.totalRows.toLocaleString()} trips</AdminInsightChip>
            </div>
          ) : null
        }
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="font-mono text-xs">{error}</span>
        </AdminCallout>
      ) : null}

      {data ? (
        <>
          <ExpenseKpiRow kpiDeltas={data.kpiDeltas} kpis={data.kpis} variant={variant} />

          {isAdmin ? (
            <ExpenseSavedViews currentFilters={filters} onLoad={(loaded) => setFilters(loaded)} />
          ) : null}

          <ExpenseFilterBar
            filters={filters}
            filterOptions={data.filterOptions}
            loading={loading}
            onChange={updateFilters}
            onClear={clearFilters}
            variant={variant}
          />

          <div className={loading ? "space-y-5 opacity-60 transition-opacity" : "space-y-5 transition-opacity"}>
            <ExpenseHeatmapLayer
              browserKey={mapsBrowserKey}
              points={heatPoints}
              unmappedAmount={unmappedAmount}
              unmappedCount={data.kpis.unmappableRows}
            />

            <ExpenseTrendChart trend={data.trend} />

            <ExpenseBreakdownCharts
              breakdowns={data.breakdowns}
              bySource={data.kpis.bySource}
              onSelectExpenseType={isAdmin ? (expenseType) => updateFilters({ expenseType }) : undefined}
              onSelectRegion={isAdmin ? (region) => updateFilters({ region }) : undefined}
              onSelectSource={(source: ExpenseSource) => updateFilters({ source })}
              onSelectTransport={(transportation) => updateFilters({ transportation })}
            />

            {isAdmin ? (
              <>
                <ExpenseLeaderboards
                  onSelectEmployee={(hrId) => updateFilters({ employeeHrId: hrId })}
                  topSpenders={data.leaderboards.topSpenders}
                />
                <ExpenseRiskPanel
                  highRiskByLocation={data.leaderboards.highRiskByLocation}
                  highRiskRows={data.kpis.highRiskRows}
                  onSelectRegion={(region) => updateFilters({ region })}
                />
              </>
            ) : null}

            <ExpenseDetailTable rows={data.rows} variant={variant} />
          </div>
        </>
      ) : !error ? (
        <AdminCallout tone="neutral">
          <span>Loading outstation expense intelligence…</span>
        </AdminCallout>
      ) : null}
    </div>
  );
}
