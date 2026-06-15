"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Clock3,
  Download,
  Eye,
  Gauge,
  LayoutGrid,
  Loader2,
  Radio,
  RefreshCw,
  ShieldOff,
  TriangleAlert,
  Users,
  X,
  Zap,
} from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
} from "@/components/admin/admin-design-system";
import type {
  ActivityOverview,
  AdoptionStatus,
  LiveActivity,
  RoleBenchmark,
  UserActivitySummary,
  UserTimeline,
} from "@/lib/activity/types";
import type { EngagementBand } from "@/lib/activity/engagement";

const RANGE_OPTIONS = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_LABELS = ["12a", "3a", "6a", "9a", "12p", "3p", "6p", "9p"];

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatMinutes(minutes: number): string {
  if (!minutes || minutes <= 0) return "0m";
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB");
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

const BAND_STYLES: Record<EngagementBand, string> = {
  High: "border-emerald-300 bg-emerald-50 text-emerald-700",
  Moderate: "border-amber-300 bg-amber-50 text-amber-700",
  Low: "border-rose-300 bg-rose-50 text-rose-700",
};

function EngagementBadge({ band, score }: { band: EngagementBand; score: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${BAND_STYLES[band]}`}
      title="Engagement = active time vs logged-in time, blended with modules and pages visited. Usage indicator, not a performance rating."
    >
      <span className="tabular-nums">{score}</span>
      <span className="uppercase tracking-wide">{band}</span>
    </span>
  );
}

function NoDataChip() {
  return (
    <span
      className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-400"
      title="No page-view activity recorded yet. Tracking only captures navigation going forward."
    >
      No data yet
    </span>
  );
}

function SectionCard({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[14px] border border-[#E2E8F0] bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
      <div className="flex flex-col gap-3 border-b border-[#EEF2F7] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-[#FFF4EA] text-[#EA580C]">
            {icon}
          </span>
          <div>
            <h2 className="text-sm font-black tracking-tight text-[#0F172A]">{title}</h2>
            {description ? <p className="text-xs text-[#64748B]">{description}</p> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

const ADOPTION_TONE: Record<AdoptionStatus, string> = {
  active: "text-emerald-700",
  dormant: "text-amber-700",
  never: "text-rose-700",
};

// ── Heatmap calendar (52 weeks from the range's startedAt data) ──────────────

function HeatmapCalendar({ sessions }: { sessions: { startedAt: string }[] }) {
  const dateMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      if (!s.startedAt) continue;
      const key = s.startedAt.slice(0, 10); // YYYY-MM-DD
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [sessions]);

  const max = useMemo(() => Math.max(1, ...Array.from(dateMap.values())), [dateMap]);

  // Build 13 weeks (≈90 days) ending today.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weeks: { date: Date; key: string }[][] = [];
  const current = new Date(today);
  // Roll back to the Sunday of 12 weeks ago.
  current.setDate(current.getDate() - current.getDay() - 12 * 7);

  for (let w = 0; w < 13; w++) {
    const week: { date: Date; key: string }[] = [];
    for (let d = 0; d < 7; d++) {
      week.push({ date: new Date(current), key: current.toISOString().slice(0, 10) });
      current.setDate(current.getDate() + 1);
    }
    weeks.push(week);
  }

  function cellColor(count: number): string {
    if (!count) return "bg-slate-100";
    const ratio = count / max;
    if (ratio < 0.25) return "bg-orange-200";
    if (ratio < 0.5) return "bg-orange-300";
    if (ratio < 0.75) return "bg-orange-400";
    return "bg-orange-600";
  }

  return (
    <div>
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-[#94A3B8]">
        Login frequency — last 3 months (Cairo)
      </p>
      <div className="overflow-x-auto">
        <div className="flex gap-0.5">
          {/* Day labels */}
          <div className="flex flex-col gap-0.5 pr-1.5 pt-4">
            {WEEKDAY_LABELS.map((d) => (
              <div key={d} className="h-3 text-[9px] leading-3 text-[#94A3B8]">{d}</div>
            ))}
          </div>
          {/* Week columns */}
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-0.5">
              {/* Month label on first day of month */}
              <div className="h-3 text-[9px] leading-3 text-[#94A3B8]">
                {week[0].date.getDate() <= 7
                  ? week[0].date.toLocaleDateString("en-GB", { month: "short" })
                  : ""}
              </div>
              {week.map(({ date, key }) => {
                const count = dateMap.get(key) ?? 0;
                const isToday = key === today.toISOString().slice(0, 10);
                return (
                  <div
                    key={key}
                    className={`h-3 w-3 rounded-sm ${cellColor(count)} ${isToday ? "ring-1 ring-orange-500" : ""}`}
                    title={`${date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}: ${count} session${count === 1 ? "" : "s"}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[#94A3B8]">
        <span>Less</span>
        {["bg-slate-100", "bg-orange-200", "bg-orange-300", "bg-orange-400", "bg-orange-600"].map((c) => (
          <div key={c} className={`h-3 w-3 rounded-sm ${c}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

// ── Time-of-Day heatmap (7 weekdays × 24 hours) ───────────────────────────────

function TimeOfDayHeatmap({ hourlyHeatmap }: { hourlyHeatmap: number[][] }) {
  const max = useMemo(() => Math.max(1, ...hourlyHeatmap.flatMap((row) => row)), [hourlyHeatmap]);

  function cellColor(count: number): string {
    if (!count) return "bg-slate-100";
    const ratio = count / max;
    if (ratio < 0.2) return "bg-blue-100";
    if (ratio < 0.4) return "bg-blue-200";
    if (ratio < 0.6) return "bg-blue-400";
    if (ratio < 0.8) return "bg-blue-500";
    return "bg-blue-700";
  }

  return (
    <div className="px-5 py-4">
      <div className="overflow-x-auto">
        {/* Hour labels */}
        <div className="mb-1 flex gap-0.5 pl-10">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="w-5 text-center text-[8px] text-[#94A3B8]">
              {HOUR_LABELS[Math.floor(h / 3)] && h % 3 === 0 ? HOUR_LABELS[h / 3] : ""}
            </div>
          ))}
        </div>
        {/* Rows */}
        {WEEKDAY_LABELS.map((day, wi) => (
          <div key={day} className="mb-0.5 flex items-center gap-0.5">
            <div className="w-9 text-right text-[10px] text-[#64748B]">{day}</div>
            <div className="ml-1 flex gap-0.5">
              {hourlyHeatmap[wi].map((count, h) => (
                <div
                  key={h}
                  className={`h-5 w-5 rounded-sm ${cellColor(count)}`}
                  title={`${day} ${h}:00 — ${count} login${count === 1 ? "" : "s"}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[10px] text-[#94A3B8]">
        <span>Quiet</span>
        {["bg-slate-100", "bg-blue-100", "bg-blue-200", "bg-blue-400", "bg-blue-700"].map((c) => (
          <div key={c} className={`h-3 w-3 rounded-sm ${c}`} />
        ))}
        <span>Busy</span>
        <span className="ml-2">· Cairo (EET)</span>
      </div>
    </div>
  );
}

// ── Role benchmarks table ─────────────────────────────────────────────────────

function RoleBenchmarksTable({ benchmarks }: { benchmarks: RoleBenchmark[] }) {
  const maxActive = Math.max(1, ...benchmarks.map((b) => b.avgActiveMinutes));

  if (!benchmarks.length) {
    return <p className="px-5 py-8 text-center text-sm text-[#94A3B8]">No data yet.</p>;
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="px-4 py-2 text-left">Role</th>
            <th className="px-4 py-2 text-right">Users</th>
            <th className="px-4 py-2 text-right">Avg session</th>
            <th className="px-4 py-2 text-right">Avg active</th>
            <th className="px-4 py-2 text-left" colSpan={2}>Avg engagement</th>
          </tr>
        </thead>
        <tbody>
          {benchmarks.map((b) => (
            <tr key={b.role} className="border-t border-[#F1F5F9]">
              <td className="px-4 py-2 font-semibold text-[#0F172A]">{b.role}</td>
              <td className="px-4 py-2 text-right tabular-nums text-[#334155]">{b.userCount}</td>
              <td className="px-4 py-2 text-right tabular-nums text-[#334155]">{formatMinutes(b.avgSessionMinutes)}</td>
              <td className="px-4 py-2 text-right tabular-nums font-semibold text-[#0F172A]">{formatMinutes(b.avgActiveMinutes)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-[#334155] w-12">{b.avgEngagementScore > 0 ? b.avgEngagementScore : "—"}</td>
              <td className="px-4 py-2 w-28">
                {b.avgEngagementScore > 0 ? (
                  <div className="relative h-2 w-full overflow-hidden rounded-full bg-[#F1F5F9]">
                    <div
                      className={`h-full rounded-full ${
                        b.avgEngagementScore >= 66
                          ? "bg-emerald-500"
                          : b.avgEngagementScore >= 33
                          ? "bg-amber-400"
                          : "bg-rose-400"
                      }`}
                      style={{ width: `${b.avgEngagementScore}%` }}
                    />
                  </div>
                ) : null}
                <div className="h-2 w-full overflow-hidden rounded-full bg-[#F1F5F9]" style={{ display: b.avgEngagementScore > 0 ? "none" : "block" }}>
                  <div className="h-full w-full rounded-full bg-[#F97316]" style={{ width: `${(b.avgActiveMinutes / maxActive) * 100}%` }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Force-logout confirmation dialog ─────────────────────────────────────────

function ForceLogoutDialog({
  name,
  onConfirm,
  onCancel,
  isPending,
}: {
  name: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [reason, setReason] = useState("Security review");
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-[14px] bg-white shadow-2xl">
        <div className="border-b border-[#EEF2F7] px-5 py-4">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-rose-500">Force logout</p>
          <h3 className="mt-0.5 text-base font-black text-[#0F172A]">{name}</h3>
          <p className="mt-1 text-xs text-[#64748B]">
            All active sessions for this person will be immediately terminated. They will be asked to log in again on their next action.
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-bold uppercase tracking-wide text-[#64748B]">Reason (logged to audit trail)</span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-[8px] border border-[#E2E8F0] px-3 py-2 text-sm text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-1 focus:ring-[#F97316]"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="flex-1 rounded-[8px] border border-[#E2E8F0] py-2 text-sm font-semibold text-[#64748B] transition hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onConfirm(reason)}
              disabled={isPending || !reason.trim()}
              className="flex-1 rounded-[8px] bg-rose-600 py-2 text-sm font-bold text-white transition hover:bg-rose-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}
              Force logout
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function ActivityControlDashboard({
  initialOverview,
  initialError,
  initialDays,
}: {
  initialOverview: ActivityOverview | null;
  initialError: string | null;
  initialDays: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const [selectedUser, setSelectedUser] = useState<UserActivitySummary | null>(null);
  const [timeline, setTimeline] = useState<UserTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  // Live feed state
  const [liveData, setLiveData] = useState<LiveActivity | null>(null);
  const liveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Force-logout state
  const [forceLogoutTarget, setForceLogoutTarget] = useState<{ name: string; hrId: string } | null>(null);
  const [forceLogoutPending, setForceLogoutPending] = useState(false);
  const [forceLogoutFeedback, setForceLogoutFeedback] = useState<string | null>(null);

  const days = initialDays;
  const overview = initialOverview;

  // ── Live feed polling ──────────────────────────────────────────────────────
  // fetchLive is used by handleForceLogout (below) to refresh after a kick.
  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/activity/live", { credentials: "same-origin" });
      if (!res.ok) return;
      const body = (await res.json()) as { live: LiveActivity };
      setLiveData(body.live);
    } catch {
      // silently degrade — live feed is non-critical
    }
  }, []);

  useEffect(() => {
    // Inline poll so the effect does not hold a direct setState call in its synchronous body.
    let active = true;
    function poll() {
      fetch("/api/admin/activity/live", { credentials: "same-origin" })
        .then((r) => (r.ok ? (r.json() as Promise<{ live: LiveActivity }>) : null))
        .then((body) => { if (active && body?.live) setLiveData(body.live); })
        .catch(() => {});
    }
    poll();
    liveIntervalRef.current = setInterval(poll, 30_000);
    return () => {
      active = false;
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);
    };
  }, []);

  // ── Force logout ───────────────────────────────────────────────────────────
  const handleForceLogout = useCallback(async (reason: string) => {
    if (!forceLogoutTarget) return;
    setForceLogoutPending(true);
    try {
      const res = await fetch("/api/admin/activity/force-logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "x-phoenix-csrf": "1" },
        body: JSON.stringify({ hrId: forceLogoutTarget.hrId, reason }),
      });
      const body = (await res.json()) as { ok?: boolean; revokedCount?: number; message?: string };
      if (!res.ok) throw new Error(body.message ?? "Force logout failed");
      setForceLogoutFeedback(`${forceLogoutTarget.name} has been logged out (${body.revokedCount ?? 0} session${(body.revokedCount ?? 0) === 1 ? "" : "s"} terminated).`);
      setForceLogoutTarget(null);
      // Refresh live feed immediately.
      setTimeout(fetchLive, 1000);
    } catch (caught) {
      setForceLogoutFeedback(caught instanceof Error ? caught.message : "Force logout failed.");
    } finally {
      setForceLogoutPending(false);
    }
  }, [forceLogoutTarget, fetchLive]);

  const changeRange = useCallback(
    (nextDays: number) => {
      startTransition(() => {
        router.push(`${pathname}?days=${nextDays}`);
      });
    },
    [pathname, router],
  );

  const openTimeline = useCallback(
    async (user: UserActivitySummary) => {
      if (!user.hrId) return;
      setSelectedUser(user);
      setTimeline(null);
      setTimelineError(null);
      setTimelineLoading(true);
      try {
        const res = await fetch(`/api/admin/activity/timeline?hrId=${encodeURIComponent(user.hrId)}&days=${days}`, {
          credentials: "same-origin",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { message?: string })?.message ?? "Failed to load timeline.");
        }
        const body = (await res.json()) as { timeline: UserTimeline };
        setTimeline(body.timeline);
      } catch (caught) {
        setTimelineError(caught instanceof Error ? caught.message : "Failed to load timeline.");
      } finally {
        setTimelineLoading(false);
      }
    },
    [days],
  );

  const rangeLabel = useMemo(
    () => RANGE_OPTIONS.find((option) => option.days === days)?.label ?? `${days} days`,
    [days],
  );

  // Prefer live data for the online section when available.
  const displayedOnline = liveData?.online ?? overview?.online ?? [];

  const heroActions = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center rounded-full border border-white/20 bg-white/10 p-0.5 backdrop-blur">
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option.days}
            type="button"
            onClick={() => changeRange(option.days)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              option.days === days ? "bg-[#F97316] text-white" : "text-slate-200 hover:text-white"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <a
        href={`/api/admin/activity/export?days=${days}`}
        className="inline-flex items-center gap-2 rounded-full bg-[#F97316] px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(249,115,22,0.32)] transition hover:bg-[#EA580C]"
      >
        <Download className="h-4 w-4" />
        Export
      </a>
      <button
        type="button"
        onClick={() => changeRange(days)}
        className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-2 text-sm font-semibold text-slate-100 backdrop-blur transition hover:bg-white/[0.16]"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Refresh
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Activity"
        icon={<Activity className="h-3.5 w-3.5" />}
        title="Activity Control Center"
        description="See who is using the system, how long they stay, which modules they spend time in, and a fair engagement signal — all from existing sessions and lightweight page tracking."
        actions={heroActions}
        badges={
          <>
            <span>Window: {rangeLabel}</span>
            {overview ? <span>· Updated {formatRelative(overview.generatedAtIso)}</span> : null}
            <span>· Module-level · no keystrokes or contents</span>
          </>
        }
      />

      {forceLogoutFeedback ? (
        <AdminCallout tone="warning">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex flex-1 items-center justify-between">
            <p className="text-xs">{forceLogoutFeedback}</p>
            <button type="button" onClick={() => setForceLogoutFeedback(null)} className="ml-4 text-xs underline">Dismiss</button>
          </div>
        </AdminCallout>
      ) : null}

      {initialError ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-bold">Could not load activity data</p>
            <p className="font-mono text-xs">{initialError}</p>
          </div>
        </AdminCallout>
      ) : null}

      {overview ? (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <AdminStatCard
              icon={<Radio className="h-5 w-5" />}
              label="Online now"
              value={displayedOnline.length}
              description="Active sessions right now"
              tone="emerald"
              size="compact"
            />
            <AdminStatCard
              icon={<Users className="h-5 w-5" />}
              label="Active users"
              value={overview.kpis.activeUsers}
              description={`Used the system in ${rangeLabel.toLowerCase()}`}
              tone="blue"
              size="compact"
            />
            <AdminStatCard
              icon={<Activity className="h-5 w-5" />}
              label="Sessions"
              value={overview.kpis.sessions}
              description="Logins in the window"
              tone="orange"
              size="compact"
            />
            <AdminStatCard
              icon={<Clock3 className="h-5 w-5" />}
              label="Avg session"
              value={formatMinutes(overview.kpis.avgSessionMinutes)}
              description="Logged-in time per session"
              tone="violet"
              size="compact"
            />
            <AdminStatCard
              icon={<Gauge className="h-5 w-5" />}
              label="Avg active / user"
              value={formatMinutes(overview.kpis.avgActiveMinutesPerUser)}
              description="Hands-on time per person"
              tone="orange"
              size="compact"
            />
            <AdminStatCard
              icon={<LayoutGrid className="h-5 w-5" />}
              label="Top module"
              value={overview.kpis.topModuleLabel ?? "—"}
              description="Most time spent"
              tone="rose"
              size="compact"
            />
          </div>

          {overview.kpis.totalPageViews < 25 ? (
            <AdminCallout tone="warning">
              <Activity className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-xs leading-5">
                <strong>Engagement &amp; module data is still warming up.</strong> Page-by-page tracking
                only just started, so active-time, module popularity, and engagement scores will be sparse
                until people navigate the system over the coming hours and days. <strong>Sessions, online,
                and adoption figures are accurate right now.</strong>
              </p>
            </AdminCallout>
          ) : null}

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {/* Who's online now — LIVE, auto-refreshes every 30s */}
            <SectionCard
              icon={<Radio className="h-4 w-4" />}
              title="Who's online now"
              description={`${displayedOnline.length} active · refreshes every 30s`}
              action={
                <div className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  <span className="text-[11px] font-bold text-emerald-600 uppercase tracking-wide">Live</span>
                </div>
              }
            >
              {displayedOnline.length ? (
                <div className="max-h-[360px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th className="px-4 py-2 text-left">User</th>
                        <th className="px-4 py-2 text-left">Current module</th>
                        <th className="px-4 py-2 text-right">Last active</th>
                        <th className="px-4 py-2 text-right"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedOnline.map((user) => (
                        <tr key={`${user.key}-${user.startedAt}`}>
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#0F172A] text-[10px] font-bold text-white">
                                {initialsFor(user.name)}
                              </span>
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-[#0F172A]">{user.name}</p>
                                <p className="truncate text-[11px] text-[#64748B]">{user.role}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-2 text-[#334155]">{user.currentModule ?? "—"}</td>
                          <td className="px-4 py-2 text-right text-[#64748B]">{formatRelative(user.lastSeenAt)}</td>
                          <td className="px-4 py-2 text-right">
                            {user.hrId ? (
                              <button
                                type="button"
                                onClick={() => setForceLogoutTarget({ name: user.name, hrId: user.hrId! })}
                                className="inline-flex items-center gap-1 rounded-full border border-rose-200 px-2.5 py-1 text-[11px] font-semibold text-rose-600 transition hover:bg-rose-50"
                                title="Force logout this user"
                              >
                                <ShieldOff className="h-3 w-3" /> Logout
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-[#94A3B8]">No one is online right now.</p>
              )}

              {/* Recent navigation events */}
              {liveData?.recentEvents.length ? (
                <div className="border-t border-[#EEF2F7]">
                  <div className="flex items-center gap-2 px-5 py-2.5">
                    <Zap className="h-3.5 w-3.5 text-[#F97316]" />
                    <p className="text-[11px] font-bold uppercase tracking-wide text-[#64748B]">Recent navigation (last 15 min)</p>
                  </div>
                  <div className="divide-y divide-[#F8FAFC]">
                    {liveData.recentEvents.slice(0, 8).map((event, i) => (
                      <div key={i} className="flex items-center justify-between px-5 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#F97316] shrink-0" />
                          <span className="truncate text-xs text-[#0F172A] font-semibold">{event.name}</span>
                          <span className="text-xs text-[#64748B]">→</span>
                          <span className="truncate text-xs text-[#334155]">{event.moduleLabel}</span>
                        </div>
                        <span className="ml-3 shrink-0 text-[11px] text-[#94A3B8]">{formatRelative(event.occurredAtIso)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </SectionCard>

            {/* Module popularity */}
            <SectionCard
              icon={<LayoutGrid className="h-4 w-4" />}
              title="Module popularity"
              description="Where employees spend their time"
            >
              {overview.modulePopularity.length ? (
                <div className="space-y-2.5 px-5 py-4">
                  {overview.modulePopularity.slice(0, 10).map((module) => (
                    <div key={module.key} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-[#0F172A]">{module.label}</span>
                        <span className="tabular-nums text-[#64748B]">
                          {formatMinutes(module.activeMinutes)} · {module.distinctUsers} user{module.distinctUsers === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-[#F1F5F9]">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#F97316] to-[#FB923C]"
                          style={{ width: `${Math.max(2, Math.min(100, module.sharePct))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-[#94A3B8]">
                  No page activity recorded yet. Data appears as people navigate the system.
                </p>
              )}
            </SectionCard>
          </div>

          {/* Time-of-Day heatmap */}
          <SectionCard
            icon={<Clock3 className="h-4 w-4" />}
            title="When is the system used?"
            description="Login frequency by day and hour (Cairo time) — great for scheduling maintenance"
          >
            <TimeOfDayHeatmap hourlyHeatmap={overview.hourlyHeatmap} />
          </SectionCard>

          {/* Top users + engagement */}
          <SectionCard
            icon={<Gauge className="h-4 w-4" />}
            title="People — engagement & usage"
            description="Is this person really working? Active time, modules touched, and a fair engagement band."
            action={<AdminInsightChip tone="orange" surface="light">Top {overview.topUsers.length}</AdminInsightChip>}
          >
            {overview.topUsers.length ? (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="px-4 py-2 text-left">Employee</th>
                      <th className="px-4 py-2 text-right">Logins</th>
                      <th className="px-4 py-2 text-right">Logged-in</th>
                      <th className="px-4 py-2 text-right">Active</th>
                      <th className="px-4 py-2 text-right">Modules</th>
                      <th className="px-4 py-2 text-left">Top module</th>
                      <th className="px-4 py-2 text-center">Engagement</th>
                      <th className="px-4 py-2 text-right">Last seen</th>
                      <th className="px-4 py-2 text-right"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.topUsers.map((user) => (
                      <tr key={user.key}>
                        <td className="px-4 py-2">
                          <p className="font-semibold text-[#0F172A]">{user.name}</p>
                          <p className="text-[11px] text-[#64748B]">{user.role}{user.team ? ` · ${user.team}` : ""}</p>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-[#334155]">{user.sessions}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-[#334155]">{formatMinutes(user.sessionMinutes)}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold text-[#0F172A]">{user.pageViews > 0 ? formatMinutes(user.activeMinutes) : "—"}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-[#334155]">{user.distinctModules}</td>
                        <td className="px-4 py-2 text-[#334155]">{user.topModule ?? "—"}</td>
                        <td className="px-4 py-2 text-center">
                          {user.pageViews > 0 ? (
                            <EngagementBadge band={user.engagement.band} score={user.engagement.score} />
                          ) : (
                            <NoDataChip />
                          )}
                        </td>
                        <td className="px-4 py-2 text-right text-[#64748B]">{formatRelative(user.lastSeenAt)}</td>
                        <td className="px-4 py-2 text-right">
                          {user.hrId ? (
                            <button
                              type="button"
                              onClick={() => openTimeline(user)}
                              className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] px-2.5 py-1 text-[11px] font-semibold text-[#C2410C] transition hover:bg-[#FFF7ED]"
                            >
                              <Eye className="h-3.5 w-3.5" /> Timeline
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-[#94A3B8]">No user activity in this window yet.</p>
            )}
            <div className="border-t border-[#EEF2F7] px-5 py-3">
              <AdminCallout tone="neutral">
                <Gauge className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-xs leading-5">
                  <strong>How to read engagement.</strong> It blends active-vs-logged-in time (most weight),
                  how many modules were touched, and how many pages were opened — into a 0–100 score and a band.
                  It reflects <em>system usage</em>, not the quality of someone&apos;s work or anything done off-system.
                </p>
              </AdminCallout>
            </div>
          </SectionCard>

          {/* Role benchmarks */}
          <SectionCard
            icon={<BarChart3 className="h-4 w-4" />}
            title="Role benchmarks"
            description="Average session time, active time, and engagement score by role"
          >
            <RoleBenchmarksTable benchmarks={overview.roleBenchmarks} />
          </SectionCard>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {/* Adoption */}
            <SectionCard
              icon={<Users className="h-4 w-4" />}
              title="Adoption — who isn't using the system"
              description={`Active ${overview.adoption.counts.active} · Dormant ${overview.adoption.counts.dormant} · Never ${overview.adoption.counts.never}`}
            >
              {overview.adoption.rows.filter((row) => row.status !== "active").length ? (
                <div className="max-h-[360px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th className="px-4 py-2 text-left">Employee</th>
                        <th className="px-4 py-2 text-left">Status</th>
                        <th className="px-4 py-2 text-right">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.adoption.rows
                        .filter((row) => row.status !== "active")
                        .slice(0, 60)
                        .map((row) => (
                          <tr key={row.key}>
                            <td className="px-4 py-2">
                              <p className="font-semibold text-[#0F172A]">{row.name}</p>
                              <p className="text-[11px] text-[#64748B]">{row.role}</p>
                            </td>
                            <td className={`px-4 py-2 font-semibold capitalize ${ADOPTION_TONE[row.status]}`}>
                              {row.status === "never" ? "Never (90d)" : row.status}
                            </td>
                            <td className="px-4 py-2 text-right text-[#64748B]">
                              {row.lastSeenAt ? formatRelative(row.lastSeenAt) : "—"}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-[#94A3B8]">Every account has been active recently. 🎉</p>
              )}
            </SectionCard>

            {/* Anomalies */}
            <SectionCard
              icon={<TriangleAlert className="h-4 w-4" />}
              title="Anomalies"
              description="Concurrent logins and odd-hour access"
            >
              {overview.anomalies.length ? (
                <div className="max-h-[360px] divide-y divide-[#EEF2F7] overflow-auto">
                  {overview.anomalies.map((anomaly) => (
                    <div key={anomaly.id} className="flex items-start gap-3 px-5 py-3">
                      <span
                        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                          anomaly.severity === "warning" ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-600"
                        }`}
                      >
                        <TriangleAlert className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[#0F172A]">{anomaly.identity.name}</p>
                        <p className="text-xs text-[#64748B]">{anomaly.detail}</p>
                        <p className="text-[11px] text-[#94A3B8]">{formatDateTime(anomaly.occurredAt)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-[#94A3B8]">No anomalies detected in this window.</p>
              )}
            </SectionCard>
          </div>
        </>
      ) : null}

      {/* Timeline drawer */}
      {selectedUser ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setSelectedUser(null)}>
          <div
            className="h-full w-full max-w-xl overflow-auto bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#EEF2F7] bg-[#0F172A] px-5 py-4 text-white">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-orange-300">Activity timeline</p>
                <h3 className="text-lg font-black">{selectedUser.name}</h3>
                <p className="text-xs text-slate-300">{selectedUser.role}{selectedUser.team ? ` · ${selectedUser.team}` : ""} · last {rangeLabel.toLowerCase()}</p>
              </div>
              <div className="flex items-center gap-2">
                {selectedUser.hrId ? (
                  <button
                    type="button"
                    onClick={() => setForceLogoutTarget({ name: selectedUser.name, hrId: selectedUser.hrId! })}
                    className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/30 bg-rose-500/20 px-3 py-1.5 text-[11px] font-bold text-rose-300 transition hover:bg-rose-500/30"
                  >
                    <ShieldOff className="h-3.5 w-3.5" /> Force logout
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setSelectedUser(null)}
                  className="rounded-full p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="space-y-4 p-5">
              {timelineLoading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-[#64748B]">
                  <Loader2 className="h-5 w-5 animate-spin" /> Loading timeline…
                </div>
              ) : timelineError ? (
                <AdminCallout tone="danger">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                  <p className="text-sm">{timelineError}</p>
                </AdminCallout>
              ) : timeline ? (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <SummaryTile label="Logins" value={String(timeline.summary.sessions)} />
                    <SummaryTile label="Active" value={formatMinutes(timeline.summary.activeMinutes)} />
                    <SummaryTile label="Modules" value={String(timeline.summary.distinctModules)} />
                    <SummaryTile label="Pages" value={String(timeline.summary.pageViews)} />
                  </div>

                  {/* Engagement signal */}
                  <div className="flex items-center justify-between rounded-[12px] border border-[#E2E8F0] bg-[#FBFCFD] px-4 py-3">
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wide text-[#94A3B8]">Engagement signal</p>
                      <p className="text-xs text-[#64748B]">
                        {timeline.summary.pageViews > 0
                          ? `Active ${Math.round(timeline.summary.engagement.activeRatio * 100)}% of logged-in time · top module ${timeline.summary.topModule ?? "—"}`
                          : "No page-view activity recorded yet — it appears here as they navigate the system."}
                      </p>
                    </div>
                    {timeline.summary.pageViews > 0 ? (
                      <EngagementBadge band={timeline.summary.engagement.band} score={timeline.summary.engagement.score} />
                    ) : (
                      <NoDataChip />
                    )}
                  </div>

                  {/* Login heatmap calendar */}
                  <div className="rounded-[12px] border border-[#E2E8F0] bg-[#FBFCFD] px-4 py-3">
                    <HeatmapCalendar sessions={timeline.sessions} />
                  </div>

                  {timeline.sessions.length ? (
                    <div className="space-y-3">
                      {timeline.sessions.map((session, index) => (
                        <div key={session.sessionId ?? `loose-${index}`} className="rounded-[12px] border border-[#E2E8F0]">
                          <div className="flex items-center justify-between border-b border-[#EEF2F7] px-4 py-2.5">
                            <div className="flex items-center gap-2 text-sm">
                              <Clock3 className="h-4 w-4 text-[#EA580C]" />
                              <span className="font-semibold text-[#0F172A]">{formatDateTime(session.startedAt)}</span>
                            </div>
                            <span className="text-xs text-[#64748B]">
                              {formatMinutes(session.durationMinutes)} session · {formatMinutes(session.activeMinutes)} active · {session.endedReason}
                            </span>
                          </div>
                          {session.modules.length ? (
                            <div className="flex flex-wrap gap-1.5 px-4 py-3">
                              {session.modules.map((module) => (
                                <span
                                  key={module.label}
                                  className="inline-flex items-center gap-1 rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-2.5 py-1 text-[11px] font-semibold text-[#9A3412]"
                                >
                                  {module.label}
                                  <span className="text-[#C2410C]/70">{formatMinutes(module.minutes)}</span>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <p className="px-4 py-3 text-xs text-[#94A3B8]">No page views recorded for this session.</p>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="py-8 text-center text-sm text-[#94A3B8]">
                      No detailed page activity yet for this person. Sessions appear here as they navigate the system.
                    </p>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Force-logout confirmation dialog */}
      {forceLogoutTarget ? (
        <ForceLogoutDialog
          name={forceLogoutTarget.name}
          onConfirm={handleForceLogout}
          onCancel={() => setForceLogoutTarget(null)}
          isPending={forceLogoutPending}
        />
      ) : null}
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[12px] border border-[#E2E8F0] bg-white px-3 py-2.5 text-center">
      <p className="text-[10px] font-bold uppercase tracking-wide text-[#94A3B8]">{label}</p>
      <p className="text-lg font-black text-[#0F172A]">{value}</p>
    </div>
  );
}
