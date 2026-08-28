import Link from "next/link";

import { EarlyBirdOfTheFortnightCard } from "@/components/early-birds/early-bird-of-the-fortnight-card";
import { getLatestLineEarlyBirds } from "@/lib/early-birds/service";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  DollarSign,
  LayoutDashboard,
  MapPinned,
  ShieldCheck,
  Target,
  TrendingDown,
  TrendingUp,
  UserCheck,
  Users,
  Waypoints,
  Wallet,
} from "lucide-react";

import { AreaSparkline, TwoSeriesBars, isSfeDataSource } from "@/components/admin/ceo-command-center";
import { CeoAttendanceTables } from "@/components/admin/ceo-attendance-tables";
import { CeoDvTable } from "@/components/admin/ceo-dv-table";
import { CeoExpenseTables } from "@/components/admin/ceo-expense-tables";
import { CeoSosTables } from "@/components/admin/ceo-sos-tables";
import type { AccessContext } from "@/lib/auth/permissions";
import type { CeoCommandCenterData, CeoAttentionTone, CeoWeeklyTrendPoint } from "@/lib/ceo/command-center";
import { getCeoLandingDeferred } from "@/lib/ceo/command-center";
import { formatStartMinutes, type SfeCrmFieldAnalytics } from "@/lib/crm/sfe-field-analytics";
import type { SfeDoctorCoverageBoard } from "@/lib/crm/sfe-doctor-coverage";
import type { SfeImsContribution, SfeImsRow, SfeTargetPerformance } from "@/lib/sales/sfe-performance";

function egp(v: number) {
  if (!Number.isFinite(v) || v === 0) return "EGP 0";
  if (v >= 1_000_000) return `EGP ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `EGP ${(v / 1_000).toFixed(0)}K`;
  return `EGP ${Math.round(v).toLocaleString("en-US")}`;
}

// ── Section shell ─────────────────────────────────────────────────────────────

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-slate-200 bg-white last:border-b-0">
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-900 px-5 py-3.5">
        <div>
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-phx-2xs text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// ── Unavailable chip ──────────────────────────────────────────────────────────

function UnavailableChip({ label }: { label: string }) {
  return (
    <div className="m-4 border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-400">
      {label} — data unavailable right now.
    </div>
  );
}

function RiskSourceWarning({ owner = "CEO", sources }: { owner?: string; sources: string[] }) {
  if (sources.length === 0) return null;

  return (
    <div className="border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div>
          <p className="text-sm font-black text-amber-900">Some {owner} data sources are unavailable.</p>
          <p className="mt-1 text-xs font-medium text-amber-800">
            Do not treat missing cards as all clear until these sources recover: {sources.join(", ")}.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Health breakdown ──────────────────────────────────────────────────────────

function HealthBreakdown({
  health,
  includeEmployeeLinkage = true,
  includeAttendanceReadiness = true,
}: {
  includeEmployeeLinkage?: boolean;
  includeAttendanceReadiness?: boolean;
  health: {
    salesLinkageRate: number;
    attendanceReadinessRate: number;
    salesAchievementRate: number;
    employeeHealthRate: number;
  };
}) {
  const metrics = [
    { label: "Sales achievement", value: health.salesAchievementRate, target: 0.9, color: "#F97316" },
    // Attendance readiness scores fingerprint device mappings — HR plumbing, not sales or CRM.
    ...(includeAttendanceReadiness
      ? [{ label: "Attendance readiness", value: health.attendanceReadinessRate, target: 1, color: "#3B82F6" }]
      : []),
    // Employee linkage scores the HR employee master (records correctly attached to a manager).
    // The SFE Manager owns none of that data and cannot open any page that would fix it.
    ...(includeEmployeeLinkage
      ? [{ label: "Employee linkage", value: health.employeeHealthRate, target: 1, color: "#10B981" }]
      : []),
    { label: "Sales linkage rate", value: health.salesLinkageRate, target: 1, color: "#8B5CF6" },
  ];
  return (
    <div className={`grid divide-x divide-slate-200 ${metrics.length >= 4 ? "sm:grid-cols-4" : metrics.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
      {metrics.map(({ label, value, target, color }) => {
        const pctVal = Math.round(Math.min(1, (Number.isFinite(value) ? value : 0) / target) * 100);
        const statusColor = pctVal >= 80 ? "#10B981" : pctVal >= 60 ? "#F59E0B" : "#F43F5E";
        return (
          <div key={label} className="flex flex-col gap-3 px-5 py-5">
            <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
            <p className="text-3xl font-black tracking-tight" style={{ color: statusColor }}>
              {pctVal}%
            </p>
            <div className="h-1.5 w-full bg-slate-100">
              <div className="h-full transition-all" style={{ width: `${Math.max(2, pctVal)}%`, backgroundColor: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Trends ────────────────────────────────────────────────────────────────────

function TrendsSection({
  trends,
  includeFinancial = true,
  includeHeadcount = true,
}: {
  includeFinancial?: boolean;
  includeHeadcount?: boolean;
  trends: {
    sales: Array<{ label: string; sales: number; target: number }>;
    financial: Array<{ label: string; revenue: number; cost: number }>;
    hireExit: Array<{ label: string; hires: number; exits: number }>;
  };
}) {
  const columns = 1 + (includeFinancial ? 1 : 0) + (includeHeadcount ? 1 : 0);
  return (
    <div
      className={`grid divide-x divide-slate-200 ${
        columns === 3 ? "lg:grid-cols-3" : columns === 2 ? "lg:grid-cols-2" : "lg:grid-cols-1"
      }`}
    >
      <div className="px-5 py-5">
        <div className="mb-1 flex items-baseline justify-between">
          <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-500">Monthly Sales</p>
          {trends.sales.length > 0 ? (
            <p className="text-xs font-bold text-slate-900">
              {egp(trends.sales[trends.sales.length - 1]?.sales ?? 0)}
            </p>
          ) : null}
        </div>
        <AreaSparkline
          points={trends.sales.map((p) => ({ label: p.label, value: p.sales }))}
          stroke="#F97316"
          gradId="pb-trend-sales-grad"
        />
        <p className="mt-2 text-phx-3xs text-slate-400">Latest {trends.sales.length} periods</p>
      </div>
      {includeFinancial ? <div className="px-5 py-5">
        <div className="mb-1 flex items-baseline justify-between">
          <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-500">Payroll cost</p>
          {trends.financial.length > 0 ? (
            <p className="text-xs font-bold text-slate-900">
              {egp(trends.financial[trends.financial.length - 1]?.cost ?? 0)}
            </p>
          ) : null}
        </div>
        <AreaSparkline
          points={trends.financial.map((p) => ({ label: p.label, value: p.cost }))}
          stroke="#8B5CF6"
          gradId="pb-trend-cost-grad"
        />
        <p className="mt-2 text-phx-3xs text-slate-400">Latest {trends.financial.length} periods</p>
      </div> : null}
      {/* Hires vs exits is employee-lifecycle data (hire dates, resignations). The SFE Manager
          holds no `employees` or `resignations` grant, so it is dropped from his overview. */}
      {includeHeadcount ? <div className="px-5 py-5">
        <p className="mb-3 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-500">Headcount movement</p>
        <TwoSeriesBars
          data={trends.hireExit.map((p) => ({ label: p.label, a: p.hires, b: p.exits }))}
          colorA="#10B981"
          colorB="#F43F5E"
        />
        <div className="mt-2 flex items-center gap-4 text-phx-3xs text-slate-400">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-emerald-500" /> Hires</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-rose-500" /> Exits</span>
        </div>
      </div> : null}
    </div>
  );
}

// ── Risk signals (from admin aggregator) ──────────────────────────────────────

const toneStyles: Record<CeoAttentionTone, { bar: string; label: string; text: string; badge: string }> = {
  rose:  { bar: "bg-rose-500",  label: "URGENT",  text: "text-rose-700",  badge: "bg-rose-500 text-white"  },
  amber: { bar: "bg-amber-400", label: "WARNING", text: "text-amber-700", badge: "bg-amber-400 text-white" },
  blue:  { bar: "bg-blue-400",  label: "INFO",    text: "text-blue-700",  badge: "bg-blue-400 text-white"  },
};

function RiskSignals({
  dataUnavailable,
  items,
  payroll,
}: {
  dataUnavailable: NonNullable<import("@/lib/ceo/command-center").CeoAdminSignals>["dataUnavailable"];
  items: NonNullable<import("@/lib/ceo/command-center").CeoAdminSignals>["attention"];
  payroll: NonNullable<import("@/lib/ceo/command-center").CeoAdminSignals>["payroll"];
}) {
  const n = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "0");
  return (
    <div className="p-5 space-y-4">
      <RiskSourceWarning sources={dataUnavailable} />
      {/* Payroll KPIs */}
      {(payroll.net > 0 || payroll.gross > 0 || payroll.unresolvedSalaryFlags > 0) && (
        <div className="grid grid-cols-3 gap-2">
          <div className="border border-slate-200 px-3 py-2.5">
            <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">Net payroll</p>
            <p className="mt-0.5 text-lg font-black text-slate-900">{egp(payroll.net)}</p>
            <p className="text-phx-2xs text-slate-400">{payroll.batchLabel}</p>
          </div>
          <div className="border border-slate-200 px-3 py-2.5">
            <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">Gross payroll</p>
            <p className="mt-0.5 text-lg font-black text-slate-900">{egp(payroll.gross)}</p>
          </div>
          <div className={`border px-3 py-2.5 ${payroll.unresolvedSalaryFlags > 0 ? "border-rose-200 bg-rose-50" : "border-slate-200"}`}>
            <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">Salary flags</p>
            <p className={`mt-0.5 text-lg font-black ${payroll.unresolvedSalaryFlags > 0 ? "text-rose-700" : "text-slate-400"}`}>
              {n(payroll.unresolvedSalaryFlags)}
            </p>
          </div>
        </div>
      )}
      {/* Risk attention items */}
      {items.length > 0 ? (
        <div className="divide-y divide-slate-100 border border-slate-200">
          {items.map((item, idx) => {
            const tone = toneStyles[item.tone];
            return (
              <Link
                key={item.key}
                href={item.href}
                className="group flex items-center gap-0 hover:bg-slate-50"
              >
                <div className={`w-1 self-stretch ${tone.bar}`} />
                <span className="w-10 shrink-0 text-center text-phx-xs font-black text-slate-300">#{idx + 1}</span>
                <span className={`w-20 shrink-0 text-phx-3xs font-black uppercase tracking-[0.14em] ${tone.text}`}>{tone.label}</span>
                <span className="flex-1 py-3 text-sm font-medium text-slate-700">{item.label}</span>
                <span className="w-12 text-center text-xl font-black text-slate-900">{n(item.count)}</span>
                <ArrowRight aria-hidden="true" className="mr-4 h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5" />
              </Link>
            );
          })}
        </div>
      ) : dataUnavailable.length > 0 ? (
        <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-5 py-4">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <span className="text-sm font-semibold text-amber-900">
            No risk cards can be declared clear while critical CEO sources are unavailable.
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-5 py-4">
          <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0 text-emerald-600" />
          <span className="text-sm font-semibold text-emerald-800">No critical risk signals right now.</span>
        </div>
      )}
    </div>
  );
}

// ── Expense snippet ───────────────────────────────────────────────────────────

function ExpenseSnippet({
  data,
}: {
  data: NonNullable<Awaited<ReturnType<typeof getCeoLandingDeferred>>["expense"]>;
}) {
  const approvedPctDisplay = `${Math.round(data.approvedPct * 100)}%`;
  return (
    <div className="p-5 space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">Total spend</p>
          <p className="mt-0.5 text-lg font-black text-slate-900">{egp(data.totalAmount)}</p>
          <p className="text-phx-2xs text-slate-400">{data.windowLabel}</p>
        </div>
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">Approved</p>
          <p className="mt-0.5 text-lg font-black text-emerald-700">{approvedPctDisplay}</p>
          <p className="text-phx-2xs text-slate-400">of total</p>
        </div>
      </div>
      {(data.byRegion.length > 0 || data.topSpenders.length > 0) && (
        <CeoExpenseTables
          byRegion={data.byRegion}
          topSpenders={data.topSpenders}
          windowLabel={data.windowLabel}
        />
      )}
    </div>
  );
}

// ── ROI brief ─────────────────────────────────────────────────────────────────

function RoiBrief({
  data,
}: {
  data: NonNullable<Awaited<ReturnType<typeof getCeoLandingDeferred>>["roiSignal"]>;
}) {
  const total = data.startedStrong + data.startedWeak + data.stillZero;
  const buckets = [
    { label: "Started Strong", count: data.startedStrong, color: "bg-emerald-500", textColor: "text-emerald-700", borderColor: "border-emerald-200 bg-emerald-50", icon: <TrendingUp className="h-4 w-4 text-emerald-600" /> },
    { label: "Started Weak",   count: data.startedWeak,   color: "bg-amber-400",   textColor: "text-amber-700",   borderColor: "border-amber-200 bg-amber-50",   icon: <TrendingDown className="h-4 w-4 text-amber-600" /> },
    { label: "Still Zero",     count: data.stillZero,     color: "bg-rose-500",    textColor: "text-rose-700",    borderColor: "border-rose-200 bg-rose-50",     icon: <AlertTriangle className="h-4 w-4 text-rose-600" /> },
  ];
  return (
    <div className="p-5 space-y-4">
      {data.lastPeriod && (
        <p className="text-phx-2xs text-slate-400">Latest period: {data.lastPeriod} · {total} total requests</p>
      )}
      <div className="grid grid-cols-3 gap-2">
        {buckets.map((b) => (
          <div key={b.label} className={`border px-4 py-3 ${b.borderColor}`}>
            <div className="flex items-center gap-2 mb-1">{b.icon}<span className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">{b.label}</span></div>
            <p className={`text-3xl font-black ${b.textColor}`}>{b.count}</p>
            <p className="text-phx-2xs text-slate-400 mt-0.5">{total > 0 ? `${Math.round((b.count / total) * 100)}% of total` : "—"}</p>
          </div>
        ))}
      </div>
      {data.trend.length > 1 && (
        <div>
          <p className="mb-2 text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">ROI status trend</p>
          <div className="flex items-end gap-1 h-12">
            {data.trend.map((p) => {
              const t = p.onTrack + p.behind + p.noData || 1;
              return (
                <div key={p.period} className="flex flex-1 flex-col items-center gap-0.5">
                  <div className="flex h-10 w-full flex-col-reverse overflow-hidden">
                    <div className="bg-emerald-500" style={{ height: `${(p.onTrack / t) * 100}%` }} />
                    <div className="bg-amber-400"   style={{ height: `${(p.behind / t) * 100}%` }} />
                    <div className="bg-rose-400"    style={{ height: `${(p.noData / t) * 100}%` }} />
                  </div>
                  <span className="text-[7px] text-slate-400 truncate max-w-full">{p.period.slice(5)}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-1.5 flex items-center gap-3 text-phx-3xs text-slate-500">
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-emerald-500" />Strong</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-amber-400" />Weak</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-rose-400" />Zero</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Weekly sales trend (SFE) ──────────────────────────────────────────────────

function WeeklySalesTrend({ points }: { points: CeoWeeklyTrendPoint[] }) {
  if (points.length === 0) {
    return <UnavailableChip label="Weekly sales — no uploaded weeks in scope yet" />;
  }
  const latest = points[points.length - 1]!;
  const max = Math.max(...points.map((p) => p.salesValue), 1);
  return (
    <div className="space-y-4 p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Latest week</p>
          <p className="mt-1 text-3xl font-black leading-none text-slate-900">{egp(latest.salesValue)}</p>
        </div>
        {latest.deltaPct !== null ? (
          <span
            className={`px-2 py-1 text-phx-xs font-black ${
              latest.deltaPct >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
            }`}
          >
            {latest.deltaPct >= 0 ? "▲" : "▼"} {Math.abs(Math.round(latest.deltaPct))}% vs prior week
          </span>
        ) : (
          // Null is not zero: the prior week was never uploaded, so a delta would be measured
          // across a gap. Say so rather than printing a confident 0%.
          <span className="px-2 py-1 text-phx-xs font-bold text-slate-400">No comparable prior week</span>
        )}
      </div>
      <div className="flex h-24 items-end gap-1.5">
        {points.map((point) => (
          <div key={point.weekStart} className="flex flex-1 flex-col items-center gap-1">
            <span className="text-phx-4xs font-bold text-slate-400">
              {point.salesValue >= 1_000_000
                ? `${(point.salesValue / 1_000_000).toFixed(1)}M`
                : `${Math.round(point.salesValue / 1_000)}K`}
            </span>
            <div className="flex h-16 w-full items-end">
              <div
                className="w-full bg-orange-500"
                style={{ height: `${Math.max(3, (point.salesValue / max) * 100)}%` }}
                title={`${point.label} — ${egp(point.salesValue)}`}
              />
            </div>
            <span className="text-phx-3xs text-slate-400">{point.label}</span>
          </div>
        ))}
      </div>
      <p className="text-phx-2xs text-slate-400">
        De-cumulated real per-week value across the last {points.length} uploaded weeks.
      </p>
    </div>
  );
}

// ── Targets & IMS contribution (SFE) ──────────────────────────────────────────

function TargetsWidget({ data }: { data: SfeTargetPerformance }) {
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  const tone = (v: number | null) =>
    v === null ? "text-slate-400" : v >= 1 ? "text-emerald-700" : v >= 0.8 ? "text-amber-700" : "text-rose-700";
  const max = Math.max(...data.lines.map((l) => l.target), 1);
  return (
    <div className="space-y-5 p-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: "Target", value: egp(data.totalTarget), sub: "Company, in-scope lines" },
          { label: "Actual", value: egp(data.totalActual), sub: "Approved sales" },
          { label: "Gap to target", value: egp(Math.abs(data.gap)), sub: data.gap > 0 ? "Still to sell" : "Ahead of target" },
          { label: "Achievement", value: pct(data.achievementRate), sub: "Actual vs target" },
        ].map((tile) => (
          <div key={tile.label} className="border border-slate-200 px-3 py-2.5">
            <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{tile.label}</p>
            <p className={`mt-0.5 text-lg font-black ${tile.label === "Achievement" ? tone(data.achievementRate) : "text-slate-900"}`}>
              {tile.value}
            </p>
            <p className="text-phx-2xs text-slate-400">{tile.sub}</p>
          </div>
        ))}
      </div>

      {data.lines.length === 0 ? (
        <p className="text-xs text-slate-400">No targets loaded for your lines.</p>
      ) : (
        <div className="divide-y divide-slate-100 border border-slate-200">
          {data.lines.map((line) => (
            <div key={line.line} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-semibold text-slate-700">{line.line}</span>
                <span className="text-phx-xs text-slate-400">
                  {egp(line.actual)} of {egp(line.target)}
                </span>
                <span className={`w-12 text-right text-sm font-black ${tone(line.achievementRate)}`}>
                  {pct(line.achievementRate)}
                </span>
              </div>
              <div className="mt-2 h-2 w-full bg-slate-100">
                {/* Bar width is the line's TARGET relative to the largest target, so the lines are
                    visually weighted by how much of the number they carry; the fill is achievement. */}
                <div className="h-full bg-slate-200" style={{ width: `${Math.max(4, (line.target / max) * 100)}%` }}>
                  <div
                    className={`h-full ${line.achievementRate !== null && line.achievementRate >= 1 ? "bg-emerald-500" : "bg-orange-500"}`}
                    style={{ width: `${Math.min(100, (line.achievementRate ?? 0) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ImsTable({ rows, title, tone }: { rows: SfeImsRow[]; title: string; tone: "emerald" | "rose" }) {
  const accent = tone === "emerald" ? "text-emerald-700" : "text-rose-700";
  return (
    <div>
      <p className="mb-2 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400">No comparable areas.</p>
      ) : (
        <div className="divide-y divide-slate-100 border border-slate-200">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-1 text-sm font-medium text-slate-700">{row.label}</span>
              <span className="w-14 text-right text-phx-xs text-slate-400">{row.salesSharePct.toFixed(1)}%</span>
              <span className="w-14 text-right text-phx-xs text-slate-400">{row.imsPct.toFixed(1)}%</span>
              <span className={`w-16 text-right text-sm font-black ${accent}`}>
                {row.gapPts > 0 ? "+" : ""}{row.gapPts.toFixed(1)}
              </span>
            </div>
          ))}
          <div className="flex items-center gap-3 bg-slate-50 px-3 py-1.5 text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">
            <span className="flex-1">Area</span>
            <span className="w-14 text-right">Sales</span>
            <span className="w-14 text-right">IMS</span>
            <span className="w-16 text-right">Gap pts</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ImsWidget({ data }: { data: SfeImsContribution }) {
  return (
    <div className="space-y-5 p-5">
      {data.matchedSharePct < 100 ? (
        <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-900">
          {data.matchedSharePct.toFixed(1)}% of in-scope sales sit in an area carrying an IMS ratio
          {data.areasWithoutRatio > 0 ? ` — ${data.areasWithoutRatio} area(s) with sales have no ratio and are excluded` : ""}.
          The comparison below covers only the matched share.
        </div>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <ImsTable rows={data.over} title="Over-indexing the market" tone="emerald" />
        <ImsTable rows={data.under} title="Under-indexing the market" tone="rose" />
      </div>
    </div>
  );
}

// ── CRM field activity (SFE) ──────────────────────────────────────────────────

function StartTimeTable({
  rows,
  title,
  tone,
}: {
  rows: SfeCrmFieldAnalytics["earlyBirds"];
  title: string;
  tone: "emerald" | "amber";
}) {
  const accent = tone === "emerald" ? "text-emerald-700" : "text-amber-700";
  return (
    <div>
      <p className="mb-2 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400">Not enough check-in history yet.</p>
      ) : (
        <div className="divide-y divide-slate-100 border border-slate-200">
          {rows.map((row, index) => (
            <div key={`${row.agentHrId ?? row.agentName}-${index}`} className="flex items-center gap-3 px-3 py-2">
              <span className="w-5 shrink-0 text-phx-xs font-black text-slate-300">#{index + 1}</span>
              <span className="flex-1 text-sm font-medium text-slate-700">{row.agentName}</span>
              <span className={`w-14 text-right text-sm font-black ${accent}`}>
                {formatStartMinutes(row.medianStartMinutes)}
              </span>
              <span className="w-16 text-right text-phx-2xs text-slate-400">{row.daysObserved} days</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Compact SFE-overview render of the Doctor Coverage board: tiles + the two lists a manager acts
// on (worst rep panels, freshest lapses). Server-only — the full doctors array never serializes
// to the client; the Full Board action link carries the rest.
function DoctorCoverageEmbed({ data }: { data: SfeDoctorCoverageBoard }) {
  const worstReps = data.reps.slice(0, 8);
  const freshLapses = data.doctors
    .filter((doctor) => doctor.status === "red")
    .sort((a, b) => ((a.lastVisitDate ?? "") < (b.lastVisitDate ?? "") ? 1 : -1))
    .slice(0, 8);
  return (
    <div className="space-y-5 p-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Coverage", sub: data.isCurrentMonth ? "month to date" : data.monthLabel, value: `${data.totals.coveragePct}%` },
          { label: "Active panel", sub: "graded doctors", value: String(data.totals.activePanel) },
          { label: "Covered", sub: "met their target", value: String(data.totals.green) },
          { label: "Under-visited", sub: "short of target", value: String(data.totals.yellow) },
          { label: "Not visited", sub: "on the list, none this month", value: String(data.totals.red) },
          { label: "Ungraded seen", sub: "no vendor grade", value: String(data.totals.ungradedContacts) },
        ].map((tile) => (
          <div key={tile.label} className="border border-slate-200 px-3 py-2.5">
            <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{tile.label}</p>
            <p className="mt-0.5 text-lg font-black text-slate-900">{tile.value}</p>
            <p className="text-phx-2xs text-slate-400">{tile.sub}</p>
          </div>
        ))}
      </div>
      {data.totals.activePanel === 0 ? (
        <p className="text-xs text-slate-400">
          No graded doctor panel yet this month — grades arrive from iReports360 (supplied since 2026-07-24).
        </p>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Lowest coverage — reps to coach</p>
            <div className="divide-y divide-slate-100 border border-slate-200">
              {worstReps.map((rep, index) => (
                <div key={rep.repKey} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-5 shrink-0 text-phx-xs font-black text-slate-300">#{index + 1}</span>
                  <span className="flex-1 text-sm font-medium text-slate-700">{rep.repName}</span>
                  <span className="w-16 text-right text-phx-2xs text-slate-400">{rep.panelSize} panel</span>
                  <span className={`w-12 text-right text-sm font-black ${rep.coveragePct >= 80 ? "text-emerald-700" : rep.coveragePct >= 50 ? "text-amber-700" : "text-rose-700"}`}>
                    {rep.coveragePct}%
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Freshest lapses — doctors to win back</p>
            {freshLapses.length === 0 ? (
              <p className="text-xs text-slate-400">No lapsed doctors this month.</p>
            ) : (
              <div className="divide-y divide-slate-100 border border-slate-200">
                {freshLapses.map((doctor) => (
                  <div key={doctor.contactCrmId} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-5 shrink-0 text-phx-xs font-black text-rose-300">{doctor.gradeRaw}</span>
                    <span className="flex-1 text-sm font-medium text-slate-700">{doctor.contactName}</span>
                    <span className="w-24 text-right text-phx-2xs text-slate-400">last {doctor.lastVisitDate ?? "—"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CrmFieldWidget({ data }: { data: SfeCrmFieldAnalytics }) {
  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  const classified = data.amVisits + data.pmVisits;
  const amPct = classified > 0 ? Math.round((data.amVisits / classified) * 100) : 0;
  return (
    <div className="space-y-5 p-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Visits", value: n(data.totalVisits), sub: "after duplicate collapse" },
          { label: "Active reps", value: n(data.activeReps), sub: "logged ≥1 visit" },
          { label: "Contacts seen", value: n(data.contactsCovered), sub: "distinct customers" },
          { label: "Visits / rep-day", value: data.avgVisitsPerRepDay.toFixed(1), sub: `${n(data.repDays)} rep-days` },
          { label: "Double visits", value: n(data.doubleVisits), sub: "manager in field" },
          { label: "No GPS check-in", value: n(data.repsWithoutCheckins), sub: "reps, time unverifiable" },
        ].map((tile) => (
          <div key={tile.label} className="border border-slate-200 px-3 py-2.5">
            <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{tile.label}</p>
            <p className="mt-0.5 text-lg font-black text-slate-900">{tile.value}</p>
            <p className="text-phx-2xs text-slate-400">{tile.sub}</p>
          </div>
        ))}
      </div>

      {classified > 0 ? (
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">AM / PM split</p>
            <p className="text-phx-2xs text-slate-400">
              {n(data.amVisits)} AM · {n(data.pmVisits)} PM
            </p>
          </div>
          <div className="flex h-3 w-full overflow-hidden border border-slate-200">
            <div className="bg-orange-500" style={{ width: `${amPct}%` }} />
            <div className="bg-slate-300" style={{ width: `${100 - amPct}%` }} />
          </div>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <StartTimeTable rows={data.earlyBirds} title="Early birds — earliest median start" tone="emerald" />
        <StartTimeTable rows={data.lateStarters} title="Latest median start" tone="amber" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Most active reps</p>
          {data.topReps.length === 0 ? (
            <p className="text-xs text-slate-400">No visits in this window.</p>
          ) : (
            <div className="divide-y divide-slate-100 border border-slate-200">
              {data.topReps.map((rep, index) => (
                <div key={`${rep.label}-${index}`} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-5 shrink-0 text-phx-xs font-black text-slate-300">#{index + 1}</span>
                  <span className="flex-1 text-sm font-medium text-slate-700">{rep.label}</span>
                  <span className="w-12 text-right text-sm font-black text-slate-900">{n(rep.visits)}</span>
                  <span className="w-20 text-right text-phx-2xs text-slate-400">{n(rep.contacts)} contacts</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <p className="mb-2 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Visit type mix</p>
          {data.byVisitType.length === 0 ? (
            <p className="text-xs text-slate-400">No visits in this window.</p>
          ) : (
            <div className="divide-y divide-slate-100 border border-slate-200">
              {data.byVisitType.map((type) => (
                <div key={type.label} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex-1 text-sm font-medium text-slate-700">{type.label}</span>
                  <span className="w-14 text-right text-sm font-black text-slate-900">{n(type.count)}</span>
                  <span className="w-12 text-right text-phx-2xs text-slate-400">
                    {data.totalVisits > 0 ? `${Math.round((type.count / data.totalVisits) * 100)}%` : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Attendance widget ─────────────────────────────────────────────────────────

function AttendanceWidget({
  data,
  managersOnLeave,
}: {
  data: NonNullable<Awaited<ReturnType<typeof getCeoLandingDeferred>>["attendance"]>;
  managersOnLeave: Array<{ name: string; hrId: string; role: string }> | null;
}) {
  const maxLate = Math.max(...data.weeklyTrend.map((w) => w.lateRate), 1);
  return (
    <div className="p-5 space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">Today</p>
          <p className="mt-0.5 text-sm font-black text-slate-900">{data.todayIsWorkingDay ? "Working day" : "Non-working day"}</p>
        </div>
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">Absent today</p>
          <p className={`mt-0.5 text-2xl font-black ${data.todayAbsentees.length > 5 ? "text-rose-700" : "text-slate-900"}`}>{data.todayAbsentees.length}</p>
        </div>
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">Chronic late (30d)</p>
          <p className={`mt-0.5 text-2xl font-black ${data.chronicLate.length > 3 ? "text-amber-700" : "text-slate-900"}`}>{data.chronicLate.length}</p>
        </div>
        <div className={`border px-3 py-2.5 ${(managersOnLeave?.length ?? 0) > 0 ? "border-amber-200 bg-amber-50" : "border-slate-200"}`}>
          <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">Managers on leave</p>
          <p className={`mt-0.5 text-2xl font-black ${(managersOnLeave?.length ?? 0) > 0 ? "text-amber-700" : "text-slate-400"}`}>{managersOnLeave?.length ?? 0}</p>
        </div>
      </div>
      <CeoAttendanceTables
        managersOnLeave={managersOnLeave ?? []}
        absentees={data.todayAbsentees}
        allAbsenteesCount={data.todayAbsentees.length}
        chronicLate={data.chronicLate}
      />
      {data.weeklyTrend.length > 0 && (
        <div className="px-5 pb-5">
          <p className="mb-2 text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">Late rate — 7-week trend</p>
          <div className="flex items-end gap-1.5 h-14">
            {data.weeklyTrend.map((w) => (
              <div key={w.isoWeek} className="flex flex-1 flex-col items-center gap-0.5">
                <div className="flex h-10 w-full items-end">
                  <div className="w-full bg-orange-400" style={{ height: `${Math.max(3, (w.lateRate / maxLate) * 100)}%` }} title={`${w.lateRate.toFixed(1)}% late`} />
                </div>
                <span className="text-[7px] text-slate-400 truncate max-w-full">{w.isoWeek}</span>
              </div>
            ))}
          </div>
          <p className="mt-1 text-phx-3xs text-slate-400">Latest: {data.weeklyTrend[data.weeklyTrend.length - 1]?.lateRate.toFixed(1) ?? "—"}% late rate</p>
        </div>
      )}
    </div>
  );
}

// ── Smart navigation grid ─────────────────────────────────────────────────────

const NAV_ITEMS = [
  { href: "/employees",                              icon: Users,        label: "Employees",         sub: "Directory & lifecycle" },
  { href: "/admin/m-payroll",                        icon: Wallet,       label: "Payroll",            sub: "Salary & flags" },
  { href: "/admin/analytics/monthly-closing",        icon: BarChart3,    label: "Source of Sales",    sub: "Monthly distributor data" },
  { href: "/sales/weekly/dashboard",                 icon: Activity,     label: "Weekly Sales",       sub: "Weekly trends & targets" },
  { href: "/admin/double-visit-analytics",           icon: UserCheck,    label: "Double Visit",       sub: "Manager coverage intelligence" },
  { href: "/admin/outstation/expense-command",       icon: DollarSign,   label: "Expense Command",    sub: "Company-wide outstation spend" },
  { href: "/coaching/analytics",                     icon: ShieldCheck,  label: "Coaching",           sub: "Rep performance & KPIs" },
  { href: "/admin/approvals-hub",                    icon: CheckCircle2, label: "Approvals Hub",      sub: "Pending approvals" },
  { href: "/organogram",                             icon: Users,        label: "Organogram",         sub: "Org chart & hierarchy" },
  { href: "/admin/data-health",                      icon: ShieldCheck,  label: "Data Health",        sub: "System quality score" },
];

// The SFE Manager's own module list, not the CEO's with holes punched in it. Every href below
// is one his sidebar already resolves (verified against the admin nav + hub items for the role),
// which is why the CEO entries for /employees, /organogram, /admin/data-health and
// /admin/outstation/expense-command are absent — each of those redirects him to
// /employee-portals or renders a Forbidden card.
const SFE_NAV_ITEMS = [
  { href: "/admin/analytics/monthly-closing",        icon: BarChart3,    label: "Source of Sales",    sub: "Monthly distributor data" },
  { href: "/sales/weekly/dashboard",                 icon: Activity,     label: "Weekly Sales",       sub: "Weekly trends & targets" },
  { href: "/sales/targets",                          icon: Target,       label: "Targets",            sub: "Line & area target setting" },
  { href: "/admin/analytics",                        icon: BarChart3,    label: "Sales Analytics",    sub: "SoS, closing & weekly BI" },
  { href: "/admin/double-visit-analytics",           icon: UserCheck,    label: "Double Visit",       sub: "Manager coverage intelligence" },
  { href: "/coaching/analytics",                     icon: ShieldCheck,  label: "Coaching",           sub: "Rep performance & KPIs" },
  { href: "/employee-360",                           icon: Users,        label: "Employee 360",       sub: "Field-force performance profile" },
  { href: "/sales/territory-management",             icon: Waypoints,    label: "Territory",          sub: "Bricks, areas & coverage" },
  { href: "/admin/crm",                              icon: MapPinned,    label: "CRM Workspace",      sub: "Visits, check-ins & contacts" },
  { href: "/admin/crm-integrity",                    icon: ShieldCheck,  label: "CRM Integrity",      sub: "Check-in vs visit correlation" },
  { href: "/probation",                              icon: ClipboardCheck, label: "Probation",        sub: "SFE assessments & decisions" },
  { href: "/business-review",                     icon: LayoutDashboard, label: "Business Review", sub: "Live business review, any period" },
];

function SmartNavGrid({ access, variant }: { access: AccessContext; variant: "ceo" | "sfe" }) {
  const items = variant === "sfe"
    ? SFE_NAV_ITEMS
    : access.role === "CEO"
    ? NAV_ITEMS.filter((item) => item.href !== "/employees" && item.href !== "/admin/data-health")
    : NAV_ITEMS;

  return (
    <div className="grid grid-cols-2 gap-2 p-5 sm:grid-cols-3 lg:grid-cols-4">
      {items.map(({ href, icon: Icon, label, sub }) => (
        <Link
          key={href}
          href={href}
          className="group flex items-start gap-3 border border-slate-200 bg-white p-3.5 transition hover:border-orange-300 hover:bg-orange-50/30"
        >
          <div className="mt-0.5 shrink-0 border border-slate-200 bg-slate-50 p-1.5 transition group-hover:border-orange-300 group-hover:bg-orange-100/50">
            <Icon className="h-3.5 w-3.5 text-slate-600 group-hover:text-orange-600" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-black text-slate-900 group-hover:text-orange-800">{label}</p>
            <p className="mt-0.5 text-phx-2xs text-slate-400 leading-tight">{sub}</p>
          </div>
          <ArrowRight className="ml-auto h-3 w-3 shrink-0 self-center text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-orange-400" />
        </Link>
      ))}
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

// Titles must track the sections actually rendered below, per variant — a skeleton row for a
// partition that never arrives reads as a stuck load.
const PHASE_B_SKELETON_TITLES = {
  ceo: ["Risk signals & payroll", "Company health", "Trends", "Double-Visit Intelligence", "Monthly Sales Intelligence", "Expense Snapshot", "ROI Signal", "Attendance & Leave"],
  sfe: ["Company health", "Targets", "IMS contribution", "Weekly sales trend", "Trends", "Double-Visit Intelligence", "Monthly Sales Intelligence", "ROI Signal", "CRM field activity", "Doctor coverage & frequency"],
} as const;

export function CeoPhaseBSkeleton({ variant = "ceo" }: { variant?: "ceo" | "sfe" }) {
  return (
    <div className="divide-y divide-slate-200 border-t border-slate-200">
      {PHASE_B_SKELETON_TITLES[variant].map((title) => (
        <div key={title} className="bg-white">
          <div className="border-b border-slate-200 bg-slate-900 px-5 py-3.5">
            <div className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</div>
          </div>
          <div className="space-y-2 p-5">
            <div className="h-5 w-2/3 animate-pulse bg-slate-100" />
            <div className="h-5 w-1/2 animate-pulse bg-slate-100" />
            <div className="h-16 w-full animate-pulse bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Phase B async server component ──────────────────────────────────────

export async function CeoPhaseBWidgets({
  access,
  sosPrefetched,
  adminSignalsPrefetched,
  variant = "ceo",
}: {
  access: AccessContext;
  sosPrefetched: CeoCommandCenterData["sos"];
  adminSignalsPrefetched: CeoCommandCenterData["adminSignals"];
  variant?: "ceo" | "sfe";
}) {
  const isSfe = variant === "sfe";
  // The outstation expense fetch is skipped outright for the SFE variant — his overview does not
  // render the Expense Snapshot (canUseAdminOutstationWorkspace names Super Admin / Finance
  // Manager / CEO only), so the company-wide read is pure waste on this page.
  const landing = await getCeoLandingDeferred(access, adminSignalsPrefetched, {
    includeExpense: !isSfe,
    // The SFE Manager owns sales and CRM. Fingerprint attendance is neither, so his page neither
    // renders it nor pays for the company-wide aggregate; field presence comes from CRM check-ins.
    includeAttendance: !isSfe,
    includeCrmField: isSfe,
    includeWeeklyTrend: isSfe,
    includeSfePerformance: isSfe,
    includeDoctorCoverage: isSfe,
  });
  const unavailableSources = Array.from(
    new Set(landing.dataUnavailable.filter((source) => !isSfe || isSfeDataSource(source))),
  );

  // This fortnight's stars, one per line, for the two admin-shell audiences. This component is
  // rendered by BOTH the CEO command center and the SFE Manager overview, so one fetch covers
  // both. Degrades to [] like every other source here — a missing announcement must never blank an
  // executive page.
  const earlyBirdStars = await getLatestLineEarlyBirds().catch(() => []);

  return (
    <div className="divide-y divide-slate-200 border-t border-slate-200">
      {earlyBirdStars.length > 0 ? (
        <div className="bg-white p-5">
          <EarlyBirdOfTheFortnightCard href="/admin/early-birds" stars={earlyBirdStars} />
        </div>
      ) : null}
      {unavailableSources.length > 0 ? (
        <div className="bg-white p-5">
          <RiskSourceWarning owner={isSfe ? "SFE" : "CEO"} sources={unavailableSources} />
        </div>
      ) : null}

      {/* ── Risk signals + payroll (from admin aggregator, deferred) ──────── */}
      {!isSfe ? <Section
        title="Risk signals & payroll"
        description="Resignations, leave SLA, expiring contracts, coaching red zone, salary flags — and payroll snapshot."
        action={
          <Link
            href="/admin/approvals-hub"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
          >
            Approvals Hub <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {landing.adminSignals ? (
          <RiskSignals
            dataUnavailable={landing.adminSignals.dataUnavailable}
            items={landing.adminSignals.attention}
            payroll={landing.adminSignals.payroll}
          />
        ) : (
          <UnavailableChip label="Risk signals" />
        )}
      </Section> : null}

      {/* ── Company health breakdown ───────────────────────────────────────── */}
      <Section
        title="Company health breakdown"
        description={
          isSfe
            ? "Weighted signal across sales achievement and sales data coverage."
            : "Weighted signal across sales achievement, attendance, employee linkage, and data coverage."
        }
      >
        {landing.adminSignals ? (
          <HealthBreakdown
            health={landing.adminSignals.health}
            includeEmployeeLinkage={!isSfe}
            includeAttendanceReadiness={!isSfe}
          />
        ) : (
          <UnavailableChip label="Health breakdown" />
        )}
      </Section>

      {/* ── Targets (SFE) ─────────────────────────────────────────────────── */}
      {isSfe ? <Section
        title="Targets"
        description="Target, actual and the remaining gap — per line, for the lines you carry."
        action={
          <Link
            href="/sales/targets"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
          >
            Manage Targets <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {landing.targets ? <TargetsWidget data={landing.targets} /> : <UnavailableChip label="Sales targets" />}
      </Section> : null}

      {/* ── IMS contribution (SFE) ────────────────────────────────────────── */}
      {isSfe ? <Section
        title="IMS contribution"
        description="Where sales land versus where the market is — each area's share of your sales against its IMS share."
      >
        {landing.ims ? <ImsWidget data={landing.ims} /> : <UnavailableChip label="IMS contribution" />}
      </Section> : null}

      {/* ── Weekly sales trend (SFE) ──────────────────────────────────────── */}
      {isSfe ? <Section
        title="Weekly sales trend"
        description="Real per-week value across the most recent uploaded weeks, with the week-over-week move."
        action={
          <Link
            href="/admin/field-sales/weekly-sales"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
          >
            Full Weekly Sales <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {landing.weeklyTrend ? (
          <WeeklySalesTrend points={landing.weeklyTrend} />
        ) : (
          <UnavailableChip label="Weekly sales trend" />
        )}
      </Section> : null}

      {/* ── Trends ────────────────────────────────────────────────────────── */}
      {/* buildCeoTrends emits at most ONE point per series, and AreaSparkline needs two — so for
          the SFE variant, which has no payroll or headcount series to carry the section, this
          rendered as an empty panel reading "Not enough history yet." The real week-over-week
          series above replaces it. */}
      {!isSfe ? <Section
        title="Trends"
        description="Sales value, people cost, and headcount movement over recent periods."
      >
        {landing.adminSignals ? (
          <TrendsSection
            trends={landing.adminSignals.trends}
            includeFinancial={!isSfe}
            includeHeadcount={!isSfe}
          />
        ) : (
          <UnavailableChip label="Trends" />
        )}
      </Section> : null}

      {/* ── Double-Visit Intelligence ──────────────────────────────────────── */}
      <Section
        title="Double-Visit Intelligence"
        description="Repeated vs. neglected medical reps per manager — company-wide."
        action={
          <Link
            href="/admin/double-visit-analytics"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
          >
            Full Analytics <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {landing.doubleVisit ? (
          landing.doubleVisit.managerRows.length > 0 ? (
            <CeoDvTable
              rows={landing.doubleVisit.managerRows}
              dateFrom={landing.doubleVisit.dateFrom}
              dateTo={landing.doubleVisit.dateTo}
            />
          ) : (
            <UnavailableChip label="Double-visit data not yet imported for the current period" />
          )
        ) : (
          <UnavailableChip label="Double-Visit Intelligence" />
        )}
      </Section>

      {/* ── Monthly Source of Sales (prefetched from fast path) ───────────── */}
      <Section
        title="Monthly Sales Intelligence"
        description="Company-wide source of sales — sortable by region or product."
        action={
          <Link
            href="/admin/analytics/monthly-closing"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
          >
            Full SoS <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {sosPrefetched ? (
          <CeoSosTables
            byRegion={sosPrefetched.byRegion}
            byProduct={sosPrefetched.byProduct}
            period={sosPrefetched.period}
          />
        ) : (
          <UnavailableChip label="Monthly SoS" />
        )}
      </Section>

      {/* ── Expense Snapshot ──────────────────────────────────────────────── */}
      {/* Outstation spend is an admin-outstation-workspace surface. canUseAdminOutstationWorkspace
          names Super Admin (approve) plus Finance Manager / CEO (read) and the comment on
          executionOnlyOutstationRoles says the list exists "to prevent accidental promotion" —
          the SFE Manager is deliberately not on it, so both this snapshot and its
          "Full Expense Dashboard" button are off his overview. */}
      {!isSfe ? <Section
        title="Expense Snapshot"
        description="Last 30 days — outstation spend by region + top spenders."
        action={
          <Link
            href="/admin/outstation/expense-command"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
          >
            Full Expense Dashboard <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {landing.expense ? (
          <ExpenseSnippet data={landing.expense} />
        ) : (
          <UnavailableChip label="Expense Snapshot" />
        )}
      </Section> : null}

      {/* ── ROI Signal ────────────────────────────────────────────────────── */}
      <Section
        title="Marketing ROI Signal"
        description="Who started strong, who started weak, who is still at zero."
      >
        {landing.roiSignal ? (
          <RoiBrief data={landing.roiSignal} />
        ) : (
          <UnavailableChip label="ROI Signal" />
        )}
      </Section>

      {/* ── Attendance & Leave ────────────────────────────────────────────── */}
      {/* Fingerprint attendance and leave are HR surfaces. The SFE Manager owns sales and CRM, so
          his page measures field presence through CRM check-ins (below) instead. */}
      {!isSfe ? <Section
        title="Attendance & Leave"
        description="Today's absentees, managers on leave, chronic late offenders, and 7-week trend."
      >
        {landing.attendance ? (
          <AttendanceWidget data={landing.attendance} managersOnLeave={landing.managersOnLeave} />
        ) : (
          <UnavailableChip label="Attendance Analytics" />
        )}
      </Section> : null}

      {/* ── CRM field activity (SFE) ──────────────────────────────────────── */}
      {isSfe ? <Section
        title="CRM field activity"
        description="Last 30 days — visit volume, reach, AM/PM split, and who starts the field day earliest (GPS check-in, Cairo time)."
        action={
          <Link
            href="/admin/crm"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
          >
            CRM Workspace <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {landing.crmField ? (
          <CrmFieldWidget data={landing.crmField} />
        ) : (
          <UnavailableChip label="CRM field activity" />
        )}
      </Section> : null}

      {/* ── Doctor coverage & frequency (SFE) ─────────────────────────────── */}
      {isSfe ? <Section
        title="Doctor coverage & frequency"
        description="Current month, regular customer visits only — A doctors need 2 visits, B/C need 1; lapsed = seen in the prior 2 months, none this month."
        action={
          <Link
            href="/admin/doctor-coverage"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
          >
            Full Board <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {landing.doctorCoverage ? (
          <DoctorCoverageEmbed data={landing.doctorCoverage} />
        ) : (
          <UnavailableChip label="Doctor coverage" />
        )}
      </Section> : null}

      {/* ── Smart Navigation Grid ─────────────────────────────────────────── */}
      <Section title="Quick Navigation" description="Every module, one click away.">
        <SmartNavGrid access={access} variant={variant} />
      </Section>
    </div>
  );
}
