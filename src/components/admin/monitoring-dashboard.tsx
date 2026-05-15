"use client";

import Link from "next/link";
import { Activity, AlertTriangle, ArrowRight, BellRing, Lock, Radar, ScrollText, ShieldAlert, UserRoundCog } from "lucide-react";

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
    amber: "bg-gradient-to-br from-amber-50 to-amber-100 text-amber-600 ring-amber-200 shadow-[0_8px_20px_rgba(251,191,36,0.15)]",
    emerald: "bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-600 ring-emerald-200 shadow-[0_8px_20px_rgba(16,185,129,0.15)]",
    rose: "bg-gradient-to-br from-rose-50 to-rose-100 text-rose-600 ring-rose-200 shadow-[0_8px_20px_rgba(244,63,94,0.15)]",
    slate: "bg-gradient-to-br from-slate-100 to-slate-200 text-slate-600 ring-slate-300 shadow-[0_8px_20px_rgba(148,163,184,0.15)]",
  }[tone];

  return (
    <Card className="relative overflow-hidden rounded-[24px] border border-slate-200/90 bg-white/95 p-6 shadow-[0_16px_40px_rgba(15,23,42,0.06)] transition-all duration-300 ease-out hover:-translate-y-1 hover:border-orange-300/80 hover:bg-white hover:shadow-[0_24px_52px_rgba(15,23,42,0.14)] hover:scale-[1.02]">
      <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-orange-200/15 blur-3xl" />
      <div className="flex items-center justify-between">
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ring-1 transition-all duration-300 hover:scale-110 ${toneClass}`}>
          <Icon className="h-6 w-6" />
        </div>
      </div>
      <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-black text-slate-900">{value}</p>
    </Card>
  );
}

export function MonitoringDashboard({ stats }: { stats: AdminMonitoringStats }) {
  const coveragePercent = `${(stats.auth.authBridgeCoverageRate * 100).toFixed(1)}%`;
  const panelClass = "rounded-2xl border border-slate-200/90 bg-white/95 p-6 shadow-[0_20px_48px_rgba(15,23,42,0.10)]";
  const metricTileClass = "rounded-xl border border-slate-200/80 bg-gradient-to-b from-slate-50 to-slate-100 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all duration-200 hover:border-orange-300/60 hover:shadow-md";

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-slate-200/90 bg-[radial-gradient(ellipse_at_top_left,rgba(249,115,22,0.08),transparent_45%),radial-gradient(ellipse_at_bottom_right,rgba(251,146,60,0.05),transparent_40%),radial-gradient(ellipse_at_center,rgba(148,163,184,0.02),transparent_35%),linear-gradient(180deg,#F8FAFC_0%,#F1F5F9_45%,#E8EEF5_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_0_120px_rgba(249,115,22,0.03)] sm:p-6 xl:p-8">
      <div className="space-y-10">
      <div className="relative overflow-hidden rounded-3xl border border-slate-200/90 bg-white/95 p-8 shadow-[0_25px_70px_rgba(15,23,42,0.12),0_0_0_1px_rgba(255,255,255,0.8)_inset]">
        {/* Premium multi-layered glow blobs */}
        <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-[#F97316]/12 blur-[100px]" />
        <div className="pointer-events-none absolute -bottom-16 left-32 h-56 w-56 rounded-full bg-[#F59E0B]/10 blur-[80px]" />
        <div className="pointer-events-none absolute right-1/4 top-1/3 h-40 w-40 rounded-full bg-[#FB923C]/8 blur-[70px]" />
        {/* Subtle grid pattern overlay */}
        <div className="pointer-events-none absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTTAgNDBMMDQwIDBIMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMDMpIiBzdHJva2Utd2lkdGg9IjEiLz48L3BhdHRlcm4+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9InVybCgjZ3JpZCkiLz48L3N2Zz4=')] opacity-30" />
        {/* Subtle noise texture overlay */}
        <div className="pointer-events-none absolute inset-0 opacity-[0.02] bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48ZmlsdGVyIGlkPSJub2lzZSI+PGZlVHVyYnVsZW5jZSB0eXBlPSJmcmFjdGFsTm9pc2UiIGJhc2VGcmVxdWVuY3k9IjAuNjUiIG51bU9jdGF2ZXM9IjMiIHN0aXRjaFRpbGVzPSJzdGl0Y2giLz48L2ZpbHRlcj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWx0ZXI9InVybCgjbm9pc2UpIiBvcGFjaXR5PSIxIi8+PC9zdmc+')] mix-blend-overlay" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-4 inline-flex items-center gap-2.5 rounded-full border border-orange-500/25 bg-orange-500/8 px-4 py-1.5 backdrop-blur-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.6)]" />
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-orange-200">Observability cockpit</span>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#0B0B0B] to-[#1a1a1a] text-orange-400 shadow-[0_16px_36px_rgba(15,23,42,0.25)]">
                <Radar className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-4xl font-black tracking-tight text-slate-950 sm:text-5xl">Monitoring Dashboard</h1>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-500">
                  Operational monitoring for auth stability, notification throughput, and security-sensitive activity using live Supabase data.
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50 px-5 py-4 shadow-[0_12px_28px_rgba(15,23,42,0.08)]">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Auth coverage</p>
            <p className="mt-1.5 text-3xl font-black text-slate-950">{coveragePercent}</p>
          </div>
        </div>
      </div>

      {stats.auth.brokenAccounts.length > 0 && (
        <div className="flex items-start gap-4 rounded-2xl border border-rose-200/90 bg-gradient-to-r from-rose-50/95 via-white to-rose-50/95 px-6 py-4.5 shadow-[0_18px_42px_rgba(244,63,94,0.14)] backdrop-blur-sm transition-all duration-300 hover:shadow-[0_22px_50px_rgba(244,63,94,0.18)]">
          <AlertTriangle className="mt-0.5 h-5.5 w-5.5 shrink-0 text-rose-500" />
          <div>
            <p className="text-sm font-bold text-rose-900">
              {stats.auth.brokenAccounts.length} account{stats.auth.brokenAccounts.length > 1 ? "s" : ""} cannot log in — missing access profile
            </p>
            <p className="mt-1.5 text-sm text-rose-700">
              Login ID{stats.auth.brokenAccounts.length > 1 ? "s" : ""} affected:{" "}
              <span className="font-mono font-bold text-rose-800">{stats.auth.brokenAccounts.join(", ")}</span>
            </p>
            <p className="mt-1.5 text-xs font-medium text-rose-600">
              Fix: open Users &amp; Access → edit each user → re-save with a new password.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-5">
        <StatCard icon={Radar} label="Auth Bridge Coverage" tone="emerald" value={coveragePercent} />
        <StatCard icon={ShieldAlert} label="Failed Logins (24h)" tone={stats.auth.failedAttempts24h > 0 ? "rose" : "slate"} value={stats.auth.failedAttempts24h} />
        <StatCard icon={Lock} label="Locked Accounts" tone={stats.auth.lockedAccounts > 0 ? "rose" : "slate"} value={stats.auth.lockedAccounts} />
        <StatCard icon={UserRoundCog} label="Forced Password Reset" tone={stats.auth.forcedPasswordResets > 0 ? "amber" : "slate"} value={stats.auth.forcedPasswordResets} />
        <StatCard icon={BellRing} label="Queued Notification Events" tone={stats.notifications.pending24h > 0 ? "amber" : "slate"} value={stats.notifications.pending24h} />
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <Card className={panelClass}>
          <h2 className="flex items-center gap-2.5 text-xs font-black uppercase tracking-[0.2em] text-slate-700">
            <span className="h-2 w-2 rounded-full bg-gradient-to-r from-orange-500 to-amber-400 shadow-[0_0_8px_rgba(249,115,22,0.5)]" />
            Auth Monitoring
          </h2>
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Unique failed IPs (24h)</p>
              <p className="mt-2 text-3xl font-black text-slate-900">{stats.auth.uniqueFailedIps24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Auth audit events (24h)</p>
              <p className="mt-2 text-3xl font-black text-slate-900">{stats.auth.recentAuthEvents}</p>
            </div>
          </div>
        </Card>

        <Card className={panelClass}>
          <h2 className="flex items-center gap-2.5 text-xs font-black uppercase tracking-[0.2em] text-slate-700">
            <span className="h-2 w-2 rounded-full bg-gradient-to-r from-orange-500 to-amber-400 shadow-[0_0_8px_rgba(249,115,22,0.5)]" />
            Notification Monitoring
          </h2>
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Sent logs (24h)</p>
              <p className="mt-2 text-3xl font-black text-slate-900">{stats.notifications.sent24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Failed logs (24h)</p>
              <p className="mt-2 text-3xl font-black text-slate-900">{stats.notifications.failed24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Pending events (24h)</p>
              <p className="mt-2 text-3xl font-black text-slate-900">{stats.notifications.pending24h}</p>
            </div>
            <div className={metricTileClass}>
              <p className="text-xs font-semibold text-slate-500">Total delivery logs</p>
              <p className="mt-2 text-3xl font-black text-slate-900">{stats.notifications.totalLogs}</p>
            </div>
          </div>
        </Card>
      </div>

      <Card className="rounded-2xl border border-slate-200/90 bg-white/95 p-6 shadow-[0_20px_48px_rgba(15,23,42,0.10)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
              <ScrollText className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-black uppercase tracking-[0.18em] text-slate-700">Security Audit Detail</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
                Monitoring keeps health counters here. Detailed auth and user-administration events are centralized in the master audit report.
              </p>
            </div>
          </div>
          <Link
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-xs font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition hover:bg-orange-600"
            href="/admin/logs?module=auth"
          >
            Open Auth Audit
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </Card>
      </div>
    </div>
  );
}
