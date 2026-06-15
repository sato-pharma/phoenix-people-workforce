"use client";

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  Filter,
  Minus,
  Package,
  Store,
  TrendingUp,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import type {
  WeeklyBranchComparisonRow,
  WeeklyBranchRow,
  WeeklyDashboard,
  WeeklyDelta,
  WeeklyRanked,
} from "@/lib/sales/weekly/types";

const money = (value: number) => `EGP ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const num = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });
const pct = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;

export function WeeklyDashboardView({ initial, initialError }: { initial: WeeklyDashboard | null; initialError: string | null }) {
  const [data, setData] = useState<WeeklyDashboard | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    weeks: initial?.appliedFilters.weekStarts?.length ? [...initial.appliedFilters.weekStarts] : initial?.appliedFilters.weekStart ? [initial.appliedFilters.weekStart] : [],
    allWeeks: initial?.appliedFilters.allWeeks ?? false,
    distributor: "",
    region: "",
    product: "",
    line: "",
  });
  const selectedWeeksKey = useMemo(() => filters.weeks.join("|"), [filters.weeks]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (filters.allWeeks) {
      params.set("allWeeks", "1");
    } else {
      for (const week of selectedWeeksKey ? selectedWeeksKey.split("|") : []) params.append("week", week);
    }
    if (filters.distributor) params.set("distributor", filters.distributor);
    if (filters.region) params.set("region", filters.region);
    if (filters.product) params.set("product", filters.product);
    if (filters.line) params.set("line", filters.line);
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
  }, [selectedWeeksKey, filters.allWeeks, filters.distributor, filters.region, filters.product, filters.line]);

  const regionOptions = useMemo(() => data?.regions ?? [], [data]);
  const productOptions = useMemo(() => data?.products ?? [], [data]);
  const lineOptions = useMemo(() => data?.availableLines ?? [], [data]);
  const selectedWeekSummary = useMemo(() => {
    if (data?.appliedFilters.allWeeks) {
      return "All time";
    }
    if ((data?.appliedFilters.weekStarts?.length ?? 0) > 1) {
      return `${data?.appliedFilters.weekStarts?.length ?? 0} selected weeks`;
    }
    return data?.appliedFilters.weekStart ? `Week of ${data.appliedFilters.weekStart}` : data?.weekStart;
  }, [data]);

  const filterWeekLabel = useMemo(() => {
    if (filters.allWeeks) return "All time";
    if (filters.weeks.length > 1) return `${filters.weeks.length} selected weeks`;
    return filters.weeks[0] ? `Week of ${filters.weeks[0]}` : "Pick week";
  }, [filters.allWeeks, filters.weeks]);

  const selectedWeekTitle = useMemo(() => {
    if (!data) return "";
    if (data.appliedFilters.allWeeks) return data.availableWeeks.join(", ") || "All time";
    if (!data.appliedFilters.weekStarts.length) return "";
    return data.appliedFilters.weekStarts.join(", ");
  }, [data]);

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
          {data.weekStart && (
            <span className="rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm font-black text-[#0F172A]" title={selectedWeekTitle}>
              {selectedWeekSummary}
              {data.priorWeekStart && <span className="ml-1 font-medium text-[#94A3B8]">vs {data.priorWeekStart}</span>}
            </span>
          )}
        </div>
      </header>

      <div className="rounded-[6px] border border-[#E2E8F0] bg-white p-2 shadow-sm">
        <div className="mb-2 flex items-center justify-between px-1 text-[11px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">
          <span className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5" />
            Filters
          </span>
          <span className={cn("text-[#64748B]", loading && "text-[#F97316]")}>{loading ? "Updating" : "Ready"}</span>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-[minmax(220px,0.9fr)_repeat(4,minmax(0,1fr))]">
          <WeekDropdown
            allWeeks={filters.allWeeks}
            availableWeeks={data.availableWeeks}
            selectedTitle={selectedWeekTitle}
            selectedWeeks={filters.weeks}
            summary={filterWeekLabel}
            onAllWeeksChange={(checked) => {
              setFilters((prev) => {
                const fallbackWeeks = prev.weeks.length > 0 ? prev.weeks : data.availableWeeks.slice(0, 1);
                return {
                  ...prev,
                  allWeeks: checked,
                  weeks: checked ? [] : fallbackWeeks,
                };
              });
            }}
            onWeekChange={(week, checked) => {
              setFilters((prev) => {
                if (prev.allWeeks) return prev;
                const next = new Set(prev.weeks);
                if (checked) {
                  next.add(week);
                } else {
                  next.delete(week);
                  if (next.size === 0 && data.availableWeeks.length > 0) {
                    return { ...prev, weeks: [data.availableWeeks[0]] };
                  }
                }
                return { ...prev, weeks: [...next].sort((left, right) => right.localeCompare(left)) };
              });
            }}
          />
          <Select label="Distributor" value={filters.distributor} onChange={(value) => setFilters((f) => ({ ...f, distributor: value }))}>
            <option value="">All distributors</option>
            {data.distributors.map((distributor) => (
              <option key={distributor.code} value={distributor.code}>
                {distributor.name}
              </option>
            ))}
          </Select>
          <Select label="Region" value={filters.region} onChange={(value) => setFilters((f) => ({ ...f, region: value }))}>
            <option value="">All regions</option>
            {regionOptions.map((region) => (
              <option key={region.code} value={region.code}>
                {region.name}
              </option>
            ))}
          </Select>
          <Select label="Product" value={filters.product} onChange={(value) => setFilters((f) => ({ ...f, product: value }))}>
            <option value="">All products</option>
            {productOptions.map((product) => (
              <option key={product.code} value={product.code}>
                {product.name}
              </option>
            ))}
          </Select>
          <Select label="Line" value={filters.line} onChange={(value) => setFilters((f) => ({ ...f, line: value }))}>
            <option value="">All lines</option>
            {lineOptions.map((line) => (
              <option key={line} value={line}>
                {line}
              </option>
            ))}
          </Select>
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
        <>
          <div className={cn("grid grid-cols-2 gap-3 transition-opacity lg:grid-cols-4", loading && "opacity-60")}>
            <Kpi icon={<TrendingUp className="h-4 w-4" />} label="Sales value" value={money(data.kpis.salesValue)} delta={data.compare.salesValue} format={money} />
            <Kpi icon={<Package className="h-4 w-4" />} label="Sales units" value={num(data.kpis.salesUnits)} delta={data.compare.salesUnits} format={num} />
            <Kpi icon={<Store className="h-4 w-4" />} label="Stock units" value={num(data.kpis.stockUnits)} delta={data.compare.stockUnits} format={num} />
            <Kpi icon={<Store className="h-4 w-4" />} label="Branches" value={num(data.kpis.branchCount)} sub={`${data.kpis.regionCount} regions - ${data.kpis.productCount} products`} />
          </div>

          <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
            <RankTable title="By region (all distributors)" rows={data.regions} />
            <RankTable title="By product" rows={data.products} />
          </div>

          <BranchComparisonTable rows={branchRows} />

          {data.distributors.length > 1 && <RankTable maxHeight="max-h-64" title="By distributor" rows={data.distributorBreakdown} />}

          <TrendStrip trend={data.trend} selected={data.appliedFilters.weekStarts} />

          <ZeroStockTable rows={zeroStockRows} totalStock={zeroStockTotal} />
        </>
      )}
    </div>
  );
}

function WeekDropdown({
  allWeeks,
  availableWeeks,
  selectedTitle,
  selectedWeeks,
  summary,
  onAllWeeksChange,
  onWeekChange,
}: {
  allWeeks: boolean;
  availableWeeks: string[];
  selectedTitle: string;
  selectedWeeks: string[];
  summary: string;
  onAllWeeksChange: (checked: boolean) => void;
  onWeekChange: (week: string, checked: boolean) => void;
}) {
  return (
    <details className="group relative">
      <summary className="flex h-[58px] cursor-pointer list-none items-center justify-between gap-3 rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 shadow-sm outline-none transition hover:border-[#FDBA74] focus-visible:border-[#FDBA74] [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">
            <CalendarDays className="h-3.5 w-3.5" />
            Weeks
          </span>
          <span className="block truncate text-sm font-black text-[#0F172A]" title={selectedTitle}>
            {summary}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[#94A3B8] transition group-open:rotate-180" />
      </summary>
      <div className="absolute left-0 top-full z-30 mt-2 w-[min(320px,calc(100vw-2rem))] rounded-[6px] border border-[#E2E8F0] bg-white shadow-lg">
        <div className="border-b border-[#E2E8F0] p-2">
          <label className="flex items-center justify-between rounded-[4px] px-2 py-2 text-sm font-black text-[#0F172A] hover:bg-[#F8FAFC]">
            All time
            <input className="h-4 w-4 accent-[#F97316]" checked={allWeeks} type="checkbox" onChange={(event) => onAllWeeksChange(event.target.checked)} />
          </label>
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto p-2">
          {availableWeeks.map((week) => (
            <label className={cn("flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm text-[#0F172A] hover:bg-[#F8FAFC]", allWeeks && "opacity-50")} key={week}>
              <input
                checked={!allWeeks && selectedWeeks.includes(week)}
                className="h-4 w-4 accent-[#F97316]"
                disabled={allWeeks}
                type="checkbox"
                onChange={(event) => onWeekChange(week, event.target.checked)}
              />
              <span>Week of {week}</span>
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="block h-[58px] rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-1.5 shadow-sm transition focus-within:border-[#FDBA74] hover:border-[#FDBA74]">
      <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">{label}</span>
      <select
        className="mt-1 h-8 w-full bg-transparent text-sm font-black text-[#0F172A] outline-none"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
    </label>
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
  const max = Math.max(1, ...rows.map((row) => row.salesValue));
  return (
    <section className={cn("overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm", className)}>
      <PanelTitle count={rows.length} title={title} />
      <div className={cn("overflow-auto", maxHeight)}>
        <table className="w-full min-w-[620px] text-sm">
          <thead className="sticky top-0 z-10 bg-[#020617] text-left text-[10px] font-black uppercase text-white">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 text-right">Sales value</th>
              <th className="px-3 py-2 text-right">Units</th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2 text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-5 text-center text-[#94A3B8]" colSpan={5}>
                  No rows.
                </td>
              </tr>
            )}
            {rows.map((row) => (
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
  const max = Math.max(1, ...rows.map((row) => row.salesValue));
  return (
    <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
      <PanelTitle count={rows.length} title="Branches comparison" />
      <div className="max-h-96 overflow-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="sticky top-0 z-10 bg-[#020617] text-left text-[10px] font-black uppercase text-white">
            <tr>
              <th className="px-3 py-2">Branch</th>
              <th className="px-3 py-2">Region</th>
              <th className="px-3 py-2 text-right">Sales value</th>
              <th className="px-3 py-2 text-right">Units</th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2 text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-5 text-center text-[#94A3B8]" colSpan={6}>
                  No branch rows.
                </td>
              </tr>
            )}
            {rows.map((row) => (
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
  const max = Math.max(1, ...rows.map((row) => row.stockUnits));
  return (
    <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
        <div>
          <div className="text-xs font-black uppercase tracking-wide text-[#64748B]">Stock on hand watchlist</div>
          <div className="text-[11px] font-bold text-[#94A3B8]">Zero sales branches</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-black tabular-nums text-[#0F172A]">{num(totalStock)}</div>
          <div className="text-[10px] font-black uppercase tracking-wide text-[#94A3B8]">{rows.length} rows</div>
        </div>
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 z-10 bg-[#020617] text-left text-[10px] font-black uppercase text-white">
            <tr>
              <th className="w-[52%] px-3 py-2">Branch</th>
              <th className="w-[24%] px-3 py-2">Region</th>
              <th className="w-[24%] px-3 py-2 text-right">Stock units</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-5 text-center text-[#94A3B8]" colSpan={3}>
                  No stock-on-hand branches with zero sales in this view.
                </td>
              </tr>
            )}
            {rows.map((branch) => (
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

function PanelTitle({ count, title }: { count: number; title: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
      <span className="text-xs font-black uppercase tracking-wide text-[#64748B]">{title}</span>
      <span className="rounded-[4px] border border-[#E2E8F0] bg-white px-2 py-1 text-[10px] font-black uppercase tracking-wide text-[#94A3B8]">
        {count} rows
      </span>
    </div>
  );
}

// Year bar colors — subtle, non-selected only; selected always stays orange
const TREND_YEAR_BAR: Record<string, { bg: string; border: string }> = {
  "2025": { bg: "#93C5FD", border: "#BFDBFE" }, // blue-300 / blue-200 — "past"
  "2026": { bg: "#CBD5E1", border: "#E2E8F0" }, // slate-300 / slate-200 — "current" (original look)
};
const TREND_YEAR_CHIP: Record<string, string> = { "2025": "#93C5FD", "2026": "#CBD5E1" };

function TrendStrip({ trend, selected }: { trend: WeeklyDashboard["trend"]; selected: string[] }) {
  if (trend.length < 2) return null;
  const max = Math.max(1, ...trend.map((point) => point.salesValue));
  const average = trend.reduce((total, point) => total + point.salesValue, 0) / trend.length;
  const selectedSet = new Set(selected);
  const highlighted = trend.find((point) => selectedSet.has(point.weekStart)) ?? trend[trend.length - 1];
  const years = [...new Set(trend.map((p) => p.weekStart.slice(0, 4)))].sort();
  const multiYear = years.length > 1;
  return (
    <section className="w-full overflow-hidden border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
        <div>
          <div className="text-xs font-black uppercase tracking-wide text-[#64748B]">Weekly sales-value trend</div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="text-[11px] font-bold text-[#94A3B8]">{trend.length} weeks</span>
            {multiYear && (
              <span className="flex items-center gap-1.5">
                {years.map((y) => (
                  <span key={y} className="flex items-center gap-1">
                    <span className="inline-block h-2 w-3 rounded-sm" style={{ background: TREND_YEAR_CHIP[y] ?? "#CBD5E1" }} />
                    <span className="text-[10px] font-bold text-[#94A3B8]">{y}</span>
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-right">
          <div>
            <div className="text-[10px] font-black uppercase tracking-wide text-[#64748B]">Average</div>
            <div className="text-sm font-black tabular-nums text-[#334155]">{money(average)}</div>
          </div>
          <div className="border-l border-[#E2E8F0] pl-3">
            <div className="text-[10px] font-black uppercase tracking-wide text-[#EA580C]">Highlighted week</div>
            <div className="text-lg font-black tabular-nums text-[#0F172A]">{money(highlighted.salesValue)}</div>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto px-4 pb-4 pt-3">
        <div className="flex h-48 min-w-[860px] items-end gap-1.5 border-t border-[#F1F5F9] bg-[#F8FAFC] px-2 pt-4">
          {trend.map((point) => {
            const isSelected = selectedSet.has(point.weekStart);
            const height = Math.max(6, (point.salesValue / max) * 154);
            const year = point.weekStart.slice(0, 4);
            const yearStyle = TREND_YEAR_BAR[year] ?? { bg: "#CBD5E1", border: "#E2E8F0" };
            return (
              <div
                className={cn(
                  "flex min-w-[44px] flex-1 flex-col items-center gap-1 px-1 pt-2",
                  isSelected && "bg-[linear-gradient(180deg,rgba(249,115,22,0.10)_0%,rgba(249,115,22,0)_100%)]",
                )}
                key={point.weekStart}
                title={`${point.weekStart}: ${money(point.salesValue)}`}
              >
                <div
                  className="w-full border-t"
                  style={{
                    height: `${height}px`,
                    background: isSelected ? "#F97316" : yearStyle.bg,
                    borderColor: isSelected ? "#EA580C" : yearStyle.border,
                  }}
                />
                <span className={cn("text-[9px] font-black", isSelected ? "text-[#EA580C]" : "text-[#94A3B8]")}>
                  {point.weekStart.slice(5)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
