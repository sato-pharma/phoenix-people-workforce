"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Component, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { formatDateOnly } from "@/lib/date-only";
import {
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  Printer,
  Search,
  WifiOff,
  X,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LineChart,
  Line,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
} from "recharts";

import type {
  CoachingPerformanceZone,
  CoachingReportStatus,
  CoachingReportSummaryRow,
} from "@/lib/coaching/types";
import { completedReportStatuses as completedStatuses } from "@/lib/coaching/analytics";
import { getCoachingScoreColor as getScoreColor } from "@/lib/coaching/landing-insights";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";
import { CSV_BOM, csvLine } from "@/lib/export/spreadsheet-safe";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { phxFieldClassName } from "@/components/ui/form-tokens";


/* ━━━━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

type EmployeeCoachingListProps = {
  mode?: "self" | "team";
  reports: CoachingReportSummaryRow[];
};

type PeriodFilter = {
  month: string;
  quarter: string;
  year: string;
};

/* ━━━━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const zoneConfig: Record<
  CoachingPerformanceZone,
  { bg: string; border: string; color: string; fill: string; label: string; text: string }
> = {
  critical_red: { bg: "bg-red-50", border: "border-red-200", color: "#b91c1c", fill: "#fca5a5", label: "Critical", text: "text-red-700" },
  red_zone: { bg: "bg-red-50", border: "border-red-200", color: "#dc2626", fill: "#fca5a5", label: "Red Zone", text: "text-red-700" },
  yellow_zone: { bg: "bg-amber-50", border: "border-amber-200", color: "#d97706", fill: "#fcd34d", label: "Yellow Zone", text: "text-amber-700" },
  green_zone: { bg: "bg-emerald-50", border: "border-emerald-200", color: "#059669", fill: "#6ee7b7", label: "Green Zone", text: "text-emerald-700" },
  excellence_zone: { bg: "bg-sky-50", border: "border-sky-200", color: "#0369a1", fill: "#7dd3fc", label: "Excellence", text: "text-sky-700" },
};

const statusLabels: Record<CoachingReportStatus, string> = {
  cancelled: "Cancelled",
  draft: "Draft",
  locked: "Locked",
  reviewed_by_employee: "Reviewed",
  submitted: "Submitted",
};

const statusColors: Record<CoachingReportStatus, string> = {
  cancelled: "bg-slate-100 text-slate-600 border-slate-200",
  draft: "bg-slate-100 text-slate-600 border-slate-200",
  locked: "bg-slate-800 text-white border-slate-700",
  reviewed_by_employee: "bg-emerald-50 text-emerald-700 border-emerald-200",
  submitted: "bg-blue-50 text-blue-700 border-blue-200",
};

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/* ━━━━━━━━━━━━━━━━━━ Utilities ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function formatDate(value: string | null | undefined) {
  // Parse + format both in local time via the shared helper so the literal
  // date-only value never shifts a day on non-UTC clients (e.g. Cairo browsers).
  return formatDateOnly(value, "en-US", { day: "2-digit", month: "short", year: "numeric" }, "—");
}

function formatPct(value: number) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/* ━━━━━━━━━━━━━━━━━━ Analytics Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function computeAnalytics(reports: CoachingReportSummaryRow[]) {
  const completed = reports.filter((r) => completedStatuses.has(r.status));
  const scores = completed.map((r) => r.finalScorePercent).filter(Number.isFinite);
  const avgScore = scores.length ? round2(scores.reduce((s, v) => s + v, 0) / scores.length) : 0;
  const bestScore = scores.length ? Math.max(...scores) : 0;
  const lowestScore = scores.length ? Math.min(...scores) : 0;

  const zoneCounts: Record<string, number> = {};
  for (const r of completed) {
    const z = r.performanceZone ?? "unclassified";
    zoneCounts[z] = (zoneCounts[z] ?? 0) + 1;
  }

  const pendingAck = completed.filter((r) => r.status === "submitted" && !r.acknowledged).length;
  const draftCount = reports.filter((r) => r.status === "draft").length;

  // Status distribution
  const statusCounts: Partial<Record<CoachingReportStatus, number>> = {};
  for (const r of reports) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  }

  return { avgScore, bestScore, completed, draftCount, lowestScore, pendingAck, scores, statusCounts, zoneCounts };
}

function buildZoneDistribution(zoneCounts: Record<string, number>, total: number) {
  const zones: CoachingPerformanceZone[] = ["critical_red", "red_zone", "yellow_zone", "green_zone", "excellence_zone"];
  return zones
    .filter((z) => (zoneCounts[z] ?? 0) > 0)
    .map((z) => ({
      count: zoneCounts[z] ?? 0,
      pct: total > 0 ? round2(((zoneCounts[z] ?? 0) / total) * 100) : 0,
      zone: z,
    }));
}

function buildScoreTrend(reports: CoachingReportSummaryRow[]) {
  const completed = reports
    .filter((r) => completedStatuses.has(r.status) && r.coachingDate)
    .sort((a, b) => a.coachingDate.localeCompare(b.coachingDate));

  if (completed.length < 2) return [];

  const monthMap = new Map<string, { scores: number[]; month: string }>();
  for (const r of completed) {
    const key = r.coachingDate.slice(0, 7);
    const entry = monthMap.get(key) ?? { scores: [], month: key };
    entry.scores.push(r.finalScorePercent);
    monthMap.set(key, entry);
  }

  return [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => {
      const avg = round2(val.scores.reduce((s, v) => s + v, 0) / val.scores.length);
      const [y, m] = key.split("-");
      const label = `${monthNames[Number(m) - 1]?.slice(0, 3)} ${y}`;
      return { avg, count: val.scores.length, label };
    });
}

/** Self-mode: per-session score progression over time */
function buildSelfScoreTrend(reports: CoachingReportSummaryRow[]) {
  const completed = reports
    .filter((r) => completedStatuses.has(r.status) && r.coachingDate)
    .sort((a, b) => a.coachingDate.localeCompare(b.coachingDate));

  if (completed.length < 2) return [];

  return completed.map((r) => ({
    avg: r.finalScorePercent,
    count: 1,
    label: formatDate(r.coachingDate),
  }));
}

function buildRepComparisonData(reports: CoachingReportSummaryRow[]) {
  const completed = reports.filter((r) => completedStatuses.has(r.status));
  const repMap = new Map<string, { name: string; scores: number[]; hrId: string }>();
  for (const r of completed) {
    const entry = repMap.get(r.medicalRepHrId) ?? {
      name: formatEmployeeDisplayName(r.medicalRepName) || r.medicalRepHrId,
      scores: [],
      hrId: r.medicalRepHrId,
    };
    entry.scores.push(r.finalScorePercent);
    repMap.set(r.medicalRepHrId, entry);
  }

  return [...repMap.values()]
    .map((rep) => ({
      avg: round2(rep.scores.reduce((s, v) => s + v, 0) / rep.scores.length),
      count: rep.scores.length,
      hrId: rep.hrId,
      name: rep.name.length > 20 ? `${rep.name.slice(0, 18)}..` : rep.name,
      fullName: rep.name,
    }))
    .sort((a, b) => b.avg - a.avg);
}

/** Build coaching parameter category avg scores from summary data for radar chart.
 * We derive approximate category data from the available fields. */
function buildParameterRadarData(reports: CoachingReportSummaryRow[]) {
  // We can only build meaningful radar if we have completed reports with scores
  const completed = reports.filter((r) => completedStatuses.has(r.status) && r.finalScorePercent > 0);
  if (completed.length === 0) return [];

  // Since we don't have per-category data in summary rows, build a score distribution radar
  // using zone performance as proxy for coaching quality dimensions
  const avgScore = round2(completed.reduce((s, r) => s + r.finalScorePercent, 0) / completed.length);
  const consistency = completed.length > 1
    ? round2(100 - (Math.max(...completed.map(r => r.finalScorePercent)) - Math.min(...completed.map(r => r.finalScorePercent))))
    : avgScore;
  const completionRate = round2((completed.length / Math.max(reports.length, 1)) * 100);
  const ackRate = round2((completed.filter(r => r.acknowledged).length / Math.max(completed.length, 1)) * 100);
  const recentTrend = (() => {
    const sorted = [...completed].sort((a, b) => b.coachingDate.localeCompare(a.coachingDate));
    if (sorted.length < 2) return avgScore;
    const recent = sorted.slice(0, Math.ceil(sorted.length / 2));
    return round2(recent.reduce((s, r) => s + r.finalScorePercent, 0) / recent.length);
  })();

  return [
    { dimension: "Avg Score", value: avgScore, fullMark: 100 },
    { dimension: "Consistency", value: Math.max(0, consistency), fullMark: 100 },
    { dimension: "Completion", value: completionRate, fullMark: 100 },
    { dimension: "Acknowledgment", value: ackRate, fullMark: 100 },
    { dimension: "Recent Trend", value: recentTrend, fullMark: 100 },
  ];
}

/* ━━━━━━━━━━━━━━━━━━ CSV Export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function exportCSV(reports: CoachingReportSummaryRow[], isTeamMode: boolean) {
  const headers = [
    "Report Number",
    ...(isTeamMode ? ["Medical Rep", "HR ID"] : []),
    "Coaching Date",
    "Coach",
    "Score %",
    "Zone",
    "Status",
    "Acknowledged",
    ...(isTeamMode ? ["Team", "Area"] : []),
  ];

  const rows = reports.map((r) => [
    r.reportNumber,
    ...(isTeamMode ? [formatEmployeeDisplayName(r.medicalRepName), r.medicalRepHrId] : []),
    r.coachingDate?.slice(0, 10) ?? "",
    r.coachName ?? "",
    r.finalScorePercent.toFixed(1),
    r.performanceZone ? zoneConfig[r.performanceZone]?.label ?? r.performanceZone : "Not scored",
    statusLabels[r.status] ?? r.status,
    r.acknowledged ? "Yes" : "No",
    ...(isTeamMode ? [r.teamName ?? "", r.areaName ?? ""] : []),
  ]);

  // The shared guard quotes each cell and neutralises a formula lead (= + - @) — names and team
  // labels are typed text, and the sheet opens in Excel.
  const csvContent = CSV_BOM + [csvLine(headers), ...rows.map((row) => csvLine(row))].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `coaching-reports-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ━━━━━━━━━━━━━━━━━━ Error Boundary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

type EBProps = { children: ReactNode; title?: string };
type EBState = { hasError: boolean };

class ErrorBoundaryChart extends Component<EBProps, EBState> {
  constructor(props: EBProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="border border-slate-200 bg-slate-50 p-4 text-center text-sm text-slate-500">
          Unable to render {this.props.title ?? "chart"}. Please reload the page.
        </div>
      );
    }
    return this.props.children;
  }
}

/* ━━━━━━━━━━━━━━━━━━ Skeleton Loader ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function SkeletonPulse({ className }: { className?: string }) {
  return <div className={cn("animate-pulse bg-slate-200", className)} />;
}

function SkeletonDashboard() {
  return (
    <div className="space-y-4">
      {/* Toolbar skeleton */}
      <div className="flex items-center gap-2">
        <SkeletonPulse className="h-9 w-32" />
        <SkeletonPulse className="h-7 w-20" />
      </div>
      {/* Metric cards skeleton */}
      <div className="grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="bg-white p-4" key={i}>
            <div className="space-y-2">
              <SkeletonPulse className="h-3 w-16" />
              <SkeletonPulse className="h-6 w-24" />
              <SkeletonPulse className="h-3 w-14" />
            </div>
          </div>
        ))}
      </div>
      {/* Zone bar skeleton */}
      <div className="border border-slate-200 bg-white p-4">
        <SkeletonPulse className="mb-2 h-3 w-24" />
        <SkeletonPulse className="h-2.5 w-full" />
      </div>
      {/* Table skeleton */}
      <div className="border border-slate-200 bg-white">
        <div className="p-3">
          <SkeletonPulse className="mb-3 h-4 w-full" />
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonPulse className="mb-2 h-10 w-full" key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Offline Banner ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);

    // Initial offline status read — navigator.onLine is a browser API and
    // cannot be evaluated server-side, so we sync it post-mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffline(!navigator.onLine);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="flex items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      You are offline. Data shown may be outdated.
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Sub-components ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/** Metric card — clean, no icon box. Accent left-border stripe indicates category. */
function MetricCard({
  label, value, sub, accentColor,
}: {
  accentColor?: string; label: string; sub?: string; value: string | number;
}) {
  return (
    <div className="relative bg-white p-3 sm:p-4" role="group" aria-label={`${label}: ${value}`}>
      <div className="absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: accentColor ?? "#e2e8f0" }} />
      <p className="text-phx-2xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-bold leading-tight text-slate-900 sm:text-2xl">{value}</p>
      {sub ? <p className="mt-0.5 text-phx-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

function ZoneDistributionBar({ data }: { data: { count: number; pct: number; zone: CoachingPerformanceZone }[] }) {
  if (data.length === 0) return null;
  return (
    <div className="space-y-2" role="region" aria-label="Performance zone distribution">
      <p className="text-phx-2xs font-semibold uppercase tracking-wider text-slate-400">Zone distribution</p>
      <div className="flex h-2.5 overflow-hidden border border-slate-200">
        {data.map((d) => (
          <div
            className="transition-all duration-300"
            key={d.zone}
            style={{ backgroundColor: zoneConfig[d.zone]?.color ?? "#94a3b8", width: `${d.pct}%` }}
            title={`${zoneConfig[d.zone]?.label}: ${d.count} (${d.pct}%)`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {data.map((d) => (
          <span className="flex items-center gap-1.5 text-phx-xs text-slate-600" key={d.zone}>
            <span className="inline-block h-2 w-2" style={{ backgroundColor: zoneConfig[d.zone]?.color ?? "#94a3b8" }} />
            {zoneConfig[d.zone]?.label}: {d.count} <span className="text-slate-400">({d.pct}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Status distribution — horizontal breakdown bar */
function StatusDistributionBar({ counts, total }: { counts: Partial<Record<CoachingReportStatus, number>>; total: number }) {
  if (total === 0) return null;
  const statusOrder: CoachingReportStatus[] = ["submitted", "reviewed_by_employee", "locked", "draft", "cancelled"];
  const statusBarColors: Record<CoachingReportStatus, string> = {
    submitted: "#2563eb",
    reviewed_by_employee: "#059669",
    locked: "#334155",
    draft: "#94a3b8",
    cancelled: "#d1d5db",
  };
  const entries = statusOrder.filter((s) => (counts[s] ?? 0) > 0);
  if (entries.length === 0) return null;

  return (
    <div className="space-y-2" role="region" aria-label="Report status breakdown">
      <p className="text-phx-2xs font-semibold uppercase tracking-wider text-slate-400">Status breakdown</p>
      <div className="flex h-2.5 overflow-hidden border border-slate-200">
        {entries.map((s) => (
          <div
            key={s}
            className="transition-all duration-300"
            style={{ backgroundColor: statusBarColors[s], width: `${round2(((counts[s] ?? 0) / total) * 100)}%` }}
            title={`${statusLabels[s]}: ${counts[s]}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {entries.map((s) => (
          <span className="flex items-center gap-1.5 text-phx-xs text-slate-600" key={s}>
            <span className="inline-block h-2 w-2" style={{ backgroundColor: statusBarColors[s] }} />
            {statusLabels[s]}: {counts[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

function ZoneBadge({ zone }: { zone: CoachingPerformanceZone | null }) {
  if (!zone) return <span className="inline-flex border border-slate-200 bg-slate-50 px-2 py-0.5 text-phx-xs font-semibold text-slate-500">—</span>;
  const cfg = zoneConfig[zone];
  return <span className={cn("inline-flex border px-2 py-0.5 text-phx-xs font-semibold", cfg.bg, cfg.border, cfg.text)}>{cfg.label}</span>;
}

function StatusBadge({ status }: { status: CoachingReportStatus }) {
  return <span className={cn("inline-flex border px-2 py-0.5 text-phx-xs font-semibold", statusColors[status])}>{statusLabels[status] ?? status}</span>;
}

function AckBadge({ acknowledged }: { acknowledged: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1 border px-2 py-0.5 text-phx-xs font-semibold", acknowledged ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-500")}>
      {acknowledged ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
      {acknowledged ? "Ack'd" : "Pending"}
    </span>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Period Filter (smart inline with URL sync) ━━━━━ */

function PeriodFilterPanel({
  filter, onChange, years,
}: {
  filter: PeriodFilter; onChange: (f: PeriodFilter) => void; years: number[];
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const activeCount = [filter.year, filter.quarter, filter.month].filter(Boolean).length;
  const label = useMemo(() => {
    const parts: string[] = [];
    if (filter.month) parts.push(monthNames[Number(filter.month) - 1]?.slice(0, 3) ?? filter.month);
    if (filter.quarter) parts.push(`Q${filter.quarter}`);
    if (filter.year) parts.push(filter.year);
    return parts.length ? parts.join(" · ") : "All periods";
  }, [filter]);

  // Focus trap
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    if (e.key === "Tab" && open && panelRef.current) {
      const focusable = panelRef.current.querySelectorAll<HTMLElement>('button, select, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) && triggerRef.current && !triggerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Quick presets
  const presets = useMemo(() => {
    const now = new Date();
    return [
      { label: "This Month", fn: () => onChange({ year: String(now.getFullYear()), quarter: "", month: String(now.getMonth() + 1) }) },
      { label: `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`, fn: () => onChange({ year: String(now.getFullYear()), quarter: String(Math.ceil((now.getMonth() + 1) / 3)), month: "" }) },
      { label: String(now.getFullYear()), fn: () => onChange({ year: String(now.getFullYear()), quarter: "", month: "" }) },
    ];
  }, [onChange]);

  return (
    <div className="relative" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "inline-flex min-h-[44px] items-center gap-2 border px-3 py-2 text-sm font-semibold transition sm:min-h-0",
          open ? "border-orange-300 bg-orange-50 text-orange-700" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
        )}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Calendar className="h-3.5 w-3.5 shrink-0" />
        {/* Wraps, never an ellipsis (owner rule): a long period label goes to a second line. */}
        <span className="min-w-0 text-left leading-tight">{label}</span>
        {activeCount > 0 ? <span className="flex h-4.5 min-w-[18px] items-center justify-center bg-orange-600 px-1 text-phx-2xs font-bold text-white">{activeCount}</span> : null}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div ref={panelRef} className="absolute left-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] border border-slate-200 bg-white p-4 shadow-lg sm:w-80" role="dialog" aria-label="Period filter">
          {/* Quick presets */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p.label}
                className="min-h-[44px] border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-xs font-semibold text-slate-600 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 sm:min-h-0"
                onClick={() => { p.fn(); setOpen(false); }}
                type="button"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="text-phx-2xs font-semibold uppercase tracking-wider text-slate-400">Year</span>
              <SearchableSelect className="mt-1 h-9 w-full px-2" onChange={(e) => onChange({ ...filter, year: e.target.value })} value={filter.year}>
                <option value="">All years</option>
                {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
              </SearchableSelect>
            </label>
            <label className="block">
              <span className="text-phx-2xs font-semibold uppercase tracking-wider text-slate-400">Quarter</span>
              <SearchableSelect className="mt-1 h-9 w-full px-2" onChange={(e) => onChange({ ...filter, quarter: e.target.value })} value={filter.quarter}>
                <option value="">All quarters</option>
                <option value="1">Q1 (Jan–Mar)</option>
                <option value="2">Q2 (Apr–Jun)</option>
                <option value="3">Q3 (Jul–Sep)</option>
                <option value="4">Q4 (Oct–Dec)</option>
              </SearchableSelect>
            </label>
            <label className="block">
              <span className="text-phx-2xs font-semibold uppercase tracking-wider text-slate-400">Month</span>
              <SearchableSelect className="mt-1 h-9 w-full px-2" onChange={(e) => onChange({ ...filter, month: e.target.value })} value={filter.month}>
                <option value="">All months</option>
                {monthNames.map((name, i) => <option key={name} value={String(i + 1)}>{name}</option>)}
              </SearchableSelect>
            </label>
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
            <button className="min-h-[44px] text-xs font-medium text-slate-500 hover:text-red-600 sm:min-h-0" onClick={() => { onChange({ month: "", quarter: "", year: "" }); }} type="button">Clear all</button>
            <button className="min-h-[44px] bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-orange-600 sm:min-h-0" onClick={() => { setOpen(false); triggerRef.current?.focus(); }} type="button">Apply</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Charts ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function ScoreTrendChart({ data, title }: { data: { avg: number; count: number; label: string }[]; title?: string }) {
  if (data.length < 2) return null;
  return (
    <ErrorBoundaryChart title="Score trend">
      <div className="border border-slate-200 bg-white p-4" role="region" aria-label="Score trend chart">
        <p className="mb-3 text-phx-2xs font-semibold uppercase tracking-wider text-slate-400">{title ?? "Monthly score trend"}</p>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 12, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} domain={[0, 100]} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 0, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(value) => [`${Number(value ?? 0).toFixed(1)}%`, "Score"]} />
              <Line type="monotone" dataKey="avg" stroke="#ea580c" strokeWidth={2} dot={{ r: 3, fill: "#ea580c", stroke: "#fff", strokeWidth: 2 }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </ErrorBoundaryChart>
  );
}

function RepComparisonChart({ data }: { data: { avg: number; name: string; fullName: string }[] }) {
  if (data.length === 0) return null;
  return (
    <ErrorBoundaryChart title="Rep comparison">
      <div className="border border-slate-200 bg-white p-4" role="region" aria-label="Rep score comparison chart">
        <p className="mb-3 text-phx-2xs font-semibold uppercase tracking-wider text-slate-400">Rep avg. score comparison</p>
        <div style={{ height: Math.max(data.length * 36 + 24, 120) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
              <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: "#334155" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 0, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(value) => [`${Number(value ?? 0).toFixed(1)}%`, "Avg Score"]} />
              <Bar dataKey="avg" radius={0} barSize={20}>
                {data.map((entry, i) => <Cell key={`cell-${i}`} fill={getScoreColor(entry.avg)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </ErrorBoundaryChart>
  );
}

/** Radar chart for coaching quality dimensions. When `wide`, pairs the radar
 * with a per-dimension score breakdown so it fills a full-width row instead of
 * leaving large horizontal gaps around the (inherently circular) chart. */
function CoachingRadarChart({ data, wide = false }: { data: { dimension: string; value: number; fullMark: number }[]; wide?: boolean }) {
  if (data.length === 0) return null;
  return (
    <ErrorBoundaryChart title="Coaching quality radar">
      <div className="border border-slate-200 bg-white p-4" role="region" aria-label="Coaching quality radar chart">
        <p className="mb-3 text-phx-2xs font-semibold uppercase tracking-wider text-slate-400">Coaching quality overview</p>
        <div className={cn("grid gap-4", wide ? "md:grid-cols-2 md:items-center" : "")}>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart cx="50%" cy="50%" outerRadius="80%" data={data}>
                <PolarGrid stroke="#e2e8f0" />
                <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10, fill: "#64748b" }} />
                <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 9, fill: "#94a3b8" }} axisLine={false} />
                <Radar name="Score" dataKey="value" stroke="#ea580c" fill="#ea580c" fillOpacity={0.15} strokeWidth={2} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          {wide ? (
            <div className="space-y-3">
              {data.map((d) => (
                <div key={d.dimension}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 break-words text-phx-xs font-semibold text-slate-600">{d.dimension}</span>
                    <span className="shrink-0 whitespace-nowrap text-sm font-bold tabular-nums" style={{ color: getScoreColor(d.value) }}>{d.value.toFixed(1)}%</span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden bg-slate-100">
                    <div className="h-full transition-all duration-300" style={{ width: `${Math.min(100, Math.max(0, d.value))}%`, backgroundColor: getScoreColor(d.value) }} />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </ErrorBoundaryChart>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Mobile Report Card ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/** Map a coaching performance zone to the closest PortalRecordCard accent color. */
function zoneAccent(zone: CoachingPerformanceZone | null): "orange" | "emerald" | "amber" | "rose" | "sky" | "slate" {
  switch (zone) {
    case "critical_red":
    case "red_zone":
      return "rose";
    case "yellow_zone":
      return "amber";
    case "green_zone":
      return "emerald";
    case "excellence_zone":
      return "sky";
    default:
      return "slate";
  }
}

function MobileReportCard({ report, isTeamMode }: { isTeamMode: boolean; report: CoachingReportSummaryRow }) {
  const scoreColor = getScoreColor(report.finalScorePercent);
  return (
    <PortalRecordCard
      accent={zoneAccent(report.performanceZone)}
      title={<span className="text-orange-600">{report.reportNumber}</span>}
      meta={isTeamMode ? formatEmployeeDisplayName(report.medicalRepName) : undefined}
      status={
        // Score + zone are the most important glance-value, so they take the
        // card's status slot instead of sitting in the label/value field grid.
        <div className="flex flex-col items-end gap-1">
          <span className="text-xl font-black leading-none tabular-nums" style={{ color: scoreColor }}>
            {formatPct(report.finalScorePercent)}
          </span>
          <ZoneBadge zone={report.performanceZone} />
        </div>
      }
      actions={
        <Link
          className="inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 bg-slate-900 px-3 text-xs font-semibold text-white transition hover:bg-orange-600"
          href={`/employee-portals/coaching/${report.reportId}`}
        >
          Review Report <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={report.status} />
        <AckBadge acknowledged={report.acknowledged} />
      </div>
      <PortalRecordFields
        fields={[
          { label: "Date", value: formatDate(report.coachingDate) },
          { label: "Coach", value: report.coachName || "—" },
          ...(isTeamMode
            ? [
                { label: "Team", value: report.teamName || "—" },
                { label: "Area", value: report.areaName || "—" },
              ]
            : []),
        ]}
      />
    </PortalRecordCard>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Reports Table ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function ReportsTable({
  reports, isTeamMode, focusedRow, onKeyNav,
}: {
  focusedRow: number; isTeamMode: boolean; onKeyNav: (index: number) => void; reports: CoachingReportSummaryRow[];
}) {
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (reports.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onKeyNav(Math.min(focusedRow + 1, reports.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      onKeyNav(Math.max(focusedRow - 1, 0));
    } else if (e.key === "Enter" && focusedRow >= 0 && focusedRow < reports.length) {
      const link = tbodyRef.current?.querySelectorAll("tr")?.[focusedRow]?.querySelector("a");
      link?.click();
    }
  }, [reports, focusedRow, onKeyNav]);

  // Scroll focused row into view
  useEffect(() => {
    if (focusedRow < 0) return;
    const row = tbodyRef.current?.querySelectorAll("tr")?.[focusedRow];
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedRow]);

  const thCls = "px-3 py-2.5";
  const tdCls = "border-b border-r border-slate-100 px-3 py-2.5 align-top last:border-r-0";

  // FITS THE SCREEN (owner's golden rule). This was PortalDesktopTable over a 860px (1040px in team
  // mode) min-width inside `overflow-x-auto` — the exact pattern the rule names — and the table
  // shows from `md`, where the column is ~736px, and ~636px from `lg` once the sidebar opens. So the
  // columns are MERGED rather than squeezed: Score carries its zone underneath, Status carries the
  // acknowledgement, and a fixed layout with a colgroup holds the table to its column at every width.
  return (
    <div aria-label="Coaching reports" className="hidden md:block" onKeyDown={handleKeyDown} role="grid" tabIndex={0}>
      <table className="w-full table-fixed border-collapse text-left text-sm" data-portal-desktop-table>
        <colgroup>
          {isTeamMode ? (
            <>
              <col className="w-[15%]" />
              <col className="w-[19%]" />
              <col className="w-[13%]" />
              <col className="w-[17%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
              <col className="w-[10%]" />
            </>
          ) : (
            <>
              <col className="w-[18%]" />
              <col className="w-[16%]" />
              <col className="w-[22%]" />
              <col className="w-[16%]" />
              <col className="w-[17%]" />
              <col className="w-[11%]" />
            </>
          )}
        </colgroup>
        <thead>
          <tr>
            <th className={thCls}>Report</th>
            {isTeamMode ? <th className={thCls}>Medical Rep</th> : null}
            <th className={thCls}>Date</th>
            <th className={thCls}>Coach</th>
            <th className={thCls}>Score</th>
            <th className={thCls}>Status</th>
            <th className={thCls}>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody ref={tbodyRef}>
          {reports.map((report, idx) => (
            <tr
              className={cn("transition-colors last:border-b-0", idx === focusedRow ? "bg-orange-50/60 outline outline-1 outline-orange-200" : "hover:bg-slate-50/40")}
              key={report.reportId}
              aria-selected={idx === focusedRow}
            >
              <td className={cn(tdCls, "break-words font-bold text-orange-600")}>{report.reportNumber}</td>
              {isTeamMode ? (
                <td className={cn(tdCls, "break-words font-semibold text-slate-900")}>
                  {formatEmployeeDisplayName(report.medicalRepName)}
                </td>
              ) : null}
              <td className={cn(tdCls, "text-slate-700")}>{formatDate(report.coachingDate)}</td>
              <td className={cn(tdCls, "break-words text-slate-700")}>{report.coachName || "—"}</td>
              <td className={tdCls}>
                <p className="font-bold tabular-nums" style={{ color: getScoreColor(report.finalScorePercent) }}>
                  {formatPct(report.finalScorePercent)}
                </p>
                <div className="mt-1">
                  <ZoneBadge zone={report.performanceZone} />
                </div>
              </td>
              <td className={tdCls}>
                <div className="flex flex-col items-start gap-1">
                  <StatusBadge status={report.status} />
                  <AckBadge acknowledged={report.acknowledged} />
                </div>
              </td>
              <td className={cn(tdCls, "text-center")}>
                <Link
                  aria-label={`Open coaching report ${report.reportNumber}`}
                  className="inline-flex items-center gap-1 border border-slate-200 bg-white px-2 py-1.5 text-phx-xs font-semibold text-slate-700 hover:border-orange-300 hover:text-orange-600"
                  href={`/employee-portals/coaching/${report.reportId}`}
                >
                  View <ArrowUpRight className="h-3 w-3 shrink-0" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Print Stylesheet ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const printStyles = `
@media print {
  nav, header, aside, footer, .no-print { display: none !important; }
  body { font-size: 11px; }
  table { font-size: 10px; border-collapse: collapse; }
  th, td { border: 1px solid #e2e8f0 !important; padding: 4px 8px !important; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
`;

/* ━━━━━━━━━━━━━━━━━━ Main Component ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export function EmployeeCoachingList({ mode = "self", reports }: EmployeeCoachingListProps) {
  const isTeamMode = mode === "team";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [hydrated, setHydrated] = useState(false);
  const [focusedRow, setFocusedRow] = useState(-1);

  // Hydration guard for skeleton — mount-only setState is the canonical
  // React pattern for SSR-safe hydration. Disabling the rule here is
  // intentional.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setHydrated(true); }, []);

  // URL-synced period filter
  const periodFilter: PeriodFilter = useMemo(() => ({
    month: searchParams.get("month") ?? "",
    quarter: searchParams.get("quarter") ?? "",
    year: searchParams.get("year") ?? "",
  }), [searchParams]);

  const setPeriodFilter = useCallback((f: PeriodFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of ["year", "quarter", "month"] as const) {
      if (f[key]) params.set(key, f[key]);
      else params.delete(key);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  const [search, setSearch] = useState("");

  const availableYears = useMemo(() => {
    const ys = new Set(reports.map((r) => r.coachingYear).filter(Boolean));
    ys.add(new Date().getFullYear());
    return [...ys].sort((a, b) => b - a);
  }, [reports]);

  const filtered = useMemo(() => {
    let result = reports;
    if (periodFilter.year) result = result.filter((r) => r.coachingYear === Number(periodFilter.year));
    if (periodFilter.quarter) result = result.filter((r) => r.coachingQuarter === Number(periodFilter.quarter));
    if (periodFilter.month) result = result.filter((r) => r.coachingMonth === Number(periodFilter.month));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((r) =>
        r.medicalRepName?.toLowerCase().includes(q) ||
        r.medicalRepHrId?.toLowerCase().includes(q) ||
        r.coachName?.toLowerCase().includes(q) ||
        r.reportNumber?.toLowerCase().includes(q) ||
        r.teamName?.toLowerCase().includes(q) ||
        r.areaName?.toLowerCase().includes(q) ||
        (r.performanceZone && zoneConfig[r.performanceZone]?.label.toLowerCase().includes(q)) ||
        statusLabels[r.status]?.toLowerCase().includes(q),
      );
    }
    return result;
  }, [reports, periodFilter, search]);

  // Reset keyboard focus when filters change — focus state is purely
  // ephemeral UI state, not derived data, so a useEffect is appropriate.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setFocusedRow(-1); }, [filtered]);

  const analytics = useMemo(() => computeAnalytics(filtered), [filtered]);
  const zoneDistribution = useMemo(() => buildZoneDistribution(analytics.zoneCounts, analytics.completed.length), [analytics]);
  const scoreTrend = useMemo(() => (isTeamMode ? buildScoreTrend(filtered) : buildSelfScoreTrend(filtered)), [filtered, isTeamMode]);
  const repComparison = useMemo(() => (isTeamMode ? buildRepComparisonData(filtered) : []), [filtered, isTeamMode]);
  const radarData = useMemo(() => buildParameterRadarData(filtered), [filtered]);

  // Empty state
  if (reports.length === 0) {
    return (
      <div dir="auto" className="border border-slate-200 bg-white p-8 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center bg-orange-50 text-orange-500">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="square" strokeLinejoin="miter" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
        </div>
        <p className="text-base font-bold text-slate-900">{isTeamMode ? "No team coaching reports available" : "No coaching reports available"}</p>
        <p className="mt-1.5 text-sm text-slate-500">{isTeamMode ? "Submitted field coaching reports for your team will appear here." : "Submitted field coaching reports will appear here once published."}</p>
      </div>
    );
  }

  // Skeleton during hydration
  if (!hydrated) return <SkeletonDashboard />;

  return (
    <div dir="auto" className="space-y-4">
      <style dangerouslySetInnerHTML={{ __html: printStyles }} />

      {/* ─── Offline Banner ────────────────────────────────────────────── */}
      <OfflineBanner />

      {/* ─── Toolbar ──────────────────────────────────────────────────── */}
      <div className="no-print flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <PeriodFilterPanel filter={periodFilter} onChange={setPeriodFilter} years={availableYears} />
          <span className="border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-600">
            {filtered.length} report{filtered.length === 1 ? "" : "s"}
          </span>
          {/* Export CSV */}
          <button
            className="inline-flex min-h-[44px] items-center gap-1.5 border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-800 sm:min-h-0"
            onClick={() => exportCSV(filtered, isTeamMode)}
            title="Export to CSV"
            type="button"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">CSV</span>
          </button>
          {/* Print */}
          <button
            className="inline-flex min-h-[44px] items-center gap-1.5 border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-800 sm:min-h-0"
            onClick={() => window.print()}
            title="Print report"
            type="button"
          >
            <Printer className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Print</span>
          </button>
        </div>
        {isTeamMode ? (
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input className={cn(phxFieldClassName, "pl-8 pr-8")} onChange={(e) => setSearch(e.target.value)} placeholder="Search rep, coach, team..." type="text" value={search} />
            {search ? <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => setSearch("")} type="button"><X className="h-3.5 w-3.5" /></button> : null}
          </div>
        ) : null}
      </div>

      {/* ─── Metric Cards — gap-px grid gives thin divider lines ─────── */}
      <div className="grid grid-cols-2 gap-px overflow-hidden border border-slate-200 bg-slate-200 sm:grid-cols-4" role="region" aria-label="Coaching performance metrics">
        <MetricCard label="Completed" value={analytics.completed.length} sub={`of ${filtered.length} total`} accentColor="#ea580c" />
        <MetricCard label="Avg Score" value={analytics.scores.length ? `${analytics.avgScore.toFixed(1)}%` : "—"} sub={analytics.scores.length ? `Best ${analytics.bestScore.toFixed(1)}%` : "No scores"} accentColor="#2563eb" />
        <MetricCard label="Pending Ack" value={analytics.pendingAck} sub={analytics.draftCount ? `${analytics.draftCount} drafts` : "All acknowledged"} accentColor="#d97706" />
        <MetricCard label="Score Range" value={analytics.scores.length ? `${analytics.lowestScore.toFixed(0)}–${analytics.bestScore.toFixed(0)}%` : "—"} sub={analytics.scores.length > 1 ? `${analytics.scores.length} scored` : ""} accentColor="#059669" />
      </div>

      {/* ─── Distribution Bars ──────────────────────────────────────── */}
      {(() => {
        const hasZone = zoneDistribution.length > 0;
        const hasStatus = Object.keys(analytics.statusCounts).length > 1;
        if (hasZone && hasStatus) {
          return (
            <div className="grid gap-px border border-slate-200 bg-slate-200 lg:grid-cols-2">
              <div className="bg-white p-4"><ZoneDistributionBar data={zoneDistribution} /></div>
              <div className="bg-white p-4"><StatusDistributionBar counts={analytics.statusCounts} total={filtered.length} /></div>
            </div>
          );
        }
        if (hasZone) {
          return (
            <div className="border border-slate-200 bg-white p-4"><ZoneDistributionBar data={zoneDistribution} /></div>
          );
        }
        if (hasStatus) {
          return (
            <div className="border border-slate-200 bg-white p-4"><StatusDistributionBar counts={analytics.statusCounts} total={filtered.length} /></div>
          );
        }
        return null;
      })()}

      {/* ─── Charts ──────────────────────────────────────────────────── */}
      {(scoreTrend.length >= 2 || repComparison.length > 0 || radarData.length > 0) ? (
        <>
          {/* Score trend — full page-width row */}
          {scoreTrend.length >= 2 ? (
            <ScoreTrendChart
              data={scoreTrend}
              title={isTeamMode ? "Monthly score trend" : "My score progression"}
            />
          ) : null}

          {/* Secondary charts — rep comparison + coaching quality overview radar */}
          {(repComparison.length > 0 || radarData.length > 0) ? (
            <div className={cn("grid gap-4", (repComparison.length > 0 && radarData.length > 0) ? "lg:grid-cols-2" : "")}>
              {repComparison.length > 0 ? <RepComparisonChart data={repComparison} /> : null}
              {radarData.length > 0 ? <CoachingRadarChart data={radarData} wide={repComparison.length === 0} /> : null}
            </div>
          ) : null}
        </>
      ) : filtered.length > 0 ? (
        <div className="border border-slate-200 bg-white px-4 py-6 text-center">
          <p className="text-sm font-semibold text-slate-500">Not enough data for trend analysis</p>
          <p className="mt-1 text-phx-xs text-slate-400">Score trend charts require at least 2 scored reports across different periods.</p>
        </div>
      ) : null}

      {/* ─── Reports (desktop table / mobile cards) ──────────────────── */}
      <div className="border border-slate-200 bg-white">
        <PortalResponsiveDataList
          items={filtered}
          getKey={(report) => report.reportId}
          empty={<div className="px-3 py-8 text-center text-sm text-slate-500">No reports match the current filters.</div>}
          renderCard={(report) => <MobileReportCard report={report} isTeamMode={isTeamMode} />}
          renderTable={() => (
            <ReportsTable
              reports={filtered}
              isTeamMode={isTeamMode}
              focusedRow={focusedRow}
              onKeyNav={setFocusedRow}
            />
          )}
        />
      </div>
    </div>
  );
}
