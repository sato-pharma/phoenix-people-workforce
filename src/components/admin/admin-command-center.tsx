import Link from "next/link";
import {
  Users,
  TrendingUp,
  ShieldCheck,
  BarChart3,
  FileSpreadsheet,
  Network,
  Receipt,
  Briefcase,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  Activity,
  FileUp,
  Target,
  Wallet,
  HeartPulse,
  IdCard,
  LockKeyhole,
  XCircle,
} from "lucide-react";

import type { AdminCommandCenterData } from "@/lib/admin/command-center";

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function egp(value: number) {
  if (value >= 1_000_000)
    return `EGP ${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000)
    return `EGP ${(value / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(value);
}

function pct(value: number, decimals = 1) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(decimals)}%`;
}

function n(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "0";
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI card
// ─────────────────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  accent = false,
  icon: Icon,
  warn = false,
  primary = false,
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  icon: typeof Users;
  warn?: boolean;
  primary?: boolean;
  trend?: "up" | "down" | "neutral";
}) {
  const getCardAccent = () => {
    if (warn) {
      return {
        bg: "bg-gradient-to-r from-amber-50 to-amber-100/50",
        iconBg: "bg-gradient-to-br from-amber-100 to-amber-50",
        iconText: "text-amber-600",
        border: "border-amber-200/60",
        text: "text-amber-700",
        glow: ""
      };
    }
    if (accent) {
      return {
        bg: "bg-gradient-to-r from-orange-50 to-orange-100/50",
        iconBg: "bg-gradient-to-br from-orange-100 to-orange-50",
        iconText: "text-orange-600",
        border: "border-orange-200/60",
        text: "text-orange-700",
        glow: ""
      };
    }
    return {
      bg: "bg-gradient-to-r from-slate-50 to-white",
      iconBg: "bg-gradient-to-br from-slate-100 to-slate-50",
      iconText: "text-slate-600",
      border: "border-slate-200",
      text: "text-slate-900",
      glow: ""
    };
  };
  const accentStyle = getCardAccent();

  return (
    <div
      className={`relative overflow-hidden rounded-xl border ${accentStyle.border} ${accentStyle.bg} px-5 py-4 shadow-sm transition-all duration-160 ease-out hover:shadow-md hover:-translate-y-px ${primary ? "ring-2 ring-orange-200/40" : ""}`}
    >
      {primary && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-400" />
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" style={{ animationDuration: '1.5s' }} />
            {trend === "up" && <span className="text-emerald-500 text-xs font-semibold">↑</span>}
            {trend === "down" && <span className="text-rose-500 text-xs font-semibold">↓</span>}
          </div>
          <p className={`mt-2 ${primary ? "text-3xl" : "text-2xl"} font-semibold ${accentStyle.text}`}>
            {value}
          </p>
          {sub && <p className="mt-1.5 text-xs text-slate-500">{sub}</p>}
        </div>
        <div
          className={`flex ${primary ? "h-10 w-10" : "h-9 w-9"} shrink-0 items-center justify-center rounded-lg ${accentStyle.iconBg} ${accentStyle.iconText} shadow-sm transition-all duration-160 ease-out hover:scale-105`}
        >
          <Icon className={`${primary ? "h-5 w-5" : "h-4 w-4"}`} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Module card
// ─────────────────────────────────────────────────────────────────────────────

type MiniMetric = { label: string; value: string; ok?: boolean };

function ModuleCard({
  title,
  description,
  href,
  icon: Icon,
  metrics = [],
  accentColor = "orange",
  health = "healthy",
  lastSync,
}: {
  title: string;
  description: string;
  href: string;
  icon: typeof Users;
  metrics?: MiniMetric[];
  accentColor?: "orange" | "blue" | "emerald" | "violet" | "amber" | "rose";
  health?: "healthy" | "attention" | "warning";
  lastSync?: string;
}) {
  const colors: Record<string, { bg: string; text: string; ring: string; btn: string; btnHover: string }> = {
    orange:  { bg: "bg-orange-50",  text: "text-orange-600",  ring: "ring-orange-200/60",  btn: "bg-[#0B0B0B] hover:bg-[#F97316]", btnHover: "hover:bg-[#F97316]" },
    blue:    { bg: "bg-sky-50",    text: "text-sky-600",    ring: "ring-sky-200/60",    btn: "bg-[#0B0B0B] hover:bg-[#0EA5E9]", btnHover: "hover:bg-[#0EA5E9]" },
    emerald: { bg: "bg-emerald-50", text: "text-emerald-600", ring: "ring-emerald-200/60", btn: "bg-[#0B0B0B] hover:bg-[#10B981]", btnHover: "hover:bg-[#10B981]" },
    violet:  { bg: "bg-violet-50",  text: "text-violet-600",  ring: "ring-violet-200/60",  btn: "bg-[#0B0B0B] hover:bg-[#8B5CF6]", btnHover: "hover:bg-[#8B5CF6]" },
    amber:   { bg: "bg-amber-50",   text: "text-amber-600",   ring: "ring-amber-200/60",   btn: "bg-[#0B0B0B] hover:bg-[#F59E0B]", btnHover: "hover:bg-[#F59E0B]" },
    rose:    { bg: "bg-rose-50",    text: "text-rose-600",    ring: "ring-rose-200/60",    btn: "bg-[#0B0B0B] hover:bg-[#F43F5E]", btnHover: "hover:bg-[#F43F5E]" },
  };
  const c = colors[accentColor] ?? colors.orange;

  const healthColors = {
    healthy: "bg-emerald-500/10 text-emerald-700 border-emerald-200/60",
    attention: "bg-amber-500/10 text-amber-700 border-amber-200/60",
    warning: "bg-rose-500/10 text-rose-700 border-rose-200/60",
  };

  return (
    <div className="group flex flex-col rounded-xl border border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 p-5 shadow-sm transition-all duration-160 ease-out hover:-translate-y-px hover:shadow-md hover:border-slate-300">
      {/* Icon + title + health */}
      <div className="mb-4 flex items-start gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${c.bg} ${c.text} ${c.ring} shadow-sm transition-all duration-160 ease-out group-hover:scale-110 group-hover:shadow-md`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">{title}</p>
            <div className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${healthColors[health]}`}>
              {health === "healthy" && <CheckCircle2 className="h-2.5 w-2.5" />}
              {health === "attention" && <AlertTriangle className="h-2.5 w-2.5" />}
              {health === "warning" && <XCircle className="h-2.5 w-2.5" />}
              <span className="capitalize">{health}</span>
            </div>
          </div>
          <p className="mt-1 text-xs text-slate-500 leading-relaxed">{description}</p>
          {lastSync && <p className="mt-1 text-[10px] text-slate-400">Synced: {lastSync}</p>}
        </div>
      </div>

      {/* Mini metrics */}
      {metrics.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-2">
          {metrics.map((m) => (
            <div key={m.label} className="rounded-lg border border-slate-200/60 bg-gradient-to-b from-slate-50 to-white px-3 py-2 shadow-sm transition-all duration-160 ease-out group-hover:border-slate-300">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">{m.label}</p>
              <p className={`mt-1 text-sm font-semibold ${m.ok === false ? "text-rose-600" : m.ok === true ? "text-emerald-600" : "text-slate-900"}`}>
                {m.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Spacer so button sticks to bottom */}
      <div className="flex-1" />

      <Link
        href={href}
        className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition-all duration-160 ease-out hover:shadow-md active:scale-95 ${c.btn}`}
      >
        Open Module
        <ArrowRight className="h-3.5 w-3.5 transition-transform duration-160 ease-out group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick action pill
// ─────────────────────────────────────────────────────────────────────────────

function QuickAction({ href, label, icon: Icon }: { href: string; label: string; icon: typeof Users }) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-2.5 rounded-full border border-slate-200/80 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm transition-all duration-160 ease-out hover:-translate-y-px hover:border-orange-300/80 hover:bg-orange-50/95 hover:text-orange-700 hover:shadow-md"
    >
      <Icon className="h-3.5 w-3.5 transition-all duration-160 ease-out group-hover:scale-110 group-hover:text-orange-600" />
      {label}
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk alert strip
// ─────────────────────────────────────────────────────────────────────────────

function RiskStrip({ expiringContracts, probationEndings }: { expiringContracts: number; probationEndings: number }) {
  const hasRisk = expiringContracts > 0 || probationEndings > 0;
  if (!hasRisk) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200/80 bg-gradient-to-r from-amber-50/95 via-white to-amber-50/95 px-5 py-3 shadow-sm transition-all duration-160 ease-out hover:shadow-md">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
      <p className="text-xs font-semibold text-amber-900">Attention required:</p>
      {expiringContracts > 0 && (
        <Link href="/contracts" className="group flex items-center gap-1.5 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-200 transition-all duration-160 ease-out hover:shadow-sm">
          {expiringContracts} contract{expiringContracts !== 1 ? "s" : ""} expiring soon
        </Link>
      )}
      {probationEndings > 0 && (
        <Link href="/probation" className="group flex items-center gap-1.5 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-200 transition-all duration-160 ease-out hover:shadow-sm">
          {probationEndings} probation{probationEndings !== 1 ? "s" : ""} ending soon
        </Link>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Data unavailability banner
// ─────────────────────────────────────────────────────────────────────────────

function DataUnavailableBanner({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-200/80 bg-gradient-to-r from-slate-50 to-white px-5 py-3 shadow-sm transition-all duration-160 ease-out hover:shadow-md">
      <Activity className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
      <div>
        <p className="text-xs font-semibold text-slate-700">Some data sources are temporarily unavailable:</p>
        <ul className="mt-1.5 space-y-1">
          {messages.map((m) => (
            <li key={m} className="text-[11px] font-medium text-slate-500">{m}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function AdminCommandCenter({ data }: { data: AdminCommandCenterData }) {
  const { overview: o, health, payrollEligibleCount, dataUnavailable } = data;

  const salesAchievement = o.sales.achievementRate * 100;
  const offerAcceptance = o.recruitment.acceptanceRate * 100;

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top_left,rgba(249,115,22,0.06),transparent_50%),radial-gradient(ellipse_at_bottom_right,rgba(251,146,60,0.04),transparent_45%),radial-gradient(ellipse_at_center,rgba(148,163,184,0.02),transparent_40%),linear-gradient(180deg,#F8FAFC_0%,#F1F5F9_40%,#E8EEF5_100%)] px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-[1480px] space-y-10">

        {/* ── Hero header ─────────────────────────────────────────────── */}
        <div className="relative overflow-hidden rounded-2xl border border-slate-900/90 bg-[linear-gradient(135deg,#0a0a0a_0%,#111111_35%,#1a1208_65%,#2a1a0a_100%)] px-8 py-8 shadow-[0_20px_60px_rgba(0,0,0,0.40),0_0_0_1px_rgba(255,255,255,0.06)_inset,0_0_80px_rgba(249,115,22,0.06)]">
          {/* Premium multi-layered glow blobs */}
          <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-[#F97316]/10 blur-[100px]" />
          <div className="pointer-events-none absolute -bottom-20 left-40 h-72 w-72 rounded-full bg-[#F59E0B]/8 blur-[80px]" />
          <div className="pointer-events-none absolute right-1/3 top-1/3 h-56 w-56 rounded-full bg-[#FB923C]/6 blur-[60px]" />
          {/* Subtle grid pattern overlay */}
          <div className="pointer-events-none absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTTAgNDBMMDQwIDBIMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMDQpIiBzdHJva2Utd2lkdGg9IjEiLz48L3BhdHRlcm4+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9InVybCgjZ3JpZCkiLz48L3N2Zz4=')] opacity-30" />

          <div className="relative z-10">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex-1">
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/5 px-3 py-1 backdrop-blur-sm">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-400 shadow-[0_0_6px_rgba(251,146,60,0.5)]" />
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-orange-200">Phoenix Workforce</span>
                </div>
                <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl lg:text-5xl">
                  Admin Command Center
                </h1>
                <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-300/80">
                  Unified workforce, payroll, sales, and operational intelligence — all in one place.
                </p>
              </div>

              {/* Live operational status */}
              <div className="flex flex-col items-end gap-2">
                <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/90 px-4 py-2 backdrop-blur-md shadow-[0_6px_20px_rgba(0,0,0,0.3)]">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" style={{ animationDuration: '1.5s' }} />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]" />
                  </span>
                  <span className="text-xs font-semibold text-slate-200">Live data</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-400 border border-emerald-500/20">
                    <CheckCircle2 className="h-3 w-3" />
                    <span className="font-medium">Payroll Synced</span>
                  </div>
                  <div className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-1 text-sky-400 border border-sky-500/20">
                    <ShieldCheck className="h-3 w-3" />
                    <span className="font-medium">Governance Active</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick actions */}
            <div className="mt-5 flex flex-wrap gap-2">
              <QuickAction href="/employees" label="Employees" icon={Users} />
              <QuickAction href="/payroll" label="Payroll" icon={Wallet} />
              <QuickAction href="/sales" label="Sales" icon={TrendingUp} />
              <QuickAction href="/admin/access" label="Access Control" icon={ShieldCheck} />
              <QuickAction href="/imports/employees" label="Bulk Import" icon={FileUp} />
              <QuickAction href="/organogram" label="Organogram" icon={Network} />
            </div>
          </div>
        </div>

        {/* ── Risk & data alerts ──────────────────────────────────────── */}
        <RiskStrip
          expiringContracts={o.risk.expiringContracts}
          probationEndings={o.risk.probationEndings}
        />
        <DataUnavailableBanner messages={dataUnavailable} />

        {/* ── Command Center Summary Strip ─────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200/80 bg-gradient-to-r from-white via-slate-50/50 to-white px-5 py-3 shadow-sm">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-slate-700">{n(o.hr.totalEmployees)} Employees</span>
            <span className="text-slate-300">|</span>
            <span className="font-semibold text-slate-700">{n(o.hr.activeEmployees)} Active</span>
          </div>
          <div className="h-4 w-px bg-slate-200" />
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-slate-700">{o.risk.expiringContracts + o.risk.probationEndings} Pending</span>
            <span className="text-slate-300">|</span>
            <span className="font-semibold text-slate-700">{n(o.payroll.flags)} Flags</span>
          </div>
          <div className="h-4 w-px bg-slate-200" />
          <div className="flex items-center gap-2 text-xs">
            <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-1 text-emerald-700 border border-emerald-200/60">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" style={{ animationDuration: '1.5s' }} />
              <span className="font-medium">Payroll Synced</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-full bg-sky-50 px-2 py-1 text-sky-700 border border-sky-200/60">
              <ShieldCheck className="h-3 w-3" />
              <span className="font-medium">Audit Healthy</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-full bg-violet-50 px-2 py-1 text-violet-700 border border-violet-200/60">
              <LockKeyhole className="h-3 w-3" />
              <span className="font-medium">Access Protected</span>
            </div>
          </div>
        </div>

        {/* ── KPI strip ────────────────────────────────────────────────── */}
        <div>
          <div className="mb-4 flex items-center justify-between">
            <p className="flex items-center gap-2.5 text-xs font-bold uppercase tracking-[0.12em] text-slate-700">
              <span className="h-2 w-2 rounded-full bg-gradient-to-r from-orange-500 to-amber-400 shadow-[0_0_6px_rgba(249,115,22,0.4)]" />
              Key Metrics
            </p>
            <div className="flex items-center gap-2 text-xs">
              <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700 border border-emerald-200/60">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" style={{ animationDuration: '1.5s' }} />
                <span className="font-medium">Governance Active</span>
              </div>
              <div className="flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-sky-700 border border-sky-200/60">
                <ShieldCheck className="h-3 w-3" />
                <span className="font-medium">RLS Protected</span>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4">
            <KpiCard
              label="Active Employees"
              value={n(o.hr.activeEmployees)}
              sub={`of ${n(o.hr.totalEmployees)} total`}
              icon={CheckCircle2}
              primary
              trend="up"
            />
            <KpiCard
              label="Net Payroll"
              value={egp(o.payroll.net)}
              sub={`Gross ${egp(o.payroll.gross)}`}
              icon={Wallet}
              primary
              accent
            />
            <KpiCard
              label="Sales Achievement"
              value={pct(salesAchievement)}
              sub={`${n(o.sales.activeProducts)} active products`}
              icon={Target}
              accent={salesAchievement >= 90}
              warn={salesAchievement < 70}
              primary
              trend={salesAchievement >= 90 ? "up" : salesAchievement < 70 ? "down" : "neutral"}
            />
            <KpiCard
              label="Total Employees"
              value={n(o.hr.totalEmployees)}
              sub={`${n(o.hr.uniqueLines)} lines · ${n(o.hr.uniqueAreas)} areas`}
              icon={Users}
            />
            <KpiCard
              label="Payroll Eligible"
              value={n(payrollEligibleCount)}
              sub={o.payroll.batchLabel || "Latest batch"}
              icon={IdCard}
            />
            <KpiCard
              label="Total Sales"
              value={egp(o.sales.salesValue)}
              sub={`vs ${egp(o.sales.targetValue)} target`}
              icon={TrendingUp}
            />
            <KpiCard
              label="Expense Claims"
              value={egp(o.expenses.approvedAmount)}
              sub={`${n(o.expenses.totalRows)} entries`}
              icon={Receipt}
            />
            <KpiCard
              label="Data Health"
              value={pct(health.employeeHealthRate)}
              sub={`${n(health.healthyEmployees)} / ${n(health.totalEmployees || o.hr.totalEmployees)} healthy`}
              icon={HeartPulse}
              accent={health.employeeHealthRate >= 90}
              warn={health.employeeHealthRate < 70}
              trend={health.employeeHealthRate >= 90 ? "up" : health.employeeHealthRate < 70 ? "down" : "neutral"}
            />
          </div>
        </div>

        {/* ── Module grid ──────────────────────────────────────────────── */}
        <div>
          <div className="mb-4 flex items-center justify-between">
            <p className="flex items-center gap-2.5 text-xs font-bold uppercase tracking-[0.12em] text-slate-700">
              <span className="h-2 w-2 rounded-full bg-gradient-to-r from-orange-500 to-amber-400 shadow-[0_0_6px_rgba(249,115,22,0.4)]" />
              Modules
            </p>
            <div className="flex items-center gap-2 text-xs">
              <div className="flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-violet-700 border border-violet-200/60">
                <LockKeyhole className="h-3 w-3" />
                <span className="font-medium">Audit Enabled</span>
              </div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">

            {/* People & Organogram */}
            <ModuleCard
              title="People & Organogram"
              description="Workforce directory, reporting lines, and org structure visualization."
              href="/employees"
              icon={Users}
              accentColor="blue"
              health={o.hr.employeesWithoutManagers > 0 ? "attention" : "healthy"}
              lastSync="Live"
              metrics={[
                { label: "Total", value: n(o.hr.totalEmployees) },
                { label: "Active", value: n(o.hr.activeEmployees) },
                { label: "Lines", value: n(o.hr.uniqueLines) },
              ]}
            />

            {/* Payroll Operations */}
            <ModuleCard
              title="Payroll Operations"
              description="Salary batches, payslip distribution, deductions, and financial reconciliation."
              href="/payroll"
              icon={FileSpreadsheet}
              accentColor="emerald"
              health={o.payroll.flags > 0 ? "attention" : "healthy"}
              lastSync={o.payroll.batchLabel || "Latest"}
              metrics={[
                { label: "Net", value: egp(o.payroll.net) },
                { label: "Staff", value: n(o.payroll.employees) },
                { label: "Flags", value: n(o.payroll.flags), ok: o.payroll.flags === 0 },
              ]}
            />

            {/* Sales Performance */}
            <ModuleCard
              title="Sales Performance"
              description="Rep achievement tracking, product analytics, and territory-level targets."
              href="/sales"
              icon={BarChart3}
              accentColor="orange"
              health={salesAchievement >= 90 ? "healthy" : salesAchievement < 70 ? "warning" : "attention"}
              lastSync="Live"
              metrics={[
                { label: "Sales", value: egp(o.sales.salesValue) },
                { label: "Achieve", value: pct(salesAchievement), ok: salesAchievement >= 90 },
                { label: "Products", value: n(o.sales.activeProducts) },
              ]}
            />

            {/* Field Expenses */}
            <ModuleCard
              title="Field Expenses"
              description="Trip reports, fuel claims, and expense approval workflow."
              href="/payroll/expenses/dashboard"
              icon={Receipt}
              accentColor="amber"
              health="healthy"
              lastSync="Live"
              metrics={[
                { label: "Approved", value: egp(o.expenses.approvedAmount) },
                { label: "Reports", value: n(o.expenses.reportCount) },
                { label: "Entries", value: n(o.expenses.totalRows) },
              ]}
            />

            {/* Job Offers */}
            <ModuleCard
              title="Job Offers"
              description="Offer lifecycle management, acceptance tracking, and pipeline overview."
              href="/offers"
              icon={Briefcase}
              accentColor="violet"
              health={offerAcceptance >= 70 ? "healthy" : "attention"}
              lastSync="Live"
              metrics={[
                { label: "Total", value: n(o.recruitment.totalOffers) },
                { label: "Pending", value: n(o.recruitment.pendingOffers) },
                { label: "Accept %", value: pct(offerAcceptance), ok: offerAcceptance >= 70 },
              ]}
            />

            {/* Data Health */}
            <ModuleCard
              title="Data Health"
              description="Employee linkage integrity, HR ID orphan detection, and sales data quality."
              href="/imports/employees"
              icon={HeartPulse}
              accentColor="rose"
              health={health.employeeHealthRate >= 90 ? "healthy" : health.employeeHealthRate < 70 ? "warning" : "attention"}
              lastSync="Live"
              metrics={[
                { label: "HR Health", value: pct(health.employeeHealthRate), ok: health.employeeHealthRate >= 90 },
                { label: "Sales Link", value: pct(health.salesLinkageRate), ok: health.salesLinkageRate >= 90 },
                { label: "No Mgr", value: n(health.missingManager), ok: health.missingManager === 0 },
              ]}
            />

            {/* Organogram */}
            <ModuleCard
              title="Organogram"
              description="Interactive org chart with hierarchy visualization and role mapping."
              href="/organogram"
              icon={Network}
              accentColor="blue"
              health={o.hr.employeesWithoutManagers > 0 ? "attention" : "healthy"}
              lastSync="Live"
              metrics={[
                { label: "Lines", value: n(o.hr.uniqueLines) },
                { label: "Areas", value: n(o.hr.uniqueAreas) },
                { label: "No Mgr", value: n(o.hr.employeesWithoutManagers), ok: o.hr.employeesWithoutManagers === 0 },
              ]}
            />

            {/* Access Control */}
            <ModuleCard
              title="Access Control"
              description="User accounts, role permissions, authentication, and audit trail."
              href="/admin/access"
              icon={ShieldCheck}
              accentColor="violet"
              health="healthy"
              lastSync="Live"
              metrics={[]}
            />

          </div>
        </div>

        {/* ── Secondary modules row ────────────────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-3">
          <Link
            href="/probation"
            className="group flex items-center justify-between rounded-lg border border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 px-5 py-4 shadow-sm transition-all duration-160 ease-out hover:-translate-y-px hover:border-slate-300 hover:shadow-md"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-amber-50 to-amber-100 text-amber-600 ring-1 ring-amber-200/60 shadow-sm transition-all duration-160 ease-out group-hover:scale-110 group-hover:shadow-md">
                <Activity className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">Probation Tracker</p>
                <p className="text-xs text-slate-500">
                  {o.risk.probationEndings > 0
                    ? `${o.risk.probationEndings} ending soon`
                    : "All on track"}
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-300 transition-all duration-160 ease-out group-hover:text-orange-500 group-hover:translate-x-1" />
          </Link>

          <Link
            href="/contracts"
            className="group flex items-center justify-between rounded-lg border border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 px-5 py-4 shadow-sm transition-all duration-160 ease-out hover:-translate-y-px hover:border-slate-300 hover:shadow-md"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-sky-50 to-sky-100 text-sky-600 ring-1 ring-sky-200/60 shadow-sm transition-all duration-160 ease-out group-hover:scale-110 group-hover:shadow-md">
                <IdCard className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">Contract Renewal</p>
                <p className="text-xs text-slate-500">
                  {o.risk.expiringContracts > 0
                    ? `${o.risk.expiringContracts} expiring soon`
                    : "No urgent renewals"}
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-300 transition-all duration-160 ease-out group-hover:text-orange-500 group-hover:translate-x-1" />
          </Link>

        </div>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between rounded-lg border border-slate-200/70 bg-gradient-to-r from-white/80 via-white/90 to-white/80 px-5 py-3.5 shadow-sm backdrop-blur-md">
          <p className="text-[11px] font-semibold text-slate-500">Phoenix Workforce · Admin Command Center</p>
          <p className="text-[11px] font-medium text-slate-400">Data refreshes on each page load</p>
        </div>

      </div>
    </div>
  );
}
