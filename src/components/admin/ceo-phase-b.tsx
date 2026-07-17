import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  DollarSign,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  UserCheck,
  Users,
  Wallet,
} from "lucide-react";

import { AreaSparkline, TwoSeriesBars } from "@/components/admin/ceo-command-center";
import { CeoAttendanceTables } from "@/components/admin/ceo-attendance-tables";
import { CeoDvTable } from "@/components/admin/ceo-dv-table";
import { CeoExpenseTables } from "@/components/admin/ceo-expense-tables";
import { CeoSosTables } from "@/components/admin/ceo-sos-tables";
import type { AccessContext } from "@/lib/auth/permissions";
import type { CeoCommandCenterData, CeoAttentionTone } from "@/lib/ceo/command-center";
import { getCeoLandingDeferred } from "@/lib/ceo/command-center";

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
          <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-[10px] text-slate-400">{description}</p> : null}
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

function RiskSourceWarning({ sources }: { sources: string[] }) {
  if (sources.length === 0) return null;

  return (
    <div className="border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div>
          <p className="text-sm font-black text-amber-900">Some CEO data sources are unavailable.</p>
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
}: {
  health: {
    salesLinkageRate: number;
    attendanceReadinessRate: number;
    salesAchievementRate: number;
    employeeHealthRate: number;
  };
}) {
  const metrics = [
    { label: "Sales achievement", value: health.salesAchievementRate, target: 0.9, color: "#F97316" },
    { label: "Attendance readiness", value: health.attendanceReadinessRate, target: 1, color: "#3B82F6" },
    { label: "Employee linkage", value: health.employeeHealthRate, target: 1, color: "#10B981" },
    { label: "Sales linkage rate", value: health.salesLinkageRate, target: 1, color: "#8B5CF6" },
  ];
  return (
    <div className="grid divide-x divide-slate-200 sm:grid-cols-4">
      {metrics.map(({ label, value, target, color }) => {
        const pctVal = Math.round(Math.min(1, (Number.isFinite(value) ? value : 0) / target) * 100);
        const statusColor = pctVal >= 80 ? "#10B981" : pctVal >= 60 ? "#F59E0B" : "#F43F5E";
        return (
          <div key={label} className="flex flex-col gap-3 px-5 py-5">
            <p className="text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
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
}: {
  trends: {
    sales: Array<{ label: string; sales: number; target: number }>;
    financial: Array<{ label: string; revenue: number; cost: number }>;
    hireExit: Array<{ label: string; hires: number; exits: number }>;
  };
}) {
  return (
    <div className="grid divide-x divide-slate-200 lg:grid-cols-3">
      <div className="px-5 py-5">
        <div className="mb-1 flex items-baseline justify-between">
          <p className="text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">Monthly Sales</p>
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
        <p className="mt-2 text-[9px] text-slate-400">Latest {trends.sales.length} periods</p>
      </div>
      <div className="px-5 py-5">
        <div className="mb-1 flex items-baseline justify-between">
          <p className="text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">Payroll cost</p>
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
        <p className="mt-2 text-[9px] text-slate-400">Latest {trends.financial.length} periods</p>
      </div>
      <div className="px-5 py-5">
        <p className="mb-3 text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">Headcount movement</p>
        <TwoSeriesBars
          data={trends.hireExit.map((p) => ({ label: p.label, a: p.hires, b: p.exits }))}
          colorA="#10B981"
          colorB="#F43F5E"
        />
        <div className="mt-2 flex items-center gap-4 text-[9px] text-slate-400">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-emerald-500" /> Hires</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-rose-500" /> Exits</span>
        </div>
      </div>
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
            <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Net payroll</p>
            <p className="mt-0.5 text-lg font-black text-slate-900">{egp(payroll.net)}</p>
            <p className="text-[10px] text-slate-400">{payroll.batchLabel}</p>
          </div>
          <div className="border border-slate-200 px-3 py-2.5">
            <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Gross payroll</p>
            <p className="mt-0.5 text-lg font-black text-slate-900">{egp(payroll.gross)}</p>
          </div>
          <div className={`border px-3 py-2.5 ${payroll.unresolvedSalaryFlags > 0 ? "border-rose-200 bg-rose-50" : "border-slate-200"}`}>
            <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Salary flags</p>
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
                <span className="w-10 shrink-0 text-center text-[11px] font-black text-slate-300">#{idx + 1}</span>
                <span className={`w-20 shrink-0 text-[9px] font-black uppercase tracking-[0.14em] ${tone.text}`}>{tone.label}</span>
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
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Total spend</p>
          <p className="mt-0.5 text-lg font-black text-slate-900">{egp(data.totalAmount)}</p>
          <p className="text-[10px] text-slate-400">{data.windowLabel}</p>
        </div>
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Approved</p>
          <p className="mt-0.5 text-lg font-black text-emerald-700">{approvedPctDisplay}</p>
          <p className="text-[10px] text-slate-400">of total</p>
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
        <p className="text-[10px] text-slate-400">Latest period: {data.lastPeriod} · {total} total requests</p>
      )}
      <div className="grid grid-cols-3 gap-2">
        {buckets.map((b) => (
          <div key={b.label} className={`border px-4 py-3 ${b.borderColor}`}>
            <div className="flex items-center gap-2 mb-1">{b.icon}<span className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">{b.label}</span></div>
            <p className={`text-3xl font-black ${b.textColor}`}>{b.count}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{total > 0 ? `${Math.round((b.count / total) * 100)}% of total` : "—"}</p>
          </div>
        ))}
      </div>
      {data.trend.length > 1 && (
        <div>
          <p className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">ROI status trend</p>
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
          <div className="mt-1.5 flex items-center gap-3 text-[9px] text-slate-500">
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-emerald-500" />Strong</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-amber-400" />Weak</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-rose-400" />Zero</span>
          </div>
        </div>
      )}
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
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Today</p>
          <p className="mt-0.5 text-sm font-black text-slate-900">{data.todayIsWorkingDay ? "Working day" : "Non-working day"}</p>
        </div>
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Absent today</p>
          <p className={`mt-0.5 text-2xl font-black ${data.todayAbsentees.length > 5 ? "text-rose-700" : "text-slate-900"}`}>{data.todayAbsentees.length}</p>
        </div>
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Chronic late (30d)</p>
          <p className={`mt-0.5 text-2xl font-black ${data.chronicLate.length > 3 ? "text-amber-700" : "text-slate-900"}`}>{data.chronicLate.length}</p>
        </div>
        <div className={`border px-3 py-2.5 ${(managersOnLeave?.length ?? 0) > 0 ? "border-amber-200 bg-amber-50" : "border-slate-200"}`}>
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Managers on leave</p>
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
          <p className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Late rate — 7-week trend</p>
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
          <p className="mt-1 text-[9px] text-slate-400">Latest: {data.weeklyTrend[data.weeklyTrend.length - 1]?.lateRate.toFixed(1) ?? "—"}% late rate</p>
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

function SmartNavGrid({ access }: { access: AccessContext }) {
  const items = access.role === "CEO"
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
            <p className="mt-0.5 text-[10px] text-slate-400 leading-tight">{sub}</p>
          </div>
          <ArrowRight className="ml-auto h-3 w-3 shrink-0 self-center text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-orange-400" />
        </Link>
      ))}
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

export function CeoPhaseBSkeleton() {
  return (
    <div className="divide-y divide-slate-200 border-t border-slate-200">
      {["Risk signals & payroll", "Company health", "Trends", "Double-Visit Intelligence", "Monthly Sales Intelligence", "Expense Snapshot", "ROI Signal", "Attendance & Leave"].map((title) => (
        <div key={title} className="bg-white">
          <div className="border-b border-slate-200 bg-slate-900 px-5 py-3.5">
            <div className="text-[11px] font-black uppercase tracking-[0.14em] text-white">{title}</div>
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
}: {
  access: AccessContext;
  sosPrefetched: CeoCommandCenterData["sos"];
  adminSignalsPrefetched: CeoCommandCenterData["adminSignals"];
}) {
  const landing = await getCeoLandingDeferred(access, adminSignalsPrefetched);
  const unavailableSources = Array.from(new Set(landing.dataUnavailable));

  return (
    <div className="divide-y divide-slate-200 border-t border-slate-200">
      {unavailableSources.length > 0 ? (
        <div className="bg-white p-5">
          <RiskSourceWarning sources={unavailableSources} />
        </div>
      ) : null}

      {/* ── Risk signals + payroll (from admin aggregator, deferred) ──────── */}
      <Section
        title="Risk signals & payroll"
        description="Resignations, leave SLA, expiring contracts, coaching red zone, salary flags — and payroll snapshot."
        action={
          <Link
            href="/admin/approvals-hub"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
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
      </Section>

      {/* ── Company health breakdown ───────────────────────────────────────── */}
      <Section
        title="Company health breakdown"
        description="Weighted signal across sales achievement, attendance, employee linkage, and data coverage."
      >
        {landing.adminSignals ? (
          <HealthBreakdown health={landing.adminSignals.health} />
        ) : (
          <UnavailableChip label="Health breakdown" />
        )}
      </Section>

      {/* ── Trends ────────────────────────────────────────────────────────── */}
      <Section
        title="Trends"
        description="Sales value, people cost, and headcount movement over recent periods."
      >
        {landing.adminSignals ? (
          <TrendsSection trends={landing.adminSignals.trends} />
        ) : (
          <UnavailableChip label="Trends" />
        )}
      </Section>

      {/* ── Double-Visit Intelligence ──────────────────────────────────────── */}
      <Section
        title="Double-Visit Intelligence"
        description="Repeated vs. neglected medical reps per manager — company-wide."
        action={
          <Link
            href="/admin/double-visit-analytics"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
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
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
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
      <Section
        title="Expense Snapshot"
        description="Last 30 days — outstation spend by region + top spenders."
        action={
          <Link
            href="/admin/outstation/expense-command"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
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
      </Section>

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
      <Section
        title="Attendance & Leave"
        description="Today's absentees, managers on leave, chronic late offenders, and 7-week trend."
      >
        {landing.attendance ? (
          <AttendanceWidget data={landing.attendance} managersOnLeave={landing.managersOnLeave} />
        ) : (
          <UnavailableChip label="Attendance Analytics" />
        )}
      </Section>

      {/* ── Smart Navigation Grid ─────────────────────────────────────────── */}
      <Section title="Quick Navigation" description="Every module, one click away.">
        <SmartNavGrid access={access} />
      </Section>
    </div>
  );
}
