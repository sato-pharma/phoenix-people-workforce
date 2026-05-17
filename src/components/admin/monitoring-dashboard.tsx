"use client";

import { useState } from "react";
import { Activity, AlertTriangle, BellRing, Lock, Radar, Search, ShieldAlert, UserRoundCog } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import type { AdminMonitoringStats } from "@/lib/admin/service";

const activityPageSizes = [10, 25, 50] as const;

type RecentSecurityEvent = AdminMonitoringStats["recentEvents"][number];

function formatActivityTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Unknown time";
}

function getActivitySearchText(event: RecentSecurityEvent) {
  return [
    event.actor,
    event.actorHrId,
    event.actorLoginId,
    event.actorName,
    event.createdAt,
    event.entityType,
    event.summary,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function StatCard({
  icon: Icon,
  label,
  tone = "slate",
  value,
}: {
  icon: typeof Activity;
  label: string;
  tone?: "amber" | "emerald" | "rose" | "slate";
  value: number | string;
}) {
  const toneClass = {
    amber: "bg-amber-50 text-amber-600 ring-amber-100",
    emerald: "bg-emerald-50 text-emerald-600 ring-emerald-100",
    rose: "bg-rose-50 text-rose-600 ring-rose-100",
    slate: "bg-slate-50 text-slate-600 ring-slate-100",
  }[tone];

  return (
    <Card className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{label}</p>
          <p className="break-words text-[1.35rem] font-semibold leading-tight tracking-[-0.02em] text-slate-950">{value}</p>
        </div>
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ${toneClass}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );
}

export function MonitoringDashboard({ stats }: { stats: AdminMonitoringStats }) {
  const [activitySearch, setActivitySearch] = useState("");
  const [activityTypeFilter, setActivityTypeFilter] = useState("all");
  const [activityPage, setActivityPage] = useState(1);
  const [activityPageSize, setActivityPageSize] = useState<(typeof activityPageSizes)[number]>(10);
  const coveragePercent = `${(stats.auth.authBridgeCoverageRate * 100).toFixed(1)}%`;
  const metricTileClass = "rounded-xl border border-slate-200 bg-slate-50 p-4";
  const normalizedActivitySearch = activitySearch.trim().toLowerCase();
  const activityTypeOptions = Array.from(new Set(stats.recentEvents.map((event) => event.entityType))).sort();
  const filteredActivityEvents = stats.recentEvents.filter((event) => {
    const matchesType = activityTypeFilter === "all" || event.entityType === activityTypeFilter;
    const matchesSearch = !normalizedActivitySearch || getActivitySearchText(event).includes(normalizedActivitySearch);
    return matchesType && matchesSearch;
  });
  const activityTotalPages = Math.max(1, Math.ceil(filteredActivityEvents.length / activityPageSize));
  const safeActivityPage = Math.min(activityPage, activityTotalPages);
  const activityStart = (safeActivityPage - 1) * activityPageSize;
  const visibleActivityEvents = filteredActivityEvents.slice(activityStart, activityStart + activityPageSize);
  const activityEnd = activityStart + visibleActivityEvents.length;

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>{coveragePercent} auth coverage</AdminInsightChip>
            <AdminInsightChip tone="slate">{stats.auth.failedAttempts24h} failed logins</AdminInsightChip>
            <AdminInsightChip tone="orange">{stats.notifications.pending24h} queued events</AdminInsightChip>
          </>
        )}
        description="Operational monitoring for auth stability, notification throughput, and security-sensitive activity using live Supabase data."
        eyebrow="Observability"
        icon={<Radar className="h-3.5 w-3.5" />}
        title="Monitoring Dashboard"
      />

      {stats.auth.brokenAccounts.length > 0 && (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-500" />
          <div>
            <p className="text-sm font-bold text-rose-900">
              {stats.auth.brokenAccounts.length} account{stats.auth.brokenAccounts.length > 1 ? "s" : ""} cannot log in - missing access profile
            </p>
            <p className="mt-1.5 text-sm text-rose-700">
              Login ID{stats.auth.brokenAccounts.length > 1 ? "s" : ""} affected:{" "}
              <span className="font-mono font-bold text-rose-800">{stats.auth.brokenAccounts.join(", ")}</span>
            </p>
            <p className="mt-1.5 text-xs font-medium text-rose-600">
              Fix: open Users &amp; Access, edit each user, then re-save with a new password.
            </p>
          </div>
        </AdminCallout>
      )}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-5">
        <StatCard icon={Radar} label="Auth Bridge Coverage" tone="emerald" value={coveragePercent} />
        <StatCard icon={ShieldAlert} label="Failed Logins (24h)" tone={stats.auth.failedAttempts24h > 0 ? "rose" : "slate"} value={stats.auth.failedAttempts24h} />
        <StatCard icon={Lock} label="Locked Accounts" tone={stats.auth.lockedAccounts > 0 ? "rose" : "slate"} value={stats.auth.lockedAccounts} />
        <StatCard icon={UserRoundCog} label="Forced Password Reset" tone={stats.auth.forcedPasswordResets > 0 ? "amber" : "slate"} value={stats.auth.forcedPasswordResets} />
        <StatCard icon={BellRing} label="Queued Notification Events" tone={stats.notifications.pending24h > 0 ? "amber" : "slate"} value={stats.notifications.pending24h} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <AdminTableShell
          description="Authentication signal health across failed attempts and audit activity."
          title="Auth Monitoring"
        >
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Unique failed IPs (24h)</p>
              <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.auth.uniqueFailedIps24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Auth audit events (24h)</p>
              <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.auth.recentAuthEvents}</p>
            </div>
          </div>
        </AdminTableShell>

        <AdminTableShell
          description="Delivery throughput and queue pressure from notification logs."
          title="Notification Monitoring"
        >
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Sent logs (24h)</p>
              <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.notifications.sent24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Failed logs (24h)</p>
              <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.notifications.failed24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Pending events (24h)</p>
              <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.notifications.pending24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Total delivery logs</p>
              <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.notifications.totalLogs}</p>
            </div>
          </div>
        </AdminTableShell>
      </div>

      <AdminTableShell
        description="Latest authentication and user-admin events ordered by the monitoring data source."
        action={(
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative block min-w-[220px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm font-medium text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
                onChange={(event) => {
                  setActivitySearch(event.target.value);
                  setActivityPage(1);
                }}
                placeholder="Filter HR ID, name, event..."
                value={activitySearch}
              />
            </label>
            <select
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
              onChange={(event) => {
                setActivityTypeFilter(event.target.value);
                setActivityPage(1);
              }}
              value={activityTypeFilter}
            >
              <option value="all">All types</option>
              {activityTypeOptions.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
        )}
        title="Recent Security Activity"
      >
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 text-left">
            <thead className="bg-slate-50/80">
              <tr>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 sm:px-6">HR ID</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Employee Name</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Event</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Type</th>
                <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 sm:px-6">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {visibleActivityEvents.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-sm font-medium text-slate-400 sm:px-6" colSpan={5}>
                    No recent auth or user-admin events match the selected filters.
                  </td>
                </tr>
              ) : (
                visibleActivityEvents.map((event, index) => (
                  <tr key={`${event.entityType}-${event.createdAt ?? index}-${event.actorLoginId ?? "system"}`} className="transition-colors hover:bg-orange-50/40">
                    <td className="whitespace-nowrap px-4 py-4 align-top font-mono text-xs font-semibold text-slate-700 sm:px-6">
                      {event.actorHrId ?? "N/A"}
                    </td>
                    <td className="min-w-[180px] px-4 py-4 align-top">
                      <p className="text-sm font-semibold text-slate-900">{event.actorName ?? event.actor}</p>
                      {event.actorLoginId ? <p className="mt-1 text-[11px] font-medium text-slate-400">Login: {event.actorLoginId}</p> : null}
                    </td>
                    <td className="min-w-[260px] px-4 py-4 align-top">
                      <p className="text-sm font-medium leading-5 text-slate-800">{event.summary}</p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 align-top">
                      <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-600">
                        {event.entityType}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-right align-top text-xs font-medium text-slate-500 sm:px-6">
                      {formatActivityTimestamp(event.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          {filteredActivityEvents.length === 0 ? (
            <p className="font-medium">Showing 0 of {stats.recentEvents.length} events</p>
          ) : (
            <p className="font-medium">
              Showing {activityStart + 1}-{activityEnd} of {filteredActivityEvents.length} filtered events
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
              onChange={(event) => {
                setActivityPageSize(Number(event.target.value) as (typeof activityPageSizes)[number]);
                setActivityPage(1);
              }}
              value={activityPageSize}
            >
              {activityPageSizes.map((size) => (
                <option key={size} value={size}>
                  {size} / page
                </option>
              ))}
            </select>
            <button
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 transition hover:border-orange-300 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-45"
              disabled={safeActivityPage <= 1}
              onClick={() => setActivityPage((current) => Math.max(1, current - 1))}
              type="button"
            >
              Previous
            </button>
            <span className="px-1 text-xs font-bold text-slate-500">
              Page {safeActivityPage} of {activityTotalPages}
            </span>
            <button
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 transition hover:border-orange-300 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-45"
              disabled={safeActivityPage >= activityTotalPages}
              onClick={() => setActivityPage((current) => Math.min(activityTotalPages, current + 1))}
              type="button"
            >
              Next
            </button>
          </div>
        </div>
      </AdminTableShell>
    </div>
  );
}
