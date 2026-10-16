"use client";

import { AlertTriangle, Bell, Check, Globe, Loader2, Lock, Search, ServerCog, ShieldAlert, ShieldCheck, Sparkles, UsersRound, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { computeNewlyArrivedIds } from "@/lib/error-monitor/new-issue-diff";
import { useHydrated } from "@/hooks/use-hydrated";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import type { ErrorEventRowWithStatus, UnknownAttemptsSummary, UserAttemptRowWithStatus } from "@/lib/error-monitor/system-issues";
import type { IssueStatus } from "@/lib/error-monitor/derived-status";
import type { ClusterSummary, ErrorExplanation } from "@/lib/error-monitor/ai-triage";
import type { DeployTimeline, LoginSecuritySignals, ReproTrailEntry } from "@/lib/error-monitor/service";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

type ExplainState = { loading: boolean; error: string | null; data: ErrorExplanation | null };
type SummaryState = { loading: boolean; error: string | null; data: ClusterSummary | null };
type TrailState = { loading: boolean; error: string | null; entries: ReproTrailEntry[] | null };
type SecurityState = { loading: boolean; error: string | null; data: LoginSecuritySignals | null; canManage: boolean };
type TimelineState = { loading: boolean; error: string | null; data: DeployTimeline | null };

const POLL_INTERVAL_MS = 30_000;
const TOAST_BATCH_THRESHOLD = 3;

type StatusFilter = "all" | "unresolved" | "resolved";
const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { label: "All", value: "all" },
  { label: "Unresolved", value: "unresolved" },
  { label: "Resolved", value: "resolved" },
];

function matchesStatusFilter(status: IssueStatus, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "resolved") return status === "resolved";
  return status === "active";
}

function StatusFilterPills({
  value,
  onChange,
  shownCount,
  totalCount,
}: {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
  shownCount: number;
  totalCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex rounded-xl border border-phx-line bg-phx-paper p-1">
        {STATUS_FILTERS.map((option) => (
          <button
            className={`rounded-lg px-3 py-1.5 text-phx-xs font-black transition ${
              value === option.value
                ? "bg-[#0B0B0B] text-white shadow-[0_6px_14px_rgba(15,23,42,0.18)]"
                : "text-phx-ink-soft hover:text-orange-700"
            }`}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      <span className="text-xs font-semibold text-phx-ink-soft">
        {shownCount.toLocaleString("en-US")} of {totalCount.toLocaleString("en-US")} shown
      </span>
    </div>
  );
}

function formatDate(iso: string) {
  try {
    return formatStableEnGb(new Date(iso), {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      second: "2-digit",
      year: "numeric",
      timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    });
  } catch {
    return iso;
  }
}

type MergedIssueRow = {
  id: string;
  timestamp: string;
  origin: "app" | "gcp";
  severity: string;
  hrId: string | null;
  moduleKey: string;
  moduleLabel: string;
  message: string;
  displayMessage: string;
  route: string | null;
  status: IssueStatus;
  stack: string | null;
  employeeName: string | null;
};

function severityBadgeClasses(severity: string) {
  const upper = severity.toUpperCase();
  if (upper === "CRITICAL" || upper === "ALERT" || upper === "EMERGENCY") {
    return "bg-rose-100 text-rose-700 ring-rose-200";
  }
  if (upper === "ERROR") return "bg-red-50 text-red-600 ring-red-100";
  if (upper === "WARNING") return "bg-amber-50 text-amber-700 ring-amber-100";
  return "bg-slate-100 text-slate-600 ring-slate-200";
}

function StatusBadge({ status }: { status: IssueStatus }) {
  if (status === "resolved") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-phx-ok-bg px-2.5 py-1 text-phx-xs font-bold text-phx-ok ring-1 ring-phx-ok-line">
        <Check className="h-3 w-3" />
        Resolved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-phx-warn-bg px-2.5 py-1 text-phx-xs font-bold text-phx-warn ring-1 ring-phx-warn-line">
      <AlertTriangle className="h-3 w-3" />
      Active
    </span>
  );
}

function accountLabel(hrId: string, name: string | null): string {
  return name ? `${name} (${hrId})` : hrId;
}

function DeployTimelinePanel({ state }: { state: TimelineState }) {
  if (state.loading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-phx-line bg-white/95 p-4 text-xs font-semibold text-phx-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin text-phx-accent" /> Building deploy timeline…
      </div>
    );
  }
  const t = state.data;
  if (state.error || !t || t.buckets.length === 0) return null;

  const maxCount = Math.max(1, ...t.buckets.map((b) => b.count));
  const n = t.buckets.length;
  const dayIndex = new Map(t.buckets.map((b, i) => [b.day, i]));
  const markerLines = t.markers
    .map((m) => ({ ...m, idx: dayIndex.get(m.firstSeen.slice(0, 10)) }))
    .filter((m): m is DeployMarkerWithIdx => m.idx !== undefined);

  return (
    <div className="rounded-2xl border border-phx-line bg-white/95 p-4 shadow-[0_10px_28px_rgba(15,23,42,0.06)]">
      <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.18em] text-phx-ink-soft">
        Errors per day — last {t.windowDays} days · dashed lines = deploys
      </p>
      <svg className="h-20 w-full" preserveAspectRatio="none" viewBox="0 0 100 30">
        {t.buckets.map((b, i) => {
          const h = (b.count / maxCount) * 24;
          const bw = 100 / n;
          return <rect fill="#F97316" height={h} key={b.day} width={bw * 0.6} x={i * bw + bw * 0.2} y={26 - h} />;
        })}
        {markerLines.map((m, i) => {
          const bw = 100 / n;
          const x = (m.idx + 0.5) * bw;
          return <line key={`${m.release}-${i}`} stroke="#7C3AED" strokeDasharray="1.5 1" strokeWidth={0.4} x1={x} x2={x} y1={0} y2={26} />;
        })}
        <line stroke="#E2E8F0" strokeWidth={0.4} x1={0} x2={100} y1={26} y2={26} />
      </svg>
      <div className="mt-1 flex items-center justify-between text-phx-2xs font-mono text-slate-400">
        <span>{t.buckets[0]?.day}</span>
        <span>{t.buckets[t.buckets.length - 1]?.day}</span>
      </div>
      {t.markers.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {t.markers.slice(-8).map((m) => (
            <span className="rounded-full bg-phx-info-bg px-2 py-0.5 font-mono text-phx-3xs font-bold text-phx-info ring-1 ring-phx-info-line" key={m.release}>
              {m.release}
            </span>
          ))}
        </div>
      )}
      {t.regressions.length > 0 && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50/60 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-phx-xs font-black text-rose-700">
            <AlertTriangle className="h-3.5 w-3.5" /> Regressions — came back after a deploy ({t.regressions.length})
          </p>
          <ul className="space-y-1">
            {t.regressions.slice(0, 10).map((r, i) => (
              <li className="flex items-center justify-between gap-2 text-xs" key={`${r.moduleLabel}-${r.route}-${i}`}>
                <span className="font-bold text-phx-ink">
                  {r.moduleLabel}
                  {r.route && <span className="ml-1 font-mono text-phx-2xs font-normal text-phx-ink-soft">{r.route}</span>}
                </span>
                <span className="whitespace-nowrap font-mono text-phx-2xs text-rose-600">
                  quiet {r.gapReleases} deploy{r.gapReleases > 1 ? "s" : ""}, back on {r.currentRelease}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

type DeployMarkerWithIdx = { release: string; firstSeen: string; idx: number };

function SecurityLens({
  state,
  onRetry,
  canManage,
  onManageIp,
}: {
  state: SecurityState;
  onRetry: () => void;
  canManage: boolean;
  onManageIp: (ip: string, action: "block" | "unblock") => void;
}) {
  if (state.loading) {
    return (
      <div className="flex items-center gap-2 rounded-3xl border border-phx-line bg-white/95 p-4 text-xs font-semibold text-phx-ink-soft shadow-[0_10px_28px_rgba(15,23,42,0.06)]">
        <Loader2 className="h-4 w-4 animate-spin text-phx-accent" /> Scanning login activity for security signals…
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-3xl border border-rose-200 bg-rose-50 p-4 text-xs font-semibold text-rose-700">
        <span>{state.error}</span>
        <button className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 font-black hover:bg-rose-100" onClick={onRetry} type="button">
          Retry
        </button>
      </div>
    );
  }
  const s = state.data;
  if (!s) return null;

  const total = s.lockedAccounts.length + s.hammeredAccounts.length + s.bruteForceIps.length + s.newLocationLogins.length + s.blockedIps.length;
  if (total === 0) {
    return (
      <div className="flex items-center gap-2 rounded-3xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-bold text-emerald-700 shadow-[0_10px_28px_rgba(16,185,129,0.06)]">
        <ShieldCheck className="h-4 w-4" /> No login-security signals in the last {s.windowDays} days — all clear.
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-phx-line bg-white/95 p-5 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
      <p className="mb-3 flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.18em] text-phx-ink-soft">
        <ShieldAlert className="h-3.5 w-3.5 text-rose-500" /> Security lens — last {s.windowDays} days
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {s.lockedAccounts.length > 0 && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50/50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-phx-xs font-black text-rose-700">
              <Lock className="h-3.5 w-3.5" /> Currently locked ({s.lockedAccounts.length})
            </p>
            <ul className="space-y-1">
              {s.lockedAccounts.map((a) => (
                <li className="flex items-center justify-between gap-2 text-xs" key={a.hrId}>
                  <span className="font-bold text-phx-ink">{accountLabel(a.hrId, a.name)}</span>
                  <span className="whitespace-nowrap font-mono text-phx-2xs text-rose-600">
                    {a.failedAttempts} fails · until {formatDate(a.lockedUntil)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.hammeredAccounts.length > 0 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-phx-xs font-black text-amber-700">
              <UsersRound className="h-3.5 w-3.5" /> Accounts under attack ({s.hammeredAccounts.length})
            </p>
            <ul className="space-y-1">
              {s.hammeredAccounts.map((a) => (
                <li className="flex items-center justify-between gap-2 text-xs" key={a.hrId}>
                  <span className="font-bold text-phx-ink">
                    {accountLabel(a.hrId, a.name)}
                    {a.distributed && <span className="ml-1.5 rounded-full bg-phx-danger-bg px-1.5 py-0.5 text-phx-3xs font-black text-phx-danger">DISTRIBUTED</span>}
                  </span>
                  <span className="whitespace-nowrap font-mono text-phx-2xs text-amber-700">{a.failCount} fails · {a.distinctIps} IPs</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.bruteForceIps.length > 0 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-phx-xs font-black text-amber-700">
              <Globe className="h-3.5 w-3.5" /> Suspicious IPs ({s.bruteForceIps.length})
            </p>
            <ul className="space-y-1">
              {s.bruteForceIps.map((ip) => (
                <li className="flex items-center justify-between gap-2 text-xs" key={ip.ip}>
                  <span className="font-mono font-bold text-phx-ink">
                    {ip.ip}
                    {ip.credentialStuffing && <span className="ml-1.5 rounded-full bg-phx-danger-bg px-1.5 py-0.5 text-phx-3xs font-black text-phx-danger">CRED-STUFFING</span>}
                    {ip.blocked && <span className="ml-1.5 rounded-full bg-phx-paper px-1.5 py-0.5 text-phx-3xs font-black text-phx-ink-soft">BLOCKED</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="whitespace-nowrap font-mono text-phx-2xs text-amber-700">{ip.failCount} fails · {ip.distinctAccounts} accts</span>
                    {canManage && !ip.blocked && (
                      <button
                        className="rounded-md border border-rose-200 bg-white px-2 py-0.5 text-phx-3xs font-black text-rose-700 transition hover:bg-rose-50"
                        onClick={() => onManageIp(ip.ip, "block")}
                        type="button"
                      >
                        Block
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.newLocationLogins.length > 0 && (
          <div className="rounded-2xl border border-sky-200 bg-sky-50/50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-phx-xs font-black text-sky-700">
              <Globe className="h-3.5 w-3.5" /> New-location logins ({s.newLocationLogins.length})
            </p>
            <ul className="space-y-1">
              {s.newLocationLogins.map((l, i) => (
                <li className="flex items-center justify-between gap-2 text-xs" key={`${l.hrId}-${l.ip}-${i}`}>
                  <span className="font-bold text-phx-ink">{accountLabel(l.hrId, l.name)}</span>
                  <span className="whitespace-nowrap font-mono text-phx-2xs text-sky-700">{l.ip} · {formatDate(l.at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.blockedIps.length > 0 && (
          <div className="rounded-2xl border border-slate-300 bg-slate-50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-phx-xs font-black text-slate-700">
              <Lock className="h-3.5 w-3.5" /> Blocked IPs ({s.blockedIps.length})
            </p>
            <ul className="space-y-1">
              {s.blockedIps.map((b) => (
                <li className="flex items-center justify-between gap-2 text-xs" key={b.ip}>
                  <span className="font-mono font-bold text-phx-ink">{b.ip}</span>
                  <span className="flex items-center gap-2">
                    <span className="whitespace-nowrap font-mono text-phx-2xs text-slate-500">
                      {b.expiresAt ? `until ${formatDate(b.expiresAt)}` : "permanent"}
                    </span>
                    {canManage && (
                      <button
                        className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-phx-3xs font-black text-slate-600 transition hover:bg-slate-100"
                        onClick={() => onManageIp(b.ip, "unblock")}
                        type="button"
                      >
                        Unblock
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {s.truncated && (
        <p className="mt-3 text-phx-2xs text-slate-400">Attempt volume exceeded the scan cap — counts may be partial.</p>
      )}
    </div>
  );
}

function formatDwell(ms: number): string {
  if (!ms || ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function TrailSection({ state }: { state: TrailState | undefined }) {
  if (!state || state.loading) {
    return (
      <div className="flex items-center gap-2 text-xs font-semibold text-phx-ink-soft">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading what the user was doing…
      </div>
    );
  }
  if (state.error) {
    return <p className="text-xs font-semibold text-rose-700">{state.error}</p>;
  }
  if (!state.entries || state.entries.length === 0) {
    return <p className="text-xs text-phx-ink-soft">No recent activity recorded for this user before the error.</p>;
  }
  return (
    <div className="space-y-1.5">
      <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Before the error, this user visited</p>
      <ol className="space-y-1">
        {state.entries.map((entry, i) => (
          <li className="flex items-center gap-2 text-xs" key={`${entry.createdAt}-${i}`}>
            <span className="w-4 text-right font-mono text-phx-2xs text-slate-400">{i + 1}</span>
            <span className="font-bold text-phx-ink">{entry.moduleLabel}</span>
            <span className="truncate font-mono text-phx-xs text-phx-ink-soft">{entry.path}</span>
            <span className="ml-auto whitespace-nowrap font-mono text-phx-2xs text-slate-400">
              {formatDate(entry.createdAt)} · {formatDwell(entry.durationMs)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DetailPanel({
  aiEnabled,
  hasHrId,
  trail,
  explain,
  notifyState,
  onExplain,
  onNotify,
}: {
  aiEnabled: boolean;
  hasHrId: boolean;
  trail: TrailState | undefined;
  explain: ExplainState | undefined;
  notifyState: { loading: boolean; done: boolean } | undefined;
  onExplain: () => void;
  onNotify: () => void;
}) {
  const explainStarted = Boolean(explain?.data || explain?.loading || explain?.error);
  return (
    <div className="space-y-3 rounded-xl border border-phx-line bg-white/90 p-4">
      {hasHrId && <TrailSection state={trail} />}
      <div className="flex flex-wrap items-center gap-2">
        {aiEnabled &&
          (explainStarted ? null : (
            <button
              className="flex h-8 items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 text-phx-xs font-black text-violet-700 transition hover:bg-violet-100"
              onClick={onExplain}
              type="button"
            >
              <Sparkles className="h-3 w-3" />
              Explain with AI
            </button>
          ))}
        {hasHrId && (
          <button
            className="flex h-8 items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 text-phx-xs font-black text-sky-700 transition hover:bg-sky-100 disabled:opacity-50"
            disabled={notifyState?.loading || notifyState?.done}
            onClick={onNotify}
            type="button"
          >
            {notifyState?.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : notifyState?.done ? <Check className="h-3 w-3" /> : <Bell className="h-3 w-3" />}
            {notifyState?.done ? "Notified" : "Notify employee"}
          </button>
        )}
      </div>
      {aiEnabled && explainStarted && <ExplainPanel state={explain} />}
    </div>
  );
}

function ExplainPanel({ state }: { state: ExplainState | undefined }) {
  if (!state || state.loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-violet-200 bg-white/80 px-4 py-3 text-xs font-semibold text-violet-700">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Asking the AI…
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="rounded-xl border border-rose-200 bg-white/80 px-4 py-3 text-xs font-semibold text-rose-700">
        {state.error}
      </div>
    );
  }
  if (!state.data) return null;
  const { explanation, likelyCause, suggestedFix, confidence } = state.data;
  const confidenceClass =
    confidence === "high"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
      : confidence === "medium"
        ? "bg-amber-50 text-amber-700 ring-amber-100"
        : "bg-slate-100 text-slate-600 ring-slate-200";
  return (
    <div className="space-y-2 rounded-xl border border-violet-200 bg-white/90 px-4 py-3 text-sm text-phx-ink">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 text-phx-2xs font-black uppercase tracking-[0.16em] text-violet-500">
          <Sparkles className="h-3 w-3" /> AI explanation
        </span>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-phx-2xs font-bold ring-1 ${confidenceClass}`}>
          {confidence} confidence
        </span>
      </div>
      <p>{explanation}</p>
      {likelyCause && (
        <p className="text-xs text-phx-ink-soft">
          <span className="font-black text-phx-ink">Likely cause: </span>{likelyCause}
        </p>
      )}
      {suggestedFix && (
        <p className="text-xs text-phx-ink-soft">
          <span className="font-black text-phx-ink">Suggested fix: </span>{suggestedFix}
        </p>
      )}
      <p className="text-phx-2xs text-slate-400">AI-generated from redacted error data — verify before acting.</p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      className={`flex h-10 items-center gap-2 rounded-xl px-4 text-xs font-black transition ${
        active
          ? "bg-[#0B0B0B] text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)]"
          : "border border-phx-line bg-white text-phx-ink-soft hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
      }`}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
      <span
        className={`rounded-full px-2 py-0.5 text-phx-2xs ${active ? "bg-white/15 text-white" : "bg-phx-paper-2 text-phx-ink-soft"}`}
      >
        {count.toLocaleString("en-US")}
      </span>
    </button>
  );
}

type AppErrorsState = { events: ErrorEventRowWithStatus[] };
type AttemptsState = { rows: UserAttemptRowWithStatus[]; truncated: boolean; windowFrom: string; unknownAttempts: UnknownAttemptsSummary };

export function SystemIssuesDashboard({
  aiEnabled = false,
  initialAppErrors,
  initialAttempts,
}: {
  aiEnabled?: boolean;
  initialAppErrors: AppErrorsState;
  initialAttempts: AttemptsState;
}) {
  const [activeTab, setActiveTab] = useState<"issues" | "users">("issues");

  const [appErrors, setAppErrors] = useState<AppErrorsState>(initialAppErrors);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesStatusFilter, setIssuesStatusFilter] = useState<StatusFilter>("all");
  const [timeline, setTimeline] = useState<TimelineState>({ data: null, error: null, loading: true });

  // Per-row detail (repro trail + on-demand AI explanation) and the cluster summary.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [trails, setTrails] = useState<Record<string, TrailState>>({});
  const [explanations, setExplanations] = useState<Record<string, ExplainState>>({});
  const [notifyStates, setNotifyStates] = useState<Record<string, { loading: boolean; done: boolean }>>({});
  const [summaryState, setSummaryState] = useState<SummaryState>({ data: null, error: null, loading: false });

  const [attempts, setAttempts] = useState<AttemptsState>(initialAttempts);
  const [attemptsStatusFilter, setAttemptsStatusFilter] = useState<StatusFilter>("all");
  const [security, setSecurity] = useState<SecurityState>({ canManage: false, data: null, error: null, loading: false });
  const securityRequestedRef = useRef(false);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [hrIdDraft, setHrIdDraft] = useState("");
  const [dateFromDraft, setDateFromDraft] = useState("");
  const [dateToDraft, setDateToDraft] = useState("");

  // Request-generation guards: a response is only applied if its captured sequence still
  // matches the current one when it resolves — last-request-wins, not last-response-to-arrive.
  // Protects poll ticks from clobbering a newer filter change.
  const issuesSeqRef = useRef(0);
  const attemptsSeqRef = useRef(0);
  // Poll ticks read this, never the live draft inputs, so a tick landing mid-keystroke can't
  // overwrite the table with data for a filter the user never applied.
  const appliedAttemptsFilterRef = useRef({ dateFrom: "", dateTo: "", hrId: "" });
  // Seeded from SSR props so the very first poll never toasts for rows already on screen.
  const seenAppErrorIdsRef = useRef<Set<string> | null>(null);
  if (seenAppErrorIdsRef.current === null) {
    seenAppErrorIdsRef.current = new Set(initialAppErrors.events.map((event) => event.id));
  }
  const isMountedRef = useRef(true);

  function notifyNewAppErrors(newRows: ErrorEventRowWithStatus[]) {
    if (newRows.length === 0) return;
    if (newRows.length > TOAST_BATCH_THRESHOLD) {
      toast.error(`${newRows.length} new issues since you last looked`, {
        description: "Open the Issues & Errors tab to review them.",
      });
      return;
    }
    for (const row of newRows) {
      toast.error(row.displayMessage || row.message || "New application error", {
        description: `${row.moduleLabel}${row.route ? ` · ${row.route}` : ""}`,
      });
    }
  }

  function applyAppErrorsResult(events: ErrorEventRowWithStatus[]) {
    const currentIds = events.map((event) => event.id);
    const newIds = new Set(computeNewlyArrivedIds(seenAppErrorIdsRef.current, currentIds));
    if (newIds.size > 0) {
      notifyNewAppErrors(events.filter((event) => newIds.has(event.id)));
    }
    seenAppErrorIdsRef.current = new Set(currentIds);
    setAppErrors({ events });
  }

  async function loadIssues(opts: { showSpinner: boolean }) {
    const seq = ++issuesSeqRef.current;
    if (opts.showSpinner) setIssuesLoading(true);
    try {
      const res = await fetch("/api/admin/system-issues");
      if (!res.ok) throw new Error("Failed to refresh issues");
      const result = (await res.json()) as { appErrors: AppErrorsState };
      if (!isMountedRef.current || seq !== issuesSeqRef.current) return;
      applyAppErrorsResult(result.appErrors.events);
    } catch (err) {
      console.error(err);
    } finally {
      if (opts.showSpinner && isMountedRef.current && seq === issuesSeqRef.current) setIssuesLoading(false);
    }
  }

  async function loadAttempts(filter: { hrId: string; dateFrom: string; dateTo: string }, opts: { showSpinner: boolean }) {
    const seq = ++attemptsSeqRef.current;
    if (opts.showSpinner) setAttemptsLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter.hrId) params.set("hrId", filter.hrId);
      if (filter.dateFrom) params.set("dateFrom", filter.dateFrom);
      if (filter.dateTo) params.set("dateTo", filter.dateTo);
      const res = await fetch(`/api/admin/system-issues/attempts?${params.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to fetch attempt summary");
      }
      const result = (await res.json()) as AttemptsState;
      if (!isMountedRef.current || seq !== attemptsSeqRef.current) return;
      setAttempts(result);
    } catch (err) {
      console.error(err);
    } finally {
      if (opts.showSpinner && isMountedRef.current && seq === attemptsSeqRef.current) setAttemptsLoading(false);
    }
  }

  async function fetchAttempts() {
    const filter = { dateFrom: dateFromDraft, dateTo: dateToDraft, hrId: hrIdDraft };
    appliedAttemptsFilterRef.current = filter;
    await loadAttempts(filter, { showSpinner: true });
  }

  function clearAttemptFilters() {
    setHrIdDraft("");
    setDateFromDraft("");
    setDateToDraft("");
    const filter = { dateFrom: "", dateTo: "", hrId: "" };
    appliedAttemptsFilterRef.current = filter;
    void loadAttempts(filter, { showSpinner: true });
  }

  useEffect(() => {
    isMountedRef.current = true;
    // One-time deploy timeline + regressions load (client-side, after the SSR render).
    void (async () => {
      try {
        const res = await fetch("/api/admin/system-issues/timeline");
        if (!res.ok) throw new Error(`Timeline request failed (${res.status})`);
        const result = (await res.json()) as { timeline: DeployTimeline };
        if (isMountedRef.current) setTimeline({ data: result.timeline, error: null, loading: false });
      } catch (err) {
        if (isMountedRef.current) setTimeline({ data: null, error: err instanceof Error ? err.message : "Timeline failed", loading: false });
      }
    })();
    function poll() {
      if (document.visibilityState === "hidden") return;
      void loadIssues({ showSpinner: false });
      void loadAttempts(appliedAttemptsFilterRef.current, { showSpinner: false });
    }
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    function onVisibilityChange() {
      if (document.visibilityState === "visible") poll();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      isMountedRef.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only; loaders read refs, not stale closures
  }, []);

  const mergedIssues: MergedIssueRow[] = useMemo(() => {
    const appRows: MergedIssueRow[] = appErrors.events.map((event) => ({
      displayMessage: event.displayMessage,
      employeeName: event.employeeName,
      hrId: event.hrId,
      id: `app-${event.id}`,
      message: event.message,
      moduleKey: event.moduleKey,
      moduleLabel: event.moduleLabel,
      origin: "app",
      route: event.route,
      severity: event.source === "server" ? "ERROR" : "WARNING",
      stack: event.stack,
      status: event.status,
      timestamp: event.createdAt,
    }));
    return [...appRows].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  }, [appErrors.events]);

  const filteredIssues = useMemo(
    () => mergedIssues.filter((row) => matchesStatusFilter(row.status, issuesStatusFilter)),
    [mergedIssues, issuesStatusFilter],
  );

  const filteredAttemptRows = useMemo(
    () => attempts.rows.filter((row) => matchesStatusFilter(row.status, attemptsStatusFilter)),
    [attempts.rows, attemptsStatusFilter],
  );

  // Days actually covered by the applied window (default 30, or the caller's custom dateFrom),
  // derived from the effective windowFrom the server echoes back — always accurate. Date.now()
  // differs between the server render and client hydration, so hold this at null (the existing
  // "Since <date>" fallback below already handles null) until hydrated, then compute for real.
  const hydrated = useHydrated();
  const attemptWindowDays = useMemo(() => {
    if (!hydrated) return null;
    const from = attempts.windowFrom ? new Date(attempts.windowFrom).getTime() : Number.NaN;
    if (!Number.isFinite(from)) return null;
    return Math.max(1, Math.round((Date.now() - from) / 86_400_000));
  }, [attempts.windowFrom, hydrated]);

  async function toggleDetails(row: MergedIssueRow) {
    if (expandedRowId === row.id) {
      setExpandedRowId(null);
      return;
    }
    setExpandedRowId(row.id);
    // The repro trail is a free DB read — fetch it automatically on expand (if this error
    // belongs to a known user). The AI explanation stays opt-in (a button in the panel).
    if (!row.hrId) return;
    if (trails[row.id]?.entries || trails[row.id]?.loading) return;

    setTrails((prev) => ({ ...prev, [row.id]: { entries: null, error: null, loading: true } }));
    try {
      const params = new URLSearchParams({ before: row.timestamp, hrId: row.hrId });
      const res = await fetch(`/api/admin/system-issues/repro-trail?${params.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Trail request failed (${res.status})`);
      }
      const result = (await res.json()) as { entries: ReproTrailEntry[] };
      setTrails((prev) => ({ ...prev, [row.id]: { entries: result.entries, error: null, loading: false } }));
    } catch (err) {
      setTrails((prev) => ({
        ...prev,
        [row.id]: { entries: null, error: err instanceof Error ? err.message : "Trail request failed", loading: false },
      }));
    }
  }

  async function notifyEmployee(row: MergedIssueRow) {
    if (!row.hrId || notifyStates[row.id]?.loading || notifyStates[row.id]?.done) return;
    const who = row.employeeName ? `${row.employeeName} (${row.hrId})` : row.hrId;
    if (!window.confirm(`Send ${who} an in-app notice that the team is aware of this issue? No email or Telegram — in-app only.`)) return;

    setNotifyStates((prev) => ({ ...prev, [row.id]: { done: false, loading: true } }));
    try {
      const res = await fetch("/api/admin/system-issues/notify-user", {
        body: JSON.stringify({ hrId: row.hrId, moduleLabel: row.moduleLabel, route: row.route }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Notify failed (${res.status})`);
      }
      setNotifyStates((prev) => ({ ...prev, [row.id]: { done: true, loading: false } }));
      toast.success(`In-app notice sent to ${who}.`);
    } catch (err) {
      setNotifyStates((prev) => ({ ...prev, [row.id]: { done: false, loading: false } }));
      toast.error(err instanceof Error ? err.message : "Failed to notify employee.");
    }
  }

  async function fetchExplanation(row: MergedIssueRow) {
    if (explanations[row.id]?.data || explanations[row.id]?.loading) return;
    setExplanations((prev) => ({ ...prev, [row.id]: { data: null, error: null, loading: true } }));
    try {
      const res = await fetch("/api/admin/system-issues/explain", {
        body: JSON.stringify({
          // Send the decoded message — it carries the real meaning of minified React
          // codes ("Hydration mismatch…" instead of "#418"), which the model reasons over
          // far better. For plain errors it equals the raw message, so nothing is lost.
          message: row.displayMessage || row.message,
          moduleLabel: row.moduleLabel,
          route: row.route,
          severity: row.severity,
          stack: row.stack,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `AI request failed (${res.status})`);
      }
      const result = (await res.json()) as { explanation: ErrorExplanation };
      setExplanations((prev) => ({ ...prev, [row.id]: { data: result.explanation, error: null, loading: false } }));
    } catch (err) {
      setExplanations((prev) => ({
        ...prev,
        [row.id]: { data: null, error: err instanceof Error ? err.message : "AI request failed", loading: false },
      }));
    }
  }

  async function loadSecurity() {
    securityRequestedRef.current = true;
    setSecurity((prev) => ({ canManage: prev.canManage, data: null, error: null, loading: true }));
    try {
      const res = await fetch("/api/admin/system-issues/security");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Security request failed (${res.status})`);
      }
      const result = (await res.json()) as { signals: LoginSecuritySignals; canManage: boolean };
      setSecurity({ canManage: Boolean(result.canManage), data: result.signals, error: null, loading: false });
    } catch (err) {
      setSecurity((prev) => ({ canManage: prev.canManage, data: null, error: err instanceof Error ? err.message : "Security request failed", loading: false }));
    }
  }

  async function manageIpBlock(ip: string, action: "block" | "unblock") {
    if (action === "block") {
      if (!window.confirm(`Block ${ip} from logging in for 30 days? Anyone signing in from this IP will be refused. You can unblock it anytime.`)) return;
    }
    try {
      const res = await fetch("/api/admin/system-issues/block-ip", {
        body: JSON.stringify({ action, ip }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Request failed (${res.status})`);
      }
      toast.success(action === "block" ? `${ip} blocked for 30 days.` : `${ip} unblocked.`);
      await loadSecurity();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update IP blocklist.");
    }
  }

  function openUsersTab() {
    setActiveTab("users");
    // Lazy-load the security lens the first time the tab is opened (a DB aggregation).
    if (!securityRequestedRef.current) void loadSecurity();
  }

  async function handleSummarize() {
    if (summaryState.loading) return;
    setSummaryState({ data: null, error: null, loading: true });
    try {
      const res = await fetch("/api/admin/system-issues/summary", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `AI request failed (${res.status})`);
      }
      const result = (await res.json()) as { summary: ClusterSummary };
      setSummaryState({ data: result.summary, error: null, loading: false });
    } catch (err) {
      setSummaryState({ data: null, error: err instanceof Error ? err.message : "AI request failed", loading: false });
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <TabButton
          active={activeTab === "issues"}
          count={mergedIssues.length}
          icon={<ServerCog className="h-3.5 w-3.5" />}
          label="Issues & Errors"
          onClick={() => setActiveTab("issues")}
        />
        <TabButton
          active={activeTab === "users"}
          count={attempts.rows.length}
          icon={<UsersRound className="h-3.5 w-3.5" />}
          label="Per-User Attempts"
          onClick={openUsersTab}
        />
      </div>

      {activeTab === "issues" ? (
        <div className="space-y-4">
          <p className="text-xs text-phx-ink-soft">
            Status is automatic — never set by hand. An error shows <span className="font-bold text-amber-700">Active</span>{" "}
            while it still happens on the currently-deployed version, and flips to{" "}
            <span className="font-bold text-emerald-700">Resolved</span> on its own once it stops occurring on the live
            build. If it happens again, it returns to Active on the next refresh.
          </p>
          <DeployTimelinePanel state={timeline} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <StatusFilterPills
              onChange={setIssuesStatusFilter}
              shownCount={filteredIssues.length}
              totalCount={mergedIssues.length}
              value={issuesStatusFilter}
            />
            {aiEnabled && (
              <button
                className="flex h-9 items-center gap-1.5 rounded-xl border border-violet-200 bg-violet-50 px-4 text-xs font-black text-violet-700 transition hover:bg-violet-100 disabled:opacity-50"
                disabled={summaryState.loading}
                onClick={handleSummarize}
                type="button"
              >
                {summaryState.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                AI summary of last 7 days
              </button>
            )}
          </div>
          {aiEnabled && (summaryState.data || summaryState.error) && (
            <div className="rounded-2xl border border-violet-200 bg-[linear-gradient(135deg,#F5F3FF_0%,#FFFFFF_100%)] p-4 shadow-[0_10px_28px_rgba(124,58,237,0.08)]">
              {summaryState.error ? (
                <p className="text-xs font-semibold text-rose-700">{summaryState.error}</p>
              ) : summaryState.data ? (
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.16em] text-violet-500">
                    <Sparkles className="h-3 w-3" /> AI summary
                  </p>
                  <p className="text-sm font-medium text-phx-ink">{summaryState.data.summary}</p>
                  {summaryState.data.themes.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {summaryState.data.themes.map((theme, i) => (
                        <li className="rounded-full bg-phx-info-bg px-2.5 py-1 text-phx-xs font-bold text-phx-info" key={i}>
                          {theme}
                        </li>
                      ))}
                    </ul>
                  )}
                  {summaryState.data.recommendation && (
                    <p className="text-xs text-phx-ink-soft">
                      <span className="font-black text-phx-ink">Recommendation: </span>
                      {summaryState.data.recommendation}
                    </p>
                  )}
                  <p className="text-phx-2xs text-slate-400">AI-generated from redacted error data — verify before acting.</p>
                </div>
              ) : null}
            </div>
          )}
          <div className="overflow-hidden rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1050px]">
                <thead>
                  <tr className="border-b border-phx-line bg-phx-paper">
                    {["Time", "Origin", "Severity", "Status", "HR ID", "Module", "Message", "Route"].map((h) => (
                      <th
                        className="px-5 py-4 text-left text-phx-2xs font-black uppercase tracking-widest text-phx-ink-soft"
                        key={h}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-phx-paper-2">
                  {issuesLoading ? (
                    <tr>
                      <td className="px-5 py-8 text-center text-sm text-phx-ink-soft" colSpan={8}>
                        <Loader2 className="mx-auto h-5 w-5 animate-spin text-phx-accent" />
                      </td>
                    </tr>
                  ) : filteredIssues.length === 0 ? (
                    <tr>
                      <td className="px-5 py-8 text-center text-sm text-phx-ink-soft" colSpan={8}>
                        {mergedIssues.length === 0 ? "No issues found." : "No issues match this filter."}
                      </td>
                    </tr>
                  ) : (
                    filteredIssues.map((row) => (
                      <Fragment key={row.id}>
                        <tr className="transition-colors hover:bg-orange-50/35">
                          <td className="whitespace-nowrap px-5 py-4 font-mono text-xs font-semibold text-phx-ink-soft">
                            {formatDate(row.timestamp)}
                          </td>
                          <td className="px-5 py-4">
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-1 text-phx-xs font-bold ring-1 ${
                                row.origin === "app"
                                  ? "bg-sky-50 text-sky-700 ring-sky-100"
                                  : "bg-violet-50 text-violet-700 ring-violet-100"
                              }`}
                            >
                              {row.origin === "app" ? "App (Supabase)" : "GCP Infra"}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-1 text-phx-xs font-bold ring-1 ${severityBadgeClasses(row.severity)}`}
                            >
                              {row.severity}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <StatusBadge status={row.status} />
                          </td>
                          <td className="whitespace-nowrap px-5 py-4">
                            {row.hrId ? (
                              row.employeeName ? (
                                <div className="leading-tight">
                                  <div className="text-sm font-bold text-phx-ink">{row.employeeName}</div>
                                  <div className="font-mono text-phx-2xs text-slate-400">{row.hrId}</div>
                                </div>
                              ) : (
                                <span className="text-sm font-bold text-phx-ink">{row.hrId}</span>
                              )
                            ) : (
                              <span className="text-sm text-phx-ink-soft">-</span>
                            )}
                          </td>
                          <td className="px-5 py-4 text-sm text-phx-ink-soft">{row.moduleLabel}</td>
                          <td className="max-w-lg px-5 py-4 text-sm font-medium text-phx-ink">
                            <span className="line-clamp-2" title={row.message}>{row.displayMessage}</span>
                            {(row.hrId || aiEnabled) && (
                              <button
                                className="mt-1 flex items-center gap-1 text-phx-xs font-black text-phx-ink-soft transition hover:text-orange-700"
                                onClick={() => toggleDetails(row)}
                                type="button"
                              >
                                {expandedRowId === row.id ? "Hide details" : "Details"}
                              </button>
                            )}
                          </td>
                          <td className="max-w-xs px-5 py-4 font-mono text-xs text-phx-ink-soft">
                            <span className="line-clamp-1">{row.route ?? "-"}</span>
                          </td>
                        </tr>
                        {expandedRowId === row.id && (
                          <tr className="bg-slate-50/60">
                            <td className="px-5 pb-5 pt-1" colSpan={8}>
                              <DetailPanel
                                aiEnabled={aiEnabled}
                                explain={explanations[row.id]}
                                hasHrId={Boolean(row.hrId)}
                                notifyState={notifyStates[row.id]}
                                onExplain={() => fetchExplanation(row)}
                                onNotify={() => notifyEmployee(row)}
                                trail={trails[row.id]}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <SecurityLens canManage={security.canManage} onManageIp={manageIpBlock} onRetry={loadSecurity} state={security} />
          {attempts.truncated && (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-xs font-semibold">
                Row cap reached while aggregating — narrow the date range for a fully accurate count.
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1.5 px-1">
            {attempts.windowFrom && (
              <p className="text-phx-xs font-bold uppercase tracking-wide text-phx-ink-soft">
                {attemptWindowDays === null
                  ? `Since ${attempts.windowFrom.slice(0, 10)}`
                  : `Showing last ${attemptWindowDays} days · since ${attempts.windowFrom.slice(0, 10)}`}
              </p>
            )}
            {attempts.unknownAttempts && attempts.unknownAttempts.attemptCount > 0 && (
              <p className="text-phx-xs font-semibold text-phx-ink-faint">
                + {attempts.unknownAttempts.attemptCount} failed attempts against{" "}
                {attempts.unknownAttempts.distinctCount} unknown/non-existent usernames — hidden from this
                list (test/probe noise); see the Security Lens above for attack patterns.
              </p>
            )}
          </div>
          <div className="rounded-3xl border border-phx-line bg-white/95 p-5 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-soft" />
                <input
                  className={cn(phxFieldClassName, "pl-8")}
                  onChange={(e) => setHrIdDraft(e.target.value)}
                  placeholder="HR ID..."
                  value={hrIdDraft}
                />
              </div>
              <input
                className={phxFieldClassName}
                onChange={(e) => setDateFromDraft(e.target.value)}
                type="date"
                value={dateFromDraft}
              />
              <input
                className={phxFieldClassName}
                onChange={(e) => setDateToDraft(e.target.value)}
                type="date"
                value={dateToDraft}
              />
              <div className="flex gap-2">
                <button
                  className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#0B0B0B] px-4 text-xs font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition hover:bg-phx-accent disabled:opacity-50"
                  disabled={attemptsLoading}
                  onClick={fetchAttempts}
                  type="button"
                >
                  {attemptsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                  Apply
                </button>
                <button
                  className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-phx-line bg-white px-3 text-xs font-black text-phx-ink-soft transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
                  onClick={clearAttemptFilters}
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                  Clear
                </button>
              </div>
            </div>
          </div>

          <StatusFilterPills
            onChange={setAttemptsStatusFilter}
            shownCount={filteredAttemptRows.length}
            totalCount={attempts.rows.length}
            value={attemptsStatusFilter}
          />

          <div className="overflow-hidden rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1150px]">
                <thead>
                  <tr className="border-b border-phx-line bg-phx-paper">
                    {["HR ID", "Type", "Status", "Module", "Route", "Attempts", "First Seen", "Last Seen", "Sample"].map(
                      (h) => (
                        <th
                          className="px-5 py-4 text-left text-phx-2xs font-black uppercase tracking-widest text-phx-ink-soft"
                          key={h}
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-phx-paper-2">
                  {attemptsLoading ? (
                    <tr>
                      <td className="px-5 py-8 text-center text-sm text-phx-ink-soft" colSpan={9}>
                        <Loader2 className="mx-auto h-5 w-5 animate-spin text-phx-accent" />
                      </td>
                    </tr>
                  ) : filteredAttemptRows.length === 0 ? (
                    <tr>
                      <td className="px-5 py-8 text-center text-sm text-phx-ink-soft" colSpan={9}>
                        {attempts.rows.length === 0 ? "No attempts found." : "No attempts match this filter."}
                      </td>
                    </tr>
                  ) : (
                    filteredAttemptRows.map((row) => {
                      const key = `user|${row.hrId}|${row.category}|${row.moduleKey}|${row.route ?? ""}`;
                      return (
                        <tr className="transition-colors hover:bg-orange-50/35" key={key}>
                          <td className="whitespace-nowrap px-5 py-4">
                            {row.employeeName ? (
                              <div className="leading-tight">
                                <div className="text-sm font-bold text-phx-ink">
                                  {row.employeeName}
                                  {row.employeeRole && <span className="ml-1 text-phx-2xs font-semibold text-slate-400">· {row.employeeRole}</span>}
                                </div>
                                <div className="font-mono text-phx-2xs text-slate-400">{row.hrId}</div>
                              </div>
                            ) : (
                              <span className="text-sm font-bold text-phx-ink">{row.hrId}</span>
                            )}
                          </td>
                          <td className="px-5 py-4">
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-1 text-phx-xs font-bold ring-1 ${
                                row.category === "app_error"
                                  ? "bg-sky-50 text-sky-700 ring-sky-100"
                                  : "bg-rose-50 text-rose-700 ring-rose-100"
                              }`}
                            >
                              {row.category === "app_error" ? "App Error" : "Failed Login"}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <StatusBadge status={row.status} />
                          </td>
                          <td className="px-5 py-4 text-sm text-phx-ink-soft">{row.moduleLabel}</td>
                          <td className="max-w-xs px-5 py-4 font-mono text-xs text-phx-ink-soft">
                            <span className="line-clamp-1">{row.route ?? "-"}</span>
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 text-sm font-black text-phx-ink">
                            {row.attemptCount.toLocaleString("en-US")}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 font-mono text-xs text-phx-ink-soft">
                            {formatDate(row.firstSeen)}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 font-mono text-xs text-phx-ink-soft">
                            {formatDate(row.lastSeen)}
                          </td>
                          <td className="max-w-sm px-5 py-4 text-sm text-phx-ink">
                            <span className="line-clamp-1" title={row.sampleMessage}>{row.displayMessage}</span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
