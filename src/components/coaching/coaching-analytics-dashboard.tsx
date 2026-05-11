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
  TrendingUp,
  UsersRound,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AdminSectionHeader,
  adminInsetPanelClassName,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
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

function zoneClassName(zone: string | null | undefined) {
  if (zone === "critical_red" || zone === "red_zone") return "border-rose-200 bg-rose-50 text-rose-700";
  if (zone === "yellow_zone") return "border-orange-200 bg-orange-50 text-orange-700";
  if (zone === "green_zone") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (zone === "excellence_zone") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function completedReports(data: CoachingAnalyticsPayload) {
  return data.reports.filter((report) => completedStatuses.has(report.status));
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
      <select
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
      </select>
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
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#FFF7ED] text-[#F97316]">
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
    <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
      <AdminSectionHeader description={description} title={title} />
      <div className="h-[320px] p-4">{children}</div>
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

function buildZoneData(data: CoachingAnalyticsPayload) {
  const counts = data.analytics.zoneCounts;
  return [
    { key: "red_zone", label: "Red Zone", value: (counts.critical_red ?? 0) + (counts.red_zone ?? 0) },
    { key: "yellow_zone", label: "Yellow Zone", value: counts.yellow_zone ?? 0 },
    { key: "green_zone", label: "Green Zone", value: counts.green_zone ?? 0 },
    { key: "excellence_zone", label: "Excellence Zone", value: counts.excellence_zone ?? 0 },
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
    { key: "acknowledged", label: "Acknowledged", value: acknowledged },
    { key: "pending", label: "Pending", value: pending },
  ].filter((row) => row.value > 0);
}

function buildParameterDistributionData(rows: CoachingParameterDistributionRow[]) {
  return rows.map((row) => ({
    label: row.parameterLabel,
    percent: row.percent,
    value: row.count,
  }));
}

function buildRepRows(data: CoachingAnalyticsPayload) {
  const reportByHrId = new Map<string, CoachingReportSummaryRow[]>();
  for (const report of data.reports) {
    reportByHrId.set(report.medicalRepHrId, [...(reportByHrId.get(report.medicalRepHrId) ?? []), report]);
  }

  return data.quarterlySummary.map((row) => {
    const reports = (reportByHrId.get(row.medicalRepHrId) ?? [])
      .sort((left, right) => right.coachingDate.localeCompare(left.coachingDate));
    const latestReport = reports[0] ?? null;

    return {
      averageScore: row.averageScore,
      coachingCount: row.coachingCount,
      firstScore: row.firstScore,
      hrId: row.medicalRepHrId,
      improvementScore: row.improvementScore,
      keyDevelopmentArea: "Not available",
      lastCoachingDate: latestReport?.coachingDate ?? null,
      latestScore: row.latestScore,
      latestZone: row.latestZone,
      medicalRep: latestReport?.medicalRepName || row.medicalRepHrId,
      strongestParameter: "Not available",
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
          <div className="rounded-[28px] border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-[#F97316] shadow-sm ring-1 ring-[#E2E8F0]">
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
                href="/coaching/new"
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
        <KpiCard helper="All coaching reports in the current scope." icon={<ClipboardIcon />} label="Total Coaching Reports" value={formatNumber(data.reports.length)} />
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
            <ResponsiveContainer height="100%" width="100%">
              <PieChart>
                <Pie data={zoneData} dataKey="value" innerRadius={65} outerRadius={105} paddingAngle={3}>
                  {zoneData.map((entry) => <Cell fill={zoneColors[entry.key]} key={entry.key} />)}
                </Pie>
                <Tooltip formatter={(value) => [value, "Reports"]} />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptyChart message="No scored reports available for this view." />}
        </ChartPanel>

        <ChartPanel description="Quarterly average coaching score by employee summary rows." title="Average Score by Quarter">
          {quarterTrend.length ? (
            <ResponsiveContainer height="100%" width="100%">
              <LineChart data={quarterTrend}>
                <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" />
                <XAxis dataKey="label" stroke="#64748B" tickLine={false} />
                <YAxis domain={[0, 100]} stroke="#64748B" tickLine={false} />
                <Tooltip formatter={(value) => [`${value}%`, "Average score"]} />
                <Line dataKey="value" dot={{ fill: "#F97316", r: 4 }} stroke="#F97316" strokeWidth={3} type="monotone" />
              </LineChart>
            </ResponsiveContainer>
          ) : <EmptyChart message="No quarterly trend is available yet." />}
        </ChartPanel>

        <ChartPanel description="Average coaching score grouped by line." title="Average Score by Line">
          {lineAverages.length ? (
            <ResponsiveContainer height="100%" width="100%">
              <BarChart data={lineAverages}>
                <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" />
                <XAxis dataKey="label" stroke="#64748B" tickLine={false} />
                <YAxis domain={[0, 100]} stroke="#64748B" tickLine={false} />
                <Tooltip formatter={(value) => [`${value}%`, "Average score"]} />
                <Bar dataKey="value" fill="#F97316" radius={[12, 12, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyChart message="No line score data available." />}
        </ChartPanel>

        <ChartPanel description="Average coaching score grouped by area." title="Average Score by Area">
          {areaAverages.length ? (
            <ResponsiveContainer height="100%" width="100%">
              <BarChart data={areaAverages} layout="vertical" margin={{ left: 24, right: 16 }}>
                <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" />
                <XAxis domain={[0, 100]} stroke="#64748B" tickLine={false} type="number" />
                <YAxis dataKey="label" stroke="#64748B" tickLine={false} type="category" width={110} />
                <Tooltip formatter={(value) => [`${value}%`, "Average score"]} />
                <Bar dataKey="value" fill="#0F172A" radius={[0, 12, 12, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyChart message="No area score data available." />}
        </ChartPanel>

        <ChartPanel description="Employee acknowledgment split for completed coaching reports." title="Acknowledgment Status Split">
          {acknowledgmentSplit.length ? (
            <ResponsiveContainer height="100%" width="100%">
              <PieChart>
                <Pie data={acknowledgmentSplit} dataKey="value" innerRadius={65} outerRadius={105} paddingAngle={3}>
                  {acknowledgmentSplit.map((entry) => <Cell fill={entry.key === "acknowledged" ? "#10B981" : "#CBD5E1"} key={entry.key} />)}
                </Pie>
                <Tooltip formatter={(value) => [value, "Reports"]} />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptyChart message="No acknowledgment data available." />}
        </ChartPanel>

        <ChartPanel description="Most frequent strongest scoring parameter across completed reports." title="Strongest Parameters Distribution">
          {strongestParameterData.length ? (
            <ResponsiveContainer height="100%" width="100%">
              <BarChart data={strongestParameterData} layout="vertical" margin={{ left: 24, right: 16 }}>
                <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" />
                <XAxis allowDecimals={false} stroke="#64748B" tickLine={false} type="number" />
                <YAxis dataKey="label" stroke="#64748B" tickLine={false} type="category" width={155} />
                <Tooltip formatter={(value) => [`${value} reports`, "Reports"]} />
                <Bar dataKey="value" fill="#F97316" radius={[0, 12, 12, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyChart message="Strongest parameter distribution will appear after scored coaching reports are submitted." />}
        </ChartPanel>

        <ChartPanel description="Most frequent priority development focus by report-level category averages." title="Top Development Areas">
          {keyDevelopmentAreaData.length ? (
            <ResponsiveContainer height="100%" width="100%">
              <BarChart data={keyDevelopmentAreaData} layout="vertical" margin={{ left: 24, right: 16 }}>
                <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" />
                <XAxis allowDecimals={false} stroke="#64748B" tickLine={false} type="number" />
                <YAxis dataKey="label" stroke="#64748B" tickLine={false} type="category" width={155} />
                <Tooltip formatter={(value) => [`${value} reports`, "Reports"]} />
                <Bar dataKey="value" fill="#0F172A" radius={[0, 12, 12, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyChart message="Priority Development Focus analytics will appear after scored coaching reports are submitted." />}
        </ChartPanel>
      </div>

      <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
        <AdminSectionHeader
          title="Quarterly Intelligence"
          description="Per Medical Rep improvement trend and appraisal-support summary."
          action={<UsersRound className="h-5 w-5 text-[#F97316]" />}
        />
        <div className="overflow-x-auto">
          <table className="min-w-[1180px] w-full border-collapse text-left">
            <thead className="bg-[#F8FAFC]">
              <tr className="border-b border-[#E2E8F0] text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                <th className="px-5 py-3">Medical Rep</th>
                <th className="px-5 py-3">HR ID</th>
                <th className="px-5 py-3">Coaching Count</th>
                <th className="px-5 py-3">Average Score</th>
                <th className="px-5 py-3">First Score</th>
                <th className="px-5 py-3">Latest Score</th>
                <th className="px-5 py-3">Improvement Trend</th>
                <th className="px-5 py-3">Latest Zone</th>
                <th className="px-5 py-3">Strongest Parameter</th>
                <th className="px-5 py-3">Key Development Area</th>
                <th className="px-5 py-3">Last Coaching Date</th>
              </tr>
            </thead>
            <tbody>
              {repRows.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-center text-sm font-semibold text-[#64748B]" colSpan={11}>
                    No quarterly intelligence rows are available for the current filters.
                  </td>
                </tr>
              ) : repRows.map((row) => (
                <tr className="border-b border-[#E2E8F0] bg-white text-sm last:border-b-0 hover:bg-[#FFFBF7]" key={`${row.hrId}-${row.lastCoachingDate ?? "none"}`}>
                  <td className="px-5 py-4 font-black text-[#0F172A]">{row.medicalRep}</td>
                  <td className="px-5 py-4 font-mono text-xs font-black text-[#475569]">{row.hrId}</td>
                  <td className="px-5 py-4 font-semibold text-[#475569]">{formatNumber(row.coachingCount)}</td>
                  <td className="px-5 py-4 font-black text-[#0F172A]">{formatPercent(row.averageScore)}</td>
                  <td className="px-5 py-4 text-[#475569]">{formatPercent(row.firstScore)}</td>
                  <td className="px-5 py-4 text-[#475569]">{formatPercent(row.latestScore)}</td>
                  <td className={cn("px-5 py-4 font-black", row.improvementScore >= 0 ? "text-emerald-700" : "text-rose-700")}>
                    {row.improvementScore >= 0 ? "+" : ""}{formatPercent(row.improvementScore)}
                  </td>
                  <td className="px-5 py-4">
                    <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-[11px] font-black", zoneClassName(row.latestZone))}>
                      {zoneLabel(row.latestZone)}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-[#475569]">{row.strongestParameter}</td>
                  <td className="px-5 py-4 text-[#475569]">{row.keyDevelopmentArea}</td>
                  <td className="px-5 py-4 text-[#475569]">{formatDate(row.lastCoachingDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
        </>
      ) : null}
    </div>
  );
}

function ClipboardIcon() {
  return <BarChart3 className="h-5 w-5" />;
}
