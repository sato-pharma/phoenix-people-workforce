"use client";

import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { SiTrendPoint } from "@/lib/sales/intelligence/types";

const compactEGP = (value: number) => {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
  if (Math.abs(safe) >= 1_000) return `${(safe / 1_000).toFixed(0)}K`;
  return String(Math.round(safe));
};

type TooltipPayload = {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: SiTrendPoint }>;
};

// Monthly sales value (bars) + units (line). Incomplete months — where not every expected
// distributor has uploaded — are drawn in amber so a half-loaded month never reads as a real dip.
export function SiTrendChart({ points }: { points: SiTrendPoint[] }) {
  if (points.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-[#94A3B8]">No validated months yet.</p>;
  }
  return (
    <div className="h-72 w-full px-2 pb-2 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#EEF2F7" vertical={false} />
          <XAxis dataKey="period" tick={{ fill: "#64748B", fontSize: 11, fontWeight: 700 }} tickLine={false} axisLine={{ stroke: "#E2E8F0" }} />
          <YAxis yAxisId="value" tickFormatter={compactEGP} tick={{ fill: "#94A3B8", fontSize: 10 }} tickLine={false} axisLine={false} width={44} />
          <YAxis yAxisId="units" orientation="right" tickFormatter={compactEGP} tick={{ fill: "#94A3B8", fontSize: 10 }} tickLine={false} axisLine={false} width={40} />
          <Tooltip
            cursor={{ fill: "rgba(30,58,95,0.06)" }}
            content={({ active, payload }: TooltipPayload) => {
              const point = active ? payload?.[0]?.payload : undefined;
              if (!point) return null;
              return (
                <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                  <p className="mb-1 text-[10px] font-black uppercase tracking-wider text-slate-400">{point.period}</p>
                  <p className="text-[12px] font-black text-slate-900">EGP {Math.round(point.value).toLocaleString()}</p>
                  <p className="text-[11px] font-bold text-slate-500">{Math.round(point.units).toLocaleString()} units</p>
                  {!point.monthComplete && (
                    <p className="mt-1 text-[10px] font-black text-amber-600">
                      Incomplete · {point.uploaded}/{point.expected} distributors
                    </p>
                  )}
                </div>
              );
            }}
          />
          <Bar yAxisId="value" dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={54}>
            {points.map((point) => (
              <Cell key={point.period} fill={point.monthComplete ? "#1E3A5F" : "#FBBF24"} />
            ))}
          </Bar>
          <Line yAxisId="units" type="monotone" dataKey="units" stroke="#0F172A" strokeWidth={2} dot={{ r: 3, fill: "#0F172A" }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
