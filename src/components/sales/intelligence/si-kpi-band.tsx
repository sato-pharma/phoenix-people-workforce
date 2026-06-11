"use client";

import { Banknote, Boxes, Tag, Truck, Users, UsersRound, type LucideIcon } from "lucide-react";

import { SiDeltaBadge } from "@/components/sales/intelligence/si-delta-badge";
import { compactEGP, compactNumber, shareText } from "@/components/sales/intelligence/si-format";
import type {
  SiCompare,
  SiConcentration,
  SiCoverage,
  SiKpiSparkPoint,
  SiKpiSummary,
} from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

// Executive Navy — one restrained navy→steel→dusty→slate ramp + muted clay, plus the semantic
// green (all reporting) / amber (incomplete) coverage states. Each tone carries the hex its
// sparkline is drawn in.
type Tone = "navy" | "steel" | "dusty" | "slate" | "clay" | "green" | "amber";

const TONE: Record<Tone, { accent: string; chip: string }> = {
  navy: { accent: "#1E3A5F", chip: "bg-[#EEF2F7] text-[#1E3A5F]" },
  steel: { accent: "#3B6B9A", chip: "bg-[#EEF3F8] text-[#3B6B9A]" },
  dusty: { accent: "#6B8FB5", chip: "bg-[#F1F5F9] text-[#4E7298]" },
  slate: { accent: "#475569", chip: "bg-[#F1F5F9] text-[#475569]" },
  clay: { accent: "#B08968", chip: "bg-[#F6F1EC] text-[#8C6A4E]" },
  green: { accent: "#15803D", chip: "bg-[#ECFDF3] text-[#15803D]" },
  amber: { accent: "#B45309", chip: "bg-[#FFFBEB] text-[#B45309]" },
};

// A smooth filled sparkline — the modern replacement for the chunky bar blocks. An incomplete
// trailing month dims the fill and marks the last point amber, the same semantic as the trend chart.
function Sparkline({ id, values, incomplete, accent }: { id: string; values: number[]; incomplete: boolean; accent: string }) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2) return <div className="h-9" aria-hidden="true" />;
  const width = 120;
  const height = 34;
  const max = Math.max(...clean);
  const min = Math.min(...clean);
  const range = max - min || 1;
  const points = clean.map((value, index) => {
    const x = (index / (clean.length - 1)) * width;
    const y = height - 3 - ((value - min) / range) * (height - 6);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const [lastX, lastY] = points[points.length - 1];
  return (
    <svg aria-hidden="true" className="h-9 w-full" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity={incomplete ? 0.16 : 0.22} />
          <stop offset="100%" stopColor={accent} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${id})`} />
      <path d={line} fill="none" stroke={accent} strokeOpacity={incomplete ? 0.5 : 1} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} fill={incomplete ? "#F59E0B" : accent} r={2.4} />
    </svg>
  );
}

// A slim reporting meter for the coverage card: reporting ÷ expected, amber while incomplete.
function CoverageMeter({ reporting, expected, incomplete }: { reporting: number; expected: number; incomplete: boolean }) {
  const ratio = expected > 0 ? Math.min(reporting / expected, 1) : 0;
  return (
    <div className="flex h-9 items-center" aria-hidden="true">
      <div className="h-2 w-full overflow-hidden rounded-full bg-[#EEF1F5]">
        <div
          className={cn("h-full rounded-full transition-all", incomplete ? "bg-[#F59E0B]" : "bg-[#15803D]")}
          style={{ width: `${Math.max(ratio * 100, 4)}%` }}
        />
      </div>
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
  meter?: { reporting: number; expected: number; incomplete: boolean };
};

// Six executive KPIs. Net Sales / Units / Avg Price deltas are LIKE-FOR-LIKE (only the
// distributors present in both months) so an under-uploaded month never reads as a crash; the
// "Distributors Reporting" card makes that coverage explicit instead of hiding it behind a number.
export function SiKpiBand({
  kpis,
  compare,
  coverage,
  sparks,
  concentration,
  customerTop10Share,
  customerPending,
}: {
  kpis: SiKpiSummary;
  compare: SiCompare;
  coverage: SiCoverage;
  sparks: SiKpiSparkPoint[];
  concentration: SiConcentration;
  customerTop10Share: number | null;
  customerPending: boolean;
}) {
  const incompleteTail = sparks.length > 0 && !sparks[sparks.length - 1].monthComplete;
  const series = {
    value: sparks.map((point) => point.value),
    units: sparks.map((point) => point.units),
    customers: sparks.map((point) => point.customers),
    avgPrice: sparks.map((point) => point.avgPrice),
  };
  const latestAvgPrice = series.avgPrice[series.avgPrice.length - 1] ?? 0;
  const basis = coverage.incomplete ? `like-for-like · ${coverage.commonDistributors} distrib.` : "vs prior month";

  const cards: Array<KpiDef & { spark: number[] }> = [
    {
      key: "value", label: "Net Sales", icon: Banknote, tone: "navy",
      value: `EGP ${compactEGP(kpis.totals.value)}`, pct: compare.value.mom.pct,
      sub: basis, spark: series.value,
    },
    {
      key: "units", label: "Units", icon: Boxes, tone: "steel",
      value: compactNumber(kpis.totals.units), pct: compare.units.mom.pct,
      sub: coverage.incomplete ? basis : "packs sold", spark: series.units,
    },
    {
      key: "avgPrice", label: "Avg Realized Price", icon: Tag, tone: "dusty",
      value: `EGP ${latestAvgPrice.toFixed(1)}`, pct: coverage.avgPrice.pct,
      sub: "value ÷ units", spark: series.avgPrice,
    },
    {
      key: "customers", label: "Active Customers", icon: Users, tone: "slate",
      value: compactNumber(series.customers[series.customers.length - 1] ?? 0),
      pct: coverage.incomplete ? null : pctSeries(series.customers),
      sub: coverage.incomplete ? "partial coverage" : "buying this month", spark: series.customers,
    },
    {
      key: "coverage", label: "Distributors Reporting", icon: Truck,
      tone: coverage.incomplete ? "amber" : "green",
      value: `${coverage.reporting} / ${coverage.expected}`, pct: null,
      sub: coverage.incomplete ? `${coverage.expected - coverage.reporting} not yet uploaded` : "all reporting",
      meter: { reporting: coverage.reporting, expected: coverage.expected, incomplete: coverage.incomplete },
      spark: [],
    },
    {
      key: "top10", label: "Top-10 Customer Share", icon: UsersRound, tone: "clay",
      value: customerPending ? "···" : customerTop10Share !== null ? shareText(customerTop10Share, 0) : "—",
      pct: null, pending: customerPending, invert: true,
      sub: concentration.distributors.band === "high" ? "high concentration" : "concentration",
      spark: series.value,
    },
  ];

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((card) => {
          const tone = TONE[card.tone];
          const Icon = card.icon;
          return (
            <div
              className="group relative flex flex-col justify-between rounded-xl border border-[#E7ECF2] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-[#D3DCE6] hover:shadow-[0_8px_24px_rgba(15,23,42,0.07)]"
              key={card.key}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-[10px] font-bold uppercase tracking-[0.12em] text-[#94A3B8]">{card.label}</p>
                <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", tone.chip)}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
              </div>
              <p className={cn("mt-2 truncate text-[1.6rem] font-extrabold leading-none tracking-tight tabular-nums text-[#0F172A]", card.pending && "animate-pulse text-slate-300")}>
                {card.value}
              </p>
              <div className="mt-2.5">
                {card.meter ? (
                  <CoverageMeter expected={card.meter.expected} incomplete={card.meter.incomplete} reporting={card.meter.reporting} />
                ) : (
                  <Sparkline accent={tone.accent} id={card.key} incomplete={incompleteTail} values={card.spark} />
                )}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <SiDeltaBadge invert={card.invert} pct={card.pct} pending={card.pending && card.pct === null ? false : undefined} />
                <span className="truncate text-[10px] font-medium text-[#94A3B8]">{card.sub}</span>
              </div>
            </div>
          );
        })}
      </div>
      {coverage.incomplete && (
        <p className="px-0.5 text-[11px] font-medium text-[#94A3B8]">
          ▲▼ deltas are like-for-like — only the {coverage.commonDistributors} distributor
          {coverage.commonDistributors === 1 ? "" : "s"} reporting in both months are compared, so partial
          uploads aren&apos;t mistaken for a sales swing. {coverage.expected - coverage.reporting} distributor
          {coverage.expected - coverage.reporting === 1 ? "" : "s"} still to upload for this month.
        </p>
      )}
    </div>
  );
}
