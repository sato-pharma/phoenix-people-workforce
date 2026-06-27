import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BarChart3,
  CalendarClock,
  CalendarDays,
  CalendarX2,
  ChartColumnBig,
  CheckCircle2,
  ClipboardCheck,
  Layers,
  ReceiptText,
  Send,
  Target,
  TrendingUp,
  Trophy,
  User,
  Users,
  Wallet,
} from "lucide-react";

import { IdentityCard } from "@/components/employee-portal/identity-card";
import { InsightPreviewPanel } from "@/components/employee-portal/dashboards/insight-preview-panel";
import { DsmCommandCenter } from "@/components/employee-portal/dashboards/dsm-command-center";
import { NsmCommandCenter } from "@/components/employee-portal/dashboards/nsm-command-center";
import { MarketingManagerCommandCenter } from "@/components/employee-portal/dashboards/marketing-manager-command-center";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";

export function egp(n: number) {
  return new Intl.NumberFormat("en-EG", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n);
}

function monthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

export function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-2.5 sm:px-5 sm:py-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">{title}</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>
      <div className="bg-white p-3 sm:p-5">{children}</div>
    </div>
  );
}

function StatTile({
  icon: Icon,
  headline,
  sub,
}: {
  icon: React.ElementType;
  headline: string;
  sub: string;
}) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center gap-2 bg-slate-900 px-4 py-2">
        <Icon className="h-3.5 w-3.5 text-slate-400" />
      </div>
      <div className="px-3 py-3 sm:px-4 sm:py-4">
        <p className="break-words text-xl font-bold text-slate-900 sm:text-2xl">{headline}</p>
        <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">{sub}</p>
      </div>
    </div>
  );
}

export function PremiumNavTile({
  href,
  icon: Icon,
  label,
  description,
  badge,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  description: string;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className="group relative flex min-h-[52px] bg-white transition-colors hover:bg-orange-50 active:bg-orange-100 sm:min-h-[72px]"
    >
      {badge != null && badge > 0 && (
        <span className="absolute right-2 top-2 flex h-5 min-w-[20px] items-center justify-center bg-orange-500 px-1 text-[9px] font-black text-white">
          {badge}
        </span>
      )}
      <div className="w-[3px] shrink-0 bg-slate-200 transition-colors group-hover:bg-orange-500" />
      <div className="flex flex-1 items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4 sm:py-5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white sm:h-10 sm:w-10">
          <Icon className="h-4 w-4 sm:h-[18px] sm:w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500 transition-colors group-hover:text-orange-600">
            {label}
          </p>
          <p className="mt-0.5 hidden text-sm font-semibold leading-snug text-slate-800 sm:block">{description}</p>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-orange-500" />
      </div>
    </Link>
  );
}

export function MarketingToolRow({
  href,
  icon: Icon,
  label,
  sub,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  sub: string;
}) {
  return (
    <Link
      href={href}
      className="group flex min-h-[48px] items-center gap-3 bg-white px-4 py-3 transition-colors hover:bg-slate-50 active:bg-orange-50 sm:min-h-[56px] sm:gap-4 sm:px-5 sm:py-4"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-slate-200 bg-slate-50 transition-colors group-hover:border-orange-300 group-hover:bg-orange-50">
        <Icon className="h-4 w-4 text-slate-500 transition-colors group-hover:text-orange-600" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">{label}</p>
        <p className="text-[11px] leading-snug text-slate-500">{sub}</p>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-orange-500" />
    </Link>
  );
}

export function PendingActions({
  pendingVacationCount,
  pendingExcuseCount,
  plansAwaitingApproval = 0,
}: {
  pendingVacationCount: number;
  pendingExcuseCount: number;
  plansAwaitingApproval?: number;
}) {
  return (
    <SectionShell title="Needs Your Decision">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {plansAwaitingApproval > 0 && (
          <Link
            href="/employee-portals/plans"
            className="flex items-center justify-between border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-800 hover:bg-orange-100"
          >
            <span className="flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4" />
              {plansAwaitingApproval} plan{plansAwaitingApproval > 1 ? "s" : ""} awaiting your approval
            </span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
        {pendingVacationCount > 0 && (
          <Link
            href="/employee-portals/actions"
            className="flex items-center justify-between border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-800 hover:bg-orange-100"
          >
            <span className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              {pendingVacationCount} vacation request{pendingVacationCount > 1 ? "s" : ""} pending
            </span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
        {pendingExcuseCount > 0 && (
          <Link
            href="/employee-portals/actions"
            className="flex items-center justify-between border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-800 hover:bg-orange-100"
          >
            <span className="flex items-center gap-2">
              <CalendarX2 className="h-4 w-4" />
              {pendingExcuseCount} excuse request{pendingExcuseCount > 1 ? "s" : ""} pending
            </span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
      </div>
    </SectionShell>
  );
}

/* ── ProfileIntelBar ─────────────────────────────────────────────── */

export function ProfileIntelBar({ shell }: { shell: EmployeePortalShellData }) {
  const { employee, hrContract } = shell;
  const hireDateLabel = hrContract.hireDate
    ? new Date(hrContract.hireDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : null;
  if (!employee.line && !hireDateLabel && !employee.manager) return null;
  return (
    <div className="relative overflow-hidden bg-[#0b1f3a] shadow-[0_8px_32px_rgba(11,31,58,0.35)]">
      <div className="absolute inset-0 opacity-[0.04] [background-image:linear-gradient(rgba(255,255,255,1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,1)_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#f47b20] to-transparent" />
      <div className="relative flex flex-col">
        {/* Row 1 — Line + Joined */}
        {(employee.line || hireDateLabel) && (
          <div className="flex border-b border-white/[0.06]">
            {employee.line && (
              <div className="flex min-w-0 flex-1 flex-col gap-1 border-r border-white/[0.06] px-4 py-3 sm:px-7 sm:py-4">
                <div className="flex items-center gap-1.5">
                  <Layers className="h-3 w-3 shrink-0 text-[#f47b20]" />
                  <span className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500">Line</span>
                </div>
                <span className="whitespace-nowrap text-sm font-black text-white sm:text-base">{employee.line}</span>
              </div>
            )}
            {hireDateLabel && (
              <div className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 sm:px-7 sm:py-4">
                <div className="flex items-center gap-1.5">
                  <CalendarDays className="h-3 w-3 shrink-0 text-[#f47b20]" />
                  <span className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500">Joined</span>
                </div>
                <span className="whitespace-nowrap text-sm font-black text-white sm:text-base">{hireDateLabel}</span>
              </div>
            )}
          </div>
        )}
        {/* Row 2 — Reports To */}
        {employee.manager && (
          <div className="flex min-w-0 items-center gap-3 px-4 py-3 sm:px-7 sm:py-4">
            <div className="flex shrink-0 items-center gap-1.5">
              <User className="h-3 w-3 shrink-0 text-[#f47b20]" />
              <span className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500">Reports To</span>
            </div>
            <div className="h-3 w-px shrink-0 bg-white/[0.12]" />
            <span className="min-w-0 whitespace-nowrap text-sm font-black text-white sm:text-base">{employee.manager}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── PortalContextBar ────────────────────────────────────────────── */

export function PortalContextBar({ role, context }: { role: string; context: string }) {
  return (
    <div className="flex items-center gap-3 border border-orange-200 bg-orange-50 px-4 py-3 sm:px-5 sm:py-3.5">
      <Layers className="h-4 w-4 shrink-0 text-orange-600" />
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-widest text-orange-500">{role}</p>
        <p className="truncate font-bold text-slate-900">{context}</p>
      </div>
    </div>
  );
}

/* ── GlanceStrip ─────────────────────────────────────────────────── */

type GlanceStripItem = {
  icon: React.ElementType;
  value: string;
  label: string;
  href: string;
  urgent?: boolean;
};

export function GlanceStrip({ items }: { items: GlanceStripItem[] }) {
  return (
    <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-3">
      {items.map((item, i) => (
        <Link
          key={i}
          href={item.href}
          className={`group flex min-h-[56px] items-center gap-2 bg-white px-3 py-3 transition-colors hover:bg-slate-50 sm:min-h-[64px] sm:gap-4 sm:px-5 border-l-[3px] ${item.urgent ? "border-orange-500" : "border-transparent"}`}
        >
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center border transition-colors group-hover:border-orange-300 group-hover:bg-orange-50${item.urgent ? " border-orange-200 bg-orange-50" : " border-slate-200 bg-slate-50"}`}
          >
            <item.icon
              className={`h-4 w-4 transition-colors group-hover:text-orange-600${item.urgent ? " text-orange-600" : " text-slate-500"}`}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className={`truncate text-sm font-black leading-tight sm:text-base${item.urgent ? " text-orange-600" : " text-slate-900"}`}>{item.value}</p>
            <p className="truncate text-xs text-slate-500">{item.label}</p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-orange-400" />
        </Link>
      ))}
    </div>
  );
}

/* ── QuickActions ────────────────────────────────────────────────── */

type QuickAction = {
  href: string;
  icon: React.ElementType;
  label: string;
};

export function QuickActions({ actions }: { actions: QuickAction[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-2">
      {actions.map((action, i) => (
        <Link
          key={i}
          href={action.href}
          className="flex min-h-[48px] items-center justify-center gap-2 border border-slate-200 bg-white px-3 py-3 text-xs font-bold uppercase tracking-wide text-slate-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 sm:inline-flex sm:min-h-0 sm:px-4 sm:py-2.5 sm:text-[11px]"
        >
          <action.icon className="h-4 w-4 shrink-0 sm:h-3.5 sm:w-3.5" />
          <span className="truncate">{action.label}</span>
        </Link>
      ))}
    </div>
  );
}

/* ── Private command center layouts ─────────────────────────────── */

function PmGpmCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount, latestPayslip, leaveEntitlementDays, pmMarketing, plansAwaitingManagerApproval } = snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount + plansCount;

  return (
    <div className="mx-auto w-full space-y-2 sm:space-y-3" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />

      <GlanceStrip
        items={[
          {
            icon: Send,
            value: pmMarketing ? String(pmMarketing.myPendingRequests) : "—",
            label: pmMarketing?.myPendingRequests === 1 ? "marketing request in flight" : "marketing requests in flight",
            href: "/employee-portals/marketing-requests",
          },
          {
            icon: CalendarX2,
            value: String(totalPending),
            label: totalPending === 1 ? "pending request" : "pending requests",
            href: "/employee-portals/actions",
            urgent: totalPending > 0,
          },
          {
            icon: CalendarDays,
            value: leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "—",
            label: "leave balance",
            href: "/employee-portals/vacation-request",
          },
          {
            icon: Wallet,
            value: latestPayslip ? egp(latestPayslip.netSalary) : "—",
            label: latestPayslip ? `${monthLabel(latestPayslip.month)} payslip` : "last payslip",
            href: "/employee-portals/payslips",
          },
        ]}
      />
      <QuickActions
        actions={[
          { href: "/employee-portals/marketing-requests", icon: Send, label: "Marketing Request" },
          { href: "/employee-portals/plans", icon: CalendarDays, label: "My Plans" },
          { href: "/employee-portals/roi", icon: Target, label: "ROI Intelligence" },
          { href: "/employee-portals/vacation-request", icon: CalendarX2, label: "Request Leave" },
        ]}
      />
      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      )}

      {/* ── SALES INTELLIGENCE ────────────────────────────────────── */}
      <div className="overflow-hidden shadow-[0_4px_24px_rgba(0,0,0,0.08)]">
        {/* header */}
        <div className="relative flex items-center justify-between bg-[#0b1f3a] px-4 py-3 sm:px-6 sm:py-4">
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-[#f47b20]/60 via-[#f47b20]/20 to-transparent" />
          <div className="flex items-center gap-3">
            <span className="inline-block h-4 w-[3px] bg-[#f47b20]" />
            <h2 className="text-[11px] font-black uppercase tracking-[0.22em] text-white">Sales Intelligence</h2>
          </div>
          <TrendingUp className="h-4 w-4 text-[#f47b20]/60" />
        </div>
        {/* 3 cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3">
          {([
            { href: "/employee-portals/weekly-sales", icon: TrendingUp, label: "Weekly Sales", sub: "Distributor performance week by week", primary: true },
            { href: "/employee-portals/monthly-sales", icon: BarChart3, label: "Monthly Closing", sub: "17-distributor closing progress", primary: false },
            { href: "/employee-portals/sales", icon: Activity, label: "Sales Dashboard", sub: "Monthly target vs actual achievement", primary: false },
          ] as const).map(({ href, icon: Icon, label, sub, primary }) => (
            <Link key={href} href={href}
              className="group relative flex flex-row items-center gap-3 overflow-hidden border-b border-slate-100 bg-white px-4 py-3 last:border-b-0 transition-all duration-200 hover:bg-[#0b1f3a] sm:flex-col sm:items-start sm:gap-3 sm:border-b-0 sm:border-r sm:p-6"
            >
              <div className="absolute inset-x-0 top-0 h-0 bg-[#f47b20] transition-all duration-300 group-hover:h-[3px]" />
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center transition-colors duration-200 sm:h-11 sm:w-11 ${primary ? "bg-[#f47b20]" : "border border-slate-200 bg-slate-50 group-hover:border-[#f47b20]/40 group-hover:bg-[#f47b20]/10"}`}>
                <Icon className={`h-4 w-4 transition-colors sm:h-5 sm:w-5 ${primary ? "text-white" : "text-slate-400 group-hover:text-[#f47b20]"}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-black uppercase tracking-wider text-slate-900 transition-colors group-hover:text-white">{label}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-500 transition-colors group-hover:text-slate-400">{sub}</p>
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-[#f47b20] sm:hidden" />
              <div className="hidden items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[#f47b20] opacity-0 transition-all duration-200 group-hover:opacity-100 sm:flex">
                Open <ArrowRight className="h-3 w-3" />
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* ── MARKETING & WORKSPACE ─────────────────────────────────── */}
      <div className="overflow-hidden shadow-[0_4px_24px_rgba(0,0,0,0.08)]">
        <div className="relative flex items-center justify-between bg-[#0b1f3a] px-4 py-3 sm:px-6 sm:py-4">
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-[#f47b20]/60 via-[#f47b20]/20 to-transparent" />
          <div className="flex items-center gap-3">
            <span className="inline-block h-4 w-[3px] bg-[#f47b20]" />
            <h2 className="text-[11px] font-black uppercase tracking-[0.22em] text-white">Marketing &amp; Workspace</h2>
          </div>
          <Send className="h-4 w-4 text-[#f47b20]/60" />
        </div>
        <div className="divide-y divide-slate-100 bg-white">
          {([
            { href: "/employee-portals/plans", icon: CalendarDays, label: "My Plans", sub: "Weekly and monthly field activity planning", num: "01" },
            { href: "/employee-portals/marketing-requests", icon: Send, label: "Marketing Requests", sub: "Submit and track promotional investments", num: "02" },
            { href: "/employee-portals/roi", icon: Target, label: "ROI Intelligence", sub: "Measure return on marketing spend", num: "03" },
            { href: "/employee-portals/coaching-analytics", icon: ChartColumnBig, label: "Coaching Analytics", sub: "Team coaching performance overview", num: "04" },
          ] as const).map(({ href, icon: Icon, label, sub, num }) => (
            <Link key={href} href={href}
              className="group relative flex items-center gap-2 overflow-hidden px-3 py-2 transition-all duration-150 hover:bg-[#fdf5ee] sm:gap-5 sm:px-6 sm:py-4"
            >
              <div className="absolute inset-y-0 left-0 w-0 bg-[#f47b20] transition-all duration-200 group-hover:w-[3px]" />
              <span className="w-6 shrink-0 text-[11px] font-black tabular-nums text-[#f47b20]/40 transition-colors group-hover:text-[#f47b20]">{num}</span>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-slate-200 bg-slate-50 transition-all duration-150 group-hover:border-[#f47b20]/40 group-hover:bg-[#f47b20]/8">
                <Icon className="h-4 w-4 text-slate-400 transition-colors group-hover:text-[#f47b20]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-slate-900">{label}</p>
                <p className="text-[11px] text-slate-500">{sub}</p>
              </div>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-all duration-150 group-hover:translate-x-1 group-hover:text-[#f47b20]" />
            </Link>
          ))}
        </div>
      </div>

      {/* ── UPCOMING PAY DATES ────────────────────────────────────── */}
      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Upcoming Pay Dates</h2>
        </div>
        {pmMarketing && pmMarketing.upcoming.length > 0 ? (
          <div className="divide-y divide-slate-100 bg-white">
            {pmMarketing.upcoming.map((row) => (
              <Link
                key={row.id}
                href="/employee-portals/marketing-requests"
                className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-orange-50"
              >
                <CalendarClock className="h-4 w-4 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{row.requestCode}</p>
                  <p className="text-[11px] text-slate-500">
                    {new Date(row.payDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-bold text-slate-700">{egp(row.estimatedCost)}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="bg-white px-5 py-6 text-sm text-slate-500">No approved marketing requests paying out soon.</p>
        )}
      </div>

      <InsightPreviewPanel note="Campaign and ROI recommendations for your line are coming soon." />

      {/* ── STATUS ────────────────────────────────────────────────── */}
      {totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      ) : (
        <div className="relative overflow-hidden bg-[#0a2018] px-4 py-4 shadow-[0_4px_24px_rgba(0,0,0,0.12)] sm:px-6 sm:py-5">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-500 to-transparent" />
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-emerald-500/30 bg-emerald-500/10">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-emerald-500">All Clear</p>
              <p className="mt-0.5 text-sm font-medium text-emerald-300/80">Nothing needs your attention right now.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Medical Rep layout — premium field rep command center ---

function MedicalRepCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount, latestPayslip, leaveEntitlementDays, mrSalesAchievement, monthlySalesTrend, doubleVisitPulse, mrPendingExpenseCount } =
    snapshot;
  const daysUntilRenewal = shell.hrContract?.daysUntilRenewal;
  const probationStatus = shell.hrContract?.probationStatus;
  const serviceDuration = shell.hrContract?.serviceDurationText;
  const totalPending = pendingVacationCount + pendingExcuseCount;

  const ach = mrSalesAchievement;
  const pct = ach ? Math.max(0, Math.round(ach.achievementPercent)) : null;
  const pctCapped = pct !== null ? Math.min(100, pct) : 0;

  const achNumColor =
    pct === null ? "text-white" : pct >= 100 ? "text-emerald-300" : pct >= 90 ? "text-amber-300" : "text-orange-300";
  const barColor =
    pct === null ? "bg-orange-500" : pct >= 100 ? "bg-emerald-500" : pct >= 90 ? "bg-amber-400" : "bg-orange-500";

  const achStatus =
    pct === null
      ? null
      : pct >= 100
        ? { label: "Target Hit", cls: "border-emerald-400/30 bg-emerald-500/15 text-emerald-300" }
        : pct >= 90
          ? { label: "Almost There", cls: "border-amber-400/30 bg-amber-500/15 text-amber-300" }
          : pct >= 70
            ? { label: "On Track", cls: "border-orange-400/30 bg-orange-500/15 text-orange-300" }
            : { label: "Needs Push", cls: "border-rose-400/30 bg-rose-500/15 text-rose-300" };

  const gapToTarget = ach && pct !== null && pct < 100 ? ach.targetValue - ach.salesValue : null;
  const surplus = ach && pct !== null && pct >= 100 ? ach.salesValue - ach.targetValue : null;

  const now = new Date();
  const thisMonth = now.toLocaleString("en-US", { month: "long", year: "numeric" });

  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const pacingPct =
    ach && pct !== null && dayOfMonth > 0
      ? Math.round(((ach.salesValue / dayOfMonth) * daysInMonth) / (ach.targetValue || 1) * 100)
      : null;
  const pacingVsActual = pacingPct !== null && pct !== null ? pacingPct - pct : null;

  const renewalUrgent = daysUntilRenewal !== null && daysUntilRenewal !== undefined && daysUntilRenewal <= 30;
  const renewalWarning =
    daysUntilRenewal !== null && daysUntilRenewal !== undefined && daysUntilRenewal > 30 && daysUntilRenewal <= 60;

  return (
    <div className="mx-auto w-full space-y-3 sm:space-y-4" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />
      <PortalContextBar role="Medical Representative" context="Field Performance" />

      <GlanceStrip
        items={[
          {
            icon: TrendingUp,
            value: pct !== null ? `${pct}%` : "—",
            label: "achievement",
            href: "/employee-portals/sales",
            urgent: pct !== null && pct < 70,
          },
          {
            icon: CalendarX2,
            value: String(totalPending),
            label: totalPending === 1 ? "pending request" : "pending requests",
            href: "/employee-portals/actions",
            urgent: totalPending > 0,
          },
          {
            icon: CalendarDays,
            value: leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "—",
            label: "leave balance",
            href: "/employee-portals/vacation-request",
          },
          {
            icon: Wallet,
            value: latestPayslip ? egp(latestPayslip.netSalary) : "—",
            label: latestPayslip ? `${monthLabel(latestPayslip.month)} payslip` : "last payslip",
            href: "/employee-portals/payslips",
          },
        ]}
      />
      <QuickActions
        actions={[
          { href: "/employee-portals/expenses", icon: ReceiptText, label: "My Expenses" },
          { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
          { href: "/employee-portals/plans", icon: ClipboardCheck, label: "Submit Plan" },
          { href: "/employee-portals/sales", icon: TrendingUp, label: "Sales Dashboard" },
        ]}
      />
      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      )}

      <div className="relative overflow-hidden border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_58%,#241002_100%)] shadow-[0_16px_48px_rgba(0,0,0,0.24)]">
        <div className="absolute inset-0 opacity-[0.07] [background-image:linear-gradient(rgba(255,255,255,.3)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.3)_1px,transparent_1px)] [background-size:40px_40px]" />

        <div className="relative grid gap-4 px-4 py-4 sm:gap-6 sm:px-7 sm:py-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(250px,0.8fr)] lg:px-8">
          {ach && pct !== null ? (
            <>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-[10px] font-bold uppercase text-slate-400">{thisMonth} | Field Achievement</p>
                  {achStatus && (
                    <span className={`inline-flex items-center border px-2.5 py-0.5 text-[10px] font-bold uppercase ${achStatus.cls}`}>
                      {achStatus.label}
                    </span>
                  )}
                </div>

                <div className="mt-5 flex flex-wrap items-end gap-x-5 gap-y-3">
                  <p className={`text-4xl font-black leading-none tabular-nums sm:text-6xl ${achNumColor}`}>
                    {pct}<span className="text-2xl sm:text-4xl">%</span>
                  </p>
                  <div className="pb-2">
                    <p className="text-base font-bold text-white">Monthly target progress</p>
                    <p className="mt-1 text-sm text-slate-400">
                      {gapToTarget !== null && gapToTarget > 0
                        ? `${egp(gapToTarget)} remaining`
                        : surplus !== null && surplus > 0
                          ? `${egp(surplus)} over target`
                          : "Target baseline loaded"}
                    </p>
                  </div>
                </div>

                <div className="mt-5 h-3 w-full overflow-hidden bg-white/10">
                  <div
                    className={`h-full transition-[width] duration-700 ${barColor}`}
                    style={{ width: `${Math.max(3, pctCapped)}%` }}
                  />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:max-w-xl sm:grid-cols-3">
                  <div className="border border-white/10 bg-white/5 px-3 py-2">
                    <p className="text-[10px] font-bold uppercase text-slate-500">Sold</p>
                    <p className="mt-1 font-black text-white">{egp(ach.salesValue)}</p>
                  </div>
                  <div className="border border-white/10 bg-white/5 px-3 py-2">
                    <p className="text-[10px] font-bold uppercase text-slate-500">Target</p>
                    <p className="mt-1 font-black text-white">{egp(ach.targetValue)}</p>
                  </div>
                  <div className="col-span-2 border border-white/10 bg-white/5 px-3 py-2 sm:col-span-1">
                    <p className="text-[10px] font-bold uppercase text-slate-500">Status</p>
                    <p className="mt-1 font-black text-white">{achStatus?.label ?? "Ready"}</p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col justify-between border border-orange-500/30 bg-orange-500/10 p-4">
                <div>
                  <p className="text-[10px] font-bold uppercase text-orange-300">Next field move</p>
                  <p className="mt-2 text-lg font-black leading-snug text-white">
                    {pct >= 100 ? "Protect the over-target month." : pct >= 90 ? "Close the final target gap." : "Push the next high-value visit."}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    Use the sales dashboard for customer mix, distributor movement, and monthly closing details.
                  </p>
                </div>
                <Link
                  href="/employee-portals/sales"
                  className="mt-5 inline-flex items-center justify-center gap-2 border border-orange-400 bg-orange-500 px-4 py-2.5 text-[11px] font-black uppercase text-white transition hover:bg-orange-600"
                >
                  Open sales dashboard <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-start gap-5">
                <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center border border-orange-500/25 bg-orange-500/10">
                  <TrendingUp className="h-8 w-8 text-orange-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase text-slate-400">{thisMonth} | Field Achievement</p>
                  <p className="mt-2 text-2xl font-black text-white">Sales upload pending</p>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
                    Your monthly achievement will appear here once the current sales upload is available.
                  </p>
                </div>
              </div>
              <div className="flex items-end justify-start lg:justify-end">
                <Link
                  href="/employee-portals/sales"
                  className="inline-flex items-center justify-center gap-2 border border-orange-400 bg-orange-500 px-4 py-2.5 text-[11px] font-black uppercase text-white transition hover:bg-orange-600"
                >
                  View dashboard <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </>
          )}
        </div>
      </div>

      {(ach || (monthlySalesTrend && monthlySalesTrend.length > 0) || doubleVisitPulse) && (
        <SectionShell title="Field Intelligence">
          <div className="grid gap-3 sm:grid-cols-3">
            {/* Pacing */}
            <div className="border border-slate-200 bg-slate-50 p-3 sm:p-4">
              <div className="flex items-center gap-2">
                <Target className="h-3.5 w-3.5 text-slate-400" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Month Pace</p>
              </div>
              {pacingPct !== null ? (
                <>
                  <p className={`mt-2 text-2xl font-black tabular-nums ${pacingPct >= 100 ? "text-emerald-600" : pacingPct >= 90 ? "text-amber-600" : "text-orange-500"}`}>
                    {pacingPct}%
                  </p>
                  <p className="mt-0.5 text-[10px] font-semibold text-slate-400">projected end-of-month</p>
                  {pacingVsActual !== null && (
                    <p className={`mt-1.5 text-xs font-bold ${pacingVsActual >= 0 ? "text-emerald-600" : "text-rose-500"}`}>
                      {pacingVsActual >= 0 ? `+${pacingVsActual}%` : `${pacingVsActual}%`} vs current
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-2 text-sm font-semibold text-slate-400">Data not yet available</p>
              )}
            </div>

            {/* Monthly trend mini-bars */}
            <div className="border border-slate-200 bg-slate-50 p-3 sm:p-4">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-3.5 w-3.5 text-slate-400" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Trend (4 Mo.)</p>
              </div>
              {monthlySalesTrend && monthlySalesTrend.length > 0 ? (
                <div className="mt-3 flex items-end gap-1.5" style={{ height: 64 }}>
                  {[...monthlySalesTrend].reverse().map((m) => {
                    const barH = Math.max(5, Math.min(100, m.achievementPercent));
                    const bColor = m.achievementPercent >= 100 ? "bg-emerald-500" : m.achievementPercent >= 90 ? "bg-amber-400" : "bg-orange-400";
                    const mo = new Date(m.year, m.month - 1).toLocaleString("en-US", { month: "short" });
                    return (
                      <div key={`${m.year}-${m.month}`} className="flex flex-1 flex-col items-center justify-end gap-0.5">
                        <p className="text-[9px] font-bold tabular-nums text-slate-500">{m.achievementPercent}%</p>
                        <div className={`w-full ${bColor}`} style={{ height: `${barH}%`, minHeight: 4 }} />
                        <p className="text-[9px] font-semibold text-slate-400">{mo}</p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 text-sm font-semibold text-slate-400">No history yet</p>
              )}
            </div>

            {/* Double visit pulse */}
            <div className="border border-slate-200 bg-slate-50 p-3 sm:p-4">
              <div className="flex items-center gap-2">
                <Users className="h-3.5 w-3.5 text-slate-400" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Double Visits</p>
              </div>
              {doubleVisitPulse ? (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <div>
                      <p className="text-xl font-black tabular-nums text-slate-900">{doubleVisitPulse.dvsThisMonth}</p>
                      <p className="text-[9px] font-semibold uppercase text-slate-400">this month</p>
                    </div>
                    <div>
                      <p className="text-xl font-black tabular-nums text-slate-900">{doubleVisitPulse.dvsLast90Days}</p>
                      <p className="text-[9px] font-semibold uppercase text-slate-400">last 90 days</p>
                    </div>
                  </div>
                  <p className="mt-2 text-[10px] font-semibold text-slate-400">
                    {doubleVisitPulse.daysSinceLastDv === null
                      ? "No visits recorded"
                      : doubleVisitPulse.daysSinceLastDv === 0
                        ? "Last visit today"
                        : `Last visit ${doubleVisitPulse.daysSinceLastDv}d ago`}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm font-semibold text-slate-400">No data available</p>
              )}
            </div>
          </div>
        </SectionShell>
      )}

      <SectionShell title="My Status">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Link href="/employee-portals/payslips" className="group overflow-hidden border border-slate-200 transition hover:border-orange-300">
            <div className="flex items-center gap-2 bg-slate-900 px-4 py-2 transition-colors group-hover:bg-orange-600">
              <Wallet className="h-3.5 w-3.5 text-slate-400 transition-colors group-hover:text-white" />
            </div>
            <div className="bg-white px-3 py-3 transition-colors group-hover:bg-orange-50 sm:px-4 sm:py-4">
              <p className="break-words text-2xl font-bold text-slate-900">
                {latestPayslip ? egp(latestPayslip.netSalary) : "Not issued"}
              </p>
              <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                {latestPayslip ? `${monthLabel(latestPayslip.month)} payslip` : "last payslip"}
              </p>
            </div>
          </Link>

          <Link href="/employee-portals/vacation-request" className="group overflow-hidden border border-slate-200 transition hover:border-orange-300">
            <div className="flex items-center gap-2 bg-slate-900 px-4 py-2 transition-colors group-hover:bg-orange-600">
              <CalendarDays className="h-3.5 w-3.5 text-slate-400 transition-colors group-hover:text-white" />
            </div>
            <div className="bg-white px-3 py-3 transition-colors group-hover:bg-orange-50 sm:px-4 sm:py-4">
              <p className="text-2xl font-bold text-slate-900">
                {leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "-"}
              </p>
              <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">annual leave entitlement</p>
            </div>
          </Link>

          {daysUntilRenewal != null ? (
            <div className={`overflow-hidden border ${renewalUrgent ? "border-rose-200" : renewalWarning ? "border-amber-200" : "border-slate-200"}`}>
              <div className={`flex items-center gap-2 px-4 py-2 ${renewalUrgent ? "bg-rose-600" : renewalWarning ? "bg-amber-500" : "bg-slate-900"}`}>
                <CalendarClock className="h-3.5 w-3.5 text-white/70" />
              </div>
              <div className={`px-3 py-3 sm:px-4 sm:py-4 ${renewalUrgent ? "bg-rose-50" : renewalWarning ? "bg-amber-50" : "bg-white"}`}>
                <p className={`text-xl font-bold tracking-tight sm:text-2xl ${renewalUrgent ? "text-rose-700" : renewalWarning ? "text-amber-700" : "text-slate-900"}`}>
                  {daysUntilRenewal} days
                </p>
                <p className={`mt-1 text-[10px] font-semibold uppercase tracking-widest ${renewalUrgent ? "text-rose-400" : renewalWarning ? "text-amber-400" : "text-slate-400"}`}>
                  until contract renewal
                </p>
              </div>
            </div>
          ) : probationStatus === "On Probation" ? (
            <div className="overflow-hidden border border-amber-200">
              <div className="flex items-center gap-2 bg-amber-500 px-4 py-2">
                <ClipboardCheck className="h-3.5 w-3.5 text-white/70" />
              </div>
              <div className="bg-amber-50 px-3 py-3 sm:px-4 sm:py-4">
                <p className="text-xl font-bold tracking-tight text-amber-700 sm:text-2xl">On Probation</p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-amber-400">
                  {serviceDuration || "in progress"}
                </p>
              </div>
            </div>
          ) : (
            <StatTile
              icon={ClipboardCheck}
              headline={serviceDuration || "Active"}
              sub="employment duration"
            />
          )}
        </div>
      </SectionShell>

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-4 py-2.5 sm:px-5 sm:py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">My Tools</h2>
        </div>
        <div className="grid grid-cols-2 gap-px bg-slate-200">
          <PremiumNavTile href="/employee-portals/coaching" icon={ClipboardCheck} label="My Coaching" description="View and track coaching reports" />
          <PremiumNavTile href="/employee-portals/expenses" icon={ReceiptText} label="My Expenses" description="Outstation expense tracker" badge={mrPendingExpenseCount ?? 0} />
          <PremiumNavTile href="/employee-portals/incentive" icon={Trophy} label="My Incentive" description="Track commission and bonus" />
          <PremiumNavTile href="/employee-portals/sales" icon={TrendingUp} label="Sales Dashboard" description="Achievement vs monthly target" />
          <PremiumNavTile href="/employee-portals/vacation-request" icon={CalendarDays} label="Vacation Request" description="Submit and track leave requests" />
          <PremiumNavTile href="/employee-portals/payslips" icon={Wallet} label="My Payslips" description="View and download salary slips" />
        </div>
      </div>

      {totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      ) : (
        <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-4 py-3 sm:px-5 sm:py-4">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-800">All clear — nothing needs your attention right now.</span>
        </div>
      )}
    </div>
  );
}

// --- Standard / MR layout ---

function StandardCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount, latestPayslip, leaveEntitlementDays, mrSalesAchievement, role, plansAwaitingManagerApproval } =
    snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount + plansCount;

  const ach = mrSalesAchievement;
  const pct = ach ? Math.max(0, Math.min(100, Math.round(ach.achievementPercent))) : null;
  const achColor =
    pct === null ? "text-slate-900" : pct >= 100 ? "text-emerald-600" : pct >= 90 ? "text-amber-600" : "text-orange-500";
  const barColor =
    pct === null ? "bg-orange-500" : pct >= 100 ? "bg-emerald-500" : pct >= 90 ? "bg-amber-400" : "bg-orange-500";

  return (
    <div className="mx-auto w-full space-y-3 sm:space-y-5" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />
      <PortalContextBar role={role} context={shell.employee.department || ""} />

      <GlanceStrip
        items={[
          ...(ach && pct !== null
            ? [
                {
                  icon: TrendingUp,
                  value: `${pct}%`,
                  label: "achievement",
                  href: "/employee-portals/sales",
                  urgent: pct < 70,
                },
              ]
            : []),
          {
            icon: CalendarX2,
            value: String(totalPending),
            label: totalPending === 1 ? "pending request" : "pending requests",
            href: "/employee-portals/actions",
            urgent: totalPending > 0,
          },
          {
            icon: CalendarDays,
            value: leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "—",
            label: "leave balance",
            href: "/employee-portals/vacation-request",
          },
          {
            icon: Wallet,
            value: latestPayslip ? egp(latestPayslip.netSalary) : "—",
            label: latestPayslip ? `${monthLabel(latestPayslip.month)} payslip` : "last payslip",
            href: "/employee-portals/payslips",
          },
        ]}
      />
      <QuickActions
        actions={[
          { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
          { href: "/employee-portals/plans", icon: ClipboardCheck, label: "My Plans" },
          { href: "/employee-portals/expenses", icon: ReceiptText, label: "My Expenses" },
          { href: "/employee-portals/report-it", icon: Activity, label: "Report It" },
        ]}
      />
      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      )}

      {ach && pct !== null && (
        <div className="overflow-hidden border border-slate-200">
          <div className="bg-slate-900 px-5 py-3">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
              This Month | Achievement
            </h2>
          </div>
          <div className="bg-white px-4 py-4 sm:px-6 sm:py-6">
            <div className="flex items-end gap-3">
              <p className={`text-4xl font-black leading-none tabular-nums sm:text-5xl ${achColor}`}>{pct}%</p>
              <p className="mb-1 text-sm text-slate-500">of target</p>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden bg-slate-100">
              <div
                className={`h-full transition-[width] duration-700 ${barColor}`}
                style={{ width: `${Math.max(4, pct)}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-800">{egp(ach.salesValue)} sold</span>
              <span className="text-slate-500">target {egp(ach.targetValue)}</span>
            </div>
          </div>
        </div>
      )}

      <div className="overflow-hidden border border-slate-200">
        <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">My Workspace</h2>
          <div className="h-1.5 w-12 bg-orange-500" />
        </div>
        <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2">
          <PremiumNavTile href="/employee-portals/coaching" icon={ClipboardCheck} label="My Coaching" description="Field coaching reports and history" />
          <PremiumNavTile href="/employee-portals/plans" icon={CalendarDays} label="My Plans" description="Weekly and monthly field activity" />
          <PremiumNavTile href="/employee-portals/expenses" icon={ReceiptText} label="My Expenses" description="Outstation expense tracker" />
          <PremiumNavTile href="/employee-portals/payslips" icon={Wallet} label="My Payslips" description="View and download salary slips" />
        </div>
      </div>

      {totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      ) : (
        <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-4 py-3 sm:px-5 sm:py-4">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-800">All clear — nothing needs your attention right now.</span>
        </div>
      )}
    </div>
  );
}

export function PortalCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  switch (snapshot.role) {
    case "Product Manager":
    case "Group Product Manager":
      return <PmGpmCommandCenter snapshot={snapshot} />;
    case "Marketing Manager":
      return <MarketingManagerCommandCenter snapshot={snapshot} />;
    case "District Manager":
      return <DsmCommandCenter snapshot={snapshot} />;
    case "National Sales Manager":
      return <NsmCommandCenter snapshot={snapshot} />;
  }
  if (snapshot.role.toLowerCase() === "medical rep") return <MedicalRepCommandCenter snapshot={snapshot} />;
  return <StandardCommandCenter snapshot={snapshot} />;
}
