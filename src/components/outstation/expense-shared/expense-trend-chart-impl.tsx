"use client";

import { Area, AreaChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { compactEgp, egp, formatPeriodLabel } from "@/components/outstation/expense-shared/formatters";
import type { PayrollExpenseTrendPoint } from "@/lib/outstation/expense-metrics";

type TrendDatum = { period: string; amount: number; rows: number; label: string };

function TrendTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TrendDatum }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">{datum.label}</p>
      <p className="mt-1 text-sm font-black text-phx-accent-press">{egp(datum.amount)}</p>
      <p className="text-xs text-slate-500">
        {datum.rows.toLocaleString()} trip{datum.rows === 1 ? "" : "s"}
      </p>
    </div>
  );
}

export function ExpenseTrendChart({ trend }: { trend: PayrollExpenseTrendPoint[] }) {
  const data: TrendDatum[] = trend.map((point) => ({
    period: point.period,
    amount: point.amount,
    rows: point.rows,
    label: formatPeriodLabel(point.period),
  }));

  const average =
    data.length > 0 ? data.reduce((sum, point) => sum + point.amount, 0) / data.length : 0;

  return (
    <div className="overflow-hidden rounded-[18px] border border-phx-line bg-white shadow-[0_18px_46px_rgba(15,23,42,0.08)]">
      <div className="flex items-center gap-2.5 border-b border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 px-5 py-4">
        <span className="h-2 w-2 rounded-full bg-gradient-to-r from-orange-500 to-amber-400 shadow-[0_0_8px_rgba(249,115,22,0.5)]" />
        <div>
          <h2 className="text-base font-black tracking-tight text-slate-900">Monthly spend trend</h2>
          <p className="text-xs text-slate-500">Claimed outstation expense by payout period.</p>
        </div>
      </div>
      <div className="p-4">
        {data.length === 0 ? (
          <div className="flex h-[240px] items-center justify-center text-sm font-semibold text-slate-400">
            No trend data for these filters.
          </div>
        ) : (
          <SafeResponsiveContainer minHeight={260} style={{ height: 260 }}>
            <AreaChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="expenseTrendFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#F97316" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#F97316" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#EEF2F7" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="label"
                tick={{ fill: "#64748B", fontSize: 11 }}
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                tick={{ fill: "#64748B", fontSize: 11 }}
                tickFormatter={(value: number) => compactEgp(value)}
                tickLine={false}
                width={64}
              />
              <Tooltip content={<TrendTooltip />} cursor={{ stroke: "#F97316", strokeWidth: 1 }} />
              {average > 0 ? (
                <ReferenceLine
                  stroke="#94A3B8"
                  strokeDasharray="4 4"
                  y={average}
                  label={{ fill: "#94A3B8", fontSize: 10, position: "insideTopRight", value: "avg" }}
                />
              ) : null}
              <Area
                dataKey="amount"
                fill="url(#expenseTrendFill)"
                stroke="#EA580C"
                strokeWidth={2.5}
                type="monotone"
              />
            </AreaChart>
          </SafeResponsiveContainer>
        )}
      </div>
    </div>
  );
}
