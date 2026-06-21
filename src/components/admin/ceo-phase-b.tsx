import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarOff,
  CheckCircle2,
  Clock,
  DollarSign,
  ExternalLink,
  MapPin,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  UserCheck,
  Users,
  Wallet,
} from "lucide-react";

import { CeoDvTable } from "@/components/admin/ceo-dv-table";
import { CeoSosTables } from "@/components/admin/ceo-sos-tables";
import type { AccessContext } from "@/lib/auth/permissions";
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

// ── Expense snippet ───────────────────────────────────────────────────────────

function ExpenseSnippet({
  data,
}: {
  data: NonNullable<Awaited<ReturnType<typeof getCeoLandingDeferred>>["expense"]>;
}) {
  const approvedPctDisplay = `${Math.round(data.approvedPct * 100)}%`;

  return (
    <div className="p-5 space-y-4">
      {/* KPI row */}
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
        <div className={`border px-3 py-2.5 ${(data.highRiskCount ?? 0) > 0 ? "border-rose-200 bg-rose-50" : "border-slate-200"}`}>
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">High-risk</p>
          <p className={`mt-0.5 text-lg font-black ${(data.highRiskCount ?? 0) > 0 ? "text-rose-700" : "text-slate-400"}`}>
            {data.highRiskCount ?? "—"}
          </p>
          <p className="text-[10px] text-slate-400">trips flagged</p>
        </div>
      </div>

      {/* By region + top spenders side by side */}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.byRegion.length > 0 && (
          <div>
            <p className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">By Region</p>
            <div className="space-y-1">
              {data.byRegion.map((r) => (
                <div key={r.label} className="flex items-center justify-between gap-2 border border-slate-100 bg-slate-50 px-2.5 py-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <MapPin className="h-3 w-3 shrink-0 text-slate-400" />
                    <span className="truncate text-[11px] font-semibold text-slate-700">{r.label}</span>
                  </div>
                  <span className="shrink-0 text-[11px] font-black text-slate-900">{egp(r.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {data.topSpenders.length > 0 && (
          <div>
            <p className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Top Spenders</p>
            <div className="space-y-1">
              {data.topSpenders.map((s, i) => (
                <div key={s.label} className="flex items-center justify-between gap-2 border border-slate-100 bg-slate-50 px-2.5 py-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-black text-slate-300">#{i + 1}</span>
                    <span className="truncate text-[11px] font-semibold text-slate-700">{s.label}</span>
                  </div>
                  <span className="shrink-0 text-[11px] font-black text-slate-900">{egp(s.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
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
    {
      label: "Started Strong",
      count: data.startedStrong,
      color: "bg-emerald-500",
      textColor: "text-emerald-700",
      borderColor: "border-emerald-200 bg-emerald-50",
      icon: <TrendingUp className="h-4 w-4 text-emerald-600" />,
    },
    {
      label: "Started Weak",
      count: data.startedWeak,
      color: "bg-amber-400",
      textColor: "text-amber-700",
      borderColor: "border-amber-200 bg-amber-50",
      icon: <TrendingDown className="h-4 w-4 text-amber-600" />,
    },
    {
      label: "Still Zero",
      count: data.stillZero,
      color: "bg-rose-500",
      textColor: "text-rose-700",
      borderColor: "border-rose-200 bg-rose-50",
      icon: <AlertTriangle className="h-4 w-4 text-rose-600" />,
    },
  ];

  return (
    <div className="p-5 space-y-4">
      {data.lastPeriod && (
        <p className="text-[10px] text-slate-400">Latest period: {data.lastPeriod} · {total} total requests</p>
      )}

      {/* Bucket cards */}
      <div className="grid grid-cols-3 gap-2">
        {buckets.map((b) => (
          <div key={b.label} className={`border px-4 py-3 ${b.borderColor}`}>
            <div className="flex items-center gap-2 mb-1">
              {b.icon}
              <span className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">{b.label}</span>
            </div>
            <p className={`text-3xl font-black ${b.textColor}`}>{b.count}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">
              {total > 0 ? `${Math.round((b.count / total) * 100)}% of total` : "—"}
            </p>
          </div>
        ))}
      </div>

      {/* Trend bars */}
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
                    <div className="bg-amber-400" style={{ height: `${(p.behind / t) * 100}%` }} />
                    <div className="bg-rose-400" style={{ height: `${(p.noData / t) * 100}%` }} />
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
      {/* Today snapshot */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Today</p>
          <p className="mt-0.5 text-sm font-black text-slate-900">
            {data.todayIsWorkingDay ? "Working day" : "Non-working day"}
          </p>
        </div>
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Absent today</p>
          <p className={`mt-0.5 text-2xl font-black ${data.todayAbsentees.length > 5 ? "text-rose-700" : "text-slate-900"}`}>
            {data.todayAbsentees.length}
          </p>
        </div>
        <div className="border border-slate-200 px-3 py-2.5">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Chronic late (30d)</p>
          <p className={`mt-0.5 text-2xl font-black ${data.chronicLate.length > 3 ? "text-amber-700" : "text-slate-900"}`}>
            {data.chronicLate.length}
          </p>
        </div>
        <div className={`border px-3 py-2.5 ${(managersOnLeave?.length ?? 0) > 0 ? "border-amber-200 bg-amber-50" : "border-slate-200"}`}>
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Managers on leave</p>
          <p className={`mt-0.5 text-2xl font-black ${(managersOnLeave?.length ?? 0) > 0 ? "text-amber-700" : "text-slate-400"}`}>
            {managersOnLeave?.length ?? 0}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Managers on leave list */}
        {(managersOnLeave?.length ?? 0) > 0 && (
          <div>
            <p className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-400 flex items-center gap-1.5">
              <CalendarOff className="h-3 w-3 text-amber-500" />
              Managers on leave today
            </p>
            <div className="space-y-1">
              {managersOnLeave!.map((m) => (
                <div key={m.hrId} className="flex items-center gap-2 border border-amber-100 bg-amber-50 px-2.5 py-1.5">
                  <span className="border border-amber-300 bg-white px-1.5 py-0.5 text-[9px] font-bold text-amber-700">{m.role}</span>
                  <span className="text-[11px] font-semibold text-slate-800">{m.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Today's absentees (first 6) */}
        {data.todayAbsentees.length > 0 && (
          <div>
            <p className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-400 flex items-center gap-1.5">
              <Users className="h-3 w-3 text-rose-500" />
              Absent today {data.todayAbsentees.length > 6 ? `(showing 6 of ${data.todayAbsentees.length})` : ""}
            </p>
            <div className="space-y-1">
              {data.todayAbsentees.slice(0, 6).map((a) => (
                <div key={a.hrId} className="flex items-center justify-between border border-slate-100 bg-slate-50 px-2.5 py-1.5">
                  <span className="text-[11px] font-semibold text-slate-800">{a.name}</span>
                  <span className="text-[10px] text-slate-400">{a.department}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Weekly late-rate trend */}
      {data.weeklyTrend.length > 0 && (
        <div>
          <p className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Late rate — 7-week trend</p>
          <div className="flex items-end gap-1.5 h-14">
            {data.weeklyTrend.map((w) => (
              <div key={w.isoWeek} className="flex flex-1 flex-col items-center gap-0.5">
                <div className="flex h-10 w-full items-end">
                  <div
                    className="w-full bg-orange-400"
                    style={{ height: `${Math.max(3, (w.lateRate / maxLate) * 100)}%` }}
                    title={`${w.lateRate.toFixed(1)}% late`}
                  />
                </div>
                <span className="text-[7px] text-slate-400 truncate max-w-full">{w.isoWeek}</span>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-slate-400">
            Latest: {data.weeklyTrend[data.weeklyTrend.length - 1]?.lateRate.toFixed(1) ?? "—"}% late rate
          </p>
        </div>
      )}

      {/* Chronic late top offenders */}
      {data.chronicLate.length > 0 && (
        <div>
          <p className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">Chronic late (30-day window)</p>
          <div className="space-y-1">
            {data.chronicLate.slice(0, 6).map((c) => (
              <div key={c.hrId} className="flex items-center justify-between border border-slate-100 bg-slate-50 px-2.5 py-1.5">
                <span className="text-[11px] font-semibold text-slate-800">{c.name}</span>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-slate-500">{c.lateDays} days late</span>
                  <span className={`text-[11px] font-bold ${c.lateRate >= 50 ? "text-rose-700" : c.lateRate >= 30 ? "text-amber-700" : "text-slate-600"}`}>
                    {c.lateRate.toFixed(0)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Link href="/attendance/analytics" className="inline-flex items-center gap-1.5 border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700 hover:border-orange-300 hover:text-orange-700">
          Full Attendance <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

// ── Smart navigation grid ─────────────────────────────────────────────────────

const NAV_ITEMS = [
  { href: "/employees", icon: Users, label: "Employees", sub: "Directory & lifecycle" },
  { href: "/payroll", icon: Wallet, label: "Payroll", sub: "Salary & flags" },
  { href: "/sales", icon: BarChart3, label: "Source of Sales", sub: "Monthly distributor data" },
  { href: "/sales/weekly", icon: Activity, label: "Weekly Sales", sub: "Weekly trends & targets" },
  { href: "/admin/marketing-requests/roi-tracking", icon: TrendingUp, label: "ROI Tracking", sub: "Marketing investment returns" },
  { href: "/admin/double-visit-analytics", icon: UserCheck, label: "Double Visit", sub: "Manager coverage intelligence" },
  { href: "/admin/outstation/expense-command", icon: DollarSign, label: "Expense Command", sub: "Company-wide outstation spend" },
  { href: "/coaching/analytics", icon: ShieldCheck, label: "Coaching", sub: "Rep performance & KPIs" },
  { href: "/admin/action-center", icon: CheckCircle2, label: "Action Center", sub: "Pending approvals" },
  { href: "/organogram", icon: Users, label: "Organogram", sub: "Org chart & hierarchy" },
  { href: "/attendance/analytics", icon: Clock, label: "Attendance", sub: "Today & trend" },
  { href: "/admin/data-health", icon: ShieldCheck, label: "Data Health", sub: "System quality score" },
];

function SmartNavGrid() {
  return (
    <div className="grid grid-cols-2 gap-2 p-5 sm:grid-cols-3 lg:grid-cols-4">
      {NAV_ITEMS.map(({ href, icon: Icon, label, sub }) => (
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
      {["Double-Visit Intelligence", "Monthly Sales Intelligence", "Expense Snapshot", "ROI Signal", "Attendance & Leave"].map((title) => (
        <div key={title} className="bg-white">
          <div className="border-b border-slate-200 bg-slate-900 px-5 py-3.5">
            <div className="text-[11px] font-black uppercase tracking-[0.14em] text-white">{title}</div>
          </div>
          <div className="space-y-2 p-5">
            <div className="h-5 w-2/3 animate-pulse bg-slate-100" />
            <div className="h-5 w-1/2 animate-pulse bg-slate-100" />
            <div className="h-20 w-full animate-pulse bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Phase B async server component ──────────────────────────────────────

export async function CeoPhaseBWidgets({ access }: { access: AccessContext }) {
  const landing = await getCeoLandingDeferred(access);

  return (
    <div className="divide-y divide-slate-200 border-t border-slate-200">

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

      {/* ── Monthly Source of Sales ────────────────────────────────────────── */}
      <Section
        title="Monthly Sales Intelligence"
        description="Company-wide source of sales — sortable by region or product."
        action={
          <Link
            href="/sales"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
          >
            Full SoS <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {landing.sosMonthly ? (
          <CeoSosTables
            byRegion={landing.sosMonthly.byRegion}
            byProduct={landing.sosMonthly.byProduct}
            period={landing.sosMonthly.period}
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
        action={
          <Link
            href="/admin/marketing-requests/roi-tracking"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
          >
            ROI Tracking <ArrowRight className="h-3 w-3" />
          </Link>
        }
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
        action={
          <Link
            href="/attendance/analytics"
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
          >
            Attendance <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {landing.attendance ? (
          <AttendanceWidget data={landing.attendance} managersOnLeave={landing.managersOnLeave} />
        ) : (
          <UnavailableChip label="Attendance Analytics" />
        )}
      </Section>

      {/* ── Smart Navigation Grid ─────────────────────────────────────────── */}
      <Section title="Quick Navigation" description="Every module, one click away.">
        <SmartNavGrid />
      </Section>
    </div>
  );
}
