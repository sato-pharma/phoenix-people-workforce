"use client";

import { Users } from "lucide-react";
import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ChartCard } from "@/components/cards/chart-card";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { SectionHeader } from "@/components/ui/section-header";
import { compactEGP, shareText } from "@/components/sales/intelligence/si-format";
import { formatCurrency } from "@/lib/sales/format";
import type { SiCustomerChurn, SiCustomerInsights } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

type ParetoPoint = {
  rank: number;
  name: string;
  distributorName: string;
  brick: string;
  value: number;
  cumulativePct: number;
};

type ParetoTooltipProps = {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ParetoPoint }>;
};

function ParetoTooltip({ active, payload }: ParetoTooltipProps) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="border border-slate-200 bg-white p-3 shadow-xl">
      <p className="text-xs font-black text-slate-900">{point.name}</p>
      <p className="text-[11px] font-bold text-slate-500">{point.brick} · {point.distributorName}</p>
      <p className="mt-1 text-[12px] font-black tabular-nums text-slate-900">{formatCurrency(point.value)}</p>
      <p className="text-[10px] font-bold text-[#F97316]">Top {point.rank} = {point.cumulativePct.toFixed(0)}% of customer value</p>
    </div>
  );
}

export function SiCustomerPareto({
  customers,
  churn,
  loading,
}: {
  customers: SiCustomerInsights | null;
  churn: SiCustomerChurn | null;
  loading: boolean;
}) {
  const { points, eightyAt } = useMemo(() => {
    if (!customers) return { points: [] as ParetoPoint[], eightyAt: null as number | null };
    const total = customers.customers.reduce((sum, customer) => sum + customer.value, 0);
    let cumulative = 0;
    let crossing: number | null = null;
    const ranked = customers.customers.slice(0, 20).map((customer, index) => {
      cumulative += customer.value;
      const cumulativePct = total > 0 ? (cumulative / total) * 100 : 0;
      if (crossing === null && cumulativePct >= 80) crossing = index + 1;
      return {
        rank: index + 1,
        name: customer.name,
        distributorName: customer.distributorName,
        brick: customer.brick,
        value: customer.value,
        cumulativePct,
      };
    });
    return { points: ranked, eightyAt: crossing };
  }, [customers]);

  return (
    <ChartCard className="h-full p-5">
      <SectionHeader
        action={customers ? (
          <div className="flex flex-wrap gap-2">
            <span className="border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-[#64748B]">
              {customers.customerCount.toLocaleString()} customers
            </span>
            <span className={cn(
              "border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide",
              customers.top10Share > 0.5 ? "border-rose-200 bg-rose-50 text-rose-700" : "border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]",
            )}>
              Top-10 = {shareText(customers.top10Share, 0)}
            </span>
          </div>
        ) : undefined}
        icon={Users}
        subtitle="Top customers by value with the cumulative-share curve. The red line marks 80% of sales."
        title="Customer Concentration"
      />

      <div className="mt-4" id="customers">
        {loading ? (
          <div className="flex h-[260px] items-end gap-1.5 px-2">
            {Array.from({ length: 20 }).map((_, index) => (
              <div className="flex-1 animate-pulse bg-slate-100" key={index} style={{ height: `${90 - index * 4}%` }} />
            ))}
          </div>
        ) : !customers || points.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-[#94A3B8]">No customers in scope for this month.</p>
        ) : (
          <>
            <SafeResponsiveContainer minHeight={260} style={{ height: 260 }}>
              <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                <CartesianGrid stroke="#EEF2F7" vertical={false} />
                <XAxis dataKey="rank" tick={{ fill: "#94A3B8", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "#E2E8F0" }} />
                <YAxis yAxisId="value" tickFormatter={compactEGP} tick={{ fill: "#94A3B8", fontSize: 10 }} tickLine={false} axisLine={false} width={44} />
                <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} tickFormatter={(value: number) => `${value}%`} tick={{ fill: "#94A3B8", fontSize: 10 }} tickLine={false} axisLine={false} width={36} />
                <Tooltip content={<ParetoTooltip />} cursor={{ fill: "rgba(249,115,22,0.07)" }} />
                <ReferenceLine
                  label={{
                    value: eightyAt ? `Top ${eightyAt} = 80% of sales` : "80%",
                    position: "insideTopRight",
                    fill: "#EF4444",
                    fontSize: 10,
                    fontWeight: 800,
                  }}
                  stroke="#EF4444"
                  strokeDasharray="6 4"
                  y={80}
                  yAxisId="pct"
                />
                <Bar yAxisId="value" dataKey="value" fill="#F97316" radius={[2, 2, 0, 0]} maxBarSize={26} />
                <Line yAxisId="pct" type="monotone" dataKey="cumulativePct" stroke="#0F172A" strokeWidth={2.5} dot={{ r: 2.5, fill: "#0F172A" }} />
              </ComposedChart>
            </SafeResponsiveContainer>

            {/* Churn strip — new vs lost customers (real movement, not decoration). */}
            {churn && churn.priorPeriod && (
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[#EEF2F7] pt-3">
                <div className="border border-emerald-200 bg-emerald-50 p-2.5 text-center">
                  <p className="text-lg font-black tabular-nums text-emerald-700">+{churn.newCount}</p>
                  <p className="text-[9px] font-black uppercase tracking-wide text-emerald-600">New customers</p>
                </div>
                <div className="border border-rose-200 bg-rose-50 p-2.5 text-center">
                  <p className="text-lg font-black tabular-nums text-rose-700">−{churn.lostCount}</p>
                  <p className="text-[9px] font-black uppercase tracking-wide text-rose-600">Lost vs {churn.priorPeriod}</p>
                </div>
                <div className="border border-[#E2E8F0] bg-[#F8FAFC] p-2.5 text-center">
                  <p className="text-lg font-black tabular-nums text-[#0F172A]">{churn.retentionRate !== null ? shareText(churn.retentionRate, 0) : "—"}</p>
                  <p className="text-[9px] font-black uppercase tracking-wide text-[#64748B]">Retention</p>
                </div>
              </div>
            )}

            {/* Top-15 table — rank cells bind table to curve via the orange ramp. */}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr>
                    <th className="px-2.5 py-2 text-xs font-black uppercase tracking-wide">#</th>
                    <th className="px-2.5 py-2 text-xs font-black uppercase tracking-wide">Customer</th>
                    <th className="px-2.5 py-2 text-xs font-black uppercase tracking-wide">Brick</th>
                    <th className="px-2.5 py-2 text-xs font-black uppercase tracking-wide">Distributor</th>
                    <th className="px-2.5 py-2 text-right text-xs font-black uppercase tracking-wide">Value</th>
                    <th className="px-2.5 py-2 text-right text-xs font-black uppercase tracking-wide">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.customers.slice(0, 15).map((customer, index) => (
                    <tr key={`${customer.name}:${customer.distributorName}:${index}`}>
                      <td
                        className="w-10 px-2.5 py-2 text-center text-xs font-black tabular-nums text-[#0F172A]"
                        style={index < 10 ? { backgroundColor: `rgba(249,115,22,${(0.32 - index * 0.03).toFixed(2)})` } : undefined}
                      >
                        {index + 1}
                      </td>
                      <td className="px-2.5 py-2 font-bold text-[#0F172A]">{customer.name}</td>
                      <td className="px-2.5 py-2 text-[#475569]">{customer.brick}</td>
                      <td className="px-2.5 py-2 text-[#64748B]">{customer.distributorName}</td>
                      <td className="px-2.5 py-2 text-right font-black tabular-nums text-[#0F172A]">{formatCurrency(customer.value)}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums text-[#64748B]">{shareText(customer.share)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </ChartCard>
  );
}
