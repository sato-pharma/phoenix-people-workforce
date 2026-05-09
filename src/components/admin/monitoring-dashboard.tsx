"use client";

import { Activity, AlertTriangle, BellRing, Lock, Radar, ShieldAlert, UserRoundCog } from "lucide-react";

import { Card } from "@/components/ui/card";
import type { AdminMonitoringStats } from "@/lib/admin/service";

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
    amber: "bg-amber-50 text-amber-600",
    emerald: "bg-emerald-50 text-emerald-600",
    rose: "bg-rose-50 text-rose-600",
    slate: "bg-slate-100 text-slate-600",
  }[tone];

  return (
    <Card className="border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className={`flex h-10 w-10 items-center justify-center rounded-2xl ${toneClass}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-4 text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-black text-slate-900">{value}</p>
    </Card>
  );
}

export function MonitoringDashboard({ stats }: { stats: AdminMonitoringStats }) {
  const coveragePercent = `${(stats.auth.authBridgeCoverageRate * 100).toFixed(1)}%`;

  return (
    <div className="mx-auto min-h-screen max-w-[1600px] space-y-8 bg-slate-50/50 p-6 lg:p-8">
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-orange-500">Observability</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-900">Monitoring Dashboard</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-500">
          Operational monitoring for auth stability, notification throughput, and security-sensitive activity using live Supabase data.
        </p>
      </div>

      {stats.auth.brokenAccounts.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-500" />
          <div>
            <p className="font-semibold text-rose-800">
              {stats.auth.brokenAccounts.length} account{stats.auth.brokenAccounts.length > 1 ? "s" : ""} cannot log in — missing access profile
            </p>
            <p className="mt-1 text-sm text-rose-600">
              Login ID{stats.auth.brokenAccounts.length > 1 ? "s" : ""} affected:{" "}
              <span className="font-mono font-bold">{stats.auth.brokenAccounts.join(", ")}</span>
            </p>
            <p className="mt-1 text-xs text-rose-500">
              Fix: open Users &amp; Access → edit each user → re-save with a new password.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard icon={Radar} label="Auth Bridge Coverage" tone="emerald" value={coveragePercent} />
        <StatCard icon={ShieldAlert} label="Failed Logins (24h)" tone={stats.auth.failedAttempts24h > 0 ? "rose" : "slate"} value={stats.auth.failedAttempts24h} />
        <StatCard icon={Lock} label="Locked Accounts" tone={stats.auth.lockedAccounts > 0 ? "rose" : "slate"} value={stats.auth.lockedAccounts} />
        <StatCard icon={UserRoundCog} label="Forced Password Reset" tone={stats.auth.forcedPasswordResets > 0 ? "amber" : "slate"} value={stats.auth.forcedPasswordResets} />
        <StatCard icon={BellRing} label="Queued Notification Events" tone={stats.notifications.pending24h > 0 ? "amber" : "slate"} value={stats.notifications.pending24h} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-400">Auth Monitoring</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">Unique failed IPs (24h)</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.auth.uniqueFailedIps24h}</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">Auth audit events (24h)</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.auth.recentAuthEvents}</p>
            </div>
          </div>
        </Card>

        <Card className="border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-400">Notification Monitoring</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">Sent logs (24h)</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.notifications.sent24h}</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">Failed logs (24h)</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.notifications.failed24h}</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">Pending events (24h)</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.notifications.pending24h}</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">Total delivery logs</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.notifications.totalLogs}</p>
            </div>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-5">
          <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-400">Recent Security Activity</h2>
        </div>
        <div className="divide-y divide-slate-100">
          {stats.recentEvents.length === 0 ? (
            <div className="p-8 text-sm text-slate-500">No recent auth or user-admin events were recorded.</div>
          ) : (
            stats.recentEvents.map((event, index) => (
              <div key={`${event.entityType}-${event.createdAt ?? index}`} className="flex items-start justify-between gap-4 p-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{event.summary}</p>
                  <p className="mt-1 text-xs text-slate-500">{event.entityType}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold text-slate-700">{event.actor}</p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    {event.createdAt ? new Date(event.createdAt).toLocaleString() : "Unknown time"}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
