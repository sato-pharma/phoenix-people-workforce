"use client";

import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus, Package, Store, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { WeeklyDashboard, WeeklyDelta, WeeklyRanked } from "@/lib/sales/weekly/types";

const money = (value: number) => `EGP ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const num = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });
const pct = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;

export function WeeklyDashboardView({ initial, initialError }: { initial: WeeklyDashboard | null; initialError: string | null }) {
  const [data, setData] = useState<WeeklyDashboard | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    week: initial?.appliedFilters.weekStart ?? "",
    distributor: "",
    region: "",
    product: "",
  });

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (filters.week) params.set("week", filters.week);
    if (filters.distributor) params.set("distributor", filters.distributor);
    if (filters.region) params.set("region", filters.region);
    if (filters.product) params.set("product", filters.product);
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
  }, [filters.week, filters.distributor, filters.region, filters.product]);

  const regionOptions = useMemo(() => data?.regions ?? [], [data]);
  const productOptions = useMemo(() => data?.products ?? [], [data]);

  if (!data) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <span>{error ?? "No weekly data available yet. Upload a weekly file to get started."}</span>
        </div>
      </div>
    );
  }

  const noData = data.availableWeeks.length === 0;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-black text-[#0F172A]">Weekly Sales Dashboard</h1>
          <p className="mt-1 text-sm font-medium text-[#64748B]">
            Consolidated by region across all distributors. Stock shown as units only.
          </p>
        </div>
        {data.weekStart && (
          <span className="border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm font-black text-[#0F172A]">
            Week of {data.weekStart}
            {data.priorWeekStart && <span className="ml-1 font-medium text-[#94A3B8]">vs {data.priorWeekStart}</span>}
          </span>
        )}
      </header>

      {/* Filters */}
      <div className="grid grid-cols-2 gap-3 border border-[#E2E8F0] bg-white p-3 sm:grid-cols-4">
        <Select label="Week" value={filters.week} onChange={(value) => setFilters((f) => ({ ...f, week: value }))}>
          {data.availableWeeks.map((week) => (
            <option key={week} value={week}>
              {week}
            </option>
          ))}
        </Select>
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
      </div>

      {error && (
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {noData ? (
        <div className="border border-dashed border-[#CBD5E1] bg-white p-8 text-center text-sm font-semibold text-[#64748B]">
          No validated weekly uploads yet. Upload a weekly file from <span className="font-black">Weekly Sales Upload</span>.
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${loading ? "opacity-60" : ""}`}>
            <Kpi icon={<TrendingUp className="h-4 w-4" />} label="Sales value" value={money(data.kpis.salesValue)} delta={data.compare.salesValue} format={money} />
            <Kpi icon={<Package className="h-4 w-4" />} label="Sales units" value={num(data.kpis.salesUnits)} delta={data.compare.salesUnits} format={num} />
            <Kpi icon={<Store className="h-4 w-4" />} label="Stock units" value={num(data.kpis.stockUnits)} delta={data.compare.stockUnits} format={num} />
            <Kpi icon={<Store className="h-4 w-4" />} label="Branches" value={num(data.kpis.branchCount)} sub={`${data.kpis.regionCount} regions · ${data.kpis.productCount} products`} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RankTable title="By region (all distributors)" rows={data.regions} />
            <RankTable title="By product" rows={data.products} />
          </div>

          {data.distributors.length > 1 && (
            <RankTable title="By distributor" rows={data.distributorBreakdown} />
          )}

          {/* Trend */}
          <TrendStrip trend={data.trend} selected={data.weekStart} />

          {/* Zero-sales branches */}
          {data.zeroSalesBranches.length > 0 && (
            <section className="border border-[#E2E8F0] bg-white">
              <div className="border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-black uppercase tracking-wide text-[#64748B]">
                Stock on hand, zero sales this week ({data.zeroSalesBranches.length})
              </div>
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] font-bold uppercase text-[#94A3B8]">
                    <tr>
                      <th className="px-3 py-1.5">Branch</th>
                      <th className="px-3 py-1.5">Region</th>
                      <th className="px-3 py-1.5 text-right">Stock units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.zeroSalesBranches.map((branch) => (
                      <tr className="border-t border-[#F1F5F9]" key={branch.branchCode}>
                        <td className="px-3 py-1.5 font-semibold text-[#0F172A]">{branch.branchName}</td>
                        <td className="px-3 py-1.5 text-[#334155]">{branch.regionName}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-[#334155]">{num(branch.stockUnits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
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
    <label className="block">
      <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">{label}</span>
      <select
        className="h-9 w-full border border-[#E2E8F0] bg-white px-2 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
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
    <div className="border border-[#E2E8F0] bg-white p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-[#94A3B8]">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-black tabular-nums text-[#0F172A]">{value}</div>
      {delta ? <DeltaLabel delta={delta} format={format} /> : sub ? <div className="mt-0.5 text-[11px] font-bold text-[#94A3B8]">{sub}</div> : null}
    </div>
  );
}

function DeltaLabel({ delta, format }: { delta: WeeklyDelta; format?: (value: number) => string }) {
  if (delta.prior == null) {
    return <div className="mt-0.5 flex items-center gap-1 text-[11px] font-bold text-[#94A3B8]"><Minus className="h-3 w-3" /> no prior week</div>;
  }
  const up = (delta.pct ?? 0) >= 0;
  const tone = delta.pct == null ? "text-[#94A3B8]" : up ? "text-emerald-600" : "text-rose-600";
  return (
    <div className={`mt-0.5 flex items-center gap-1 text-[11px] font-bold ${tone}`}>
      {delta.pct == null ? <Minus className="h-3 w-3" /> : up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {delta.pct == null ? "—" : pct(delta.pct)}
      <span className="font-medium text-[#94A3B8]">vs {format ? format(delta.prior) : delta.prior}</span>
    </div>
  );
}

function RankTable({ title, rows }: { title: string; rows: WeeklyRanked[] }) {
  const max = Math.max(1, ...rows.map((row) => row.salesValue));
  return (
    <section className="border border-[#E2E8F0] bg-white">
      <div className="border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-black uppercase tracking-wide text-[#64748B]">{title}</div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] font-bold uppercase text-[#94A3B8]">
            <tr>
              <th className="px-3 py-1.5">Name</th>
              <th className="px-3 py-1.5 text-right">Sales value</th>
              <th className="px-3 py-1.5 text-right">Units</th>
              <th className="px-3 py-1.5 text-right">Stock</th>
              <th className="px-3 py-1.5 text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-3 text-center text-[#94A3B8]" colSpan={5}>
                  No rows.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr className="border-t border-[#F1F5F9]" key={row.code}>
                <td className="px-3 py-1.5">
                  <div className="font-semibold text-[#0F172A]">{row.name}</div>
                  <div className="mt-0.5 h-1 w-full bg-[#F1F5F9]">
                    <div className="h-1 bg-[#F97316]" style={{ width: `${Math.max(2, (row.salesValue / max) * 100)}%` }} />
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums font-bold text-[#0F172A]">{money(row.salesValue)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#334155]">{num(row.salesUnits)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#334155]">{num(row.stockUnits)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#64748B]">{(row.share * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrendStrip({ trend, selected }: { trend: WeeklyDashboard["trend"]; selected: string | null }) {
  if (trend.length < 2) return null;
  const max = Math.max(1, ...trend.map((point) => point.salesValue));
  return (
    <section className="border border-[#E2E8F0] bg-white p-3">
      <div className="mb-2 text-xs font-black uppercase tracking-wide text-[#64748B]">Weekly sales-value trend</div>
      <div className="flex items-end gap-1.5 overflow-x-auto">
        {trend.map((point) => (
          <div className="flex min-w-[44px] flex-1 flex-col items-center gap-1" key={point.weekStart} title={`${point.weekStart}: ${money(point.salesValue)}`}>
            <div
              className={`w-full ${point.weekStart === selected ? "bg-[#F97316]" : "bg-[#CBD5E1]"}`}
              style={{ height: `${Math.max(4, (point.salesValue / max) * 120)}px` }}
            />
            <span className="text-[9px] font-bold text-[#94A3B8]">{point.weekStart.slice(5)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
