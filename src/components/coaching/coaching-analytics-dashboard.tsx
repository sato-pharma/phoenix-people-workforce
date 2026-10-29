"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { formatDateOnly } from "@/lib/date-only";
import { Loader2, Plus, RotateCcw, Search } from "lucide-react";

import { Card } from "@/components/ui/card";
import type {
  CoachingCategoryAverageScore,
  CoachingParameterDistributionRow,
  CoachingPerformanceZone,
  CoachingQuarterlySummaryRow,
  CoachingReportSummaryRow,
  CoachingScoreItemAverageScore,
  CoachingTrainingManagerAreaComparisonRow,
  CoachingTrainingManagerComparison,
  CoachingTrainingManagerComparisonRow,
} from "@/lib/coaching/types";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";


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
  trainingManagerComparison: CoachingTrainingManagerComparison;
};

type CoachingAnalyticsDashboardProps = {
  canCreate: boolean;
  createHref?: string;
  filterOptions: CoachingAnalyticsFilterOptions;
  initialFilters?: Partial<FilterState>;
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

type AreaCoverageTableFilters = {
  area: string;
};

type MedicalRepComparisonTableFilters = {
  area: string;
  hireDate: string;
  lineTeam: string;
  rep: string;
  status: string;
};

type ApiResponse<T> = {
  data?: T;
  error?: string;
  message?: string;
};

const emptyFilters: FilterState = {
  areaId: "",
  lineId: "",
  medicalRepHrId: "",
  quarter: "",
  teamId: "",
  year: "",
};

const emptyAreaCoverageTableFilters: AreaCoverageTableFilters = {
  area: "",
};

const emptyMedicalRepComparisonTableFilters: MedicalRepComparisonTableFilters = {
  area: "",
  hireDate: "",
  lineTeam: "",
  rep: "",
  status: "",
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

// ── shared formatting + zone helpers ────────────────────────────────────────

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
  // Parse + format both in local time via the shared helper so the literal
  // date-only value never shifts a day on non-UTC clients (e.g. Cairo browsers).
  return formatDateOnly(value, "en-US", { day: "2-digit", month: "short", year: "numeric" }, "Not available");
}

function normalizeSearchText(value: string | number | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function includesSearchText(value: string | number | null | undefined, query: string) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  return normalizeSearchText(value).includes(normalizedQuery);
}

function zoneLabel(zone: string | null | undefined) {
  if (!zone || !(zone in zoneLabels)) return "Not scored";
  return zoneLabels[zone as CoachingPerformanceZone];
}

/** Colour a score (0-100) by the performance band it falls into. */
function scoreZoneColor(percent: number) {
  if (percent <= 65) return zoneColors.red_zone;
  if (percent <= 80) return zoneColors.yellow_zone;
  if (percent <= 90) return zoneColors.green_zone;
  return zoneColors.excellence_zone;
}

type ScoreBand = { className: string; label: string };

function scoreBand(percent: number): ScoreBand {
  if (percent <= 65) return { className: "border-rose-200 bg-rose-50 text-rose-700", label: "Below" };
  if (percent <= 80) return { className: "border-orange-200 bg-orange-50 text-orange-700", label: "Needs Work" };
  if (percent <= 90) return { className: "border-emerald-200 bg-emerald-50 text-emerald-700", label: "Meets" };
  return { className: "border-amber-200 bg-amber-50 text-amber-800", label: "Exceeds" };
}

function zoneBand(zone: string | null | undefined): ScoreBand {
  if (zone === "critical_red" || zone === "red_zone") return { className: "border-rose-200 bg-rose-50 text-rose-700", label: "Below" };
  if (zone === "yellow_zone") return { className: "border-orange-200 bg-orange-50 text-orange-700", label: "Needs Work" };
  if (zone === "green_zone") return { className: "border-emerald-200 bg-emerald-50 text-emerald-700", label: "Meets" };
  if (zone === "excellence_zone") return { className: "border-amber-200 bg-amber-50 text-amber-800", label: "Exceeds" };
  return { className: "border-slate-200 bg-slate-50 text-slate-600", label: "Not scored" };
}

type PortalCardAccent = "amber" | "emerald" | "orange" | "rose" | "sky" | "slate";

/** Reuse an already-computed score/zone band's label to pick the shared portal card's
 * left-border accent colour, so every mobile card below stays tied to this file's own
 * red/orange/emerald/amber scoring palette instead of a separate ad hoc colour scheme. */
function bandAccent(band: ScoreBand): PortalCardAccent {
  switch (band.label) {
    case "Below":
      return "rose";
    case "Needs Work":
      return "orange";
    case "Meets":
      return "emerald";
    case "Exceeds":
      return "amber";
    default:
      return "slate";
  }
}

function completedReports(data: CoachingAnalyticsPayload) {
  return data.reports.filter((report) => completedStatuses.has(report.status));
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// ── editorial primitives ─────────────────────────────────────────────────────

/** Section with the report's signature uppercase title + black underline rule. */
function ReportSection({
  action,
  children,
  hint,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  hint?: string;
  title: string;
}) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-b-2 border-phx-ink pb-1.5">
        <h2 className="text-phx-sm font-black uppercase tracking-[0.1em] text-phx-ink">{title}</h2>
        {hint ? <span className="text-phx-xs font-semibold text-phx-ink-faint">{hint}</span> : null}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Band({ band }: { band: ScoreBand }) {
  return (
    <span className={cn("inline-flex whitespace-nowrap border px-2 py-0.5 text-phx-xs font-black", band.className)}>
      {band.label}
    </span>
  );
}

function CoverageRateBar({ rate }: { rate: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-full min-w-[64px] bg-[#EEF2F7]">
        <div className="h-full bg-[#10B981]" style={{ width: `${Math.min(100, Math.max(0, rate))}%` }} />
      </div>
      <span className="w-12 shrink-0 whitespace-nowrap text-right text-xs font-black tabular-nums text-phx-ink">{formatPercent(rate)}</span>
    </div>
  );
}

/** Hand-rolled quarterly trend (no chart lib → no blank-canvas race). */
function QuarterTrend({ data }: { data: { label: string; value: number }[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-[150px] items-center justify-center border border-dashed border-phx-line-strong bg-phx-paper text-sm font-semibold text-phx-ink-soft">
        No quarterly trend is available yet.
      </div>
    );
  }
  const width = 300;
  const height = 132;
  const padX = 16;
  const top = 14;
  const bottom = 110;
  const values = data.map((point) => point.value);
  const min = Math.max(0, Math.floor(Math.min(...values) - 5));
  const max = Math.min(100, Math.ceil(Math.max(...values) + 5));
  const span = max - min || 1;
  const xFor = (index: number) =>
    data.length === 1 ? width / 2 : padX + (index * (width - 2 * padX)) / (data.length - 1);
  const yFor = (value: number) => bottom - ((value - min) / span) * (bottom - top);
  const points = data.map((point, index) => `${xFor(index)},${yFor(point.value)}`).join(" ");

  return (
    <div>
      <svg className="block h-[150px] w-full" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Average coaching score by quarter">
        <line stroke="#E2E8F0" strokeWidth="1" x1="0" x2={width} y1={bottom} y2={bottom} />
        <line stroke="#F1F5F9" strokeWidth="1" x1="0" x2={width} y1={(top + bottom) / 2} y2={(top + bottom) / 2} />
        <polyline fill="none" points={points} stroke="#0F172A" strokeWidth="2.5" />
        {data.map((point, index) => {
          const isLast = index === data.length - 1;
          return (
            <circle
              cx={xFor(index)}
              cy={yFor(point.value)}
              fill={isLast ? "#F97316" : "#0F172A"}
              key={point.label}
              r={isLast ? 4 : 3}
            />
          );
        })}
      </svg>
      <div className="mt-1.5 flex justify-between text-phx-xs font-bold text-phx-ink-faint">
        {data.map((point) => (
          <span className="whitespace-nowrap" key={point.label}>
            {point.label} · {formatNumber(point.value, 0)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Compact stacked performance-zone distribution bar with inline legend. */
function ZoneDistribution({ data }: { data: { color: string; key: string; label: string; value: number }[] }) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) {
    return <p className="text-sm font-semibold text-phx-ink-soft">No scored reports available for this scope.</p>;
  }
  return (
    <div className="space-y-2.5">
      <div className="flex h-3 w-full overflow-hidden border border-phx-line">
        {data.map((item) => (
          <div key={item.key} style={{ background: item.color, width: `${(item.value / total) * 100}%` }} title={`${item.label}: ${item.value}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {data.map((item) => (
          <span className="inline-flex items-center gap-1.5 text-phx-xs font-bold text-phx-ink-soft" key={item.key}>
            <span className="inline-block h-2.5 w-2.5" style={{ background: item.color }} />
            {item.label}
            <span className="font-black tabular-nums text-phx-ink">{item.value}</span>
            <span className="text-phx-ink-faint">({Math.round((item.value / total) * 100)}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function StatCell({ helper, label, value }: { helper: string; label: string; value: string }) {
  return (
    <div className="bg-white px-4 py-3.5 text-center">
      <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">{label}</p>
      <p className="mt-1.5 text-2xl font-black tracking-[-0.03em] text-phx-ink">{value}</p>
      <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">{helper}</p>
    </div>
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
      <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{label}</span>
      <SearchableSelect
        className="mt-1.5 h-9 w-full px-3"
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

/** Compact text filter that lives ABOVE a table (never inside <thead>). */
function FilterInput({
  ariaLabel,
  onChange,
  placeholder,
  value,
}: {
  ariaLabel: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <input
      aria-label={ariaLabel}
      className={`${phxFieldClassName} min-w-0`}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      type="search"
      value={value}
    />
  );
}

function FilterSelect({
  ariaLabel,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  value: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={`${phxSelectClassName} min-w-0`}
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
  );
}

function TableToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">
        <Search className="h-3.5 w-3.5" />
        Filter
      </span>
      {children}
    </div>
  );
}

/** Shared empty-state block for the responsive table/card pairs below — one node
 * replaces both the mobile card list and the desktop table together when empty. */
function TableEmptyNotice({ children }: { children: ReactNode }) {
  return (
    <div className="border border-dashed border-phx-line-strong bg-phx-paper px-3 py-7 text-center text-sm font-semibold text-phx-ink-soft">
      {children}
    </div>
  );
}

// ── data builders ────────────────────────────────────────────────────────────

function buildZoneData(data: CoachingAnalyticsPayload) {
  const counts = data.analytics.zoneCounts;
  return [
    { color: zoneColors.red_zone, key: "red_zone", label: "Below", value: (counts.critical_red ?? 0) + (counts.red_zone ?? 0) },
    { color: zoneColors.yellow_zone, key: "yellow_zone", label: "Needs Work", value: counts.yellow_zone ?? 0 },
    { color: zoneColors.green_zone, key: "green_zone", label: "Meets", value: counts.green_zone ?? 0 },
    { color: zoneColors.excellence_zone, key: "excellence_zone", label: "Exceeds", value: counts.excellence_zone ?? 0 },
  ].filter((row) => row.value > 0);
}

// The quarterly summary holds one row PER medical rep per quarter, so aggregate
// by (year, quarter) into a single averaged point — otherwise the trend plots
// dozens of overlapping points that share a quarter label (and duplicate keys).
function buildQuarterTrend(rows: CoachingQuarterlySummaryRow[]) {
  const buckets = new Map<string, { quarter: number; values: number[]; year: number }>();
  for (const row of rows) {
    const key = `${row.year}-${row.quarter}`;
    const bucket = buckets.get(key) ?? { quarter: row.quarter, values: [], year: row.year };
    bucket.values.push(row.averageScore);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((left, right) => left.year * 10 + left.quarter - (right.year * 10 + right.quarter))
    .map((bucket) => ({
      label: `Q${bucket.quarter} ${bucket.year}`,
      value: Number(average(bucket.values).toFixed(1)),
    }));
}

function buildCategoryAverages(rows: CoachingCategoryAverageScore[]) {
  return [...rows]
    .map((row) => ({
      label: row.parameterLabel,
      reportCount: row.reportCount,
      value: Number(row.averagePercent.toFixed(1)),
    }))
    .sort((left, right) => right.value - left.value);
}

function coverageStatusLabel(status: "coached" | "not_coached") {
  return status === "coached" ? "Coached" : "Not coached";
}

function coverageStatusClassName(status: "coached" | "not_coached") {
  return status === "coached"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-orange-200 bg-orange-50 text-orange-700";
}

function medicalRepComparisonRowMatchesFilters(
  row: CoachingTrainingManagerComparisonRow,
  filters: MedicalRepComparisonTableFilters,
) {
  const hireDateSearchValue = `${row.hireDate ?? ""} ${formatDate(row.hireDate)}`;
  const lineTeamSearchValue = `${row.lineName ?? "Not assigned"} ${row.teamName ?? "No team"}`;
  return (
    includesSearchText(`${row.medicalRepName} ${row.hrId}`, filters.rep) &&
    (!filters.status || row.status === filters.status) &&
    includesSearchText(hireDateSearchValue, filters.hireDate) &&
    includesSearchText(row.areaName || "Not assigned", filters.area) &&
    includesSearchText(lineTeamSearchValue, filters.lineTeam)
  );
}

// One row per medical rep, aggregated across that rep's FULL coaching history
// (not per quarter). Improvement is the rep's first-ever score vs. their latest.
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
      areaName: latest.areaName,
      averageScore: Number(average(scores).toFixed(1)),
      coachingCount: ordered.length,
      firstScore: first.finalScorePercent,
      hrId,
      improvementScore: Number((latest.finalScorePercent - first.finalScorePercent).toFixed(1)),
      lastCoachingDate: latest.coachingDate ?? null,
      latestReportId: latest.reportId,
      latestScore: latest.finalScorePercent,
      latestZone: latest.performanceZone,
      lineName: latest.lineName,
      medicalRep: latest.medicalRepName || hrId,
    };
  }).sort((left, right) => right.improvementScore - left.improvementScore);
}

// ── responsive card renderers (mobile equivalents of the report tables) ──────

function AreaCoverageCard({ row }: { row: CoachingTrainingManagerAreaComparisonRow }) {
  return (
    <PortalRecordCard accent="sky" meta={`${formatNumber(row.totalReps)} reps in area`} title={row.areaName || "Not assigned"}>
      <div className="space-y-3">
        <CoverageRateBar rate={row.coachedRate} />
        <PortalRecordFields
          fields={[
            { label: "Coached", value: <span className="font-black text-emerald-700">{formatNumber(row.coachedCount)}</span> },
            { label: "Not Coached", value: <span className="font-black text-orange-700">{formatNumber(row.uncoachedCount)}</span> },
          ]}
        />
      </div>
    </PortalRecordCard>
  );
}

function RepComparisonCard({ row }: { row: CoachingTrainingManagerComparisonRow }) {
  return (
    <PortalRecordCard
      accent={row.status === "coached" ? "emerald" : "orange"}
      status={
        <span className={cn("inline-flex whitespace-nowrap border px-2 py-0.5 text-phx-xs font-black", coverageStatusClassName(row.status))}>
          {coverageStatusLabel(row.status)}
        </span>
      }
      title={row.medicalRepName}
    >
      <PortalRecordFields
        fields={[
          { label: "Hiring Date", value: formatDate(row.hireDate) },
          { label: "Area", value: row.areaName || "Not assigned" },
          { label: "Line", value: row.lineName || "Not assigned" },
          { label: "Team", value: row.teamName || "No team" },
        ]}
      />
    </PortalRecordCard>
  );
}

type CategoryAverageRow = ReturnType<typeof buildCategoryAverages>[number];

function SkillIndexCard({ row }: { row: CategoryAverageRow }) {
  const band = scoreBand(row.value);
  return (
    <PortalRecordCard accent={bandAccent(band)} meta={`${formatNumber(row.reportCount)} reports`} status={<Band band={band} />} title={row.label}>
      <div className="flex items-center gap-2">
        <div className="h-2 w-full bg-[#EEF2F7]">
          <div className="h-full" style={{ background: scoreZoneColor(row.value), width: `${Math.min(100, row.value)}%` }} />
        </div>
        <span className="shrink-0 whitespace-nowrap text-right text-sm font-black tabular-nums text-phx-ink">{formatPercent(row.value)}</span>
      </div>
    </PortalRecordCard>
  );
}

function ParameterDetailCard({ row }: { row: CoachingScoreItemAverageScore }) {
  const band = scoreBand(row.averagePercent);
  return (
    <PortalRecordCard accent={bandAccent(band)} meta={row.parameterLabel} status={<Band band={band} />} title={row.scoreItemLabel}>
      <PortalRecordFields
        fields={[
          { label: "Reports", value: formatNumber(row.reportCount) },
          { label: "Avg Score", value: formatPercent(row.averagePercent) },
        ]}
      />
    </PortalRecordCard>
  );
}

type RepRow = ReturnType<typeof buildRepRows>[number];

function RepDetailCard({ coachingReportBase, row }: { coachingReportBase: string; row: RepRow }) {
  const band = zoneBand(row.latestZone);
  const trendUp = row.improvementScore > 0;
  const trendDown = row.improvementScore < 0;
  return (
    <PortalRecordCard
      accent={bandAccent(band)}
      actions={
        <Link
          className="inline-flex w-full items-center justify-center gap-1.5 border border-phx-line-strong bg-white px-3 py-2 text-xs font-black text-phx-ink transition hover:border-phx-accent/60 hover:text-phx-accent"
          href={`${coachingReportBase}/${row.latestReportId}`}
        >
          View Latest Report
        </Link>
      }
      status={
        <span title={zoneLabel(row.latestZone)}>
          <Band band={band} />
        </span>
      }
      title={row.medicalRep}
    >
      <PortalRecordFields
        fields={[
          { label: "Area", value: row.areaName || "Not assigned" },
          { label: "Line", value: row.lineName || "Not assigned" },
          { label: "Sessions", value: formatNumber(row.coachingCount) },
          { label: "Last Coached", value: formatDate(row.lastCoachingDate) },
          { label: "First Score", value: formatPercent(row.firstScore) },
          { label: "Avg Score", value: formatPercent(row.averageScore) },
          { label: "Latest Score", value: formatPercent(row.latestScore) },
          {
            label: "Trend",
            value: (
              <span className={cn("font-black tabular-nums", trendUp ? "text-emerald-700" : trendDown ? "text-rose-700" : "text-slate-400")}>
                {trendUp ? "▲ +" : trendDown ? "▼ " : ""}
                {formatNumber(row.improvementScore, 1)}
              </span>
            ),
          },
        ]}
      />
    </PortalRecordCard>
  );
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

// ── coverage section (area table + rep comparison table) ─────────────────────

function CoverageTables({ comparison }: { comparison: CoachingTrainingManagerComparison }) {
  const [areaTableFilters, setAreaTableFilters] = useState<AreaCoverageTableFilters>(emptyAreaCoverageTableFilters);
  const [repTableFilters, setRepTableFilters] = useState<MedicalRepComparisonTableFilters>(emptyMedicalRepComparisonTableFilters);

  const filteredAreaBreakdown = useMemo(
    () => comparison.areaBreakdown.filter((row) => includesSearchText(row.areaName || "Not assigned", areaTableFilters.area)),
    [areaTableFilters.area, comparison.areaBreakdown],
  );
  const filteredComparisonRows = useMemo(
    () => comparison.rows.filter((row) => medicalRepComparisonRowMatchesFilters(row, repTableFilters)),
    [comparison.rows, repTableFilters],
  );

  const updateAreaTableFilter = (key: keyof AreaCoverageTableFilters, value: string) => {
    setAreaTableFilters((current) => ({ ...current, [key]: value }));
  };
  const updateRepTableFilter = (key: keyof MedicalRepComparisonTableFilters, value: string) => {
    setRepTableFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[0.85fr_1.15fr]">
      <ReportSection title="Coverage by Area" hint="highest gap first">
        <TableToolbar>
          <div className="w-full max-w-[220px]">
            <FilterInput
              ariaLabel="Filter Coverage by Area"
              onChange={(value) => updateAreaTableFilter("area", value)}
              placeholder="Search area"
              value={areaTableFilters.area}
            />
          </div>
        </TableToolbar>
        <PortalResponsiveDataList
          empty={<TableEmptyNotice>No area coverage rows match the current filter.</TableEmptyNotice>}
          getKey={(row) => `${row.areaId ?? "none"}-${row.label}`}
          items={filteredAreaBreakdown}
          renderCard={(row) => <AreaCoverageCard row={row} />}
          renderTable={() => (
            <div className="max-h-[440px] overflow-y-auto">
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[30%]" />
                    <col className="w-[12%]" />
                    <col className="w-[13%]" />
                    <col className="w-[12%]" />
                    <col className="w-[33%]" />
                  </colgroup>
                }
              >
                <thead className="sticky top-0 z-10 bg-white">
                  <tr>
                    <th className="px-3 py-2.5">Area</th>
                    <th className="px-2 py-2.5">Total</th>
                    <th className="px-2 py-2.5">Coached</th>
                    <th className="px-2 py-2.5">Not</th>
                    <th className="px-3 py-2.5">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAreaBreakdown.map((row) => (
                    <tr className="bg-white text-sm hover:bg-[#FFFBF7]" key={`${row.areaId ?? "none"}-${row.label}`}>
                      <td className="break-words px-3 py-3 font-black text-phx-ink">{row.areaName || "Not assigned"}</td>
                      <td className="px-2 py-3 text-center font-bold tabular-nums text-phx-ink-2">{formatNumber(row.totalReps)}</td>
                      <td className="px-2 py-3 text-center font-black tabular-nums text-emerald-700">{formatNumber(row.coachedCount)}</td>
                      <td className="px-2 py-3 text-center font-black tabular-nums text-orange-700">{formatNumber(row.uncoachedCount)}</td>
                      <td className="px-3 py-3"><CoverageRateBar rate={row.coachedRate} /></td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            </div>
          )}
        />
      </ReportSection>

      <ReportSection title="Medical Rep Coaching Comparison" hint="coached vs not coached yet">
        <TableToolbar>
          <div className="w-full max-w-[180px]">
            <FilterInput
              ariaLabel="Filter comparison by rep"
              onChange={(value) => updateRepTableFilter("rep", value)}
              placeholder="Name"
              value={repTableFilters.rep}
            />
          </div>
          <div className="w-full max-w-[140px]">
            <FilterSelect
              ariaLabel="Filter comparison by status"
              onChange={(value) => updateRepTableFilter("status", value)}
              options={[
                { label: "Coached", value: "coached" },
                { label: "Not coached", value: "not_coached" },
              ]}
              value={repTableFilters.status}
            />
          </div>
          <div className="w-full max-w-[140px]">
            <FilterInput
              ariaLabel="Filter comparison by area"
              onChange={(value) => updateRepTableFilter("area", value)}
              placeholder="Area"
              value={repTableFilters.area}
            />
          </div>
          <div className="w-full max-w-[160px]">
            <FilterInput
              ariaLabel="Filter comparison by line or team"
              onChange={(value) => updateRepTableFilter("lineTeam", value)}
              placeholder="Line or team"
              value={repTableFilters.lineTeam}
            />
          </div>
        </TableToolbar>
        <PortalResponsiveDataList
          empty={<TableEmptyNotice>No comparison rows match the current filter.</TableEmptyNotice>}
          getKey={(row) => row.hrId}
          items={filteredComparisonRows}
          renderCard={(row) => <RepComparisonCard row={row} />}
          renderTable={() => (
            <div className="max-h-[440px] overflow-y-auto">
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[24%]" />
                    <col className="w-[16%]" />
                    <col className="w-[18%]" />
                    <col className="w-[18%]" />
                    <col className="w-[24%]" />
                  </colgroup>
                }
              >
                <thead className="sticky top-0 z-10 bg-white">
                  <tr>
                    <th className="px-3 py-2.5">Medical Rep</th>
                    <th className="px-2 py-2.5">Status</th>
                    <th className="px-2 py-2.5">Hiring Date</th>
                    <th className="px-2 py-2.5">Area</th>
                    <th className="px-2 py-2.5">Line / Team</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredComparisonRows.map((row) => (
                    <tr className="bg-white text-sm hover:bg-[#FFFBF7]" key={row.hrId}>
                      <td className="px-3 py-3">
                        <p className="break-words font-black text-phx-ink">{row.medicalRepName}</p>
                      </td>
                      <td className="px-2 py-3 text-center">
                        <span className={cn("inline-flex  border px-2 py-0.5 text-phx-xs font-black", coverageStatusClassName(row.status))}>
                          {coverageStatusLabel(row.status)}
                        </span>
                      </td>
                      <td className="break-words px-2 py-3 text-phx-md font-semibold text-phx-ink-2">{formatDate(row.hireDate)}</td>
                      <td className="break-words px-2 py-3 font-semibold text-phx-ink">{row.areaName || "Not assigned"}</td>
                      <td className="px-2 py-3">
                        <p className="break-words font-semibold text-phx-ink">{row.lineName || "Not assigned"}</p>
                        <p className="break-words text-phx-xs font-bold text-phx-ink-faint">{row.teamName || "No team"}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            </div>
          )}
        />
      </ReportSection>
    </div>
  );
}

// ── main dashboard ───────────────────────────────────────────────────────────

export function CoachingAnalyticsDashboard({
  canCreate,
  createHref = "/coaching/new",
  filterOptions,
  initialFilters: initialFilterOverrides,
  initialData,
}: CoachingAnalyticsDashboardProps) {
  // This dashboard renders on the admin /coaching* routes AND inside the employee portal
  // (/employee-portals/coaching-analytics, /employee-portals/training-manager/coaching). A coaching
  // report detail link hardcoded to /coaching/<id> sends a portal user into the (admin) route group,
  // whose layout redirects employee-portal users to /employee-portals (the landing page). Derive the
  // detail base from the current surface so the link stays where the user already is.
  const pathname = usePathname();
  const coachingReportBase = pathname?.startsWith("/employee-portals") ? "/employee-portals/coaching" : "/coaching";
  const defaultFilters = useMemo<FilterState>(
    () => ({ ...emptyFilters, ...initialFilterOverrides }),
    [initialFilterOverrides],
  );
  const [data, setData] = useState(initialData);
  const [filters, setFilters] = useState<FilterState>(() => defaultFilters);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const completed = useMemo(() => completedReports(data), [data]);
  const zoneData = useMemo(() => buildZoneData(data), [data]);
  const quarterTrend = useMemo(() => buildQuarterTrend(data.quarterlySummary), [data.quarterlySummary]);
  const categoryAverages = useMemo(() => buildCategoryAverages(data.categoryAverageScores), [data.categoryAverageScores]);
  const scoreItemRows = useMemo(
    () => [...data.scoreItemAverageScores].sort((left, right) => right.averagePercent - left.averagePercent),
    [data.scoreItemAverageScores],
  );
  const repRows = useMemo(() => buildRepRows(data), [data]);
  const comparison = data.trainingManagerComparison;
  const acknowledgedCount = completed.filter((report) => report.acknowledged).length;
  const acknowledgmentRate = completed.length > 0 ? (acknowledgedCount / completed.length) * 100 : 0;

  // Computed narrative insight: where the coaching coverage gap is concentrated.
  const coverageInsight = useMemo(() => {
    const gaps = [...comparison.areaBreakdown]
      .filter((row) => row.uncoachedCount > 0)
      .sort((left, right) => right.uncoachedCount - left.uncoachedCount)
      .slice(0, 2);
    if (comparison.uncoachedCount === 0 || gaps.length === 0) return null;
    const names = gaps.map((row) => row.areaName || "Not assigned");
    const focus = names.length === 2 ? `${names[0]} & ${names[1]}` : names[0];
    const inFocus = gaps.reduce((sum, row) => sum + row.uncoachedCount, 0);
    return `Coverage gap concentrated in ${focus} — ${formatNumber(inFocus)} of ${formatNumber(comparison.uncoachedCount)} uncoached reps.`;
  }, [comparison.areaBreakdown, comparison.uncoachedCount]);

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
    setFilters(defaultFilters);
    setIsLoading(true);
    setError(null);
    try {
      const nextData = await fetchAnalytics(defaultFilters);
      if (nextData) setData(nextData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load coaching analytics.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-7">
      {/* Filters */}
      <Card className="border border-phx-line bg-white p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-b-2 border-phx-ink pb-1.5">
          <h2 className="text-phx-sm font-black uppercase tracking-[0.1em] text-phx-ink">Filters</h2>
          {error ? (
            <span className="border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-black text-rose-700">{error}</span>
          ) : (
            <span className="text-phx-xs font-semibold text-phx-ink-faint">Server-side coaching scope stays enforced</span>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
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
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="inline-flex items-center justify-center gap-2 bg-phx-ink px-5 py-2 text-sm font-black text-white transition hover:bg-phx-accent disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoading}
            onClick={applyFilters}
            type="button"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Apply Filters
          </button>
          <button
            className="inline-flex items-center justify-center gap-2 border border-phx-line-strong bg-white px-5 py-2 text-sm font-black text-phx-ink transition hover:border-phx-accent/60 hover:text-phx-accent disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoading}
            onClick={resetFilters}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
            Reset
          </button>
        </div>
      </Card>

      {/* Executive summary strip */}
      <ReportSection title="Executive Summary" hint={`${formatNumber(data.reports.length)} reports in scope`}>
        <div className="grid grid-cols-2 gap-px border border-phx-line bg-phx-line sm:grid-cols-3 lg:grid-cols-6">
          <StatCell helper={`${formatNumber(comparison.coachedCount)} of ${formatNumber(comparison.totalMedicalReps)} reps`} label="Coverage" value={formatPercent(comparison.coachedRate)} />
          <StatCell helper="no report yet" label="Not Coached" value={formatNumber(comparison.uncoachedCount)} />
          <StatCell helper={`of ${formatNumber(comparison.totalMedicalReps)} active`} label="Coached" value={formatNumber(comparison.coachedCount)} />
          <StatCell helper={`${formatNumber(data.analytics.coachingCount)} completed`} label="Avg Score" value={formatPercent(data.analytics.averageScore)} />
          <StatCell helper="highest in scope" label="Best Score" value={formatPercent(data.analytics.bestScore)} />
          <StatCell helper={`${formatNumber(acknowledgedCount)} of ${formatNumber(completed.length)}`} label="Ack Rate" value={formatPercent(acknowledgmentRate)} />
        </div>
        <div className="mt-4 border border-phx-line bg-white p-4">
          <p className="mb-2.5 text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">Performance Zone Distribution</p>
          <ZoneDistribution data={zoneData} />
        </div>
      </ReportSection>

      {data.reports.length === 0 ? (
        <Card className="border border-phx-line bg-white p-6">
          <div className="border border-dashed border-phx-line-strong bg-phx-paper p-8 text-center">
            <h3 className="text-xl font-black tracking-[-0.03em] text-phx-ink">No coaching analytics are available yet.</h3>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-phx-ink-soft">
              Score analytics, coverage, and per-rep development will appear here once coaching reports are submitted and scored for this scope.
            </p>
            {canCreate ? (
              <Link
                className="mt-5 inline-flex items-center justify-center gap-2 bg-phx-accent px-5 py-2 text-sm font-black text-white transition hover:bg-phx-accent-hover"
                href={createHref}
              >
                <Plus className="h-4 w-4" />
                Create Coaching Report
              </Link>
            ) : null}
          </div>
        </Card>
      ) : (
        <>
          {/* Skill index + quarterly trend */}
          <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <ReportSection title="Coaching Skill Index" hint="average score per coaching parameter">
              <PortalResponsiveDataList
                empty={<TableEmptyNotice>Parameter averages will appear after scored coaching reports are submitted.</TableEmptyNotice>}
                getKey={(row) => row.label}
                items={categoryAverages}
                renderCard={(row) => <SkillIndexCard row={row} />}
                renderTable={() => (
                  <div className="max-h-[420px] overflow-auto">
                    <PortalDesktopTable
                      cols={
                        <colgroup>
                          <col className="w-[40%]" />
                          <col className="w-[15%]" />
                          <col className="w-[30%]" />
                          <col className="w-[15%]" />
                        </colgroup>
                      }
                    >
                      <thead className="sticky top-0 z-10 bg-white">
                        <tr>
                          <th className="px-3 py-2.5">Parameter</th>
                          <th className="px-2 py-2.5">Reports</th>
                          <th className="px-2 py-2.5">Avg Score</th>
                          <th className="px-3 py-2.5">Band</th>
                        </tr>
                      </thead>
                      <tbody>
                        {categoryAverages.map((row) => (
                          <tr className="bg-white text-sm hover:bg-[#FFFBF7]" key={row.label}>
                            <td className="px-3 py-3 font-black text-phx-ink">{row.label}</td>
                            <td className="px-2 py-3 text-center font-bold tabular-nums text-phx-ink-2">{formatNumber(row.reportCount)}</td>
                            <td className="px-2 py-3">
                              <div className="flex items-center justify-center gap-2">
                                <div className="h-2 w-full min-w-[60px] max-w-[120px] bg-[#EEF2F7]">
                                  <div className="h-full" style={{ background: scoreZoneColor(row.value), width: `${Math.min(100, row.value)}%` }} />
                                </div>
                                <span className="w-12 shrink-0 whitespace-nowrap text-right font-black tabular-nums text-phx-ink">{formatPercent(row.value)}</span>
                              </div>
                            </td>
                            <td className="px-3 py-3 text-center"><Band band={scoreBand(row.value)} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </PortalDesktopTable>
                  </div>
                )}
              />
            </ReportSection>

            <ReportSection title="Average Score by Quarter" hint="completed reports">
              <div className="border border-phx-line bg-white p-4">
                <QuarterTrend data={quarterTrend} />
              </div>
              {coverageInsight ? (
                <p className="mt-3 border-l-2 border-phx-accent pl-3 text-phx-md leading-6 text-phx-ink-2">{coverageInsight}</p>
              ) : null}
            </ReportSection>
          </div>

          {/* Coverage tables */}
          <CoverageTables comparison={comparison} />

          {/* Parameter detail (granular) */}
          {scoreItemRows.length > 0 ? (
            <ReportSection title="Parameter Detail" hint="average score per individual parameter">
              <PortalResponsiveDataList
                empty={<TableEmptyNotice>Parameter detail will appear after scored coaching reports are submitted.</TableEmptyNotice>}
                getKey={(row) => row.scoreItemKey}
                items={scoreItemRows}
                renderCard={(row) => <ParameterDetailCard row={row} />}
                renderTable={() => (
                  <div className="max-h-[420px] overflow-auto">
                    <PortalDesktopTable
                      cols={
                        <colgroup>
                          <col className="w-[28%]" />
                          <col className="w-[24%]" />
                          <col className="w-[12%]" />
                          <col className="w-[16%]" />
                          <col className="w-[20%]" />
                        </colgroup>
                      }
                    >
                      <thead className="sticky top-0 z-10 bg-white">
                        <tr>
                          <th className="px-3 py-2.5">Parameter</th>
                          <th className="px-3 py-2.5">Category</th>
                          <th className="px-2 py-2.5">Reports</th>
                          <th className="px-2 py-2.5">Avg Score</th>
                          <th className="px-3 py-2.5">Band</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scoreItemRows.map((row) => (
                          <tr className="bg-white text-sm hover:bg-[#FFFBF7]" key={row.scoreItemKey}>
                            <td className="px-3 py-3 font-bold text-phx-ink">{row.scoreItemLabel}</td>
                            <td className="break-words px-3 py-3 text-phx-md font-semibold text-phx-ink-soft">{row.parameterLabel}</td>
                            <td className="px-2 py-3 text-center font-bold tabular-nums text-phx-ink-2">{formatNumber(row.reportCount)}</td>
                            <td className="px-2 py-3 text-center font-black tabular-nums text-phx-ink">{formatPercent(row.averagePercent)}</td>
                            <td className="px-3 py-3 text-center"><Band band={scoreBand(row.averagePercent)} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </PortalDesktopTable>
                  </div>
                )}
              />
            </ReportSection>
          ) : null}

          {/* Per-rep detail */}
          <ReportSection title="Per-Rep Coaching Detail" hint="open a rep to view the latest report">
            <PortalResponsiveDataList
              breakpoint="lg"
              empty={<TableEmptyNotice>No per-rep coaching rows are available for the current filters.</TableEmptyNotice>}
              getKey={(row) => `${row.hrId}-${row.lastCoachingDate ?? "none"}`}
              items={repRows}
              renderCard={(row) => <RepDetailCard coachingReportBase={coachingReportBase} row={row} />}
              renderTable={() => (
                <PortalDesktopTable
                  breakpoint="lg"
                  cols={
                    <colgroup>
                      <col className="w-[16%]" />
                      <col className="w-[12%]" />
                      <col className="w-[10%]" />
                      <col className="w-[8%]" />
                      <col className="w-[8%]" />
                      <col className="w-[8%]" />
                      <col className="w-[8%]" />
                      <col className="w-[8%]" />
                      <col className="w-[10%]" />
                      <col className="w-[12%]" />
                    </colgroup>
                  }
                >
                  <thead>
                    <tr>
                      <th className="px-3 py-2.5">Medical Rep</th>
                      <th className="px-2 py-2.5">Area</th>
                      <th className="px-2 py-2.5">Line</th>
                      <th className="px-2 py-2.5">Sessions</th>
                      <th className="px-2 py-2.5">First</th>
                      <th className="px-2 py-2.5">Avg</th>
                      <th className="px-2 py-2.5">Latest</th>
                      <th className="px-2 py-2.5">Trend</th>
                      <th className="px-3 py-2.5">Band</th>
                      <th className="px-2 py-2.5">Last Coached</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repRows.map((row) => (
                      <tr className="bg-white text-sm hover:bg-[#FFFBF7]" key={`${row.hrId}-${row.lastCoachingDate ?? "none"}`}>
                        <td className="px-3 py-3">
                          <Link
                            className="block outline-none transition hover:text-phx-accent focus-visible:ring-2 focus-visible:ring-phx-accent/30"
                            href={`${coachingReportBase}/${row.latestReportId}`}
                          >
                            <p className="break-words font-black text-phx-ink">{row.medicalRep}</p>
                          </Link>
                        </td>
                        <td className="break-words px-2 py-3 text-phx-md font-semibold text-phx-ink-2">{row.areaName || "Not assigned"}</td>
                        <td className="break-words px-2 py-3 text-phx-md font-semibold text-phx-ink-2">{row.lineName || "Not assigned"}</td>
                        <td className="px-2 py-3 text-center font-bold tabular-nums text-phx-ink-2">{formatNumber(row.coachingCount)}</td>
                        <td className="px-2 py-3 text-center tabular-nums text-phx-ink-soft">{formatPercent(row.firstScore)}</td>
                        <td className="px-2 py-3 text-center font-black tabular-nums text-phx-ink">{formatPercent(row.averageScore)}</td>
                        <td className="px-2 py-3 text-center tabular-nums text-phx-ink">{formatPercent(row.latestScore)}</td>
                        <td className="px-2 py-3 text-center">
                          <span
                            className={cn(
                              "font-black tabular-nums",
                              row.improvementScore > 0 ? "text-emerald-700" : row.improvementScore < 0 ? "text-rose-700" : "text-slate-400",
                            )}
                          >
                            {row.improvementScore > 0 ? "▲ +" : row.improvementScore < 0 ? "▼ " : ""}{formatNumber(row.improvementScore, 1)}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-center" title={zoneLabel(row.latestZone)}><Band band={zoneBand(row.latestZone)} /></td>
                        <td className="break-words px-2 py-3 text-center text-phx-md text-phx-ink-2">{formatDate(row.lastCoachingDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
          </ReportSection>
        </>
      )}
    </div>
  );
}
