"use client";

import { TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { ChartCard } from "@/components/cards/chart-card";
import { SectionHeader } from "@/components/ui/section-header";
import { PremiumTooltip } from "@/components/ui/premium-tooltip";
import { ChartProps, TrendDataPoint } from "./chart-types";
import { cn } from "@/lib/utils";

type TrendChartProps = ChartProps & {
  data: {
    sales: { trend: TrendDataPoint[] };
    expenses: { trend: TrendDataPoint[] };
  };
};

function compactMonth(period: string) {
  if (!period || period === "No Date") return period || "-";
  const [year, month] = period.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(month) - 1] ?? month} ${year}`;
}

function compactEGP(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(1)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { currency: "EGP", maximumFractionDigits: 0, style: "currency" }).format(safe);
}

function formatPercent(value: number) {
  return `${((Number.isFinite(value) ? value : 0) * 100).toFixed(1)}%`;
}

export function TrendChart({ data, hoveredElement, onHover, loading = false }: TrendChartProps) {
  const salesRows = useMemo(() => data.sales.trend.map((row) => {
    const source = row as TrendDataPoint & { period?: string; targetValue?: number };
    return {
      label: compactMonth(String(source.period ?? source.label ?? "")),
      sales: Number(source.sales ?? 0),
      target: Number(source.target ?? source.targetValue ?? 0),
    };
  }), [data.sales.trend]);

  const expenseRows = useMemo(() => data.expenses.trend.map((row) => {
    const source = row as TrendDataPoint & { amount?: number; month?: string; period?: string };
    const value = Number(source.amount ?? source.sales ?? 0);
    return {
      label: compactMonth(String(source.month ?? source.period ?? source.label ?? "")),
      sales: value,
      target: value,
    };
  }), [data.expenses.trend]);

  const rows = useMemo(() => (salesRows.length ? salesRows : expenseRows).slice(-6), [salesRows, expenseRows]);
  const max = useMemo(() => Math.max(...rows.flatMap((row) => [row.sales, row.target]), 1), [rows]);

  if (loading) {
    return (
      <ChartCard>
        <div className="h-64 animate-pulse bg-[#F8FAFC] rounded-lg" />
      </ChartCard>
    );
  }

  return (
    <ChartCard>
      <SectionHeader
        action={<span className="rounded-lg border border-[#E2E8F0] px-3 py-1.5 text-xs font-black text-[#64748B]">Monthly</span>}
        icon={TrendingUp}
        subtitle="Sales against target by uploaded month; expenses appear when sales trend is unavailable."
        title="Performance Trend"
      />
      <div className="mt-6 grid h-48 grid-cols-[30px_minmax(0,1fr)] gap-2 sm:h-64 sm:grid-cols-[42px_minmax(0,1fr)] sm:gap-3 md:h-72">
        <div className="flex flex-col justify-between pb-7 text-right text-[9px] font-bold text-[#64748B] sm:text-[10px]">
          <span>{compactEGP(max).replace("EGP ", "")}</span>
          <span>{compactEGP(max / 2).replace("EGP ", "")}</span>
          <span>0</span>
        </div>
        <div className="relative flex items-end gap-2 border-b border-l border-[#E2E8F0] px-2 pb-7 sm:gap-4 sm:px-3">
          <div className="absolute inset-x-3 top-1/2 border-t border-dashed border-[#E2E8F0]" />
          {rows.map((row, index) => {
            const prevRow = rows[index - 1];
            const prevSales = prevRow?.sales || 0;
            const changePercent = prevSales > 0 ? ((row.sales - prevSales) / prevSales) * 100 : 0;
            const changeMessage = changePercent > 0 ? `+${changePercent.toFixed(1)}% vs last month` : changePercent < 0 ? `${changePercent.toFixed(1)}% vs last month` : "No change vs last month";
            const isHovered = hoveredElement === `trend-${row.label}`;
            
            return (
              <PremiumTooltip
                content={
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-[#0F172A]">{row.label}</p>
                    <p className="text-[11px] text-[#64748B]">Sales: {compactEGP(row.sales)}</p>
                    <p className="text-[11px] text-[#64748B]">Target: {compactEGP(row.target)}</p>
                    <p className="text-[11px] font-bold text-[#F97316]">{row.target > 0 ? formatPercent((row.sales - row.target) / row.target) : "N/A"} vs target</p>
                    <p className="text-[10px] text-[#64748B]">{changeMessage}</p>
                  </div>
                }
                key={row.label}
              >
                <div 
                  className={cn("relative z-10 flex min-w-0 flex-1 flex-col items-center gap-2 transition", isHovered && "scale-105")}
                  onClick={() => onHover(`trend-${row.label}`)}
                  onMouseEnter={() => onHover(`trend-${row.label}`)}
                  onMouseLeave={() => onHover(null)}
                >
                  <div className="flex h-32 w-full items-end justify-center gap-1 sm:h-48 sm:gap-1.5 md:h-52">
                    <span className={cn("w-2 rounded-t sm:w-2.5 md:w-4", isHovered ? "bg-[#FB923C]" : "bg-orange-500")} style={{ height: `${Math.max((row.sales / max) * 100, 3)}%` }} />
                    <span className="w-2 rounded-t bg-[#CBD5E1] sm:w-2.5 md:w-4" style={{ height: `${Math.max((row.target / max) * 100, 3)}%` }} />
                  </div>
                  <span className={cn("absolute -bottom-1 max-w-8 translate-y-full truncate text-[9px] font-bold sm:max-w-10 sm:text-[10px] md:max-w-none md:text-[11px]", isHovered ? "text-[#F97316]" : "text-[#64748B]")}>{row.label.replace(" 2026", "")}</span>
                </div>
              </PremiumTooltip>
            );
          })}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-5 text-xs font-bold text-[#64748B]">
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm bg-orange-500" /> Sales</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm bg-[#CBD5E1]" /> Target</span>
      </div>
    </ChartCard>
  );
}
