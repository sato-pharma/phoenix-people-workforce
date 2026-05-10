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
    amber: "bg-amber-50 text-amber-600 ring-amber-100",
    emerald: "bg-emerald-50 text-emerald-600 ring-emerald-100",
    rose: "bg-rose-50 text-rose-600 ring-rose-100",
    slate: "bg-slate-100 text-slate-600 ring-slate-200",
  }[tone];

  return (
    <Card className="relative overflow-hidden border-[#E2E8F0] bg-white/95 p-5 shadow-[0_16px_36px_rgba(15,23,42,0.07)] transition-all hover:-translate-y-0.5 hover:border-[#FDBA74] hover:bg-white hover:shadow-[0_22px_48px_rgba(15,23,42,0.10)]">
      <div className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-orange-200/20 blur-2xl" />
      <div className="flex items-center justify-between">
        <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ring-8 ${toneClass}`}>
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
  const panelClass = "border-[#E2E8F0] bg-white/95 p-6 shadow-[0_18px_42px_rgba(15,23,42,0.07)]";
  const metricTileClass = "rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]";

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
      <div className="relative overflow-hidden rounded-3xl border border-[#D8E0EA] bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-12 h-28 w-28 rounded-full bg-slate-200/45 blur-2xl" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
              <span className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">Observability cockpit</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0B0B0B] text-orange-400 shadow-[0_14px_30px_rgba(15,23,42,0.22)]">
                <Radar className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-3xl font-black tracking-tight text-slate-950">Monitoring Dashboard</h1>
                <p className="mt-1 max-w-3xl text-sm text-slate-500">
                  Operational monitoring for auth stability, notification throughput, and security-sensitive activity using live Supabase data.
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Auth coverage</p>
            <p className="mt-1 text-2xl font-black text-slate-950">{coveragePercent}</p>
          </div>
        </div>
      </div>

      {stats.auth.brokenAccounts.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-[linear-gradient(135deg,#FFF1F2_0%,#FFFFFF_100%)] px-5 py-4 shadow-[0_16px_36px_rgba(244,63,94,0.10)]">
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
        <Card className={panelClass}>
          <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.16em] text-slate-700">
            <span className="h-2 w-2 rounded-full bg-[#F97316]" />
            Auth Monitoring
          </h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Unique failed IPs (24h)</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.auth.uniqueFailedIps24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Auth audit events (24h)</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.auth.recentAuthEvents}</p>
            </div>
          </div>
        </Card>

        <Card className={panelClass}>
          <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.16em] text-slate-700">
            <span className="h-2 w-2 rounded-full bg-[#F97316]" />
            Notification Monitoring
          </h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Sent logs (24h)</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.notifications.sent24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Failed logs (24h)</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.notifications.failed24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Pending events (24h)</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.notifications.pending24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Total delivery logs</p>
              <p className="mt-2 text-2xl font-black text-slate-900">{stats.notifications.totalLogs}</p>
            </div>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden border-[#E2E8F0] bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
        <div className="border-b border-[#E2E8F0] bg-white/90 px-6 py-5">
          <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.16em] text-slate-700">
            <span className="h-2 w-2 rounded-full bg-[#F97316]" />
            Recent Security Activity
          </h2>
        </div>
        <div className="divide-y divide-slate-100">
          {stats.recentEvents.length === 0 ? (
            <div className="p-8 text-sm text-slate-500">No recent auth or user-admin events were recorded.</div>
          ) : (
            stats.recentEvents.map((event, index) => (
              <div key={`${event.entityType}-${event.createdAt ?? index}`} className="flex items-start justify-between gap-4 px-6 py-4 transition-colors hover:bg-orange-50/35">
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
    </div>
  );
}
