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
  Wallet,
} from "lucide-react";

import { IdentityCard } from "@/components/employee-portal/identity-card";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";

function egp(n: number) {
  return new Intl.NumberFormat("en-EG", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n);
}

function monthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

export function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-5 py-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">{title}</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
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
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center gap-2 bg-slate-900 px-4 py-2">
        <Icon className="h-3.5 w-3.5 text-slate-400" />
      </div>
      <div className="px-4 py-4">
        <p className="break-words text-2xl font-bold text-slate-900">{headline}</p>
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
      <div className="w-[3px] shrink-0 bg-slate-200 transition-colors group-hover:bg-orange-500" />
      <div className="flex flex-1 items-center gap-4 px-4 py-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white">
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500 transition-colors group-hover:text-orange-600">
            {label}
          </p>
          <p className="mt-0.5 text-sm font-semibold leading-snug text-slate-800">{description}</p>
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

function PmGpmCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount } = snapshot;
  const lineName = shell.employee.line;
  const totalPending = pendingVacationCount + pendingExcuseCount;

  return (
    <div className="mx-auto w-full space-y-4" dir="auto">
      <IdentityCard data={shell} />

      {lineName && (
        <div className="flex items-center gap-3 border border-orange-200 bg-orange-50 px-5 py-3.5">
          <Layers className="h-4 w-4 shrink-0 text-orange-600" />
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-orange-500">Product Line</p>
            <p className="truncate font-bold text-slate-900">{lineName}</p>
          </div>
        </div>
      )}

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Sales Intelligence</h2>
        </div>
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

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Marketing Tools</h2>
        </div>
        <div className="divide-y divide-slate-100 bg-white">
          <MarketingToolRow href="/employee-portals/plans" icon={CalendarDays} label="My Plans" sub="Weekly and monthly field activity planning" />
          <MarketingToolRow href="/employee-portals/marketing-requests" icon={Send} label="Marketing Requests" sub="Submit and track promotional investments" />
          <MarketingToolRow href="/employee-portals/roi" icon={Target} label="ROI Intelligence" sub="Measure return on marketing spend" />
          <MarketingToolRow href="/employee-portals/coaching-analytics" icon={ChartColumnBig} label="Coaching Analytics" sub="Team coaching performance overview" />
        </div>
      </div>

      {totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      ) : (
        <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-5 py-4">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-800">All clear - nothing needs your attention right now.</span>
        </div>
      )}
    </div>
  );
}

function MedicalRepCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount, latestPayslip, leaveEntitlementDays, mrSalesAchievement } =
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

  const renewalUrgent = daysUntilRenewal !== null && daysUntilRenewal !== undefined && daysUntilRenewal <= 30;
  const renewalWarning =
    daysUntilRenewal !== null && daysUntilRenewal !== undefined && daysUntilRenewal > 30 && daysUntilRenewal <= 60;

  return (
    <div className="mx-auto w-full space-y-4" dir="auto">
      <IdentityCard data={shell} />

      <div className="relative overflow-hidden border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_58%,#241002_100%)] shadow-[0_16px_48px_rgba(0,0,0,0.24)]">
        <div className="absolute inset-0 opacity-[0.07] [background-image:linear-gradient(rgba(255,255,255,.3)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.3)_1px,transparent_1px)] [background-size:40px_40px]" />

        <div className="relative grid gap-6 px-5 py-6 sm:px-7 lg:grid-cols-[minmax(0,1.2fr)_minmax(250px,0.8fr)] lg:px-8">
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
                  <p className={`text-6xl font-black leading-none tabular-nums sm:text-7xl ${achNumColor}`}>
                    {pct}<span className="text-4xl sm:text-5xl">%</span>
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

      <SectionShell title="My Status">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Link href="/employee-portals/payslips" className="group overflow-hidden border border-slate-200 transition hover:border-orange-300">
            <div className="flex items-center gap-2 bg-slate-900 px-4 py-2 transition-colors group-hover:bg-orange-600">
              <Wallet className="h-3.5 w-3.5 text-slate-400 transition-colors group-hover:text-white" />
            </div>
            <div className="bg-white px-4 py-4 transition-colors group-hover:bg-orange-50">
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
            <div className="bg-white px-4 py-4 transition-colors group-hover:bg-orange-50">
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
              <div className={`px-4 py-4 ${renewalUrgent ? "bg-rose-50" : renewalWarning ? "bg-amber-50" : "bg-white"}`}>
                <p className={`text-2xl font-bold ${renewalUrgent ? "text-rose-700" : renewalWarning ? "text-amber-700" : "text-slate-900"}`}>
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
              <div className="bg-amber-50 px-4 py-4">
                <p className="text-2xl font-bold text-amber-700">On Probation</p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-amber-400">
                  {serviceDuration || "in progress"}
                </p>
              </div>
            </div>
          ) : (
            <StatTile icon={ClipboardCheck} headline={serviceDuration || "Active"} sub="employment duration" />
          )}
        </div>
      </SectionShell>

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">My Tools</h2>
        </div>
        <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2">
          <PremiumNavTile href="/employee-portals/coaching" icon={ClipboardCheck} label="My Coaching" description="View and track coaching reports" />
          <PremiumNavTile href="/employee-portals/expenses" icon={ReceiptText} label="My Expenses" description="Outstation expense tracker" />
          <PremiumNavTile href="/employee-portals/incentive" icon={Trophy} label="My Incentive" description="Track commission and bonus" />
          <PremiumNavTile href="/employee-portals/sales" icon={TrendingUp} label="Sales Dashboard" description="Achievement vs monthly target" />
          <PremiumNavTile href="/employee-portals/vacation-request" icon={CalendarDays} label="Vacation Request" description="Submit and track leave requests" />
          <PremiumNavTile href="/employee-portals/payslips" icon={Wallet} label="My Payslips" description="View and download salary slips" />
        </div>
      </div>

      {totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      ) : (
        <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-5 py-4">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-800">All clear - nothing needs your attention right now.</span>
        </div>
      )}
    </div>
  );
}

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

      {ach && pct !== null && (
        <div className="overflow-hidden border border-slate-200">
          <div className="bg-slate-900 px-5 py-3">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
              This Month | Achievement
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
            headline={leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "-"}
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
          <span className="text-sm font-medium text-emerald-800">All clear - nothing needs your attention right now.</span>
        </div>
      )}
    </div>
  );
}

export function PortalCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const isPmGpm = snapshot.role === "Product Manager" || snapshot.role === "Group Product Manager";
  const isMr = snapshot.role.toLowerCase() === "medical rep";
  if (isPmGpm) return <PmGpmCommandCenter snapshot={snapshot} />;
  if (isMr) return <MedicalRepCommandCenter snapshot={snapshot} />;
  return <StandardCommandCenter snapshot={snapshot} />;
}
