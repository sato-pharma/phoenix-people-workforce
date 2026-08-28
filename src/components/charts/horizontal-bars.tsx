"use client";

import { BarChart3 } from "lucide-react";
import { ChartCard } from "@/components/cards/chart-card";
import { SectionHeader } from "@/components/ui/section-header";
import { PremiumTooltip } from "@/components/ui/premium-tooltip";
import { ChartDataPoint, ChartProps } from "./chart-types";

type HorizontalBarsProps = ChartProps & {
  rows: ChartDataPoint[];
  title: string;
  valueKind?: "money" | "number";
};

function compactEGP(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(1)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { currency: "EGP", maximumFractionDigits: 0, style: "currency" }).format(safe);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Number.isFinite(value) ? value : 0);
}

export function HorizontalBars({ rows, title, valueKind = "money", loading = false }: HorizontalBarsProps) {
  const max = Math.max(...rows.map((row) => row.value), 1);

  if (loading) {
    return (
      <ChartCard>
        <SectionHeader icon={BarChart3} title={title} />
        <div className="mt-5 space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 animate-pulse bg-phx-paper rounded-lg" />
          ))}
        </div>
      </ChartCard>
    );
  }

  return (
    <ChartCard>
      <SectionHeader icon={BarChart3} title={title} />
      <div className="mt-5 space-y-3">
        {rows.slice(0, 8).map((row, index) => (
          <PremiumTooltip
            content={
              <div className="space-y-1">
                <p className="text-xs font-bold text-phx-ink">{row.label}</p>
                <p className="text-[11px] text-phx-ink-soft">{valueKind === "money" ? compactEGP(row.value) : formatNumber(row.value)}</p>
                {row.meta && <p className="text-[10px] text-phx-ink-soft">{row.meta}</p>}
                <p className="text-[11px] font-bold text-phx-accent">{((row.value / max) * 100).toFixed(1)}% of max</p>
              </div>
            }
            key={row.label}
          >
            <div className="grid grid-cols-[20px_minmax(0,1fr)_56px] items-center gap-2 sm:grid-cols-[24px_minmax(0,1fr)_64px] sm:gap-3 md:grid-cols-[26px_minmax(0,1fr)_92px]">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-phx-paper text-[10px] font-black text-phx-ink-soft sm:h-6 sm:w-6 sm:text-xs">{index + 1}</span>
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <p className="truncate text-xs font-black text-phx-ink sm:text-sm">{row.label}</p>
                  {row.meta && <p className="hidden shrink-0 text-[10px] font-bold text-phx-ink-soft sm:text-[11px] sm:block">{row.meta}</p>}
                </div>
                <div className="h-1.5 rounded-full bg-phx-paper sm:h-2">
                  <div className="h-full rounded-full bg-gradient-to-r from-orange-500 to-orange-300" style={{ width: `${Math.max((row.value / max) * 100, 4)}%` }} />
                </div>
              </div>
              <p className="truncate text-right text-[10px] font-black text-phx-ink sm:text-[11px] md:text-xs">{valueKind === "money" ? compactEGP(row.value).replace("EGP ", "") : formatNumber(row.value)}</p>
            </div>
          </PremiumTooltip>
        ))}
      </div>
    </ChartCard>
  );
}
