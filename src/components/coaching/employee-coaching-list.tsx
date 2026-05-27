"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Component, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  ArrowUpRight,
  BarChart3,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Clock,
  Download,
  Filter,
  TrendingUp,
  Users,
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
} from "recharts";

import type {
  CoachingPerformanceZone,
  CoachingReportStatus,
  CoachingReportSummaryRow,
} from "@/lib/coaching/types";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";

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
  critical_red: { bg: "bg-red-50", border: "border-red-200", color: "#dc2626", fill: "#fca5a5", label: "Critical", text: "text-red-700" },
  red_zone: { bg: "bg-red-50", border: "border-red-200", color: "#dc2626", fill: "#fca5a5", label: "Red Zone", text: "text-red-700" },
  yellow_zone: { bg: "bg-amber-50", border: "border-amber-200", color: "#d97706", fill: "#fcd34d", label: "Yellow Zone", text: "text-amber-700" },
  green_zone: { bg: "bg-emerald-50", border: "border-emerald-200", color: "#059669", fill: "#6ee7b7", label: "Green Zone", text: "text-emerald-700" },
  excellence_zone: { bg: "bg-sky-50", border: "border-sky-200", color: "#0284c7", fill: "#7dd3fc", label: "Excellence", text: "text-sky-700" },
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

const completedStatuses = new Set<CoachingReportStatus>(["submitted", "reviewed_by_employee", "locked"]);

/* ━━━━━━━━━━━━━━━━━━ Utilities ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
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

  return { avgScore, bestScore, completed, draftCount, lowestScore, pendingAck, scores, zoneCounts };
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
      name: rep.name.length > 18 ? `${rep.name.slice(0, 16)}..` : rep.name,
      fullName: rep.name,
    }))
    .sort((a, b) => b.avg - a.avg);
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

  const csvContent = [
    headers.join(","),
    ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")),
  ].join("\n");

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
        <div className="rounded border border-slate-200 bg-slate-50 p-4 text-center text-sm text-slate-500">
          Unable to render {this.props.title ?? "chart"}. Please reload the page.
        </div>
      );
    }
    return this.props.children;
  }
}

/* ━━━━━━━━━━━━━━━━━━ Skeleton Loader ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function SkeletonPulse({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-slate-200", className)} />;
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
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="rounded border border-slate-200 bg-white p-4" key={i}>
            <div className="flex items-start gap-3">
              <SkeletonPulse className="h-9 w-9" />
              <div className="flex-1 space-y-2">
                <SkeletonPulse className="h-3 w-16" />
                <SkeletonPulse className="h-5 w-20" />
                <SkeletonPulse className="h-3 w-14" />
              </div>
            </div>
          </div>
        ))}
      </div>
      {/* Zone bar skeleton */}
      <div className="rounded border border-slate-200 bg-white p-4">
        <SkeletonPulse className="h-3 w-24 mb-2" />
        <SkeletonPulse className="h-3 w-full" />
      </div>
      {/* Table skeleton */}
      <div className="rounded border border-slate-200 bg-white">
        <div className="p-3">
          <SkeletonPulse className="h-4 w-full mb-3" />
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonPulse className="h-10 w-full mb-2" key={i} />
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
    <div className="flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
      <WifiOff className="h-3.5 w-3.5" />
      You are offline. Data shown may be outdated.
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Sub-components ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function MetricCard({
  label, value, sub, accent, icon: Icon,
}: {
  accent?: string; icon: typeof BarChart3; label: string; sub?: string; value: string | number;
}) {
  return (
    <div className="flex items-start gap-3 rounded border border-slate-200 bg-white p-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-4">
      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded", accent ?? "bg-slate-100 text-slate-600")}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
        <p className="mt-0.5 text-lg font-bold leading-tight text-slate-900">{value}</p>
        {sub ? <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p> : null}
      </div>
    </div>
  );
}

function ZoneDistributionBar({ data }: { data: { count: number; pct: number; zone: CoachingPerformanceZone }[] }) {
  if (data.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Zone distribution</p>
      <div className="flex h-3 overflow-hidden rounded-sm border border-slate-200">
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
          <span className="flex items-center gap-1.5 text-[11px] text-slate-600" key={d.zone}>
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: zoneConfig[d.zone]?.color ?? "#94a3b8" }} />
            {zoneConfig[d.zone]?.label}: {d.count}
          </span>
        ))}
      </div>
    </div>
  );
}

function ZoneBadge({ zone }: { zone: CoachingPerformanceZone | null }) {
  if (!zone) return <span className="inline-flex rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-500">Not scored</span>;
  const cfg = zoneConfig[zone];
  return <span className={cn("inline-flex rounded border px-2 py-0.5 text-[11px] font-semibold", cfg.bg, cfg.border, cfg.text)}>{cfg.label}</span>;
}

function StatusBadge({ status }: { status: CoachingReportStatus }) {
  return <span className={cn("inline-flex rounded border px-2 py-0.5 text-[11px] font-semibold", statusColors[status])}>{statusLabels[status] ?? status}</span>;
}

function AckBadge({ acknowledged }: { acknowledged: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold", acknowledged ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-500")}>
      {acknowledged ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
      {acknowledged ? "Ack'd" : "Pending"}
    </span>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Period Filter (with URL sync) ━━━━━━━━━━━━━━━━━━ */

function PeriodFilter({
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

  return (
    <div className="relative" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="true"
        className={cn("inline-flex items-center gap-2 rounded border px-3 py-2 text-sm font-semibold transition", open ? "border-orange-300 bg-orange-50 text-orange-700" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300")}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Calendar className="h-3.5 w-3.5" />
        <span className="max-w-[200px] truncate">{label}</span>
        {activeCount > 0 ? <span className="flex h-5 w-5 items-center justify-center rounded bg-orange-600 text-[10px] font-bold text-white">{activeCount}</span> : null}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div ref={panelRef} className="absolute left-0 top-full z-30 mt-1 w-72 rounded border border-slate-200 bg-white p-4 shadow-lg sm:w-80" role="dialog" aria-label="Period filter">
          <div className="space-y-3">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Year</span>
              <select className="mt-1 h-9 w-full rounded border border-slate-200 bg-white px-2 text-sm font-medium text-slate-800 outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-200" onChange={(e) => onChange({ ...filter, year: e.target.value })} value={filter.year}>
                <option value="">All years</option>
                {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Quarter</span>
              <select className="mt-1 h-9 w-full rounded border border-slate-200 bg-white px-2 text-sm font-medium text-slate-800 outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-200" onChange={(e) => onChange({ ...filter, quarter: e.target.value })} value={filter.quarter}>
                <option value="">All quarters</option>
                <option value="1">Q1 (Jan–Mar)</option>
                <option value="2">Q2 (Apr–Jun)</option>
                <option value="3">Q3 (Jul–Sep)</option>
                <option value="4">Q4 (Oct–Dec)</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Month</span>
              <select className="mt-1 h-9 w-full rounded border border-slate-200 bg-white px-2 text-sm font-medium text-slate-800 outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-200" onChange={(e) => onChange({ ...filter, month: e.target.value })} value={filter.month}>
                <option value="">All months</option>
                {monthNames.map((name, i) => <option key={name} value={String(i + 1)}>{name}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
            <button className="text-xs font-medium text-slate-500 hover:text-red-600" onClick={() => onChange({ month: "", quarter: "", year: "" })} type="button">Clear all</button>
            <button className="rounded bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-orange-600" onClick={() => { setOpen(false); triggerRef.current?.focus(); }} type="button">Apply</button>
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
      <div className="rounded border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="mb-3 flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-slate-500" />
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{title ?? "Monthly score trend"}</p>
        </div>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 12, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={{ stroke: "#e2e8f0" }} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} domain={[0, 100]} axisLine={{ stroke: "#e2e8f0" }} />
              <Tooltip contentStyle={{ borderRadius: 4, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(value) => [`${Number(value ?? 0).toFixed(1)}%`, "Score"]} />
              <Line type="monotone" dataKey="avg" stroke="#ea580c" strokeWidth={2} dot={{ r: 4, fill: "#ea580c", stroke: "#fff", strokeWidth: 2 }} activeDot={{ r: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </ErrorBoundaryChart>
  );
}

function getBarColor(score: number) {
  if (score >= 90) return "#0284c7";
  if (score >= 80) return "#059669";
  if (score >= 65) return "#d97706";
  return "#dc2626";
}

function RepComparisonChart({ data }: { data: { avg: number; name: string; fullName: string }[] }) {
  if (data.length === 0) return null;
  return (
    <ErrorBoundaryChart title="Rep comparison">
      <div className="rounded border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="mb-3 flex items-center gap-2">
          <Users className="h-4 w-4 text-slate-500" />
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Rep avg. score comparison</p>
        </div>
        <div style={{ height: Math.max(data.length * 36 + 24, 120) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: "#64748b" }} axisLine={{ stroke: "#e2e8f0" }} />
              <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11, fill: "#334155" }} axisLine={{ stroke: "#e2e8f0" }} />
              <Tooltip contentStyle={{ borderRadius: 4, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(value) => [`${Number(value ?? 0).toFixed(1)}%`, "Avg Score"]} />
              <Bar dataKey="avg" radius={[0, 2, 2, 0]} barSize={22}>
                {data.map((entry, i) => <Cell key={`cell-${i}`} fill={getBarColor(entry.avg)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </ErrorBoundaryChart>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Mobile Report Card ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function MobileReportCard({ report, isTeamMode }: { isTeamMode: boolean; report: CoachingReportSummaryRow }) {
  return (
    <div className="rounded border border-slate-200 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2.5">
        <span className="text-[11px] font-bold text-orange-600">{report.reportNumber}</span>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={report.status} />
          <AckBadge acknowledged={report.acknowledged} />
        </div>
      </div>
      <div className="space-y-2 px-3 py-3">
        {isTeamMode ? <p className="text-sm font-bold text-slate-900">{formatEmployeeDisplayName(report.medicalRepName, report.medicalRepHrId)}</p> : null}
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <div><span className="text-slate-500">Date</span><p className="font-semibold text-slate-800">{formatDate(report.coachingDate)}</p></div>
          <div><span className="text-slate-500">Coach</span><p className="font-semibold text-slate-800">{report.coachName || "—"}</p></div>
          <div><span className="text-slate-500">Score</span><p className="font-bold text-slate-900">{formatPct(report.finalScorePercent)}</p></div>
          <div><span className="text-slate-500">Zone</span><div className="mt-0.5"><ZoneBadge zone={report.performanceZone} /></div></div>
          {isTeamMode ? (
            <>
              <div><span className="text-slate-500">Team</span><p className="font-semibold text-slate-800">{report.teamName || "—"}</p></div>
              <div><span className="text-slate-500">Area</span><p className="font-semibold text-slate-800">{report.areaName || "—"}</p></div>
            </>
          ) : null}
        </div>
      </div>
      <div className="border-t border-slate-100 px-3 py-2.5">
        <Link className="inline-flex w-full items-center justify-center gap-1.5 rounded bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-orange-600" href={`/employee-portals/coaching/${report.reportId}`}>
          Review Report <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
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

  if (reports.length === 0) {
    return (
      <div className="overflow-hidden rounded border border-slate-200 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="px-3 py-8 text-center text-sm text-slate-500">No reports match the current filters.</div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded border border-slate-200 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]" onKeyDown={handleKeyDown} tabIndex={0} role="grid" aria-label="Coaching reports">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <th className="border-r border-slate-100 px-3 py-2.5">Report</th>
              {isTeamMode ? <th className="border-r border-slate-100 px-3 py-2.5">Medical Rep</th> : null}
              <th className="border-r border-slate-100 px-3 py-2.5">Date</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Coach</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Score</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Zone</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Status</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Ack</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {reports.map((report, idx) => (
              <tr
                className={cn("border-b border-slate-100 transition-colors last:border-b-0", idx === focusedRow ? "bg-orange-50/60 outline outline-1 outline-orange-200" : "hover:bg-slate-50/60")}
                key={report.reportId}
                aria-selected={idx === focusedRow}
              >
                <td className="whitespace-nowrap border-r border-slate-100 px-3 py-2.5 font-bold text-orange-600">{report.reportNumber}</td>
                {isTeamMode ? (
                  <td className="border-r border-slate-100 px-3 py-2.5">
                    <p className="font-semibold text-slate-900">{formatEmployeeDisplayName(report.medicalRepName)}</p>
                    <p className="text-[11px] text-slate-500">{report.medicalRepHrId}</p>
                  </td>
                ) : null}
                <td className="whitespace-nowrap border-r border-slate-100 px-3 py-2.5 text-slate-700">{formatDate(report.coachingDate)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-slate-700">{report.coachName || "—"}</td>
                <td className="whitespace-nowrap border-r border-slate-100 px-3 py-2.5 font-bold text-slate-900">{formatPct(report.finalScorePercent)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5"><ZoneBadge zone={report.performanceZone} /></td>
                <td className="border-r border-slate-100 px-3 py-2.5"><StatusBadge status={report.status} /></td>
                <td className="border-r border-slate-100 px-3 py-2.5"><AckBadge acknowledged={report.acknowledged} /></td>
                <td className="px-3 py-2.5">
                  <Link className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-orange-300 hover:text-orange-600" href={`/employee-portals/coaching/${report.reportId}`}>
                    View <ArrowUpRight className="h-3 w-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
`;

/* ━━━━━━━━━━━━━━━━━━ Main Component ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export function EmployeeCoachingList({ mode = "self", reports }: EmployeeCoachingListProps) {
  const isTeamMode = mode === "team";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [hydrated, setHydrated] = useState(false);
  const [focusedRow, setFocusedRow] = useState(-1);

  // Hydration guard for skeleton
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

  // Reset keyboard focus when filters change
  useEffect(() => { setFocusedRow(-1); }, [filtered]);

  const analytics = useMemo(() => computeAnalytics(filtered), [filtered]);
  const zoneDistribution = useMemo(() => buildZoneDistribution(analytics.zoneCounts, analytics.completed.length), [analytics]);
  const scoreTrend = useMemo(() => (isTeamMode ? buildScoreTrend(filtered) : buildSelfScoreTrend(filtered)), [filtered, isTeamMode]);
  const repComparison = useMemo(() => (isTeamMode ? buildRepComparisonData(filtered) : []), [filtered, isTeamMode]);

  // Empty state
  if (reports.length === 0) {
    return (
      <div dir="auto" className="rounded border border-slate-200 bg-white p-8 text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded bg-orange-50 text-orange-500"><ClipboardCheck className="h-5 w-5" /></div>
        <p className="mt-4 text-base font-bold text-slate-900">{isTeamMode ? "No team coaching reports available" : "No coaching reports available"}</p>
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
          <PeriodFilter filter={periodFilter} onChange={setPeriodFilter} years={availableYears} />
          <span className="rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-600">
            {filtered.length} report{filtered.length === 1 ? "" : "s"}
          </span>
          {/* Export CSV */}
          <button
            className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
            onClick={() => exportCSV(filtered, isTeamMode)}
            title="Export to CSV"
            type="button"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">CSV</span>
          </button>
        </div>
        {isTeamMode ? (
          <div className="relative w-full sm:max-w-xs">
            <Filter className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input className="h-9 w-full rounded border border-slate-200 bg-white pl-8 pr-8 text-sm text-slate-700 outline-none placeholder:text-slate-400 focus:border-orange-300 focus:ring-1 focus:ring-orange-200" onChange={(e) => setSearch(e.target.value)} placeholder="Search rep, coach, team..." type="text" value={search} />
            {search ? <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => setSearch("")} type="button"><X className="h-3.5 w-3.5" /></button> : null}
          </div>
        ) : null}
      </div>

      {/* ─── Metric Cards ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricCard icon={ClipboardCheck} label="Completed" value={analytics.completed.length} sub={`of ${filtered.length} total`} accent="bg-orange-50 text-orange-600" />
        <MetricCard icon={BarChart3} label="Avg Score" value={analytics.scores.length ? `${analytics.avgScore.toFixed(1)}%` : "—"} sub={analytics.scores.length ? `Best ${analytics.bestScore.toFixed(1)}%` : "No scores"} accent="bg-blue-50 text-blue-600" />
        <MetricCard icon={CheckCircle2} label="Pending Ack" value={analytics.pendingAck} sub={analytics.draftCount ? `${analytics.draftCount} drafts` : "All acknowledged"} accent="bg-amber-50 text-amber-600" />
        <MetricCard icon={TrendingUp} label="Score Range" value={analytics.scores.length ? `${analytics.lowestScore.toFixed(0)}–${analytics.bestScore.toFixed(0)}%` : "—"} sub={analytics.scores.length > 1 ? `${analytics.scores.length} scored` : ""} accent="bg-emerald-50 text-emerald-600" />
      </div>

      {/* ─── Zone Distribution ───────────────────────────────────────── */}
      {zoneDistribution.length > 0 ? (
        <div className="rounded border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          <ZoneDistributionBar data={zoneDistribution} />
        </div>
      ) : null}

      {/* ─── Charts Row ──────────────────────────────────────────────── */}
      {(scoreTrend.length >= 2 || repComparison.length > 0) ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {scoreTrend.length >= 2 ? (
            <ScoreTrendChart
              data={scoreTrend}
              title={isTeamMode ? "Monthly score trend" : "My score progression"}
            />
          ) : null}
          {repComparison.length > 0 ? <RepComparisonChart data={repComparison} /> : null}
        </div>
      ) : null}

      {/* ─── Reports Table (desktop ≥480px) ──────────────────────────── */}
      <div className="hidden min-[480px]:block">
        <ReportsTable
          reports={filtered}
          isTeamMode={isTeamMode}
          focusedRow={focusedRow}
          onKeyNav={setFocusedRow}
        />
      </div>

      {/* ─── Mobile Card View (<480px) ───────────────────────────────── */}
      <div className="grid gap-2 min-[480px]:hidden">
        {filtered.length === 0 ? (
          <div className="rounded border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">No reports match the current filters.</div>
        ) : (
          filtered.map((report) => <MobileReportCard key={report.reportId} report={report} isTeamMode={isTeamMode} />)
        )}
      </div>
    </div>
  );
}
