"use client";

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Download,
  Filter,
  Loader2,
  MapPin,
  Minus,
  Package,
  Store,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { cn } from "@/lib/utils";
import type {
  WeeklyBranchComparisonRow,
  WeeklyBranchRow,
  WeeklyDashboard,
  WeeklyDelta,
  WeeklyFilterMode,
  WeeklyRanked,
} from "@/lib/sales/weekly/types";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import {
  SortableTh,
  TableNoResults,
  TableSearchInput,
  useSortableTable,
  visibleMax,
} from "@/components/ui/sortable-table";


const money = (value: number) => `EGP ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const num = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });
const pct = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
const compactNumber = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
};
const truncateLabel = (value: string, max = 18) => (value.length > max ? `${value.slice(0, max - 1)}...` : value);
const CHART_COLORS = ["#F97316", "#2563EB", "#0F766E", "#7C3AED", "#DC2626", "#64748B", "#CA8A04"];

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
// "2026-05-01" → "May 2026" (pure string parse, timezone-safe).
const monthLabelClient = (cycleMonth: string | null) => {
  if (!cycleMonth) return "—";
  const [year, month] = cycleMonth.split("-");
  const name = MONTH_NAMES[Number(month) - 1];
  return name ? `${name} ${year}` : cycleMonth;
};

type WeeklyFilters = {
  distributorCodes: string[];
  distributorMode: WeeklyFilterMode;
  regionCodes: string[];
  regionMode: WeeklyFilterMode;
  productCodes: string[];
  productMode: WeeklyFilterMode;
  lineCodes: string[];
  lineMode: WeeklyFilterMode;
  monthCodes: string[];
  monthMode: WeeklyFilterMode;
  weekNumberCodes: string[];
  weekNumberMode: WeeklyFilterMode;
};

export function WeeklyDashboardView({ initial, initialError }: { initial: WeeklyDashboard | null; initialError: string | null }) {
  const [data, setData] = useState<WeeklyDashboard | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [filters, setFilters] = useState<WeeklyFilters>({
    distributorCodes: initial?.appliedFilters.distributorCodes ?? [],
    distributorMode: initial?.appliedFilters.distributorFilterMode ?? "include",
    regionCodes: initial?.appliedFilters.regionCodes ?? [],
    regionMode: initial?.appliedFilters.regionFilterMode ?? "include",
    productCodes: initial?.appliedFilters.productCodes ?? [],
    productMode: initial?.appliedFilters.productFilterMode ?? "include",
    lineCodes: initial?.appliedFilters.lineCodes ?? [],
    lineMode: initial?.appliedFilters.lineFilterMode ?? "include",
    monthCodes: initial?.appliedFilters.cycleMonths ?? [],
    monthMode: initial?.appliedFilters.cycleMonthMode ?? "include",
    weekNumberCodes: (initial?.appliedFilters.weekNumbers ?? []).map((value) => String(value)),
    weekNumberMode: initial?.appliedFilters.weekNumberMode ?? "include",
  });
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    // No date-week selector: week scoping is via Month + Week-of-month filters below. With neither set,
    // the server returns all weeks.
    for (const code of filters.distributorCodes) params.append("distributor", code);
    if (filters.distributorMode === "exclude") params.set("distributorMode", "exclude");
    for (const code of filters.regionCodes) params.append("region", code);
    if (filters.regionMode === "exclude") params.set("regionMode", "exclude");
    for (const code of filters.productCodes) params.append("product", code);
    if (filters.productMode === "exclude") params.set("productMode", "exclude");
    for (const code of filters.lineCodes) params.append("line", code);
    if (filters.lineMode === "exclude") params.set("lineMode", "exclude");
    for (const code of filters.monthCodes) params.append("month", code);
    if (filters.monthMode === "exclude") params.set("monthMode", "exclude");
    for (const code of filters.weekNumberCodes) params.append("weekNum", code);
    if (filters.weekNumberMode === "exclude") params.set("weekNumMode", "exclude");
    (async () => {
      // Defer the loading flag off the synchronous effect tick (avoids cascading-render lint).
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      try {
        const response = await fetch(`/api/sales/weekly/dashboard?${params.toString()}`, { cache: "no-store" });
        const payload = (await response.json()) as { success?: boolean; data?: WeeklyDashboard; error?: string };
        if (cancelled) return;
        if (payload?.success && payload.data) {
          setData(payload.data);
          setError(null);
        } else {
          setError(payload?.error ?? "Failed to load the weekly dashboard.");
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load the weekly dashboard.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    filters.distributorCodes,
    filters.distributorMode,
    filters.regionCodes,
    filters.regionMode,
    filters.productCodes,
    filters.productMode,
    filters.lineCodes,
    filters.lineMode,
    filters.monthCodes,
    filters.monthMode,
    filters.weekNumberCodes,
    filters.weekNumberMode,
  ]);

  const distributorOptions = useMemo(
    () => (data?.distributors ?? []).map((distributor) => ({ code: distributor.code, label: distributor.name })),
    [data],
  );
  const regionOptions = useMemo(
    () => (data?.availableRegions ?? []).map((region) => ({ code: region.code, label: region.name })),
    [data],
  );
  const productOptions = useMemo(
    () => (data?.availableProducts ?? []).map((product) => ({ code: product.code, label: product.name })),
    [data],
  );
  const lineOptions = useMemo(
    () => (data?.availableLines ?? []).map((line) => ({ code: line, label: line })),
    [data],
  );
  const monthOptions = useMemo(
    () => (data?.availableMonths ?? []).map((month) => ({ code: month.code, label: month.name })),
    [data],
  );
  const weekNumberOptions = useMemo(
    () => (data?.availableWeekNumbers ?? []).map((week) => ({ code: String(week), label: `Week ${week}` })),
    [data],
  );
  const handleExport = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const params = new URLSearchParams();
      for (const code of filters.distributorCodes) params.append("distributor", code);
      if (filters.distributorMode === "exclude") params.set("distributorMode", "exclude");
      for (const code of filters.regionCodes) params.append("region", code);
      if (filters.regionMode === "exclude") params.set("regionMode", "exclude");
      for (const code of filters.productCodes) params.append("product", code);
      if (filters.productMode === "exclude") params.set("productMode", "exclude");
      for (const code of filters.lineCodes) params.append("line", code);
      if (filters.lineMode === "exclude") params.set("lineMode", "exclude");
      for (const code of filters.monthCodes) params.append("month", code);
      if (filters.monthMode === "exclude") params.set("monthMode", "exclude");
      for (const code of filters.weekNumberCodes) params.append("weekNum", code);
      if (filters.weekNumberMode === "exclude") params.set("weekNumMode", "exclude");
      const response = await fetch(`/api/sales/weekly/export?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Export failed.");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? "phoenix-weekly-sales.xlsx";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      // silent — network errors show as nothing downloaded
    } finally {
      setDownloading(false);
    }
  }, [downloading, filters]);

  if (!data) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 rounded-[6px] border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700 shadow-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <span>{error ?? "No weekly data available yet. Upload a weekly file to get started."}</span>
        </div>
      </div>
    );
  }

  const noData = data.availableWeeks.length === 0;
  const branchRows = data.branchBreakdown ?? [];
  const zeroStockRows = data.zeroSalesBranches ?? [];
  const zeroStockTotal = zeroStockRows.reduce((total, branch) => total + branch.stockUnits, 0);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="rounded-[6px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">
              <span className="h-2 w-2 rounded-full bg-[#F97316]" />
              Weekly Sales
            </div>
            <h1 className="text-xl font-black text-[#0F172A]">Weekly Sales Dashboard</h1>
            <p className="mt-1 text-sm font-medium text-[#64748B]">
              Consolidated by region, product, branch, and distributor. Stock shown as units only.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExport}
              disabled={downloading || loading}
              className="flex items-center gap-1.5 rounded-[6px] border border-[#F97316] bg-[#F97316] px-3 py-2 text-sm font-black text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
              title="Download Excel report with current filters applied"
            >
              {downloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {downloading ? "Preparing…" : "Export Excel"}
            </button>
          </div>
        </div>
      </header>

      <div className="rounded-[6px] border border-[#E2E8F0] bg-white p-2 shadow-sm">
        <div className="mb-2 flex items-center justify-between px-1 text-[11px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">
          <span className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5" />
            Filters
          </span>
          {/* A weekly reload takes seconds, and until it lands the PREVIOUS numbers are still on
              screen. A faint "Updating" was too easy to miss, so a stale unfiltered total read as
              "the period filter did nothing" — make the pending state unmissable instead. */}
          {loading ? (
            <span className="flex items-center gap-1.5 rounded-[4px] bg-[#F97316] px-2 py-0.5 text-white">
              <Loader2 className="h-3 w-3 animate-spin" />
              Updating…
            </span>
          ) : (
            <span className="text-[#64748B]">Ready</span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <MultiSelectFilter
            label="Month"
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            options={monthOptions}
            selected={filters.monthCodes}
            mode={filters.monthMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, monthCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, monthMode: next }))}
            allLabel="All months"
          />
          <MultiSelectFilter
            label="Week of month"
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            options={weekNumberOptions}
            selected={filters.weekNumberCodes}
            mode={filters.weekNumberMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, weekNumberCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, weekNumberMode: next }))}
            allLabel="All weeks"
          />
          <MultiSelectFilter
            label="Distributor"
            icon={<Store className="h-3.5 w-3.5" />}
            options={distributorOptions}
            selected={filters.distributorCodes}
            mode={filters.distributorMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, distributorCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, distributorMode: next }))}
            allLabel="All distributors"
          />
          <MultiSelectFilter
            label="Region"
            icon={<MapPin className="h-3.5 w-3.5" />}
            options={regionOptions}
            selected={filters.regionCodes}
            mode={filters.regionMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, regionCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, regionMode: next }))}
            allLabel="All regions"
          />
          <MultiSelectFilter
            label="Product"
            icon={<Package className="h-3.5 w-3.5" />}
            options={productOptions}
            selected={filters.productCodes}
            mode={filters.productMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, productCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, productMode: next }))}
            allLabel="All products"
          />
          <MultiSelectFilter
            label="Line"
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            options={lineOptions}
            selected={filters.lineCodes}
            mode={filters.lineMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, lineCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, lineMode: next }))}
            allLabel="All lines"
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-[6px] border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700 shadow-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {noData ? (
        <div className="rounded-[6px] border border-dashed border-[#CBD5E1] bg-white p-8 text-center text-sm font-semibold text-[#64748B] shadow-sm">
          No validated weekly uploads yet. Upload a weekly file from <span className="font-black">Weekly Sales Upload</span>.
        </div>
      ) : (
        // Dim EVERY figure while a reload is in flight, not just the KPI row — the tables and charts
        // below carry the same about-to-be-replaced numbers, and leaving them crisp is what made a
        // pending filter look like an applied one.
        <div className={cn("space-y-4 transition-opacity", loading && "opacity-40")} aria-busy={loading}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi icon={<TrendingUp className="h-4 w-4" />} label="Sales value" value={money(data.kpis.salesValue)} delta={data.compare.salesValue} format={money} />
            <Kpi icon={<Package className="h-4 w-4" />} label="Sales units" value={num(data.kpis.salesUnits)} delta={data.compare.salesUnits} format={num} />
            <Kpi icon={<Store className="h-4 w-4" />} label="Stock units" value={num(data.kpis.stockUnits)} delta={data.compare.stockUnits} format={num} />
            <Kpi icon={<Store className="h-4 w-4" />} label="Branches" value={num(data.kpis.branchCount)} sub={`${data.kpis.regionCount} regions - ${data.kpis.productCount} products`} />
          </div>

          <DashboardCharts data={data} />

          <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
            <RankTable title="By region (all distributors)" rows={data.regions} />
            <RankTable title="By product" rows={data.products} />
          </div>

          <BranchComparisonTable rows={branchRows} />

          {data.distributors.length > 1 && <RankTable maxHeight="max-h-64" title="By distributor" rows={data.distributorBreakdown} />}

          <WeekComparisonTable rows={data.weekComparison} />

          <TrendStrip trend={data.trend} selected={[]} />

          <ZeroStockTable rows={zeroStockRows} totalStock={zeroStockTotal} />
        </div>
      )}
    </div>
  );
}

function DeltaPct({ value }: { value: number }) {
  const up = value >= 0;
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-bold", up ? "text-emerald-600" : "text-rose-600")}>
      {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {pct(value)}
    </span>
  );
}

// Week-by-week comparison of REAL (de-cumulated) sales: each week minus the previous week of its
// month. Stock is the week's snapshot (not a difference). The % delta is vs the previous week.
function WeekComparisonTable({ rows }: { rows: WeeklyDashboard["weekComparison"] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="border-b border-[#E2E8F0] px-4 py-3">
        <h2 className="text-sm font-black uppercase tracking-[0.12em] text-[#0F172A]">Week-by-week comparison</h2>
        <p className="mt-0.5 text-xs font-medium text-[#64748B]">
          Real sales per week — each week minus the previous week of its month (W2−W1, W3−W2, …). Stock is the
          week&apos;s snapshot, never subtracted.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#020617] text-left text-[11px] font-black uppercase tracking-wide text-white">
            <tr>
              <th className="px-3 py-2">Month</th>
              <th className="px-3 py-2">Week</th>
              <th className="px-3 py-2">Period date</th>
              <th className="px-3 py-2 text-right">Sales value</th>
              <th className="px-3 py-2 text-right">Sales units</th>
              <th className="px-3 py-2 text-right">Stock units</th>
              <th className="px-3 py-2 text-right">vs prev week</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t border-[#FFE8D6]" key={`${row.cycleMonth}-${row.weekNumber}`}>
                <td className="px-3 py-2 font-semibold text-[#0F172A]">{monthLabelClient(row.cycleMonth)}</td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-flex items-center rounded bg-[#FFF7ED] px-2 py-0.5 text-[11px] font-black text-[#9A3412]">
                      W{row.weekNumber}
                    </span>
                    {row.spansGap ? (
                      <span
                        className="inline-flex items-center rounded bg-[#FEF3C7] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#92400E]"
                        title="An earlier week of this month was never uploaded, so this week's figure spans the missing week(s) — it is not a true single-week value."
                      >
                        Spans gap
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="px-3 py-2 text-[#64748B] tabular-nums">{row.weekStart ?? "—"}</td>
                <td className="px-3 py-2 text-right font-bold tabular-nums text-[#0F172A]">
                  {row.salesValue == null ? <span className="text-[#94A3B8]">—</span> : money(row.salesValue)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-[#334155]">
                  {row.salesUnits == null ? <span className="text-[#94A3B8]">—</span> : num(row.salesUnits)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-[#334155]">{num(row.stockUnits)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {row.deltaValuePct == null ? <span className="text-[#94A3B8]">—</span> : <DeltaPct value={row.deltaValuePct} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
  delta,
  format,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  delta?: WeeklyDelta;
  format?: (value: number) => string;
}) {
  return (
    <div className="rounded-[6px] border border-[#E2E8F0] bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wide text-[#94A3B8]">
        <span className="flex h-7 w-7 items-center justify-center rounded-[5px] border border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-lg font-black tabular-nums text-[#0F172A]">{value}</div>
      {delta ? <DeltaLabel delta={delta} format={format} /> : sub ? <div className="mt-0.5 text-[11px] font-bold text-[#94A3B8]">{sub}</div> : null}
    </div>
  );
}

function DeltaLabel({ delta, format }: { delta: WeeklyDelta; format?: (value: number) => string }) {
  if (delta.prior == null) {
    return (
      <div className="mt-0.5 flex items-center gap-1 text-[11px] font-bold text-[#94A3B8]">
        <Minus className="h-3 w-3" /> no prior week
      </div>
    );
  }
  const up = (delta.pct ?? 0) >= 0;
  const tone = delta.pct == null ? "text-[#94A3B8]" : up ? "text-emerald-600" : "text-rose-600";
  return (
    <div className={`mt-0.5 flex items-center gap-1 text-[11px] font-bold ${tone}`}>
      {delta.pct == null ? <Minus className="h-3 w-3" /> : up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {delta.pct == null ? "-" : pct(delta.pct)}
      <span className="font-medium text-[#94A3B8]">vs {format ? format(delta.prior) : delta.prior}</span>
    </div>
  );
}

function DashboardCharts({ data }: { data: WeeklyDashboard }) {
  const branchRows = data.branchBreakdown.slice(0, 10);
  const stockRiskRows = data.zeroSalesBranches.slice(0, 8);
  return (
    <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <HorizontalValueChart rows={data.regions.slice(0, 8)} title="Regional sales value" />
      <ProductMixChart rows={data.products} />
      <BranchSalesStockChart rows={branchRows} />
      <ZeroSalesStockChart rows={stockRiskRows} />
    </section>
  );
}

function ChartPanel({
  children,
  meta,
  title,
}: {
  children: React.ReactNode;
  meta?: string;
  title: string;
}) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
        <span className="text-xs font-black uppercase tracking-wide text-[#64748B]">{title}</span>
        {meta ? <span className="text-[10px] font-black uppercase tracking-wide text-[#94A3B8]">{meta}</span> : null}
      </div>
      {children}
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[260px] items-center justify-center px-4 text-center text-sm font-semibold text-[#94A3B8]">
      {label}
    </div>
  );
}

function HorizontalValueChart({ rows, title }: { rows: WeeklyRanked[]; title: string }) {
  const chartRows = rows.map((row) => ({
    ...row,
    label: truncateLabel(row.name || row.code, 22),
  }));
  return (
    <ChartPanel meta={`${chartRows.length} rows`} title={title}>
      {chartRows.length === 0 ? (
        <EmptyChart label="No sales rows for this filter." />
      ) : (
        <div className="h-[300px] min-w-0 px-2 py-3">
          <ResponsiveContainer height="100%" width="100%">
            <BarChart data={chartRows} layout="vertical" margin={{ bottom: 4, left: 8, right: 18, top: 6 }}>
              <CartesianGrid horizontal={false} stroke="#E2E8F0" strokeDasharray="4 8" />
              <XAxis axisLine={false} tick={{ fill: "#94A3B8", fontSize: 10, fontWeight: 700 }} tickFormatter={(value) => compactNumber(Number(value))} tickLine={false} type="number" />
              <YAxis axisLine={false} dataKey="label" tick={{ fill: "#334155", fontSize: 10, fontWeight: 700 }} tickLine={false} type="category" width={112} />
              <Tooltip formatter={(value) => money(Number(value))} labelFormatter={(_, payload) => payload?.[0]?.payload?.name ?? ""} />
              <Bar dataKey="salesValue" fill="#F97316" radius={[0, 5, 5, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartPanel>
  );
}

function ProductMixChart({ rows }: { rows: WeeklyRanked[] }) {
  const top = rows.slice(0, 6);
  const restValue = rows.slice(6).reduce((total, row) => total + row.salesValue, 0);
  const chartRows = restValue > 0 ? [...top, { code: "OTHER", name: "Other products", salesValue: restValue, salesUnits: 0, stockUnits: 0, share: 0 }] : top;
  return (
    <ChartPanel meta={`${rows.length} products`} title="Product mix">
      {chartRows.length === 0 ? (
        <EmptyChart label="No product sales for this filter." />
      ) : (
        <div className="grid min-h-[300px] grid-cols-1 gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_180px]">
          <div className="h-[260px] min-w-0">
            <ResponsiveContainer height="100%" width="100%">
              <PieChart>
                <Tooltip formatter={(value) => money(Number(value))} />
                <Pie cx="50%" cy="50%" data={chartRows} dataKey="salesValue" innerRadius="56%" nameKey="name" outerRadius="82%" paddingAngle={2}>
                  {chartRows.map((row, index) => (
                    <Cell fill={CHART_COLORS[index % CHART_COLORS.length]} key={row.code} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-col justify-center gap-2">
            {chartRows.map((row, index) => (
              <div className="flex items-center justify-between gap-2 text-xs" key={row.code}>
                <span className="flex min-w-0 items-center gap-2 font-bold text-[#334155]">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
                  <span className="truncate">{row.name}</span>
                </span>
                <span className="shrink-0 tabular-nums font-black text-[#0F172A]">{compactNumber(row.salesValue)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </ChartPanel>
  );
}

function BranchSalesStockChart({ rows }: { rows: WeeklyBranchComparisonRow[] }) {
  const chartRows = rows.map((row) => ({
    ...row,
    label: truncateLabel(row.name || row.code, 18),
  }));
  return (
    <ChartPanel meta={`${chartRows.length} branches`} title="Branch sales vs stock">
      {chartRows.length === 0 ? (
        <EmptyChart label="No branch rows for this filter." />
      ) : (
        <div className="h-[300px] min-w-0 px-2 py-3">
          <ResponsiveContainer height="100%" width="100%">
            <BarChart data={chartRows} margin={{ bottom: 22, left: -8, right: 14, top: 8 }}>
              <CartesianGrid stroke="#E2E8F0" strokeDasharray="4 8" vertical={false} />
              <XAxis axisLine={false} dataKey="label" interval={0} tick={{ fill: "#64748B", fontSize: 9, fontWeight: 700 }} tickLine={false} />
              <YAxis axisLine={false} tick={{ fill: "#94A3B8", fontSize: 10, fontWeight: 700 }} tickFormatter={(value) => compactNumber(Number(value))} tickLine={false} width={46} />
              <Tooltip formatter={(value, name) => [num(Number(value)), name === "salesUnits" ? "Sales units" : "Stock units"]} labelFormatter={(_, payload) => payload?.[0]?.payload?.name ?? ""} />
              <Bar dataKey="salesUnits" fill="#F97316" radius={[5, 5, 0, 0]} />
              <Bar dataKey="stockUnits" fill="#2563EB" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartPanel>
  );
}

function ZeroSalesStockChart({ rows }: { rows: WeeklyBranchRow[] }) {
  const chartRows = rows.map((row) => ({
    ...row,
    label: truncateLabel(row.branchName || row.branchCode, 22),
  }));
  return (
    <ChartPanel meta={`${chartRows.length} branches`} title="Stock with zero sales">
      {chartRows.length === 0 ? (
        <EmptyChart label="No stock-on-hand zero-sales branches for this filter." />
      ) : (
        <div className="h-[300px] min-w-0 px-2 py-3">
          <ResponsiveContainer height="100%" width="100%">
            <BarChart data={chartRows} layout="vertical" margin={{ bottom: 4, left: 8, right: 18, top: 6 }}>
              <CartesianGrid horizontal={false} stroke="#E2E8F0" strokeDasharray="4 8" />
              <XAxis axisLine={false} tick={{ fill: "#94A3B8", fontSize: 10, fontWeight: 700 }} tickFormatter={(value) => compactNumber(Number(value))} tickLine={false} type="number" />
              <YAxis axisLine={false} dataKey="label" tick={{ fill: "#334155", fontSize: 10, fontWeight: 700 }} tickLine={false} type="category" width={112} />
              <Tooltip formatter={(value) => [num(Number(value)), "Stock units"]} labelFormatter={(_, payload) => payload?.[0]?.payload?.branchName ?? ""} />
              <Bar dataKey="stockUnits" fill="#0F766E" radius={[0, 5, 5, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartPanel>
  );
}

function RankTable({
  title,
  rows,
  className,
  maxHeight = "max-h-80",
}: {
  title: string;
  rows: WeeklyRanked[];
  className?: string;
  maxHeight?: string;
}) {
  const table = useSortableTable(rows, {
    columns: [
      { key: "name", accessor: (row) => row.name, type: "string" },
      { key: "salesValue", accessor: (row) => row.salesValue, type: "number" },
      { key: "salesUnits", accessor: (row) => row.salesUnits, type: "number" },
      { key: "stockUnits", accessor: (row) => row.stockUnits, type: "number" },
      { key: "share", accessor: (row) => row.share, type: "number" },
    ],
    searchAccessors: [(row) => row.name, (row) => row.code],
    initialSort: { key: "salesValue", dir: "desc" },
    secondarySort: { key: "name", accessor: (row) => row.name, type: "string" },
  });
  const max = visibleMax(table.rows, (row) => row.salesValue);
  return (
    <section className={cn("overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm", className)}>
      <PanelTitle
        count={table.visible}
        total={table.total}
        filtered={table.isFiltered}
        title={title}
        actions={
          <TableSearchInput value={table.query} onChange={table.setQuery} onClear={table.clearQuery} placeholder="Filter…" />
        }
      />
      <div className={cn("overflow-auto", maxHeight)}>
        <table className="w-full min-w-[620px] text-sm">
          <thead className="sticky top-0 z-10 bg-[#020617] text-left text-[10px] font-black uppercase text-white">
            <tr>
              <SortableTh label="Name" sortKey="name" sort={table.sort} onSort={table.toggleSort} />
              <SortableTh label="Sales value" sortKey="salesValue" sort={table.sort} onSort={table.toggleSort} align="right" />
              <SortableTh label="Units" sortKey="salesUnits" sort={table.sort} onSort={table.toggleSort} align="right" />
              <SortableTh label="Stock" sortKey="stockUnits" sort={table.sort} onSort={table.toggleSort} align="right" />
              <SortableTh label="Share" sortKey="share" sort={table.sort} onSort={table.toggleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 && <TableNoResults colSpan={5} filtered={table.isFiltered} />}
            {table.rows.map((row) => (
              <tr className="border-t border-[#F1F5F9] transition hover:bg-[#FFF7ED]" key={row.code}>
                <td className="px-3 py-2">
                  <div className="font-semibold text-[#0F172A]">{row.name}</div>
                  <div className="mt-1 h-1 w-full rounded-full bg-[#F1F5F9]">
                    <div className="h-1 rounded-full bg-[#F97316]" style={{ width: `${Math.max(2, (row.salesValue / max) * 100)}%` }} />
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-bold text-[#0F172A]">{money(row.salesValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[#334155]">{num(row.salesUnits)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[#334155]">{num(row.stockUnits)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{(row.share * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BranchComparisonTable({ rows }: { rows: WeeklyBranchComparisonRow[] }) {
  const table = useSortableTable(rows, {
    columns: [
      { key: "name", accessor: (row) => row.name, type: "string" },
      { key: "regionName", accessor: (row) => row.regionName, type: "string" },
      { key: "salesValue", accessor: (row) => row.salesValue, type: "number" },
      { key: "salesUnits", accessor: (row) => row.salesUnits, type: "number" },
      { key: "stockUnits", accessor: (row) => row.stockUnits, type: "number" },
      { key: "share", accessor: (row) => row.share, type: "number" },
    ],
    searchAccessors: [(row) => row.name, (row) => row.regionName, (row) => row.code],
    initialSort: { key: "salesValue", dir: "desc" },
    secondarySort: { key: "name", accessor: (row) => row.name, type: "string" },
  });
  const max = visibleMax(table.rows, (row) => row.salesValue);
  return (
    <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
      <PanelTitle
        count={table.visible}
        total={table.total}
        filtered={table.isFiltered}
        title="Branches comparison"
        actions={
          <TableSearchInput value={table.query} onChange={table.setQuery} onClear={table.clearQuery} placeholder="Filter branches…" />
        }
      />
      <div className="max-h-96 overflow-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="sticky top-0 z-10 bg-[#020617] text-left text-[10px] font-black uppercase text-white">
            <tr>
              <SortableTh label="Branch" sortKey="name" sort={table.sort} onSort={table.toggleSort} />
              <SortableTh label="Region" sortKey="regionName" sort={table.sort} onSort={table.toggleSort} />
              <SortableTh label="Sales value" sortKey="salesValue" sort={table.sort} onSort={table.toggleSort} align="right" />
              <SortableTh label="Units" sortKey="salesUnits" sort={table.sort} onSort={table.toggleSort} align="right" />
              <SortableTh label="Stock" sortKey="stockUnits" sort={table.sort} onSort={table.toggleSort} align="right" />
              <SortableTh label="Share" sortKey="share" sort={table.sort} onSort={table.toggleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 && <TableNoResults colSpan={6} filtered={table.isFiltered} label="branch rows" />}
            {table.rows.map((row) => (
              <tr className="border-t border-[#F1F5F9] transition hover:bg-[#FFF7ED]" key={row.code}>
                <td className="px-3 py-2">
                  <div className="font-semibold text-[#0F172A]">{row.name}</div>
                  <div className="mt-1 h-1 w-full rounded-full bg-[#F1F5F9]">
                    <div className="h-1 rounded-full bg-[#F97316]" style={{ width: `${Math.max(2, (row.salesValue / max) * 100)}%` }} />
                  </div>
                </td>
                <td className="px-3 py-2 font-semibold text-[#334155]">{row.regionName}</td>
                <td className="px-3 py-2 text-right tabular-nums font-bold text-[#0F172A]">{money(row.salesValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[#334155]">{num(row.salesUnits)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[#334155]">{num(row.stockUnits)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{(row.share * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ZeroStockTable({ rows, totalStock }: { rows: WeeklyBranchRow[]; totalStock: number }) {
  const table = useSortableTable(rows, {
    columns: [
      { key: "branchName", accessor: (row) => row.branchName, type: "string" },
      { key: "regionName", accessor: (row) => row.regionName, type: "string" },
      { key: "stockUnits", accessor: (row) => row.stockUnits, type: "number" },
    ],
    searchAccessors: [(row) => row.branchName, (row) => row.regionName],
    initialSort: { key: "stockUnits", dir: "desc" },
    secondarySort: { key: "branchName", accessor: (row) => row.branchName, type: "string" },
  });
  const max = visibleMax(table.rows, (row) => row.stockUnits);
  const shownStock = table.isFiltered ? table.rows.reduce((total, row) => total + row.stockUnits, 0) : totalStock;
  return (
    <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
        <div>
          <div className="text-xs font-black uppercase tracking-wide text-[#64748B]">Stock on hand watchlist</div>
          <div className="text-[11px] font-bold text-[#94A3B8]">Zero sales branches</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-40 sm:w-48">
            <TableSearchInput value={table.query} onChange={table.setQuery} onClear={table.clearQuery} placeholder="Filter branches…" />
          </div>
          <div className="text-right">
            <div className="text-sm font-black tabular-nums text-[#0F172A]">{num(shownStock)}</div>
            <div className="text-[10px] font-black uppercase tracking-wide text-[#94A3B8]">
              {table.isFiltered && table.visible !== table.total ? `${table.visible} / ${table.total}` : table.visible} rows
            </div>
          </div>
        </div>
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 z-10 bg-[#020617] text-left text-[10px] font-black uppercase text-white">
            <tr>
              <SortableTh label="Branch" sortKey="branchName" sort={table.sort} onSort={table.toggleSort} className="w-[52%]" />
              <SortableTh label="Region" sortKey="regionName" sort={table.sort} onSort={table.toggleSort} className="w-[24%]" />
              <SortableTh label="Stock units" sortKey="stockUnits" sort={table.sort} onSort={table.toggleSort} align="right" className="w-[24%]" />
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 && <TableNoResults colSpan={3} filtered={table.isFiltered} label="stock-on-hand branches with zero sales" />}
            {table.rows.map((branch) => (
              <tr className="border-t border-[#F1F5F9] transition hover:bg-[#FFF7ED]" key={`${branch.branchCode}-${branch.regionName}`}>
                <td className="px-3 py-2">
                  <div className="font-semibold text-[#0F172A]">{branch.branchName}</div>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-[#F1F5F9]">
                    <div className="h-1.5 rounded-full bg-[#F97316]" style={{ width: `${Math.max(4, (branch.stockUnits / max) * 100)}%` }} />
                  </div>
                </td>
                <td className="px-3 py-2 text-[#334155]">{branch.regionName}</td>
                <td className="px-3 py-2 text-right tabular-nums font-bold text-[#334155]">{num(branch.stockUnits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PanelTitle({
  count,
  total,
  filtered,
  title,
  actions,
}: {
  count: number;
  total?: number;
  filtered?: boolean;
  title: string;
  actions?: React.ReactNode;
}) {
  const showSplit = filtered && typeof total === "number" && total !== count;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
      <span className="text-xs font-black uppercase tracking-wide text-[#64748B]">{title}</span>
      <div className="flex items-center gap-2">
        {actions ? <div className="w-40 sm:w-48">{actions}</div> : null}
        <span className="shrink-0 rounded-[4px] border border-[#E2E8F0] bg-white px-2 py-1 text-[10px] font-black uppercase tracking-wide text-[#94A3B8]">
          {showSplit ? `${count} / ${total}` : count} rows
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly sales-value trend — year-aware smooth area chart (white surface, calm).
// 2025 = muted slate-blue (the "past"); 2026 = brand orange (the "now"); any other
// year falls back to neutral slate so the chart never breaks on long/odd spans.
// ─────────────────────────────────────────────────────────────────────────────

// Per-year stroke colors. Distributors are NEVER drawn as extra lines — they live
// only inside the tooltip, so the chart stays quiet.
const TREND_YEAR_COLOR: Record<string, string> = {
  "2025": "#60A5FA", // blue-400 — quiet past year
  "2026": "#F97316", // brand orange — current year (focal)
};
const TREND_YEAR_FALLBACK = "#94A3B8"; // slate — any other year
const TREND_SELECTED = "#EA580C"; // deep brand orange — selected emphasis
const trendYearColor = (year: string) => TREND_YEAR_COLOR[year] ?? TREND_YEAR_FALLBACK;

const TREND_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Full-date x-axis tick: "2026-05-18" -> "18 May".
const formatWeekTick = (weekStart: string) => {
  const [, m, d] = String(weekStart).split("-");
  const month = TREND_MONTHS[Number(m) - 1];
  const day = Number(d);
  return month && day ? `${day} ${month}` : weekStart;
};

// Week-of-month x-axis label: "W1 May". Falls back to the date when a point isn't week-tagged.
const weekOfMonthLabel = (weekNumber: number | null, cycleMonth: string | null, weekStart: string) => {
  if (weekNumber == null || !cycleMonth) return formatWeekTick(weekStart);
  const month = TREND_MONTHS[Number(cycleMonth.split("-")[1]) - 1];
  return month ? `W${weekNumber} ${month}` : `W${weekNumber}`;
};

// Compact EGP axis formatter — 1_200_000 -> "1.2M", 48_000 -> "48K".
const compactEgp = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
};

// One row per week. Each year gets its own value channel (null elsewhere) so the
// year segments render in their own color and visually meet at the boundary.
type TrendDatum = {
  weekStart: string;
  /** "W1 May" week-of-month label for the axis + tooltip */
  label: string;
  year: string;
  total: number;
  selected: boolean;
  wow: number | null; // week-over-week ratio vs the previous in-scope week
  byDistributor: { distributorCode: string; distributorName: string; salesValue: number }[];
  v2025: number | null;
  v2026: number | null;
  vOther: number | null;
};

// Per-point dot — a small clean ring on every week, and a larger ringed marker on
// selected weeks. Keyed off the datum payload (NOT the x category), so it can never
// mis-resolve when the same calendar date recurs across years.
type TrendDotProps = {
  cx?: number;
  cy?: number;
  payload?: TrendDatum;
  color?: string;
};

function TrendDot({ cx, cy, payload, color = TREND_YEAR_FALLBACK }: TrendDotProps) {
  if (cx == null || cy == null) return null;
  if (payload?.selected) {
    return (
      <g>
        <circle cx={cx} cy={cy} fill="#FFFFFF" r={7} stroke={TREND_SELECTED} strokeOpacity={0.22} strokeWidth={6} />
        <circle cx={cx} cy={cy} fill={TREND_SELECTED} r={4} stroke="#FFFFFF" strokeWidth={2} />
      </g>
    );
  }
  return <circle cx={cx} cy={cy} fill="#FFFFFF" r={2.75} stroke={color} strokeWidth={2} />;
}

// Compact white floating tooltip — week + total + prominent WoW% + distributor share.
function TrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload?: TrendDatum }[];
}) {
  const datum = active ? payload?.find((entry) => entry.payload)?.payload : undefined;
  if (!datum) return null;

  const color = trendYearColor(datum.year);
  const breakdown = [...datum.byDistributor].filter((d) => d.salesValue > 0).sort((a, b) => b.salesValue - a.salesValue);
  const top = breakdown.slice(0, 4);
  const rest = breakdown.slice(4);
  const restValue = rest.reduce((sum, row) => sum + row.salesValue, 0);
  const up = (datum.wow ?? 0) >= 0;

  return (
    <div className="pointer-events-none min-w-[200px] max-w-[270px] rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2.5 shadow-[0_8px_24px_-8px_rgba(15,23,42,0.25)]">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[11px] font-bold tabular-nums text-[#64748B]">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
          {datum.label}
        </span>
        {datum.selected && (
          <span className="rounded-[4px] bg-[#FFF7ED] px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-[#EA580C]">
            Selected
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span className="text-lg font-black tabular-nums text-[#0F172A]">{money(datum.total)}</span>
        {datum.wow !== null && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-[4px] px-1.5 py-1 text-[13px] font-black tabular-nums",
              up ? "bg-[#ECFDF5] text-[#047857]" : "bg-[#FEF2F2] text-[#B91C1C]",
            )}
          >
            {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
            {`${up ? "+" : ""}${(datum.wow * 100).toFixed(1)}%`}
          </span>
        )}
      </div>
      {datum.wow !== null && <div className="mt-0.5 text-[10px] font-bold text-[#94A3B8]">vs previous week</div>}
      {top.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-[#F1F5F9] pt-2">
          {top.map((row) => {
            const share = datum.total > 0 ? row.salesValue / datum.total : 0;
            return (
              <div className="flex items-center justify-between gap-3" key={row.distributorCode}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color, opacity: 0.45 }} />
                  <span className="truncate text-[10px] font-bold text-[#64748B]">{row.distributorName || row.distributorCode}</span>
                </span>
                <span className="shrink-0 text-[10px] font-black tabular-nums text-[#334155]">
                  {(share * 100).toFixed(0)}% · {compactEgp(row.salesValue)}
                </span>
              </div>
            );
          })}
          {rest.length > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-bold text-[#94A3B8]">+{rest.length} more</span>
              <span className="shrink-0 text-[10px] font-black tabular-nums text-[#94A3B8]">{compactEgp(restValue)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrendStrip({ trend, selected }: { trend: WeeklyDashboard["trend"]; selected: string[] }) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const { chartData, years, multiYear, yearBoundaries } = useMemo(() => {
    const seen = new Set<string>();
    const boundaries: string[] = [];
    const rows: TrendDatum[] = trend.map((point, index) => {
      const year = point.weekStart.slice(0, 4);
      if (!seen.has(year)) {
        seen.add(year);
        boundaries.push(point.weekStart);
      }
      const prev = index > 0 ? trend[index - 1] : null;
      const wow = prev && prev.salesValue !== 0 ? (point.salesValue - prev.salesValue) / prev.salesValue : null;
      return {
        weekStart: point.weekStart,
        label: weekOfMonthLabel(point.weekNumber, point.cycleMonth, point.weekStart),
        year,
        total: point.salesValue,
        selected: selectedSet.has(point.weekStart),
        wow,
        byDistributor: point.byDistributor ?? [],
        v2025: year === "2025" ? point.salesValue : null,
        v2026: year === "2026" ? point.salesValue : null,
        vOther: year === "2025" || year === "2026" ? null : point.salesValue,
      };
    });

    // Stitch the boundary: write the LAST week of the ending year into the NEXT
    // year's channel too, so the two colored areas touch instead of leaving a gap.
    for (let i = 1; i < rows.length; i += 1) {
      const prevRow = rows[i - 1];
      const currRow = rows[i];
      if (prevRow.year === currRow.year) continue;
      if (currRow.v2026 !== null) prevRow.v2026 = prevRow.total;
      else if (currRow.v2025 !== null) prevRow.v2025 = prevRow.total;
      else prevRow.vOther = prevRow.total;
    }

    const ys = [...seen].sort();
    return {
      chartData: rows,
      years: ys,
      multiYear: ys.length > 1,
      yearBoundaries: boundaries.slice(1), // first year needs no divider
    };
  }, [trend, selectedSet]);

  const meta = useMemo(() => {
    const average = trend.length ? trend.reduce((sum, point) => sum + point.salesValue, 0) / trend.length : 0;
    const selectedPoints = trend.filter((point) => selectedSet.has(point.weekStart));
    const highlightTotal = selectedPoints.length
      ? selectedPoints.reduce((sum, point) => sum + point.salesValue, 0)
      : (trend[trend.length - 1]?.salesValue ?? 0);
    return { average, selectedCount: selectedPoints.length, highlightTotal };
  }, [trend, selectedSet]);

  // Render the card even when there is too little data — show a message rather than
  // vanishing silently, so the user knows the section exists and why it is empty.
  if (trend.length < 2) {
    return (
      <section className="w-full overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
        <div className="flex items-center gap-1.5 border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#F97316]" />
          <span className="text-xs font-black uppercase tracking-wide text-[#64748B]">Weekly sales-value trend</span>
          <span className="ml-2 text-[11px] font-semibold text-[#94A3B8]">
            {trend.length === 0 ? "No data for current filter" : "1 week — need at least 2 to draw a trend"}
          </span>
        </div>
        <div className="flex h-20 items-center justify-center text-[11px] font-medium text-[#CBD5E1]">
          {trend.length === 0
            ? "No weekly sales data matches the current filter selection."
            : "Upload a second week or clear filters to display the trend chart."}
        </div>
      </section>
    );
  }

  const hasOther = chartData.some((d) => d.vOther !== null);
  const labelByWeekStart = new Map(chartData.map((d) => [d.weekStart, d.label]));

  return (
    <section className="w-full overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wide text-[#64748B]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#F97316]" />
            Weekly sales-value trend
          </div>
          <div className="mt-1 flex items-center gap-2.5">
            <span className="text-[11px] font-bold text-[#94A3B8]">{trend.length} weeks</span>
            {multiYear && (
              <span className="flex items-center gap-2 border-l border-[#E2E8F0] pl-2.5">
                {years.map((year) => (
                  <span className="flex items-center gap-1" key={year}>
                    <span className="inline-block h-1.5 w-3 rounded-full" style={{ background: trendYearColor(year) }} />
                    <span className="text-[10px] font-bold tabular-nums text-[#94A3B8]">{year}</span>
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-right">
          <div>
            <div className="text-[10px] font-black uppercase tracking-wide text-[#64748B]">Average</div>
            <div className="text-sm font-black tabular-nums text-[#334155]">{money(meta.average)}</div>
          </div>
          <div className="border-l border-[#E2E8F0] pl-3">
            <div className="text-[10px] font-black uppercase tracking-wide text-[#EA580C]">
              {meta.selectedCount > 1 ? `${meta.selectedCount} selected weeks` : "Highlighted week"}
            </div>
            <div className="text-lg font-black tabular-nums text-[#0F172A]">{money(meta.highlightTotal)}</div>
          </div>
        </div>
      </div>

      <div className="h-[300px] min-w-0 px-1 pb-1 pt-3">
        <ResponsiveContainer height="100%" width="100%">
          <AreaChart data={chartData} margin={{ bottom: 4, left: -12, right: 10, top: 14 }}>
            <defs>
              <linearGradient id="trendFill2026" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#F97316" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#F97316" stopOpacity={0.01} />
              </linearGradient>
              <linearGradient id="trendFill2025" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#60A5FA" stopOpacity={0.16} />
                <stop offset="100%" stopColor="#60A5FA" stopOpacity={0.01} />
              </linearGradient>
              <linearGradient id="trendFillOther" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#94A3B8" stopOpacity={0.14} />
                <stop offset="100%" stopColor="#94A3B8" stopOpacity={0.01} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke="#E2E8F0" strokeDasharray="4 10" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="weekStart"
              interval="preserveStartEnd"
              minTickGap={24}
              tick={{ fill: "#64748B", fontSize: 10, fontWeight: 600 }}
              tickFormatter={(value) => labelByWeekStart.get(String(value)) ?? formatWeekTick(String(value))}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              axisLine={false}
              tick={{ fill: "#94A3B8", fontSize: 10, fontWeight: 600 }}
              tickFormatter={compactEgp}
              tickLine={false}
              width={48}
            />
            <Tooltip
              content={<TrendTooltip />}
              cursor={{ stroke: "#F97316", strokeDasharray: "4 4", strokeWidth: 1 }}
              isAnimationActive={false}
              wrapperStyle={{ outline: "none" }}
            />

            {/* Quiet average baseline */}
            <ReferenceLine ifOverflow="extendDomain" stroke="#CBD5E1" strokeDasharray="2 6" y={meta.average} />

            {/* Hairline year-boundary markers, labeled with the actual year. */}
            {multiYear &&
              yearBoundaries.map((boundary) => (
                <ReferenceLine
                  ifOverflow="extendDomain"
                  key={boundary}
                  label={{ fill: "#94A3B8", fontSize: 9, fontWeight: 700, position: "insideTopRight", value: boundary.slice(0, 4) }}
                  stroke="#CBD5E1"
                  strokeDasharray="2 4"
                  x={boundary}
                />
              ))}

            {/* Prior year (2025) — calm blue, recedes. */}
            <Area
              activeDot={{ fill: "#FFFFFF", r: 4, stroke: "#60A5FA", strokeWidth: 2.5 }}
              animationDuration={650}
              animationEasing="ease-out"
              connectNulls
              dataKey="v2025"
              dot={<TrendDot color="#60A5FA" />}
              fill="url(#trendFill2025)"
              isAnimationActive
              stroke="#60A5FA"
              strokeWidth={2}
              type="monotone"
            />
            {/* Current year (2026) — brand orange, the focal line. */}
            <Area
              activeDot={{ fill: "#FFFFFF", r: 5, stroke: "#F97316", strokeWidth: 3 }}
              animationBegin={140}
              animationDuration={700}
              animationEasing="ease-out"
              connectNulls
              dataKey="v2026"
              dot={<TrendDot color="#F97316" />}
              fill="url(#trendFill2026)"
              isAnimationActive
              stroke="#F97316"
              strokeWidth={2.5}
              type="monotone"
            />
            {/* Fallback for any year that is not 2025/2026 — never breaks. */}
            {hasOther && (
              <Area
                activeDot={{ fill: "#FFFFFF", r: 4, stroke: "#94A3B8", strokeWidth: 2.5 }}
                animationDuration={650}
                animationEasing="ease-out"
                connectNulls
                dataKey="vOther"
                dot={<TrendDot color="#94A3B8" />}
                fill="url(#trendFillOther)"
                isAnimationActive
                stroke="#94A3B8"
                strokeWidth={2}
                type="monotone"
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
