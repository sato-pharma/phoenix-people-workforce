"use client";

import Link from "next/link";
import { Activity, AlertTriangle, BellRing, Download, Lock, Radar, Search, ShieldAlert, UserRoundCog } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import type { AdminMonitoringStats } from "@/lib/operations/events";

function formatActivityTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Unknown time";
}

function deliveryStatusClass(status: string) {
  switch (status.toLowerCase()) {
    case "delivered":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "bounced":
    case "failed":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "complained":
    case "suppressed":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "sent":
      return "border-sky-200 bg-sky-50 text-sky-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
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
  const activitySearch = stats.recentEvents.search;
  const activityTypeFilter = stats.recentEvents.entityType;
  const activitySort = stats.recentEvents.sort;
  const activityPage = stats.recentEvents.page;
  const activityPageSize = stats.recentEvents.pageSize;
  const activityTotal = stats.recentEvents.total;
  const activityTotalPages = Math.max(1, stats.recentEvents.totalPages);
  const safeActivityPage = Math.min(Math.max(1, activityPage), activityTotalPages);
  const coveragePercent = `${(stats.auth.authBridgeCoverageRate * 100).toFixed(1)}%`;
  const metricTileClass = "rounded-xl border border-slate-200 bg-slate-50 p-4";
  const activityTypeOptions = Array.from(new Set(stats.recentEvents.entityTypes)).sort();
  const activityStart = (safeActivityPage - 1) * activityPageSize + 1;
  const activityEnd = Math.min(safeActivityPage * activityPageSize, activityTotal);
  const lastOperationalEvent = stats.operations.lastEventAt
    ? formatActivityTimestamp(stats.operations.lastEventAt)
    : "No events";

  const currentFilters = {
    pageSize: stats.recentEvents.pageSize,
    search: stats.recentEvents.search || "",
    sort: stats.recentEvents.sort,
    type: stats.recentEvents.entityType,
  };

  const createQueryParams = (page: number) => {
    const params = new URLSearchParams();
    if (currentFilters.search) params.set("search", currentFilters.search);
    if (currentFilters.type && currentFilters.type !== "all") params.set("type", currentFilters.type);
    if (currentFilters.sort) params.set("sort", currentFilters.sort);
    params.set("pageSize", String(currentFilters.pageSize));
    params.set("page", String(page));
    return params;
  };

  const tableFilterAction = "/admin/monitoring";
  const csvExportHref = `/api/admin/monitoring/events-csv${createQueryParams(1).toString() ? `?${createQueryParams(1).toString()}` : ""}`;

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>{coveragePercent} auth coverage</AdminInsightChip>
            <AdminInsightChip tone="slate">{stats.auth.failedAttempts24h} failed logins</AdminInsightChip>
            <AdminInsightChip tone="orange">{stats.notifications.pending24h} queued events</AdminInsightChip>
            <AdminInsightChip tone="slate">{stats.operations.totalEvents24h} workflow events</AdminInsightChip>
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

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-6">
        <StatCard icon={Radar} label="Auth Bridge Coverage" tone="emerald" value={coveragePercent} />
        <StatCard icon={ShieldAlert} label="Failed Logins (24h)" tone={stats.auth.failedAttempts24h > 0 ? "rose" : "slate"} value={stats.auth.failedAttempts24h} />
        <StatCard icon={Lock} label="Locked Accounts" tone={stats.auth.lockedAccounts > 0 ? "rose" : "slate"} value={stats.auth.lockedAccounts} />
        <StatCard icon={UserRoundCog} label="Forced Password Reset" tone={stats.auth.forcedPasswordResets > 0 ? "amber" : "slate"} value={stats.auth.forcedPasswordResets} />
        <StatCard icon={BellRing} label="Queued Notification Events" tone={stats.notifications.pending24h > 0 ? "amber" : "slate"} value={stats.notifications.pending24h} />
        <StatCard icon={Activity} label="Workflow Failures (24h)" tone={stats.operations.failureCount24h > 0 ? "rose" : "slate"} value={stats.operations.failureCount24h} />
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
          description="Delivery throughput and queue pressure from the Resend email-delivery event stream."
          title="Notification Monitoring"
        >
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Sent events (24h)</p>
              <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.notifications.sent24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Failed events (24h)</p>
              <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.notifications.failed24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Pending events (24h)</p>
              <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.notifications.pending24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Total email events</p>
              <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.notifications.totalLogs}</p>
            </div>
          </div>
        </AdminTableShell>
      </div>

      <AdminTableShell
        description="Workflow activity collected from payroll, sales import, and offer audit sources."
        title="Operational Activity"
      >
        <div className="grid gap-4 border-b border-slate-100 p-4 md:grid-cols-3">
          <div className={metricTileClass}>
            <p className="text-xs font-semibold text-slate-500">Workflow events (24h)</p>
            <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.operations.totalEvents24h}</p>
          </div>
          <div className={metricTileClass}>
            <p className="text-xs font-semibold text-slate-500">Failures (24h)</p>
            <p className="mt-2 text-[1.6rem] font-semibold leading-tight text-slate-950">{stats.operations.failureCount24h}</p>
          </div>
          <div className={metricTileClass}>
            <p className="text-xs font-semibold text-slate-500">Latest workflow event</p>
            <p className="mt-2 break-words text-sm font-semibold leading-tight text-slate-950">{lastOperationalEvent}</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 text-left">
            <thead className="bg-slate-50/80">
              <tr>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 sm:px-6">Module</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Activity</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">User</th>
                <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 sm:px-6">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {stats.operations.recent.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-sm font-medium text-slate-400 sm:px-6" colSpan={4}>
                    No payroll, sales, or recruitment workflow events recorded yet.
                  </td>
                </tr>
              ) : (
                stats.operations.recent.map((event, index) => (
                  <tr key={`${event.module}-${event.timestamp}-${index}`} className="transition-colors hover:bg-orange-50/40">
                    <td className="whitespace-nowrap px-4 py-4 align-top sm:px-6">
                      <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-600">
                        {event.module}
                      </span>
                    </td>
                    <td className="min-w-[260px] px-4 py-4 align-top">
                      <p className="text-sm font-medium leading-5 text-slate-800">{event.description}</p>
                      <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{event.status}</p>
                    </td>
                    <td className="min-w-[180px] px-4 py-4 align-top text-sm font-semibold text-slate-900">{event.userName}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-right align-top text-xs font-medium text-slate-500 sm:px-6">
                      {formatActivityTimestamp(event.timestamp)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="Actual provider delivery status from Resend webhooks. These statuses show what happened after Resend accepted the send request."
        title="Resend Delivery Events"
      >
        <div className="grid gap-4 border-b border-slate-100 p-4 sm:grid-cols-3 xl:grid-cols-6">
          <div className={metricTileClass}>
            <p className="text-xs font-semibold text-slate-500">Delivered (24h)</p>
            <p className="mt-2 text-[1.35rem] font-semibold leading-tight text-emerald-700">{stats.notifications.actualDelivery24h.delivered}</p>
          </div>
          <div className={metricTileClass}>
            <p className="text-xs font-semibold text-slate-500">Bounced (24h)</p>
            <p className="mt-2 text-[1.35rem] font-semibold leading-tight text-rose-700">{stats.notifications.actualDelivery24h.bounced}</p>
          </div>
          <div className={metricTileClass}>
            <p className="text-xs font-semibold text-slate-500">Failed (24h)</p>
            <p className="mt-2 text-[1.35rem] font-semibold leading-tight text-rose-700">{stats.notifications.actualDelivery24h.failed}</p>
          </div>
          <div className={metricTileClass}>
            <p className="text-xs font-semibold text-slate-500">Suppressed (24h)</p>
            <p className="mt-2 text-[1.35rem] font-semibold leading-tight text-amber-700">{stats.notifications.actualDelivery24h.suppressed}</p>
          </div>
          <div className={metricTileClass}>
            <p className="text-xs font-semibold text-slate-500">Complaints (24h)</p>
            <p className="mt-2 text-[1.35rem] font-semibold leading-tight text-amber-700">{stats.notifications.actualDelivery24h.complained}</p>
          </div>
          <div className={metricTileClass}>
            <p className="text-xs font-semibold text-slate-500">Sent Events (24h)</p>
            <p className="mt-2 text-[1.35rem] font-semibold leading-tight text-sky-700">{stats.notifications.actualDelivery24h.sent}</p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 text-left">
            <thead className="bg-slate-50/80">
              <tr>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 sm:px-6">Status</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Subject</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Recipients</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Reason</th>
                <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 sm:px-6">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {stats.notifications.recentDeliveryEvents.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-sm font-medium text-slate-400 sm:px-6" colSpan={5}>
                    No Resend webhook delivery events recorded yet.
                  </td>
                </tr>
              ) : (
                stats.notifications.recentDeliveryEvents.map((event) => (
                  <tr key={event.id} className="transition-colors hover:bg-orange-50/40">
                    <td className="whitespace-nowrap px-4 py-4 align-top sm:px-6">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] ${deliveryStatusClass(event.status)}`}>
                        {event.status}
                      </span>
                    </td>
                    <td className="min-w-[220px] px-4 py-4 align-top text-sm font-semibold text-slate-900">
                      {event.subject ?? "No subject"}
                    </td>
                    <td className="min-w-[220px] px-4 py-4 align-top font-mono text-xs text-slate-600">
                      {event.recipients.length > 0 ? event.recipients.join(", ") : "N/A"}
                    </td>
                    <td className="min-w-[220px] px-4 py-4 align-top text-sm text-slate-600">
                      {event.failureReason ?? "N/A"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-right align-top text-xs font-medium text-slate-500 sm:px-6">
                      {formatActivityTimestamp(event.occurredAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="Latest authentication and user-admin events ordered by the monitoring data source."
        action={(
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <form action={tableFilterAction} method="get" className="flex flex-1 flex-col gap-2 md:flex-row md:items-center">
              <label className="relative block min-w-[220px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm font-medium text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
                  defaultValue={activitySearch}
                  name="search"
                  placeholder="Filter HR ID, name, event..."
                  type="text"
                />
              </label>
              <select
                className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
                defaultValue={activityTypeFilter}
                name="type"
              >
                <option value="all">All types</option>
                {activityTypeOptions.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <select
                className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
                defaultValue={activitySort}
                name="sort"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
              <label className="relative inline-flex h-10 min-w-[120px] items-center rounded-xl border border-slate-200 bg-white pr-3 text-sm font-medium text-slate-700">
                <span className="px-2 text-xs text-slate-500">Page size</span>
                <input
                  className="h-full w-full rounded-r-xl border-l border-slate-200 bg-transparent pl-2 pr-2 text-sm font-semibold text-slate-700 outline-none"
                  defaultValue={activityPageSize}
                  min={1}
                  name="pageSize"
                  type="number"
                />
              </label>
              <input name="page" type="hidden" value="1" />
              <button
                className="h-10 rounded-xl border border-slate-200 bg-slate-950 px-4 text-sm font-black text-white transition hover:bg-orange-500"
                type="submit"
              >
                Apply
              </button>
            </form>
            <Link
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-700 transition hover:border-orange-300 hover:text-orange-700"
              href={csvExportHref}
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Link>
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
              {stats.recentEvents.rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-sm font-medium text-slate-400 sm:px-6" colSpan={5}>
                    No recent auth or user-admin events match the selected filters.
                  </td>
                </tr>
              ) : (
                stats.recentEvents.rows.map((event) => (
                  <tr key={event.id} className="transition-colors hover:bg-orange-50/40">
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
          {activityTotal === 0 ? (
            <p className="font-medium">Showing 0 of 0 events</p>
          ) : (
            <p className="font-medium">
              Showing {activityStart}-{activityEnd} of {activityTotal} events
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Link
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 transition hover:border-orange-300 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-45"
              href={safeActivityPage > 1 ? `/admin/monitoring?${createQueryParams(safeActivityPage - 1).toString()}` : "#"}
              onClick={safeActivityPage <= 1 ? (event) => event.preventDefault() : undefined}
            >
              Previous
            </Link>
            <span className="px-1 text-xs font-bold text-slate-500">
              Page {safeActivityPage} of {activityTotalPages}
            </span>
            <Link
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 transition hover:border-orange-300 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-45"
              href={safeActivityPage < activityTotalPages ? `/admin/monitoring?${createQueryParams(safeActivityPage + 1).toString()}` : "#"}
              onClick={safeActivityPage >= activityTotalPages ? (event) => event.preventDefault() : undefined}
            >
              Next
            </Link>
          </div>
        </div>
      </AdminTableShell>
    </div>
  );
}
