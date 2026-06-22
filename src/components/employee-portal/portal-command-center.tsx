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
  Send,
  Target,
  TrendingUp,
  Wallet,
} from "lucide-react";

import { IdentityCard } from "@/components/employee-portal/identity-card";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";

// --- local formatters ---

function egp(n: number) {
  return new Intl.NumberFormat("en-EG", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n);
}

function monthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

// --- shared layout primitives ---

export function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden border border-slate-200">
      <div className="bg-slate-900 px-5 py-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">{title}</h2>
      </div>
      <div className="bg-white p-5">{children}</div>
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
    <div className="overflow-hidden border border-slate-200">
      <div className="flex items-center gap-2 bg-slate-900 px-4 py-2">
        <Icon className="h-3.5 w-3.5 text-slate-400" />
      </div>
      <div className="bg-white px-4 py-4">
        <p className="text-2xl font-bold tracking-tight text-slate-900">{headline}</p>
        <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">{sub}</p>
      </div>
    </div>
  );
}

// Premium navigation tile — large mobile-friendly tap target with orange left-border accent.
// Used for the 3 primary Sales Intelligence tiles in the PM/GPM layout.
export function PremiumNavTile({
  href,
  icon: Icon,
  label,
  description,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group relative flex min-h-[72px] bg-white transition-colors hover:bg-orange-50 active:bg-orange-100"
    >
      {/* Left accent strip — slate at rest, orange on hover */}
      <div className="w-[3px] shrink-0 bg-slate-200 transition-colors group-hover:bg-orange-500" />
      <div className="flex flex-1 items-center gap-4 px-4 py-5">
        {/* Icon box — dark slate, turns orange on hover */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white">
          <Icon className="h-[18px] w-[18px]" />
        </div>
        {/* Text */}
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500 transition-colors group-hover:text-orange-600">
            {label}
          </p>
          <p className="mt-0.5 text-sm font-semibold leading-snug text-slate-800">{description}</p>
        </div>
        {/* Arrow */}
        <ArrowRight className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-orange-500" />
      </div>
    </Link>
  );
}

// Marketing tool row — full-width list item, 48px+ tall, icon left, description, arrow right.
// Used for the Marketing Tools section links.
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
      className="group flex min-h-[56px] items-center gap-4 bg-white px-5 py-4 transition-colors hover:bg-slate-50 active:bg-orange-50"
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

// Shared pending actions block — shown when leave/excuse approvals are outstanding.
export function PendingActions({
  pendingVacationCount,
  pendingExcuseCount,
}: {
  pendingVacationCount: number;
  pendingExcuseCount: number;
}) {
  return (
    <SectionShell title="Pending Actions">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

// --- PM / GPM layout — premium marketer's command center ---

function PmGpmCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount } = snapshot;
  const lineName = shell.employee.line;
  const totalPending = pendingVacationCount + pendingExcuseCount;

  return (
    <div className="mx-auto w-full space-y-4" dir="auto">
      <IdentityCard data={shell} />

      {/* Product line identity — marketers identify with their line, not just their role */}
      {lineName && (
        <div className="flex items-center gap-3 border border-orange-200 bg-orange-50 px-5 py-3.5">
          <Layers className="h-4 w-4 shrink-0 text-orange-600" />
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-orange-500">Product Line</p>
            <p className="truncate font-bold text-slate-900">{lineName}</p>
          </div>
        </div>
      )}

      {/* Sales Intelligence — the three primary data views, mobile: stacked; sm+: 3-col grid */}
      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Sales Intelligence</h2>
        </div>
        {/* gap-px over bg-slate-200 creates hairline dividers between tiles */}
        <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-3">
          <PremiumNavTile
            href="/employee-portals/weekly-sales"
            icon={TrendingUp}
            label="Weekly Sales"
            description="Distributor performance week by week"
          />
          <PremiumNavTile
            href="/employee-portals/monthly-sales"
            icon={BarChart3}
            label="Monthly Closing"
            description="17-distributor closing progress"
          />
          <PremiumNavTile
            href="/employee-portals/sales"
            icon={Activity}
            label="Sales Dashboard"
            description="Monthly target vs actual achievement"
          />
        </div>
      </div>

      {/* Marketing Tools — the marketer's daily workflow, list-style for readability */}
      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Marketing Tools</h2>
        </div>
        <div className="divide-y divide-slate-100 bg-white">
          <MarketingToolRow
            href="/employee-portals/plans"
            icon={CalendarDays}
            label="My Plans"
            sub="Weekly & monthly field activity planning"
          />
          <MarketingToolRow
            href="/employee-portals/marketing-requests"
            icon={Send}
            label="Marketing Requests"
            sub="Submit & track promotional investments"
          />
          <MarketingToolRow
            href="/employee-portals/roi"
            icon={Target}
            label="ROI Intelligence"
            sub="Measure return on marketing spend"
          />
          <MarketingToolRow
            href="/employee-portals/coaching-analytics"
            icon={ChartColumnBig}
            label="Coaching Analytics"
            sub="Team coaching performance overview"
          />
        </div>
      </div>

      {/* Pending actions — shown prominently when outstanding; minimal strip when all clear */}
      {totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      ) : (
        <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-5 py-4">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-800">All clear — nothing needs your attention right now.</span>
        </div>
      )}
    </div>
  );
}

// --- Standard / MR layout ---

function StandardCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount, latestPayslip, leaveEntitlementDays, mrSalesAchievement } =
    snapshot;
  const daysUntilRenewal = shell.hrContract?.daysUntilRenewal;
  const totalPending = pendingVacationCount + pendingExcuseCount;

  const ach = mrSalesAchievement;
  const pct = ach ? Math.max(0, Math.min(100, Math.round(ach.achievementPercent))) : null;
  const achColor =
    pct === null ? "text-slate-900" : pct >= 100 ? "text-emerald-600" : pct >= 90 ? "text-amber-600" : "text-orange-500";
  const barColor =
    pct === null ? "bg-orange-500" : pct >= 100 ? "bg-emerald-500" : pct >= 90 ? "bg-amber-400" : "bg-orange-500";

  return (
    <div className="mx-auto w-full space-y-5" dir="auto">
      <IdentityCard data={shell} />

      {/* ACH hero tile — only shown when monthly sales data is available */}
      {ach && pct !== null && (
        <div className="overflow-hidden border border-slate-200">
          <div className="bg-slate-900 px-5 py-3">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
              This Month · Achievement
            </h2>
          </div>
          <div className="bg-white px-6 py-6">
            <div className="flex items-end gap-3">
              <p className={`text-5xl font-black leading-none tabular-nums ${achColor}`}>{pct}%</p>
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

      <SectionShell title="Quick Stats">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            icon={Wallet}
            headline={latestPayslip ? egp(latestPayslip.netSalary) : "Not yet issued"}
            sub={latestPayslip ? `${monthLabel(latestPayslip.month)} payslip` : "last payslip"}
          />
          <StatTile
            icon={CalendarDays}
            headline={leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "—"}
            sub="annual leave entitlement"
          />
          <StatTile
            icon={daysUntilRenewal != null ? CalendarClock : ClipboardCheck}
            headline={daysUntilRenewal != null ? `${daysUntilRenewal} days` : "No renewal pending"}
            sub="until contract renewal"
          />
        </div>
      </SectionShell>

      {totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      ) : (
        <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-5 py-4">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-800">All clear — nothing needs your attention right now.</span>
        </div>
      )}
    </div>
  );
}

// --- main export ---

export function PortalCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const isPmGpm = snapshot.role === "Product Manager" || snapshot.role === "Group Product Manager";
  if (isPmGpm) return <PmGpmCommandCenter snapshot={snapshot} />;
  return <StandardCommandCenter snapshot={snapshot} />;
}
