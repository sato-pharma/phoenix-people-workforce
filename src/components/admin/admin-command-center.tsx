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
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  icon: typeof Users;
  warn?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-[22px] border px-5 py-4 shadow-[0_14px_34px_rgba(15,23,42,0.055)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_22px_44px_rgba(15,23,42,0.09)] ${
        accent
          ? "border-orange-200/80 bg-[linear-gradient(135deg,#fff7ed_0%,#ffffff_46%,#ffedd5_100%)]"
          : "border-white bg-[linear-gradient(180deg,#ffffff_0%,#fbfcfd_100%)] ring-1 ring-slate-200/70"
      }`}
    >
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-1 ${accent ? "bg-gradient-to-r from-orange-500 to-amber-300" : "bg-gradient-to-r from-slate-200 to-transparent"}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-widest text-slate-400">{label}</p>
          <p className={`mt-1.5 text-2xl font-black leading-none tracking-tight ${accent ? "text-orange-600" : warn ? "text-amber-600" : "text-slate-900"}`}>
            {value}
          </p>
          {sub && <p className="mt-1 text-[11px] text-slate-400">{sub}</p>}
        </div>
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
            accent ? "bg-orange-500 text-white shadow-[0_12px_22px_rgba(249,115,22,0.26)]" : warn ? "bg-amber-50 text-amber-500 ring-1 ring-amber-100" : "bg-slate-50 text-slate-500 ring-1 ring-slate-200"
          }`}
        >
          <Icon className="h-4 w-4" />
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
}: {
  title: string;
  description: string;
  href: string;
  icon: typeof Users;
  metrics?: MiniMetric[];
  accentColor?: "orange" | "blue" | "emerald" | "violet" | "amber" | "rose";
}) {
  const colors: Record<string, { bg: string; text: string; ring: string; btn: string }> = {
    orange:  { bg: "bg-orange-50",  text: "text-orange-600",  ring: "ring-orange-100",  btn: "bg-[#0B0B0B] hover:bg-[#F97316]" },
    blue:    { bg: "bg-blue-50",    text: "text-blue-600",    ring: "ring-blue-100",    btn: "bg-[#0B0B0B] hover:bg-[#F97316]" },
    emerald: { bg: "bg-emerald-50", text: "text-emerald-600", ring: "ring-emerald-100", btn: "bg-[#0B0B0B] hover:bg-[#F97316]" },
    violet:  { bg: "bg-violet-50",  text: "text-violet-600",  ring: "ring-violet-100",  btn: "bg-[#0B0B0B] hover:bg-[#F97316]" },
    amber:   { bg: "bg-amber-50",   text: "text-amber-600",   ring: "ring-amber-100",   btn: "bg-[#0B0B0B] hover:bg-[#F97316]" },
    rose:    { bg: "bg-rose-50",    text: "text-rose-600",    ring: "ring-rose-100",    btn: "bg-[#0B0B0B] hover:bg-[#F97316]" },
  };
  const c = colors[accentColor] ?? colors.orange;

  return (
    <div className="group flex flex-col rounded-3xl border border-[#E2E8F0] bg-white/95 p-6 shadow-[0_18px_42px_rgba(15,23,42,0.07)] transition duration-200 hover:-translate-y-1 hover:border-[#FDBA74] hover:bg-white hover:shadow-[0_24px_58px_rgba(15,23,42,0.12)]">
      {/* Icon + title */}
      <div className="mb-4 flex items-start gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ${c.bg} ${c.text} ${c.ring}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-slate-900">{title}</p>
          <p className="mt-0.5 text-xs text-slate-400 leading-relaxed">{description}</p>
        </div>
      </div>

      {/* Mini metrics */}
      {metrics.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-2">
          {metrics.map((m) => (
            <div key={m.label} className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{m.label}</p>
              <p className={`mt-0.5 text-sm font-bold ${m.ok === false ? "text-rose-500" : m.ok === true ? "text-emerald-600" : "text-slate-900"}`}>
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
        className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-xs font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition ${c.btn}`}
      >
        Open Module
        <ArrowRight className="h-3.5 w-3.5" />
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
      className="flex items-center gap-2 rounded-full border border-white/60 bg-white/90 px-4 py-2 text-xs font-black text-slate-700 shadow-[0_10px_24px_rgba(15,23,42,0.18)] backdrop-blur-sm transition hover:-translate-y-0.5 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
    >
      <Icon className="h-3.5 w-3.5" />
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
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-200 bg-[linear-gradient(135deg,#FFFBEB_0%,#FFFFFF_100%)] px-5 py-3 shadow-[0_16px_36px_rgba(245,158,11,0.10)]">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
      <p className="text-sm font-medium text-amber-800">Attention required:</p>
      {expiringContracts > 0 && (
        <Link href="/contracts" className="flex items-center gap-1.5 rounded-lg bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-200 transition">
          {expiringContracts} contract{expiringContracts !== 1 ? "s" : ""} expiring soon
        </Link>
      )}
      {probationEndings > 0 && (
        <Link href="/probation" className="flex items-center gap-1.5 rounded-lg bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-200 transition">
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
    <div className="flex items-start gap-3 rounded-2xl border border-[#E2E8F0] bg-white/90 px-5 py-3 shadow-[0_12px_30px_rgba(15,23,42,0.06)]">
      <Activity className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
      <div>
        <p className="text-xs font-medium text-slate-600">Some data sources are temporarily unavailable:</p>
        <ul className="mt-1 space-y-0.5">
          {messages.map((m) => (
            <li key={m} className="text-[11px] text-slate-400">{m}</li>
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
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.10),transparent_32%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-[1480px] space-y-8">

        {/* ── Hero header ─────────────────────────────────────────────── */}
        <div className="relative overflow-hidden rounded-3xl border border-[#242424] bg-[linear-gradient(135deg,#000000_0%,#0B0B0B_54%,#1a1208_100%)] px-8 py-10 shadow-[0_20px_60px_rgba(0,0,0,0.34)]">
          {/* Orange glow blobs */}
          <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-[#F97316]/18 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-10 left-24 h-48 w-48 rounded-full bg-[#F59E0B]/10 blur-2xl" />

          <div className="relative z-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-500/30 bg-orange-500/10 px-3 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
                <span className="text-[11px] font-semibold uppercase tracking-widest text-orange-300">Phoenix Workforce</span>
              </div>
              <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
                Admin Command Center
              </h1>
              <p className="mt-2 max-w-xl text-sm text-slate-400">
                Unified workforce, payroll, sales, and operational intelligence — all in one place.
              </p>
            </div>

            {/* Live indicator */}
            <div className="flex items-center gap-2 rounded-2xl border border-[#333333] bg-[#050505]/80 px-4 py-2.5 backdrop-blur">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <span className="text-xs font-medium text-slate-300">Live data</span>
            </div>
          </div>

          {/* Quick actions */}
          <div className="relative z-10 mt-6 flex flex-wrap gap-2">
            <QuickAction href="/employees" label="Employees" icon={Users} />
            <QuickAction href="/payroll" label="Payroll" icon={Wallet} />
            <QuickAction href="/sales" label="Sales" icon={TrendingUp} />
            <QuickAction href="/admin/access" label="Access Control" icon={ShieldCheck} />
            <QuickAction href="/imports/employees" label="Bulk Import" icon={FileUp} />
            <QuickAction href="/organogram" label="Organogram" icon={Network} />
          </div>
        </div>

        {/* ── Risk & data alerts ──────────────────────────────────────── */}
        <RiskStrip
          expiringContracts={o.risk.expiringContracts}
          probationEndings={o.risk.probationEndings}
        />
        <DataUnavailableBanner messages={dataUnavailable} />

        {/* ── KPI strip ────────────────────────────────────────────────── */}
        <div>
          <p className="mb-3 flex items-center gap-2 text-xs font-black uppercase tracking-[0.2em] text-slate-700">
            <span className="h-2 w-2 rounded-full bg-[#F97316]" />
            Key Metrics
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4">
            <KpiCard
              label="Total Employees"
              value={n(o.hr.totalEmployees)}
              sub={`${n(o.hr.uniqueLines)} lines · ${n(o.hr.uniqueAreas)} areas`}
              icon={Users}
            />
            <KpiCard
              label="Active Employees"
              value={n(o.hr.activeEmployees)}
              sub={`of ${n(o.hr.totalEmployees)} total`}
              icon={CheckCircle2}
              accent
            />
            <KpiCard
              label="Payroll Eligible"
              value={n(payrollEligibleCount)}
              sub={o.payroll.batchLabel || "Latest batch"}
              icon={IdCard}
            />
            <KpiCard
              label="Net Payroll"
              value={egp(o.payroll.net)}
              sub={`Gross ${egp(o.payroll.gross)}`}
              icon={Wallet}
              accent
            />
            <KpiCard
              label="Total Sales"
              value={egp(o.sales.salesValue)}
              sub={`vs ${egp(o.sales.targetValue)} target`}
              icon={TrendingUp}
            />
            <KpiCard
              label="Sales Achievement"
              value={pct(salesAchievement)}
              sub={`${n(o.sales.activeProducts)} active products`}
              icon={Target}
              accent={salesAchievement >= 90}
              warn={salesAchievement < 70}
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
            />
          </div>
        </div>

        {/* ── Module grid ──────────────────────────────────────────────── */}
        <div>
          <p className="mb-3 flex items-center gap-2 text-xs font-black uppercase tracking-[0.2em] text-slate-700">
            <span className="h-2 w-2 rounded-full bg-[#F97316]" />
            Modules
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">

            {/* People & Organogram */}
            <ModuleCard
              title="People & Organogram"
              description="Workforce directory, reporting lines, and org structure visualization."
              href="/employees"
              icon={Users}
              accentColor="blue"
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
              metrics={[
                { label: "HR Health", value: pct(health.employeeHealthRate), ok: health.employeeHealthRate >= 90 },
                { label: "Sales Link", value: pct(health.salesLinkageRate), ok: health.salesLinkageRate >= 90 },
                { label: "No Manager", value: n(health.missingManager), ok: health.missingManager === 0 },
              ]}
            />

            {/* Organogram */}
            <ModuleCard
              title="Organogram"
              description="Interactive org chart with hierarchy visualization and role mapping."
              href="/organogram"
              icon={Network}
              accentColor="blue"
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
              metrics={[]}
            />

          </div>
        </div>

        {/* ── Secondary modules row ────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Link
            href="/probation"
            className="group flex items-center justify-between rounded-2xl border border-[#E2E8F0] bg-white/95 px-5 py-4 shadow-[0_16px_36px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:border-[#FDBA74] hover:bg-white hover:shadow-[0_22px_48px_rgba(15,23,42,0.10)]"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-50 text-amber-500">
                <Activity className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">Probation Tracker</p>
                <p className="text-xs text-slate-400">
                  {o.risk.probationEndings > 0
                    ? `${o.risk.probationEndings} ending soon`
                    : "All on track"}
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:text-orange-500" />
          </Link>

          <Link
            href="/contracts"
            className="group flex items-center justify-between rounded-2xl border border-[#E2E8F0] bg-white/95 px-5 py-4 shadow-[0_16px_36px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:border-[#FDBA74] hover:bg-white hover:shadow-[0_22px_48px_rgba(15,23,42,0.10)]"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-500">
                <IdCard className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">Contract Renewal</p>
                <p className="text-xs text-slate-400">
                  {o.risk.expiringContracts > 0
                    ? `${o.risk.expiringContracts} expiring soon`
                    : "No urgent renewals"}
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:text-orange-500" />
          </Link>

        </div>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between rounded-2xl border border-[#E2E8F0] bg-white/80 px-5 py-4 shadow-[0_14px_34px_rgba(15,23,42,0.05)]">
          <p className="text-[11px] text-slate-400">Phoenix Workforce · Admin Command Center</p>
          <p className="text-[11px] text-slate-400">Data refreshes on each page load</p>
        </div>

      </div>
    </div>
  );
}
