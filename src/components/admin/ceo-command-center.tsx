import Link from "next/link";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CalendarClock,
  ClipboardCheck,
  HeartPulse,
  Layers,
  Megaphone,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";

import {
  AdminCallout,
  AdminHeroFrame,
  AdminSectionHeader,
  AdminStatCard,
} from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import type {
  CeoAttentionTone,
  CeoCommandCenterData,
  CeoTopMover,
} from "@/lib/ceo/command-center";

export type CeoWelcomeProfile = {
  fullName: string;
  roleLabel: string;
  hrId: string | null;
};

function egp(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(1)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return `EGP ${Math.round(safe).toLocaleString("en-US")}`;
}

function n(value: number) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0";
}

function pct(value: number, decimals = 0) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(decimals)}%`;
}

function firstNameFrom(full: string) {
  return (full || "").trim().split(/\s+/)[0] || "there";
}

const calloutToneByAttention: Record<CeoAttentionTone, "danger" | "warning" | "neutral"> = {
  rose: "danger",
  amber: "warning",
  blue: "neutral",
};

/** Circular company-health gauge — pure SVG (no client runtime, mobile-safe). */
function HealthGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const dash = (clamped / 100) * circumference;
  const color = clamped >= 75 ? "#10B981" : clamped >= 50 ? "#F59E0B" : "#F43F5E";
  return (
    <div className="relative flex h-[148px] w-[148px] items-center justify-center">
      <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="12" />
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-4xl font-black text-white">{Math.round(clamped)}</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-300">Health</span>
      </div>
    </div>
  );
}

/** Single-series sparkline (value trend). */
function Sparkline({ points, stroke = "#F97316" }: { points: number[]; stroke?: string }) {
  if (points.length < 2) {
    return <p className="text-xs text-slate-400">Not enough history yet.</p>;
  }
  const max = Math.max(...points);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const width = 260;
  const height = 48;
  const step = width / (points.length - 1);
  const d = points
    .map((value, index) => {
      const x = index * step;
      const y = height - ((value - min) / range) * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-12 w-full">
      <path d={d} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Two-series grouped bars (e.g. hires vs exits). */
function TwoSeriesBars({
  data,
  colorA,
  colorB,
}: {
  data: Array<{ label: string; a: number; b: number }>;
  colorA: string;
  colorB: string;
}) {
  if (!data.length) {
    return <p className="text-xs text-slate-400">No data yet.</p>;
  }
  const max = Math.max(...data.flatMap((row) => [row.a, row.b]), 1);
  return (
    <div className="flex h-28 items-end gap-2">
      {data.map((row, index) => (
        <div key={`${row.label}-${index}`} className="flex flex-1 flex-col items-center gap-1">
          <div className="flex h-24 w-full items-end justify-center gap-1">
            <div
              className="w-1/2 max-w-[14px] rounded-t-sm"
              style={{ height: `${Math.max(2, (row.a / max) * 100)}%`, backgroundColor: colorA }}
            />
            <div
              className="w-1/2 max-w-[14px] rounded-t-sm"
              style={{ height: `${Math.max(2, (row.b / max) * 100)}%`, backgroundColor: colorB }}
            />
          </div>
          <span className="truncate text-[9px] text-slate-400">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

function MoverList({ movers, empty }: { movers: CeoTopMover[]; empty: string }) {
  if (!movers.length) {
    return <p className="text-xs text-slate-400">{empty}</p>;
  }
  const top = movers[0]?.value || 1;
  return (
    <ul className="space-y-2">
      {movers.map((mover) => (
        <li key={mover.label} className="space-y-1">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium text-slate-700">{mover.label}</span>
            <span className="shrink-0 font-bold text-slate-900">{egp(mover.value)}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-400"
              style={{ width: `${Math.max(4, (mover.value / top) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function PerformanceCard({
  title,
  icon,
  headline,
  headlineLabel,
  meta,
  children,
}: {
  title: string;
  icon: ReactNode;
  headline: string;
  headlineLabel: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-4 rounded-2xl border border-slate-200/90 bg-white/95 p-5 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-slate-500">
          <span className="text-orange-600">{icon}</span>
          {title}
        </div>
        {meta}
      </div>
      <div>
        <p className="text-3xl font-black tracking-tight text-slate-900">{headline}</p>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">{headlineLabel}</p>
      </div>
      {children}
    </Card>
  );
}

export function CeoCommandCenter({
  data,
  welcome,
}: {
  data: CeoCommandCenterData;
  welcome: CeoWelcomeProfile;
}) {
  const { health, headcount, payroll, attention, approvals, sales, trends } = data;
  const generatedLabel = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(data.generatedAt));

  const totalApprovals = approvals.leavePending + approvals.plansPending;
  const allClear = attention.length === 0 && totalApprovals === 0;

  return (
    <div className="space-y-6">
      <AdminHeroFrame>
        <div className="relative grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:p-8">
          <div className="min-w-0 space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-orange-400/40 bg-orange-500/15 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-orange-100">
              <HeartPulse aria-hidden="true" className="h-3.5 w-3.5" />
              CEO Command Center
            </div>
            <h1 className="max-w-2xl text-3xl font-black tracking-[-0.03em] text-white sm:text-4xl lg:text-5xl">
              Hello, {firstNameFrom(welcome.fullName)} <span aria-hidden="true">👋🏻</span>
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-slate-300">
              Your company at a glance — health, what needs your decision, sales across Source of Sales and
              Weekly, marketing ROI, and the trends behind them.
            </p>
            <div className="flex flex-wrap gap-2 pt-1 text-xs text-slate-300">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1">
                <Layers aria-hidden="true" className="h-3.5 w-3.5" /> {n(headcount.uniqueLines)} lines · {n(headcount.uniqueAreas)} areas
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1">
                <Activity aria-hidden="true" className="h-3.5 w-3.5" /> Data as of {generatedLabel}
              </span>
              {data.dataUnavailable.length ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/15 px-3 py-1 text-amber-100">
                  <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" /> {data.dataUnavailable.length} source(s) unavailable
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center justify-center lg:justify-self-end">
            <HealthGauge score={health.score} />
          </div>
        </div>
      </AdminHeroFrame>

      {/* ── Headline KPIs ─────────────────────────────────────────────────── */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          icon={<Users className="h-5 w-5" />}
          label="Active headcount"
          tone="blue"
          value={n(headcount.active)}
          description={`${n(headcount.vacancies)} open vacancies · ${pct(headcount.attritionRate30d, 1)} attrition (30d)`}
        />
        <AdminStatCard
          icon={<Wallet className="h-5 w-5" />}
          label="Monthly payroll (net)"
          tone="violet"
          value={payroll.available ? egp(payroll.net) : "—"}
          description={payroll.available ? `Batch ${payroll.batchLabel} · ${n(payroll.flags)} flags` : "Company payroll summary"}
        />
        <AdminStatCard
          icon={<BarChart3 className="h-5 w-5" />}
          label="Monthly sales (SoS)"
          tone="orange"
          value={sales.sos ? egp(sales.sos.totalValue) : "—"}
          description={sales.sos?.period ? `Source of Sales · ${sales.sos.period}` : "Source of Sales (monthly)"}
        />
        <AdminStatCard
          icon={<Activity className="h-5 w-5" />}
          label="Weekly sales"
          tone="emerald"
          value={sales.weekly ? egp(sales.weekly.salesValue) : "—"}
          description={
            sales.weekly?.weekStart
              ? `Week of ${sales.weekly.weekStart}${
                  !sales.weekly.wowPriorMissing && sales.weekly.wowPct !== null
                    ? ` · ${sales.weekly.wowPct >= 0 ? "+" : ""}${pct(sales.weekly.wowPct, 1)} WoW`
                    : ""
                }`
              : "Latest week"
          }
        />
      </section>

      {/* ── Attention & pending approvals ─────────────────────────────────── */}
      <Card className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white/95 p-0 shadow-[0_20px_48px_rgba(15,23,42,0.10)]">
        <AdminSectionHeader
          title="Attention & pending approvals"
          description="What needs your decision, and the risks worth watching."
        />
        <div className="space-y-4 p-5 sm:p-6">
          {allClear ? (
            <AdminCallout tone="success">
              <ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>All clear — nothing is awaiting your approval and no risk signals are open right now.</span>
            </AdminCallout>
          ) : (
            <>
              {totalApprovals > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Link
                    href="/admin/action-center"
                    className="group flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 transition-colors hover:border-orange-300 hover:bg-orange-50/50"
                  >
                    <span className="flex items-center gap-3">
                      <ClipboardCheck aria-hidden="true" className="h-5 w-5 text-orange-600" />
                      <span className="text-sm font-semibold text-slate-700">Leave awaiting you</span>
                    </span>
                    <span className="flex items-center gap-2 text-lg font-black text-slate-900">
                      {n(approvals.leavePending)}
                      <ArrowUpRight aria-hidden="true" className="h-4 w-4 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                  <Link
                    href="/admin/action-center"
                    className="group flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 transition-colors hover:border-orange-300 hover:bg-orange-50/50"
                  >
                    <span className="flex items-center gap-3">
                      <CalendarClock aria-hidden="true" className="h-5 w-5 text-orange-600" />
                      <span className="text-sm font-semibold text-slate-700">Weekly plans awaiting you</span>
                    </span>
                    <span className="flex items-center gap-2 text-lg font-black text-slate-900">
                      {n(approvals.plansPending)}
                      <ArrowUpRight aria-hidden="true" className="h-4 w-4 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                </div>
              ) : null}
              {attention.length ? (
                <div className="grid gap-2.5">
                  {attention.map((item) => (
                    <Link key={item.key} href={item.href} className="block">
                      <AdminCallout tone={calloutToneByAttention[item.tone]}>
                        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="flex w-full items-center justify-between gap-3">
                          <span className="font-medium">{item.label}</span>
                          <span className="shrink-0 font-black">{n(item.count)}</span>
                        </span>
                      </AdminCallout>
                    </Link>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </Card>

      {/* ── Sales & marketing performance ─────────────────────────────────── */}
      <section className="space-y-3">
        <AdminSectionHeader
          title="Sales & marketing performance"
          description="Source of Sales (monthly), Weekly Sales, and marketing ROI — confidential products included."
        />
        <div className="grid gap-4 lg:grid-cols-3">
          <PerformanceCard
            title="Source of Sales"
            icon={<BarChart3 className="h-4 w-4" />}
            headline={sales.sos ? egp(sales.sos.totalValue) : "—"}
            headlineLabel={sales.sos?.period ? `Monthly · ${sales.sos.period}` : "Monthly"}
            meta={sales.sos ? <span className="text-xs text-slate-400">{n(sales.sos.totalQty)} units</span> : null}
          >
            <div className="space-y-2">
              <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Top lines</p>
              <MoverList movers={sales.sos?.topLines ?? []} empty="No monthly sales loaded yet." />
            </div>
          </PerformanceCard>

          <PerformanceCard
            title="Weekly Sales"
            icon={<Activity className="h-4 w-4" />}
            headline={sales.weekly ? egp(sales.weekly.salesValue) : "—"}
            headlineLabel={sales.weekly?.weekStart ? `Week of ${sales.weekly.weekStart}` : "This week"}
            meta={
              sales.weekly && !sales.weekly.wowPriorMissing && sales.weekly.wowPct !== null ? (
                <span
                  className={`inline-flex items-center gap-1 text-xs font-bold ${
                    sales.weekly.wowPct >= 0 ? "text-emerald-600" : "text-rose-600"
                  }`}
                >
                  {sales.weekly.wowPct >= 0 ? (
                    <TrendingUp aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <TrendingDown aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {pct(Math.abs(sales.weekly.wowPct), 1)} WoW
                </span>
              ) : null
            }
          >
            <div className="space-y-2">
              <Sparkline points={(sales.weekly?.trend ?? []).map((point) => point.value)} stroke="#F97316" />
              <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Top regions</p>
              <MoverList movers={sales.weekly?.topRegions ?? []} empty="No weekly sales loaded yet." />
            </div>
          </PerformanceCard>

          <PerformanceCard
            title="Marketing ROI"
            icon={<Megaphone className="h-4 w-4" />}
            headline={sales.marketing ? pct(sales.marketing.roiCoverage, 0) : "—"}
            headlineLabel="ROI coverage"
            meta={
              sales.marketing && sales.marketing.actionRequired > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-700">
                  {n(sales.marketing.actionRequired)} to act
                </span>
              ) : null
            }
          >
            {sales.marketing ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Requests</span>
                  <span className="font-bold text-slate-900">{n(sales.marketing.requestCount)} · {n(sales.marketing.paidRequests)} paid</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Marketing spend</span>
                  <span className="font-bold text-slate-900">{egp(sales.marketing.totalCost)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Attributed sales</span>
                  <span className="font-bold text-slate-900">{egp(sales.marketing.attributedSalesValue)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Spend at risk</span>
                  <span className="font-bold text-rose-600">{egp(sales.marketing.spendAtRisk)}</span>
                </div>
                {sales.marketing.topRisk ? (
                  <p className="border-t border-slate-100 pt-2 text-xs text-slate-500">
                    Top risk: <span className="font-semibold text-slate-700">{sales.marketing.topRisk.customer}</span>{" "}
                    ({sales.marketing.topRisk.code})
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-slate-400">Marketing ROI is unavailable right now.</p>
            )}
          </PerformanceCard>
        </div>
      </section>

      {/* ── Trends ────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <AdminSectionHeader title="Trends" description="Sales, people cost, and headcount movement over recent months." />
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="space-y-3 rounded-2xl border border-slate-200/90 bg-white/95 p-5 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
            <p className="text-sm font-black uppercase tracking-[0.12em] text-slate-500">Sales</p>
            <Sparkline points={trends.sales.map((point) => point.sales)} stroke="#F97316" />
            <p className="text-xs text-slate-400">Monthly sales value (latest {trends.sales.length} periods)</p>
          </Card>
          <Card className="space-y-3 rounded-2xl border border-slate-200/90 bg-white/95 p-5 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
            <p className="text-sm font-black uppercase tracking-[0.12em] text-slate-500">People cost</p>
            <Sparkline points={trends.financial.map((point) => point.cost)} stroke="#8B5CF6" />
            <p className="text-xs text-slate-400">Monthly payroll cost (latest {trends.financial.length} periods)</p>
          </Card>
          <Card className="space-y-3 rounded-2xl border border-slate-200/90 bg-white/95 p-5 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
            <p className="text-sm font-black uppercase tracking-[0.12em] text-slate-500">Headcount (hires vs exits)</p>
            <TwoSeriesBars
              data={trends.hireExit.map((point) => ({ label: point.label, a: point.hires, b: point.exits }))}
              colorA="#10B981"
              colorB="#F43F5E"
            />
            <p className="flex items-center gap-3 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Hires</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-rose-500" /> Exits</span>
            </p>
          </Card>
        </div>
      </section>

      <footer className="flex flex-col gap-1 border border-slate-200 bg-white/85 px-4 py-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
        <p className="font-semibold">Phoenix Workforce / CEO Command Center</p>
        <p>Live · data as of {generatedLabel}</p>
      </footer>
    </div>
  );
}
