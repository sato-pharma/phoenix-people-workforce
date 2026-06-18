"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  Award,
  BarChart3,
  CheckCircle2,
  Filter,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  TrendingDown,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AdminSectionHeader,
  adminInsetPanelClassName,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { Card } from "@/components/ui/card";
import type {
  CoachingCategoryAverageScore,
  CoachingParameterDistributionRow,
  CoachingPerformanceZone,
  CoachingQuarterlySummaryRow,
  CoachingReportSummaryRow,
  CoachingScoreItemAverageScore,
} from "@/lib/coaching/types";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type FilterOption = {
  label: string;
  value: string;
};

export type CoachingAnalyticsFilterOptions = {
  areas: FilterOption[];
  lines: FilterOption[];
  medicalReps: FilterOption[];
  teams: FilterOption[];
  years: FilterOption[];
};

export type CoachingAnalyticsPayload = {
  analytics: {
    averageScore: number;
    bestScore: number;
    coachingCount: number;
    draftCount: number;
    latestReport: CoachingReportSummaryRow | null;
    lowestScore: number;
    pendingAcknowledgmentCount: number;
    zoneCounts: Record<string, number>;
  };
  categoryAverageScores: CoachingCategoryAverageScore[];
  keyDevelopmentAreaDistribution: CoachingParameterDistributionRow[];
  quarterlySummary: CoachingQuarterlySummaryRow[];
  reports: CoachingReportSummaryRow[];
  scoreItemAverageScores: CoachingScoreItemAverageScore[];
  strongestParameterDistribution: CoachingParameterDistributionRow[];
};

type CoachingAnalyticsDashboardProps = {
  canCreate: boolean;
  createHref?: string;
  filterOptions: CoachingAnalyticsFilterOptions;
  initialData: CoachingAnalyticsPayload;
};

type FilterState = {
  areaId: string;
  lineId: string;
  medicalRepHrId: string;
  quarter: string;
  teamId: string;
  year: string;
};

type ApiResponse<T> = {
  data?: T;
  error?: string;
  message?: string;
};

const initialFilters: FilterState = {
  areaId: "",
  lineId: "",
  medicalRepHrId: "",
  quarter: "",
  teamId: "",
  year: "",
};

const zoneLabels: Record<CoachingPerformanceZone, string> = {
  critical_red: "Red Zone / Below Expectations",
  excellence_zone: "Excellence Zone / Exceeds Expectations",
  green_zone: "Green Zone / Meets Expectations",
  red_zone: "Red Zone / Below Expectations",
  yellow_zone: "Yellow Zone / Needs Improvement",
};

const zoneColors: Record<string, string> = {
  critical_red: "#E11D48",
  excellence_zone: "#F59E0B",
  green_zone: "#10B981",
  red_zone: "#E11D48",
  yellow_zone: "#F97316",
};

// Chart design tokens — quiet axes, hairline grid, brand orange focal.
const CHART_GRID = "#EEF2F7";
const CHART_AXIS = "#94A3B8";

const completedStatuses = new Set(["submitted", "reviewed_by_employee", "locked"]);

function formatNumber(value: number | string | null | undefined, digits = 0) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return digits > 0 ? "0.0" : "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(number);
}

function formatPercent(value: number | string | null | undefined) {
  return `${formatNumber(Number(value ?? 0), 1)}%`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not available";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

function zoneLabel(zone: string | null | undefined) {
  if (!zone || !(zone in zoneLabels)) return "Not scored";
  return zoneLabels[zone as CoachingPerformanceZone];
}

function zoneShortLabel(zone: string | null | undefined) {
  if (zone === "critical_red" || zone === "red_zone") return "Below";
  if (zone === "yellow_zone") return "Needs Work";
  if (zone === "green_zone") return "Meets";
  if (zone === "excellence_zone") return "Exceeds";
  return "Not scored";
}

function zoneClassName(zone: string | null | undefined) {
  if (zone === "critical_red" || zone === "red_zone") return "border-rose-200 bg-rose-50 text-rose-700";
  if (zone === "yellow_zone") return "border-orange-200 bg-orange-50 text-orange-700";
  if (zone === "green_zone") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (zone === "excellence_zone") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

/** Colour a score (0-100) by the performance zone it falls into. */
function scoreZoneColor(percent: number) {
  if (percent <= 65) return zoneColors.red_zone;
  if (percent <= 80) return zoneColors.yellow_zone;
  if (percent <= 90) return zoneColors.green_zone;
  return zoneColors.excellence_zone;
}

function completedReports(data: CoachingAnalyticsPayload) {
  return data.reports.filter((report) => completedStatuses.has(report.status));
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

type TooltipItem = {
  color?: string;
  name?: string;
  value?: number | string;
  payload?: { fill?: string; label?: string };
};

/** Premium, consistent tooltip card shared by every chart. */
function ChartTooltip({
  active,
  label,
  payload,
  suffix = "",
}: {
  active?: boolean;
  label?: string | number;
  payload?: TooltipItem[];
  suffix?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="pointer-events-none min-w-[150px] rounded-[8px] border border-[#E2E8F0] bg-white px-3 py-2 shadow-[0_16px_36px_-14px_rgba(15,23,42,0.45)]">
      {label !== undefined && label !== "" ? (
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">{label}</p>
      ) : null}
      {payload.map((item, index) => (
        <div className="mt-1 flex items-center justify-between gap-4" key={index}>
          <span className="flex items-center gap-1.5 text-xs font-semibold text-[#475569]">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: item.color ?? item.payload?.fill ?? "#F97316" }}
            />
            {item.payload?.label ?? item.name}
          </span>
          <span className="text-sm font-black tabular-nums text-[#0F172A]">
            {item.value}
            {suffix}
          </span>
        </div>
      ))}
    </div>
  );
}

function DonutLegend({ items }: { items: { color: string; label: string; value: number }[] }) {
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  return (
    <ul className="w-[150px] shrink-0 space-y-2.5">
      {items.map((item) => (
        <li className="flex items-center justify-between gap-2" key={item.label}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: item.color }} />
            <span className="truncate text-xs font-bold text-[#475569]">{item.label}</span>
          </span>
          <span className="shrink-0 text-xs font-black tabular-nums text-[#0F172A]">
            {item.value}
            <span className="ml-1 font-bold text-[#94A3B8]">{Math.round((item.value / total) * 100)}%</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function SelectField({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  value: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">{label}</span>
      <SearchableSelect
        className="mt-2 h-10 w-full rounded-xl border border-[#CBD5E1] bg-white px-3 text-sm font-semibold text-[#0F172A] shadow-sm outline-none transition focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SearchableSelect>
    </label>
  );
}

function KpiCard({
  helper,
  icon,
  label,
  value,
}: {
  helper: string;
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card className={cn(adminPanelClassName, "p-5")}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">{label}</p>
          <p className="mt-3 text-3xl font-black tracking-[-0.04em] text-[#0F172A]">{value}</p>
        </div>
        <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#FFF7ED] text-[#F97316]">
          {icon}
        </div>
      </div>
      <p className="mt-4 text-sm leading-6 text-[#64748B]">{helper}</p>
    </Card>
  );
}

function ChartPanel({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <Card className={cn(adminPanelClassName, "min-w-0 overflow-hidden p-0")}>
      <AdminSectionHeader description={description} title={title} />
      <div className="h-[320px] min-h-[320px] min-w-0 p-4">
        <div className="h-full min-h-0 min-w-0">{children}</div>
      </div>
    </Card>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-[16px] border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-6 text-center text-sm font-semibold text-[#64748B]">
      {message}
    </div>
  );
}

/** Donut (pie) with a centred total overlay + side legend. */
function DonutChart({
  caption,
  items,
}: {
  caption: string;
  items: { color: string; key: string; label: string; value: number }[];
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return (
    <div className="flex h-full min-h-0 items-center gap-3">
      <div className="relative h-full min-w-0 flex-1">
        <SafeResponsiveContainer className="h-full">
          <PieChart>
            <Pie
              cornerRadius={5}
              data={items}
              dataKey="value"
              innerRadius="64%"
              outerRadius="94%"
              paddingAngle={items.length > 1 ? 2 : 0}
              stroke="none"
            >
              {items.map((entry) => (
                <Cell fill={entry.color} key={entry.key} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} cursor={false} />
          </PieChart>
        </SafeResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[28px] font-black leading-none tracking-[-0.04em] text-[#0F172A]">{total}</span>
          <span className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">{caption}</span>
        </div>
      </div>
      <DonutLegend items={items} />
    </div>
  );
}

/**
 * Premium ranked bar list — fully readable category labels (no truncation),
 * gradient fills, rank chips, and the value + share. Renders crisp in the admin
 * shell's square-corner system. Score bars are coloured by performance zone;
 * count bars use a single gradient accent.
 */
function BarList({
  accent = "orange",
  data,
  mode,
}: {
  accent?: "orange" | "slate";
  data: { label: string; value: number }[];
  mode: "count" | "score";
}) {
  const max = mode === "score" ? 100 : Math.max(1, ...data.map((item) => item.value));
  const total = data.reduce((sum, item) => sum + item.value, 0) || 1;
  const gradient =
    accent === "orange"
      ? "linear-gradient(90deg, #FDBA74 0%, #F97316 100%)"
      : "linear-gradient(90deg, #64748B 0%, #0F172A 100%)";

  return (
    <div className="flex h-full flex-col justify-center gap-3.5 overflow-y-auto py-1 pr-0.5">
      {data.map((item, index) => {
        const width = Math.max(3, Math.round((item.value / max) * 100));
        const background = mode === "score" ? scoreZoneColor(item.value) : gradient;
        return (
          <div key={`${item.label}-${index}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center bg-[#0F172A] text-[10px] font-black text-white">
                  {index + 1}
                </span>
                <span className="text-[13px] font-bold leading-tight text-[#1E293B]">{item.label}</span>
              </span>
              <span className="shrink-0 text-sm font-black tabular-nums text-[#0F172A]">
                {mode === "score" ? (
                  `${item.value}%`
                ) : (
                  <>
                    {item.value}
                    <span className="ml-1.5 text-xs font-bold text-[#94A3B8]">
                      {Math.round((item.value / total) * 100)}%
                    </span>
                  </>
                )}
              </span>
            </div>
            <div className="mt-1.5 h-2.5 w-full bg-[#EEF2F7]">
              <div className="h-full" style={{ background, width: `${width}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function buildZoneData(data: CoachingAnalyticsPayload) {
  const counts = data.analytics.zoneCounts;
  return [
    { color: zoneColors.red_zone, key: "red_zone", label: "Red Zone", value: (counts.critical_red ?? 0) + (counts.red_zone ?? 0) },
    { color: zoneColors.yellow_zone, key: "yellow_zone", label: "Yellow Zone", value: counts.yellow_zone ?? 0 },
    { color: zoneColors.green_zone, key: "green_zone", label: "Green Zone", value: counts.green_zone ?? 0 },
    { color: zoneColors.excellence_zone, key: "excellence_zone", label: "Excellence Zone", value: counts.excellence_zone ?? 0 },
  ].filter((row) => row.value > 0);
}

function buildLineAverages(reports: CoachingReportSummaryRow[]) {
  const buckets = new Map<string, number[]>();
  for (const report of reports) {
    const key = report.lineName || "Not assigned";
    buckets.set(key, [...(buckets.get(key) ?? []), report.finalScorePercent]);
  }
  return [...buckets.entries()]
    .map(([label, values]) => ({ label, value: Number(average(values).toFixed(1)) }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 8);
}

function buildAreaAverages(reports: CoachingReportSummaryRow[]) {
  const buckets = new Map<string, number[]>();
  for (const report of reports) {
    const key = report.areaName || "Not assigned";
    buckets.set(key, [...(buckets.get(key) ?? []), report.finalScorePercent]);
  }
  return [...buckets.entries()]
    .map(([label, values]) => ({ label, value: Number(average(values).toFixed(1)) }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 8);
}

function buildQuarterTrend(rows: CoachingQuarterlySummaryRow[]) {
  return [...rows]
    .sort((left, right) => left.year * 10 + left.quarter - (right.year * 10 + right.quarter))
    .map((row) => ({
      label: `Q${row.quarter} ${row.year}`,
      value: Number(row.averageScore.toFixed(1)),
    }));
}

function buildAcknowledgmentSplit(reports: CoachingReportSummaryRow[]) {
  const acknowledged = reports.filter((report) => report.acknowledged).length;
  const pending = Math.max(reports.length - acknowledged, 0);
  return [
    { color: "#10B981", key: "acknowledged", label: "Acknowledged", value: acknowledged },
    { color: "#CBD5E1", key: "pending", label: "Pending", value: pending },
  ].filter((row) => row.value > 0);
}

function buildParameterDistributionData(rows: CoachingParameterDistributionRow[]) {
  return rows.map((row) => ({
    label: row.parameterLabel,
    percent: row.percent,
    value: row.count,
  }));
}

// One row per medical rep, aggregated across that rep's FULL coaching history
// (not per quarter). Improvement is the rep's first-ever score vs. their latest
// score, so reps coached more than once — even across different quarters — show a
// real trend (and drive the "Most Improved" KPI). Single-coaching reps show 0.
function buildRepRows(data: CoachingAnalyticsPayload) {
  const reportsByHrId = new Map<string, CoachingReportSummaryRow[]>();
  for (const report of completedReports(data)) {
    reportsByHrId.set(report.medicalRepHrId, [...(reportsByHrId.get(report.medicalRepHrId) ?? []), report]);
  }

  return [...reportsByHrId.entries()].map(([hrId, reports]) => {
    const ordered = [...reports].sort((left, right) => left.coachingDate.localeCompare(right.coachingDate));
    const first = ordered[0];
    const latest = ordered[ordered.length - 1];
    const scores = ordered.map((report) => report.finalScorePercent);

    return {
      averageScore: Number(average(scores).toFixed(1)),
      coachingCount: ordered.length,
      firstScore: first.finalScorePercent,
      hrId,
      improvementScore: Number((latest.finalScorePercent - first.finalScorePercent).toFixed(1)),
      lastCoachingDate: latest.coachingDate ?? null,
      latestScore: latest.finalScorePercent,
      latestZone: latest.performanceZone,
      medicalRep: latest.medicalRepName || hrId,
    };
  }).sort((left, right) => right.improvementScore - left.improvementScore);
}

async function fetchAnalytics(filters: FilterState) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }

  const response = await fetch(`/api/coaching/analytics?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({})) as ApiResponse<CoachingAnalyticsPayload>;
  if (!response.ok) {
    throw new Error(payload.message || "Unable to load coaching analytics.");
  }
  return payload.data;
}

export function CoachingAnalyticsDashboard({
  canCreate,
  createHref = "/coaching/new",
  filterOptions,
  initialData,
}: CoachingAnalyticsDashboardProps) {
  const [data, setData] = useState(initialData);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const completed = useMemo(() => completedReports(data), [data]);
  const zoneData = useMemo(() => buildZoneData(data), [data]);
  const lineAverages = useMemo(() => buildLineAverages(completed), [completed]);
  const areaAverages = useMemo(() => buildAreaAverages(completed), [completed]);
  const quarterTrend = useMemo(() => buildQuarterTrend(data.quarterlySummary), [data.quarterlySummary]);
  const acknowledgmentSplit = useMemo(() => buildAcknowledgmentSplit(completed), [completed]);
  const strongestParameterData = useMemo(
    () => buildParameterDistributionData(data.strongestParameterDistribution),
    [data.strongestParameterDistribution],
  );
  const keyDevelopmentAreaData = useMemo(
    () => buildParameterDistributionData(data.keyDevelopmentAreaDistribution),
    [data.keyDevelopmentAreaDistribution],
  );
  const repRows = useMemo(() => buildRepRows(data), [data]);
  const redZoneCount = (data.analytics.zoneCounts.critical_red ?? 0) + (data.analytics.zoneCounts.red_zone ?? 0);
  const yellowZoneCount = data.analytics.zoneCounts.yellow_zone ?? 0;
  const greenZoneCount = data.analytics.zoneCounts.green_zone ?? 0;
  const excellenceZoneCount = data.analytics.zoneCounts.excellence_zone ?? 0;
  const acknowledgedCount = completed.filter((report) => report.acknowledged).length;
  const acknowledgmentRate = completed.length > 0 ? (acknowledgedCount / completed.length) * 100 : 0;
  const mostImproved = repRows.find((row) => row.improvementScore > 0);

  const updateFilter = (key: keyof FilterState, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const applyFilters = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextData = await fetchAnalytics(filters);
      if (nextData) setData(nextData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load coaching analytics.");
    } finally {
      setIsLoading(false);
    }
  };

  const resetFilters = async () => {
    setFilters(initialFilters);
    setIsLoading(true);
    setError(null);
    try {
      const nextData = await fetchAnalytics(initialFilters);
      if (nextData) setData(nextData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load coaching analytics.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card className={cn(adminPanelClassName, "p-5 sm:p-6")}>
        <AdminSectionHeader
          title="Analytics filters"
          description="Filter analytics by quarter, employee, and organization structure. Server-side coaching scope remains enforced."
          action={error ? (
            <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-black text-rose-700">
              {error}
            </span>
          ) : null}
        />
        <div className={cn(adminInsetPanelClassName, "mt-5 p-4")}>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
            <SelectField label="Year" onChange={(value) => updateFilter("year", value)} options={filterOptions.years} value={filters.year} />
            <SelectField
              label="Quarter"
              onChange={(value) => updateFilter("quarter", value)}
              options={[
                { label: "Q1", value: "1" },
                { label: "Q2", value: "2" },
                { label: "Q3", value: "3" },
                { label: "Q4", value: "4" },
              ]}
              value={filters.quarter}
            />
            <SelectField label="Line" onChange={(value) => updateFilter("lineId", value)} options={filterOptions.lines} value={filters.lineId} />
            <SelectField label="Area" onChange={(value) => updateFilter("areaId", value)} options={filterOptions.areas} value={filters.areaId} />
            <SelectField label="Team" onChange={(value) => updateFilter("teamId", value)} options={filterOptions.teams} value={filters.teamId} />
            <SelectField label="Medical Rep" onChange={(value) => updateFilter("medicalRepHrId", value)} options={filterOptions.medicalReps} value={filters.medicalRepHrId} />
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[#0F172A] px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_40px_rgba(15,23,42,0.16)] transition hover:bg-[#F97316] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isLoading}
              onClick={applyFilters}
              type="button"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Apply Filters
            </button>
            <button
              className="inline-flex items-center justify-center gap-2 rounded-full border border-[#CBD5E1] bg-white px-5 py-2.5 text-sm font-black text-[#0F172A] shadow-sm transition hover:border-[#F97316]/50 hover:text-[#F97316] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isLoading}
              onClick={resetFilters}
              type="button"
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </button>
          </div>
        </div>
      </Card>

      {data.reports.length === 0 ? (
        <Card className={cn(adminPanelClassName, "p-6")}>
          <div className="rounded-lg border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-md bg-white text-[#F97316] shadow-sm ring-1 ring-[#E2E8F0]">
              <BarChart3 className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-xl font-black tracking-[-0.03em] text-[#0F172A]">
              No coaching analytics are available yet.
            </h3>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[#64748B]">
              Analytics will appear after coaching reports are submitted and scored.
            </p>
            {canCreate ? (
              <Link
                className="mt-5 inline-flex items-center justify-center gap-2 rounded-full bg-[#F97316] px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-[#EA580C]"
                href={createHref}
              >
                <Plus className="h-4 w-4" />
                Create Coaching Report
              </Link>
            ) : null}
          </div>
        </Card>
      ) : null}

      {data.reports.length > 0 ? (
        <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard helper="All coaching reports in the current scope." icon={<BarChart3 className="h-5 w-5" />} label="Total Coaching Reports" value={formatNumber(data.reports.length)} />
        <KpiCard helper="Average score across submitted, reviewed, and locked reports." icon={<Award className="h-5 w-5" />} label="Average Coaching Score" value={formatPercent(data.analytics.averageScore)} />
        <KpiCard helper="Share of completed reports acknowledged by employees." icon={<CheckCircle2 className="h-5 w-5" />} label="Acknowledgment Rate" value={formatPercent(acknowledgmentRate)} />
        <KpiCard helper={mostImproved ? `${mostImproved.hrId} improved by ${formatPercent(mostImproved.improvementScore)}` : "No positive improvement trend yet."} icon={<TrendingUp className="h-5 w-5" />} label="Most Improved Medical Rep" value={mostImproved?.medicalRep ?? "Not available"} />
        <KpiCard helper="Reports in Red Zone / Below Expectations." icon={<Filter className="h-5 w-5" />} label="Red Zone Count" value={formatNumber(redZoneCount)} />
        <KpiCard helper="Reports in Yellow Zone / Needs Improvement." icon={<Filter className="h-5 w-5" />} label="Yellow Zone Count" value={formatNumber(yellowZoneCount)} />
        <KpiCard helper="Reports in Green Zone / Meets Expectations." icon={<Filter className="h-5 w-5" />} label="Green Zone Count" value={formatNumber(greenZoneCount)} />
        <KpiCard helper="Reports in Excellence Zone / Exceeds Expectations." icon={<Filter className="h-5 w-5" />} label="Excellence Zone Count" value={formatNumber(excellenceZoneCount)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <ChartPanel description="Distribution of completed reports by performance zone." title="Reports by Performance Zone">
          {zoneData.length ? (
            <DonutChart caption="reports" items={zoneData} />
          ) : <EmptyChart message="No scored reports available for this view." />}
        </ChartPanel>

        <ChartPanel description="Quarterly average coaching score across employee summaries." title="Average Score by Quarter">
          {quarterTrend.length ? (
            <SafeResponsiveContainer className="h-full">
              <AreaChart data={quarterTrend} margin={{ bottom: 0, left: -18, right: 14, top: 12 }}>
                <defs>
                  <linearGradient id="coachingTrendFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#F97316" stopOpacity={0.26} />
                    <stop offset="100%" stopColor="#F97316" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="4 8" vertical={false} />
                <XAxis axisLine={false} dataKey="label" tick={{ fill: CHART_AXIS, fontSize: 11, fontWeight: 700 }} tickLine={false} tickMargin={8} />
                <YAxis axisLine={false} domain={[0, 100]} tick={{ fill: CHART_AXIS, fontSize: 10, fontWeight: 600 }} tickLine={false} width={42} />
                <Tooltip content={<ChartTooltip suffix="%" />} cursor={{ stroke: "#F97316", strokeDasharray: "4 4", strokeWidth: 1 }} />
                <Area
                  activeDot={{ fill: "#FFFFFF", r: 6, stroke: "#F97316", strokeWidth: 3 }}
                  animationDuration={650}
                  dataKey="value"
                  dot={{ fill: "#FFFFFF", r: 4, stroke: "#F97316", strokeWidth: 2 }}
                  fill="url(#coachingTrendFill)"
                  stroke="#F97316"
                  strokeWidth={2.5}
                  type="monotone"
                />
              </AreaChart>
            </SafeResponsiveContainer>
          ) : <EmptyChart message="No quarterly trend is available yet." />}
        </ChartPanel>

        <ChartPanel description="Average coaching score grouped by line (bars coloured by performance zone)." title="Average Score by Line">
          {lineAverages.length ? (
            <BarList data={lineAverages} mode="score" />
          ) : <EmptyChart message="No line score data available." />}
        </ChartPanel>

        <ChartPanel description="Average coaching score grouped by area (bars coloured by performance zone)." title="Average Score by Area">
          {areaAverages.length ? (
            <BarList data={areaAverages} mode="score" />
          ) : <EmptyChart message="No area score data available." />}
        </ChartPanel>

        <ChartPanel description="Employee acknowledgment split for completed coaching reports." title="Acknowledgment Status Split">
          {acknowledgmentSplit.length ? (
            <DonutChart caption="reports" items={acknowledgmentSplit} />
          ) : <EmptyChart message="No acknowledgment data available." />}
        </ChartPanel>

        <ChartPanel description="Most frequent strongest scoring parameter across completed reports." title="Strongest Parameters Distribution">
          {strongestParameterData.length ? (
            <BarList accent="orange" data={strongestParameterData} mode="count" />
          ) : <EmptyChart message="Strongest parameter distribution will appear after scored coaching reports are submitted." />}
        </ChartPanel>

        <ChartPanel description="Most frequent priority development focus by report-level category averages." title="Top Development Areas">
          {keyDevelopmentAreaData.length ? (
            <BarList accent="slate" data={keyDevelopmentAreaData} mode="count" />
          ) : <EmptyChart message="Priority Development Focus analytics will appear after scored coaching reports are submitted." />}
        </ChartPanel>
      </div>

      <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
        <AdminSectionHeader
          title="Per-Rep Coaching Intelligence"
          description="One row per medical rep across their full coaching history — first vs latest score, improvement trend, and appraisal-support summary."
          action={<UsersRound className="h-5 w-5 text-[#F97316]" />}
        />
        <table className="w-full table-fixed border-collapse text-left">
          <colgroup>
            <col style={{ width: "26%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "11%" }} />
          </colgroup>
          <thead className="text-[11px] font-black uppercase tracking-[0.12em]">
            <tr>
              <th className="px-4 py-3 text-left">Medical Rep</th>
              <th className="px-3 py-3">Sessions</th>
              <th className="px-3 py-3">Avg</th>
              <th className="px-3 py-3">First</th>
              <th className="px-3 py-3">Latest</th>
              <th className="px-3 py-3">Trend</th>
              <th className="px-3 py-3">Zone</th>
              <th className="px-3 py-3">Last Coached</th>
            </tr>
          </thead>
          <tbody>
            {repRows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-sm font-semibold text-[#64748B]" colSpan={8}>
                  No quarterly intelligence rows are available for the current filters.
                </td>
              </tr>
            ) : repRows.map((row) => (
              <tr className="bg-white text-sm hover:bg-[#FFFBF7]" key={`${row.hrId}-${row.lastCoachingDate ?? "none"}`}>
                <td className="px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate font-black text-[#0F172A]" title={row.medicalRep}>{row.medicalRep}</p>
                    <p className="truncate font-mono text-[11px] font-bold text-[#94A3B8]">{row.hrId}</p>
                  </div>
                </td>
                <td className="px-3 py-3.5 text-center font-bold tabular-nums text-[#475569]">{formatNumber(row.coachingCount)}</td>
                <td className="px-3 py-3.5 text-center font-black tabular-nums text-[#0F172A]">{formatPercent(row.averageScore)}</td>
                <td className="px-3 py-3.5 text-center tabular-nums text-[#64748B]">{formatPercent(row.firstScore)}</td>
                <td className="px-3 py-3.5 text-center tabular-nums text-[#0F172A]">{formatPercent(row.latestScore)}</td>
                <td className="px-3 py-3.5 text-center">
                  <span
                    className={cn(
                      "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-black tabular-nums",
                      row.improvementScore > 0
                        ? "bg-emerald-50 text-emerald-700"
                        : row.improvementScore < 0
                          ? "bg-rose-50 text-rose-700"
                          : "bg-slate-100 text-slate-500",
                    )}
                  >
                    {row.improvementScore > 0 ? <TrendingUp className="h-3 w-3" /> : row.improvementScore < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                    {row.improvementScore > 0 ? "+" : ""}{formatPercent(row.improvementScore)}
                  </span>
                </td>
                <td className="px-3 py-3.5 text-center">
                  <span className={cn("inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-black", zoneClassName(row.latestZone))} title={zoneLabel(row.latestZone)}>
                    {zoneShortLabel(row.latestZone)}
                  </span>
                </td>
                <td className="px-3 py-3.5 text-center whitespace-nowrap text-[13px] text-[#475569]">{formatDate(row.lastCoachingDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
        </>
      ) : null}
    </div>
  );
}
