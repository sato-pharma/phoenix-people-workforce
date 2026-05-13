import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FileText,
  LineChart,
  Target,
  TrendingUp,
  UsersRound,
} from "lucide-react";

import type {
  CoachingPerformanceZone,
  CoachingQuarterlySummaryRow,
  CoachingReportSummaryRow,
  CoachingScoreAnalytics,
} from "@/lib/coaching/types";
import { cn } from "@/lib/utils";

const completedStatuses = new Set(["submitted", "reviewed_by_employee", "locked"]);

const zoneLabels: Record<CoachingPerformanceZone, string> = {
  critical_red: "Critical",
  excellence_zone: "Excellence",
  green_zone: "Meets",
  red_zone: "Below",
  yellow_zone: "Needs Work",
};

const zoneClassNames: Record<string, string> = {
  critical_red: "border-rose-200 bg-rose-50 text-rose-700",
  excellence_zone: "border-amber-200 bg-amber-50 text-amber-800",
  green_zone: "border-emerald-200 bg-emerald-50 text-emerald-700",
  red_zone: "border-rose-200 bg-rose-50 text-rose-700",
  yellow_zone: "border-orange-200 bg-orange-50 text-orange-700",
};

function formatNumber(value: number | null | undefined, digits = 0) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return digits > 0 ? "0.0" : "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(number);
}

function formatPercent(value: number | null | undefined) {
  return `${formatNumber(value, 1)}%`;
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

function statusLabel(value: string | null | undefined) {
  return String(value ?? "unknown")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function zoneLabel(zone: string | null | undefined) {
  if (!zone || !(zone in zoneLabels)) return "Not Scored";
  return zoneLabels[zone as CoachingPerformanceZone];
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metricDelta(current: number, previous: number | null) {
  if (previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function summarizeReports(reports: CoachingReportSummaryRow[]) {
  const completed = reports.filter((report) => completedStatuses.has(report.status));
  const scores = completed.map((report) => report.finalScorePercent).filter(Number.isFinite);
  const latest = reports[0] ?? null;
  const uniqueRepCount = new Set(reports.map((report) => report.medicalRepHrId.toLowerCase())).size;
  const currentMonth = latest ? latest.coachingMonth : null;
  const previousMonth = currentMonth ? currentMonth - 1 : null;
  const currentMonthScores = completed
    .filter((report) => report.coachingMonth === currentMonth)
    .map((report) => report.finalScorePercent);
  const previousMonthScores = completed
    .filter((report) => report.coachingMonth === previousMonth)
    .map((report) => report.finalScorePercent);

  return {
    averageScore: average(scores),
    completedCount: completed.length,
    draftCount: reports.filter((report) => report.status === "draft").length,
    latest,
    pendingAcknowledgmentCount: reports.filter((report) => report.status === "submitted" && !report.acknowledged).length,
    scoreDelta: metricDelta(average(currentMonthScores), previousMonthScores.length ? average(previousMonthScores) : null),
    uniqueRepCount,
    zoneCounts: completed.reduce<Record<string, number>>((accumulator, report) => {
      const zone = report.performanceZone ?? "not_scored";
      accumulator[zone] = (accumulator[zone] ?? 0) + 1;
      return accumulator;
    }, {}),
  };
}

function MetricCard({
  icon: Icon,
  label,
  tone = "orange",
  value,
  helper,
}: {
  helper?: string;
  icon: typeof BarChart3;
  label: string;
  tone?: "emerald" | "orange" | "rose" | "sky" | "slate";
  value: string;
}) {
  const toneClassName = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    orange: "bg-orange-50 text-orange-700 ring-orange-100",
    rose: "bg-rose-50 text-rose-700 ring-rose-100",
    sky: "bg-sky-50 text-sky-700 ring-sky-100",
    slate: "bg-slate-50 text-slate-700 ring-slate-100",
  }[tone];

  return (
    <div className="rounded-[22px] border border-white/80 bg-white p-5 shadow-[0_18px_45px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
      <div className="flex items-start justify-between gap-3">
        <div className={cn("flex h-11 w-11 items-center justify-center rounded-2xl ring-1", toneClassName)}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-5 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
      {helper ? <p className="mt-2 text-sm font-semibold text-slate-500">{helper}</p> : null}
    </div>
  );
}

function SectionPanel({
  children,
  eyebrow,
  title,
}: {
  children: ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <section className="rounded-[26px] border border-white/80 bg-white/95 p-5 shadow-[0_20px_52px_rgba(15,23,42,0.08)] ring-1 ring-slate-200/70 sm:p-6">
      <div className="mb-5">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">{eyebrow}</p>
        <h2 className="mt-1 text-xl font-black text-slate-950">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function QuickLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Link
      className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
      href={href}
    >
      {label}
      <ArrowUpRight className="h-4 w-4" />
    </Link>
  );
}

export function TrainingManagerCoachingDashboard({
  quarterlySummary,
  reports,
  scoreAnalytics,
}: {
  quarterlySummary: CoachingQuarterlySummaryRow[];
  reports: CoachingReportSummaryRow[];
  scoreAnalytics: CoachingScoreAnalytics;
}) {
  const summary = summarizeReports(reports);
  const trend = [...quarterlySummary]
    .sort((left, right) => left.year - right.year || left.quarter - right.quarter)
    .slice(-6);
  const maxQuarterScore = Math.max(100, ...trend.map((row) => row.averageScore));
  const strongest = scoreAnalytics.strongestParameterDistribution[0] ?? null;
  const development = scoreAnalytics.keyDevelopmentAreaDistribution[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-white/80 bg-white/90 px-4 py-3 shadow-[0_16px_38px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/70">
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-black text-sky-700">
            Training Manager Workspace
          </span>
          <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black text-orange-700">
            {reports.length} total reports
          </span>
        </div>
        <QuickLink href="/employee-portals/training-manager/field-coaching" label="Open Field Coaching" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Target} label="Average Score" tone="orange" value={formatPercent(summary.averageScore)} helper={summary.scoreDelta === null ? "No prior month comparison" : `${summary.scoreDelta >= 0 ? "+" : ""}${formatNumber(summary.scoreDelta, 1)}% vs prior month`} />
        <MetricCard icon={ClipboardCheck} label="Completed Reports" tone="emerald" value={formatNumber(summary.completedCount)} helper={`${formatNumber(summary.draftCount)} drafts in progress`} />
        <MetricCard icon={UsersRound} label="Medical Reps Covered" tone="sky" value={formatNumber(summary.uniqueRepCount)} helper="Visible in your coaching scope" />
        <MetricCard icon={Clock3} label="Pending Acknowledgment" tone={summary.pendingAcknowledgmentCount > 0 ? "rose" : "slate"} value={formatNumber(summary.pendingAcknowledgmentCount)} helper="Submitted reports awaiting employee review" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
        <SectionPanel eyebrow="Quarterly Intelligence" title="Coaching Score Trend">
          {trend.length ? (
            <div className="grid min-h-[260px] grid-cols-6 items-end gap-3">
              {trend.map((row) => {
                const height = Math.max(8, (row.averageScore / maxQuarterScore) * 100);
                return (
                  <div className="flex h-full min-w-0 flex-col justify-end gap-2" key={`${row.year}-${row.quarter}-${row.medicalRepHrId}`}>
                    <div className="flex min-h-[190px] items-end rounded-2xl bg-slate-50 p-2">
                      <div
                        className="w-full rounded-xl bg-[linear-gradient(180deg,#F97316_0%,#0EA5E9_100%)] shadow-[0_10px_24px_rgba(14,165,233,0.18)]"
                        style={{ height: `${height}%` }}
                      />
                    </div>
                    <div className="text-center">
                      <p className="text-xs font-black text-slate-900">{formatPercent(row.averageScore)}</p>
                      <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Q{row.quarter} {row.year}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm font-semibold text-slate-500">
              No submitted coaching trend is available yet.
            </div>
          )}
        </SectionPanel>

        <SectionPanel eyebrow="Distribution" title="Performance Zones">
          <div className="space-y-3">
            {Object.entries(summary.zoneCounts).length ? (
              Object.entries(summary.zoneCounts).map(([zone, count]) => {
                const total = Math.max(1, summary.completedCount);
                return (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3" key={zone}>
                    <div className="flex items-center justify-between gap-3">
                      <span className={cn("rounded-full border px-2.5 py-1 text-xs font-black", zoneClassNames[zone] ?? "border-slate-200 bg-white text-slate-600")}>
                        {zoneLabel(zone)}
                      </span>
                      <span className="text-sm font-black text-slate-950">{count}</span>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
                      <div className="h-full rounded-full bg-orange-500" style={{ width: `${(count / total) * 100}%` }} />
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm font-semibold text-slate-500">
                Zones will appear after reports are submitted.
              </p>
            )}
          </div>
        </SectionPanel>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionPanel eyebrow="Capability Map" title="Strongest Parameters">
          <div className="space-y-3">
            {scoreAnalytics.categoryAverageScores.slice(0, 5).map((row) => (
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3" key={row.parameterKey}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-black text-slate-900">{row.parameterLabel}</span>
                  <span className="text-sm font-black text-orange-700">{formatPercent(row.averagePercent)}</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
                  <div className="h-full rounded-full bg-orange-500" style={{ width: `${Math.min(100, row.averagePercent)}%` }} />
                </div>
              </div>
            ))}
            {!scoreAnalytics.categoryAverageScores.length ? (
              <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm font-semibold text-slate-500">
                Category scores are not available yet.
              </p>
            ) : null}
          </div>
        </SectionPanel>

        <SectionPanel eyebrow="Focus" title="Development Signals">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-400">Most frequent strength</p>
              <p className="mt-3 text-xl font-black text-slate-950">{strongest?.parameterLabel ?? "Not available"}</p>
              <p className="mt-2 text-sm font-semibold text-slate-500">{strongest ? `${formatPercent(strongest.percent)} of completed reports` : "Needs submitted scores"}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-400">Primary development area</p>
              <p className="mt-3 text-xl font-black text-slate-950">{development?.parameterLabel ?? "Not available"}</p>
              <p className="mt-2 text-sm font-semibold text-slate-500">{development ? `${formatPercent(development.percent)} of completed reports` : "Needs submitted scores"}</p>
            </div>
          </div>
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-sm font-black text-slate-900">Latest coaching activity</p>
            {summary.latest ? (
              <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <p className="font-bold text-slate-400">Rep</p>
                  <p className="mt-1 font-black text-slate-900">{summary.latest.medicalRepName}</p>
                </div>
                <div>
                  <p className="font-bold text-slate-400">Date</p>
                  <p className="mt-1 font-black text-slate-900">{formatDate(summary.latest.coachingDate)}</p>
                </div>
                <div>
                  <p className="font-bold text-slate-400">Score</p>
                  <p className="mt-1 font-black text-slate-900">{formatPercent(summary.latest.finalScorePercent)}</p>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-sm font-semibold text-slate-500">No coaching reports found for this Training Manager.</p>
            )}
          </div>
        </SectionPanel>
      </div>
    </div>
  );
}

export function TrainingManagerFieldCoachingPage({
  reports,
}: {
  reports: CoachingReportSummaryRow[];
}) {
  const summary = summarizeReports(reports);
  const recentReports = reports.slice(0, 18);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard icon={FileText} label="Reports In Scope" tone="orange" value={formatNumber(reports.length)} helper="Created or visible to your coaching account" />
        <MetricCard icon={CheckCircle2} label="Submitted / Locked" tone="emerald" value={formatNumber(summary.completedCount)} helper={`${formatNumber(summary.draftCount)} drafts remain`} />
        <MetricCard icon={TrendingUp} label="Average Score" tone="sky" value={formatPercent(summary.averageScore)} helper="Completed reports only" />
      </div>

      <SectionPanel eyebrow="Field Coaching" title="Recent Coaching Reports">
        {recentReports.length ? (
          <div className="overflow-x-auto rounded-[22px] border border-slate-200 bg-white">
            <div className="min-w-[820px]">
              <div className="grid grid-cols-[1.2fr_1fr_0.8fr_0.8fr_0.8fr] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                <span>Medical Rep</span>
                <span>Context</span>
                <span>Date</span>
                <span>Score</span>
                <span>Status</span>
              </div>
              <div className="divide-y divide-slate-100">
                {recentReports.map((report) => (
                  <div className="grid grid-cols-[1.2fr_1fr_0.8fr_0.8fr_0.8fr] gap-3 px-4 py-4 text-sm" key={report.reportId}>
                    <div className="min-w-0">
                      <p className="truncate font-black text-slate-950">{report.medicalRepName}</p>
                      <p className="mt-1 truncate text-xs font-semibold text-slate-500">{report.medicalRepHrId}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-700">{report.lineName ?? "No line"}</p>
                      <p className="mt-1 truncate text-xs font-semibold text-slate-500">{report.teamName ?? report.areaName ?? "No team"}</p>
                    </div>
                    <p className="font-bold text-slate-700">{formatDate(report.coachingDate)}</p>
                    <p className="font-black text-orange-700">{formatPercent(report.finalScorePercent)}</p>
                    <div>
                      <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-xs font-black", zoneClassNames[report.performanceZone ?? ""] ?? "border-slate-200 bg-slate-50 text-slate-600")}>
                        {statusLabel(report.status)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center">
            <LineChart className="mx-auto h-8 w-8 text-slate-400" />
            <p className="mt-3 text-sm font-black text-slate-900">No field coaching reports yet</p>
            <p className="mt-1 text-sm font-semibold text-slate-500">Submitted reports for this Training Manager will appear here.</p>
          </div>
        )}
      </SectionPanel>
    </div>
  );
}
