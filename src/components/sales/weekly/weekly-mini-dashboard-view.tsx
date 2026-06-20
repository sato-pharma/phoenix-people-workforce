"use client";

import { ArrowDownRight, ArrowUpRight, Loader2, Minus, Package, Store, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import type { WeeklyDashboard, WeeklyDelta } from "@/lib/sales/weekly/types";

const money = (value: number) => `EGP ${Math.round(value).toLocaleString()}`;
const num = (value: number) => Math.round(value).toLocaleString();

function shortWeek(week: string | null) {
  if (!week) return "—";
  const date = new Date(`${week}T00:00:00`);
  if (Number.isNaN(date.getTime())) return week;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function DeltaBadge({ delta }: { delta: WeeklyDelta }) {
  if (delta.pct === null || delta.prior === null) {
    return <span className="text-[11px] font-semibold text-slate-400">no prior week</span>;
  }
  const up = delta.pct >= 0;
  const Icon = delta.pct === 0 ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const tone = delta.pct === 0 ? "text-slate-500" : up ? "text-emerald-600" : "text-rose-600";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-bold ${tone}`}>
      <Icon className="h-3.5 w-3.5" />
      {`${up ? "+" : ""}${(delta.pct * 100).toFixed(1)}% WoW`}
    </span>
  );
}

function KpiCard({
  delta,
  icon,
  label,
  value,
}: {
  delta?: WeeklyDelta;
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
      <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-50 text-orange-600">{icon}</span>
        {label}
      </div>
      <p className="mt-3 text-2xl font-black text-slate-900">{value}</p>
      {delta ? <div className="mt-1">{<DeltaBadge delta={delta} />}</div> : null}
    </div>
  );
}

export function WeeklyMiniDashboardView({
  initial,
  initialError,
}: {
  initial: WeeklyDashboard | null;
  initialError: string | null;
}) {
  const [data, setData] = useState<WeeklyDashboard | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [week, setWeek] = useState<string>(initial?.weekStart ?? "");

  useEffect(() => {
    if (!week) return;
    let cancelled = false;
    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      try {
        const response = await fetch(`/api/sales/weekly/dashboard?week=${encodeURIComponent(week)}`, { cache: "no-store" });
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
  }, [week]);

  const trend = useMemo(
    () => (data?.trend ?? []).map((point) => ({ ...point, label: shortWeek(point.weekStart) })),
    [data?.trend],
  );

  if (error && !data) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
        {error}
      </div>
    );
  }

  if (!data || (!data.weekStart && data.availableWeeks.length === 0)) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 shadow-sm">
        No weekly sales have been uploaded for your products yet.
      </div>
    );
  }

  const products = [...data.products].sort((a, b) => b.salesValue - a.salesValue);
  const branches = [...data.branchBreakdown].sort((a, b) => b.salesValue - a.salesValue).slice(0, 12);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-600">
          Week
          <select
            className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
            onChange={(event) => setWeek(event.target.value)}
            value={week}
          >
            {data.availableWeeks.map((option) => (
              <option key={option} value={option}>
                {shortWeek(option)}
              </option>
            ))}
          </select>
        </label>
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-orange-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating…
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard delta={data.compare.salesValue} icon={<TrendingUp className="h-4 w-4" />} label="Sales Value" value={money(data.kpis.salesValue)} />
        <KpiCard delta={data.compare.salesUnits} icon={<Package className="h-4 w-4" />} label="Sales Units" value={num(data.kpis.salesUnits)} />
        <KpiCard delta={data.compare.stockUnits} icon={<Store className="h-4 w-4" />} label="Stock Units" value={num(data.kpis.stockUnits)} />
      </div>

      {trend.length > 1 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <p className="mb-3 text-sm font-black text-slate-800">Weekly sales value trend</p>
          <SafeResponsiveContainer minHeight={240}>
            <AreaChart data={trend} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="weeklyMiniFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#F97316" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#F97316" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#eef2f7" vertical={false} />
              <XAxis dataKey="label" fontSize={11} stroke="#94a3b8" tickLine={false} />
              <YAxis fontSize={11} stroke="#94a3b8" tickFormatter={(value) => num(Number(value))} tickLine={false} width={64} />
              <Tooltip formatter={(value) => money(Number(value))} />
              <Area dataKey="salesValue" fill="url(#weeklyMiniFill)" stroke="#F97316" strokeWidth={2} type="monotone" />
            </AreaChart>
          </SafeResponsiveContainer>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
        <p className="border-b border-slate-100 px-4 py-3 text-sm font-black text-slate-800">My products</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#0f172a] text-left text-[11px] font-bold uppercase tracking-[0.1em] text-white">
                <th className="px-4 py-2.5">Product</th>
                <th className="px-4 py-2.5 text-right">Sales value</th>
                <th className="px-4 py-2.5 text-right">Units</th>
                <th className="px-4 py-2.5 text-right">Stock</th>
                <th className="px-4 py-2.5 text-right">Share</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td className="px-4 py-4 text-slate-500" colSpan={5}>No product sales for this week.</td>
                </tr>
              ) : (
                products.map((product) => (
                  <tr className="border-b border-orange-50 last:border-0" key={product.code}>
                    <td className="px-4 py-2.5 font-semibold text-slate-800">{product.name}</td>
                    <td className="px-4 py-2.5 text-right font-bold text-slate-900">{money(product.salesValue)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-700">{num(product.salesUnits)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-700">{num(product.stockUnits)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-500">{`${(product.share * 100).toFixed(1)}%`}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
        <p className="border-b border-slate-100 px-4 py-3 text-sm font-black text-slate-800">Top branches</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#0f172a] text-left text-[11px] font-bold uppercase tracking-[0.1em] text-white">
                <th className="px-4 py-2.5">Branch</th>
                <th className="px-4 py-2.5">Region</th>
                <th className="px-4 py-2.5 text-right">Sales value</th>
                <th className="px-4 py-2.5 text-right">Units</th>
              </tr>
            </thead>
            <tbody>
              {branches.length === 0 ? (
                <tr>
                  <td className="px-4 py-4 text-slate-500" colSpan={4}>No branch sales for this week.</td>
                </tr>
              ) : (
                branches.map((branch) => (
                  <tr className="border-b border-orange-50 last:border-0" key={`${branch.code}-${branch.regionName}`}>
                    <td className="px-4 py-2.5 font-semibold text-slate-800">{branch.name}</td>
                    <td className="px-4 py-2.5 text-slate-600">{branch.regionName}</td>
                    <td className="px-4 py-2.5 text-right font-bold text-slate-900">{money(branch.salesValue)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-700">{num(branch.salesUnits)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
