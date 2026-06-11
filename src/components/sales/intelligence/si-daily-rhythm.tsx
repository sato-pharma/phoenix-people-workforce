"use client";

import { CalendarDays } from "lucide-react";
import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ChartCard } from "@/components/cards/chart-card";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { SectionHeader } from "@/components/ui/section-header";
import { compactEGP } from "@/components/sales/intelligence/si-format";
import type { SiDailyCurve, SiRunRate } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

type RhythmPoint = {
  day: number;
  date: string;
  value: number;
  units: number;
  customers: number;
  cumulativeValue: number;
  priorCumulative: number | null;
  weekend: boolean;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function buildPoints(curve: SiDailyCurve, prior: SiDailyCurve | null): RhythmPoint[] {
  return curve.points.map((point, index) => ({
    day: point.day,
    date: point.date,
    value: point.value,
    units: point.units,
    customers: point.customers,
    cumulativeValue: point.cumulativeValue,
    // Prior-month same-day cumulative — the "are we ahead of last month?" ghost line.
    priorCumulative: prior && prior.datedValueShare >= 0.5 ? prior.points[index]?.cumulativeValue ?? null : null,
    weekend: [5, 6].includes(weekdayOf(point.date)), // Egyptian weekend: Fri + Sat
  }));
}

type RhythmTooltipProps = {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: RhythmPoint }>;
};

function RhythmTooltip({ active, payload }: RhythmTooltipProps) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  const aheadPct = point.priorCumulative
    ? (point.cumulativeValue - point.priorCumulative) / Math.abs(point.priorCumulative)
    : null;
  return (
    <div className="border border-slate-200 bg-white p-3 shadow-xl">
      <p className="mb-1 text-[10px] font-black uppercase tracking-wider text-slate-400">{point.date}</p>
      <p className="text-[12px] font-black tabular-nums text-slate-900">EGP {Math.round(point.value).toLocaleString()}</p>
      <p className="text-[11px] font-bold text-slate-500">{Math.round(point.units).toLocaleString()} units · {point.customers} customer touches</p>
      <p className="mt-1 text-[11px] font-bold text-slate-700">MTD: EGP {compactEGP(point.cumulativeValue)}</p>
      {aheadPct !== null && (
        <p className={cn("text-[10px] font-black", aheadPct >= 0 ? "text-emerald-600" : "text-rose-600")}>
          {aheadPct >= 0 ? "▲" : "▼"} {(Math.abs(aheadPct) * 100).toFixed(1)}% vs last month&apos;s pace
        </p>
      )}
    </div>
  );
}

/** The chart core — mounted full-size on the dashboard and compact inside the drill panel. */
export function DailyRhythmChart({
  curve,
  prior,
  compact = false,
}: {
  curve: SiDailyCurve;
  prior?: SiDailyCurve | null;
  compact?: boolean;
}) {
  const points = useMemo(() => buildPoints(curve, prior ?? null), [curve, prior]);
  const height = compact ? 180 : 300;

  // Day-level coverage too thin → a DESIGNED empty state, not a broken chart.
  if (curve.datedValueShare < 0.5 || points.every((point) => point.value === 0)) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-10" style={{ minHeight: height }}>
        <div className="flex h-16 items-end gap-1 opacity-50" aria-hidden="true">
          {[34, 58, 22, 70, 45, 62, 30, 52, 40, 66, 26, 48].map((bar, index) => (
            <span className="w-2.5 bg-slate-200" key={index} style={{ height: `${bar}%` }} />
          ))}
        </div>
        <p className="max-w-sm text-center text-xs font-bold text-slate-500">
          Day-level dates unavailable for this period — {(curve.datedValueShare * 100).toFixed(0)}% of value carries a parseable invoice date.
        </p>
      </div>
    );
  }

  return (
    <SafeResponsiveContainer minHeight={height} style={{ height }}>
      <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
        <CartesianGrid stroke="#EEF2F7" vertical={false} />
        {/* Friday/Saturday bands — the Egyptian work-week rhythm at a glance. */}
        {points.filter((point) => point.weekend).map((point) => (
          <ReferenceArea fill="#F8FAFC" key={point.day} x1={point.day - 0.5} x2={point.day + 0.5} />
        ))}
        <XAxis
          dataKey="day"
          tick={{ fill: "#64748B", fontSize: 10, fontWeight: 700 }}
          tickLine={false}
          axisLine={{ stroke: "#E2E8F0" }}
          interval={compact ? 4 : 1}
        />
        <YAxis yAxisId="day" tickFormatter={compactEGP} tick={{ fill: "#94A3B8", fontSize: 10 }} tickLine={false} axisLine={false} width={44} />
        <YAxis yAxisId="mtd" orientation="right" tickFormatter={compactEGP} tick={{ fill: "#94A3B8", fontSize: 10 }} tickLine={false} axisLine={false} width={44} />
        <Tooltip content={<RhythmTooltip />} cursor={{ fill: "rgba(249,115,22,0.07)" }} />
        <Bar yAxisId="day" dataKey="value" fill="#F97316" radius={[2, 2, 0, 0]} maxBarSize={22} />
        {points.some((point) => point.priorCumulative !== null) && (
          <Line
            yAxisId="mtd"
            type="monotone"
            dataKey="priorCumulative"
            stroke="#94A3B8"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
          />
        )}
        <Line yAxisId="mtd" type="monotone" dataKey="cumulativeValue" stroke="#0F172A" strokeWidth={2} dot={false} />
      </ComposedChart>
    </SafeResponsiveContainer>
  );
}

// Full dashboard card: chart + weekday-average footer + run-rate / undated chips.
export function SiDailyRhythm({
  curve,
  prior,
  runRate,
}: {
  curve: SiDailyCurve | null;
  prior: SiDailyCurve | null;
  runRate: SiRunRate;
}) {
  const weekdayAverages = useMemo(() => {
    if (!curve) return [];
    const sums = Array.from({ length: 7 }, () => ({ total: 0, count: 0 }));
    for (const point of curve.points) {
      if (point.value <= 0) continue;
      const weekday = weekdayOf(point.date);
      sums[weekday].total += point.value;
      sums[weekday].count += 1;
    }
    const averages = sums.map((entry) => (entry.count > 0 ? entry.total / entry.count : 0));
    const max = Math.max(...averages, 1);
    return averages.map((avg, index) => ({ label: WEEKDAYS[index], avg, heightPct: Math.max((avg / max) * 100, 4) }));
  }, [curve]);

  return (
    <ChartCard className="h-full p-5">
      <SectionHeader
        action={(
          <div className="flex flex-wrap items-center gap-2">
            {runRate && (
              <span className={cn(
                "border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide",
                runRate.reliable ? "border-orange-200 bg-orange-50 text-orange-700" : "border-slate-200 bg-slate-50 text-slate-500",
              )}
                title={`${runRate.daysElapsed}/${runRate.daysInMonth} days traded · ${(runRate.datedValueShare * 100).toFixed(0)}% dated`}
              >
                Pace → EGP {compactEGP(runRate.projectedValue)}{runRate.reliable ? "" : " (low confidence)"}
              </span>
            )}
            {curve && curve.undatedValue > 0 && (
              <span className="border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-amber-700">
                Undated: EGP {compactEGP(curve.undatedValue)}
              </span>
            )}
          </div>
        )}
        icon={CalendarDays}
        subtitle="Daily net sales (bars), month-to-date pace (line) and last month's pace (dashed). Friday/Saturday shaded."
        title="Daily Sales Rhythm"
      />
      <div className="mt-4">
        {curve ? (
          <DailyRhythmChart curve={curve} prior={prior} />
        ) : (
          <p className="px-5 py-10 text-center text-sm text-[#94A3B8]">Select a month to see its daily rhythm.</p>
        )}
      </div>
      {weekdayAverages.length > 0 && (
        <div className="mt-4 border-t border-[#EEF2F7] pt-3">
          <p className="mb-2 text-[9px] font-black uppercase tracking-[0.18em] text-[#94A3B8]">Avg by weekday</p>
          <div className="grid grid-cols-7 gap-2">
            {weekdayAverages.map((entry) => (
              <div className="flex flex-col items-center gap-1" key={entry.label} title={`EGP ${compactEGP(entry.avg)}`}>
                <div className="flex h-8 w-full items-end">
                  <div className="w-full bg-[#F97316]" style={{ height: `${entry.heightPct}%`, opacity: 0.25 + (entry.heightPct / 100) * 0.7 }} />
                </div>
                <span className="text-[9px] font-bold text-[#94A3B8]">{entry.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </ChartCard>
  );
}
