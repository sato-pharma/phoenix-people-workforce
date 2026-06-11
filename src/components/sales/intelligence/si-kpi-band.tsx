"use client";

import { Banknote, Boxes, MapPin, Tag, Users, UsersRound, type LucideIcon } from "lucide-react";

import { SiDeltaBadge } from "@/components/sales/intelligence/si-delta-badge";
import { compactEGP, compactNumber, shareText } from "@/components/sales/intelligence/si-format";
import type { SiCompare, SiConcentration, SiKpiSparkPoint, SiKpiSummary } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

type Tone = "orange" | "slate" | "blue" | "violet" | "emerald" | "rose";

const TONE: Record<Tone, { line: string; icon: string; spark: string }> = {
  orange: { line: "bg-[#F97316]", icon: "bg-[#FFF7ED] text-[#F97316]", spark: "bg-[#F97316]" },
  slate: { line: "bg-[#64748B]", icon: "bg-[#F8FAFC] text-[#0F172A]", spark: "bg-[#64748B]" },
  blue: { line: "bg-[#3B82F6]", icon: "bg-[#EFF6FF] text-[#3B82F6]", spark: "bg-[#3B82F6]" },
  violet: { line: "bg-[#8B5CF6]", icon: "bg-[#F5F3FF] text-[#8B5CF6]", spark: "bg-[#8B5CF6]" },
  emerald: { line: "bg-[#22C55E]", icon: "bg-[#F0FDF4] text-[#22C55E]", spark: "bg-[#22C55E]" },
  rose: { line: "bg-[#EF4444]", icon: "bg-[#FEF2F2] text-[#EF4444]", spark: "bg-[#EF4444]" },
};

function SparkBars({ values, flags, tone }: { values: number[]; flags: boolean[]; tone: Tone }) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex h-8 items-end gap-[3px]" aria-hidden="true">
      {values.map((value, index) => (
        <span
          className={cn(
            "flex-1 transition-opacity",
            // Amber = incomplete month — the same semantic as the trend chart, everywhere.
            flags[index] ? "bg-[#FBBF24]" : cn(TONE[tone].spark, "opacity-75"),
          )}
          key={index}
          style={{ height: `${Math.max((value / max) * 100, 10)}%` }}
          title={flags[index] ? "Incomplete month" : undefined}
        />
      ))}
    </div>
  );
}

function pctSeries(values: number[]): number | null {
  if (values.length < 2) return null;
  const prior = values[values.length - 2];
  if (!prior) return null;
  return (values[values.length - 1] - prior) / Math.abs(prior);
}

type KpiDef = {
  key: string;
  label: string;
  icon: LucideIcon;
  tone: Tone;
  value: string;
  pct: number | null;
  pending?: boolean;
  invert?: boolean;
  sub: string;
};

// Six executive KPIs, each with its OWN spark series from the one-scan period totals.
export function SiKpiBand({
  kpis,
  compare,
  sparks,
  concentration,
  customerTop10Share,
  customerPending,
}: {
  kpis: SiKpiSummary;
  compare: SiCompare;
  sparks: SiKpiSparkPoint[];
  concentration: SiConcentration;
  customerTop10Share: number | null;
  customerPending: boolean;
}) {
  const flags = sparks.map((point) => !point.monthComplete);
  const series = {
    value: sparks.map((point) => point.value),
    units: sparks.map((point) => point.units),
    customers: sparks.map((point) => point.customers),
    avgPrice: sparks.map((point) => point.avgPrice),
    areas: sparks.map((point) => point.areas),
  };
  const latestAvgPrice = series.avgPrice[series.avgPrice.length - 1] ?? 0;

  const cards: Array<KpiDef & { spark: number[] }> = [
    {
      key: "value", label: "Net Sales", icon: Banknote, tone: "orange",
      value: `EGP ${compactEGP(kpis.totals.value)}`, pct: compare.value.mom.pct,
      sub: "vs prior month", spark: series.value,
    },
    {
      key: "units", label: "Units", icon: Boxes, tone: "slate",
      value: compactNumber(kpis.totals.units), pct: compare.units.mom.pct,
      sub: "packs sold", spark: series.units,
    },
    {
      key: "customers", label: "Active Customers", icon: Users, tone: "blue",
      value: compactNumber(series.customers[series.customers.length - 1] ?? 0),
      pct: pctSeries(series.customers), sub: "buying this month", spark: series.customers,
    },
    {
      key: "avgPrice", label: "Avg Realized Price", icon: Tag, tone: "violet",
      value: `EGP ${latestAvgPrice.toFixed(1)}`, pct: pctSeries(series.avgPrice),
      sub: "value ÷ units", spark: series.avgPrice,
    },
    {
      key: "areas", label: "Areas Covered", icon: MapPin, tone: "emerald",
      value: compactNumber(kpis.areaCount), pct: pctSeries(series.areas),
      sub: "with sales", spark: series.areas,
    },
    {
      key: "top10", label: "Top-10 Customer Share", icon: UsersRound, tone: "rose",
      value: customerPending ? "···" : customerTop10Share !== null ? shareText(customerTop10Share, 0) : "—",
      pct: null, pending: customerPending, invert: true,
      sub: concentration.distributors.band === "high" ? "high concentration" : "concentration",
      spark: series.value,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => {
        const tone = TONE[card.tone];
        const Icon = card.icon;
        return (
          <div className="overflow-hidden border border-[#E2E8F0] bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(15,23,42,0.08)]" key={card.key}>
            <div className={cn("h-1", tone.line)} />
            <div className="p-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[10px] font-black uppercase tracking-[0.14em] text-[#64748B]">{card.label}</p>
                  <p className={cn("mt-1 truncate text-xl font-black tabular-nums text-[#0F172A]", card.pending && "animate-pulse text-slate-400")}>
                    {card.value}
                  </p>
                </div>
                <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center", tone.icon)}>
                  <Icon className="h-4 w-4" />
                </span>
              </div>
              <div className="mt-3 hidden sm:block">
                <SparkBars flags={flags} tone={card.tone} values={card.spark} />
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <SiDeltaBadge invert={card.invert} pct={card.pct} pending={card.pending && card.pct === null ? false : undefined} />
                <span className="truncate text-[10px] font-bold text-[#94A3B8]">{card.sub}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
