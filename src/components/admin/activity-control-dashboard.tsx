"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  AlertCircle,
  Clock3,
  Download,
  Eye,
  Gauge,
  LayoutGrid,
  Loader2,
  Radio,
  RefreshCw,
  TriangleAlert,
  Users,
  X,
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
  UserActivitySummary,
  UserTimeline,
} from "@/lib/activity/types";
import type { EngagementBand } from "@/lib/activity/engagement";

const RANGE_OPTIONS = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

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
      title="Engagement = active time vs logged-in time, blended with how many modules and pages were used. It is a usage indicator, not a performance rating."
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
      title="No page-view activity recorded for this person yet. Tracking only captures navigation going forward."
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

  const days = initialDays;
  const overview = initialOverview;

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
          throw new Error(body?.message ?? "Failed to load timeline.");
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
              value={overview.kpis.onlineNow}
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
            {/* Who's online now */}
            <SectionCard
              icon={<Radio className="h-4 w-4" />}
              title="Who's online now"
              description={`${overview.online.length} active session${overview.online.length === 1 ? "" : "s"}`}
            >
              {overview.online.length ? (
                <div className="max-h-[360px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th className="px-4 py-2 text-left">User</th>
                        <th className="px-4 py-2 text-left">Current module</th>
                        <th className="px-4 py-2 text-right">Last active</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.online.map((user) => (
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-[#94A3B8]">No one is online right now.</p>
              )}
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
              <button
                type="button"
                onClick={() => setSelectedUser(null)}
                className="rounded-full p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
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
