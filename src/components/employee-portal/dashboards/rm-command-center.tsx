import {
  AlertTriangle,
  CalendarDays,
  CalendarX2,
  CheckCircle2,
  ClipboardCheck,
  Flag,
  Map as MapIcon,
  Network,
  ReceiptText,
  Target,
  TrendingUp,
  Trophy,
  Users,
  Wallet,
} from "lucide-react";

import { IdentityCard } from "@/components/employee-portal/identity-card";
import {
  ActionStrip,
  DashboardsGrid,
  GlanceStrip,
  KeycardGrid,
  PendingActions,
  PortalContextBar,
  ProfileIntelBar,
  RankingPanel,
  SectionHead,
  egpCompact,
  type ActionStripItem,
  type DashboardLink,
  type Keycard,
} from "@/components/employee-portal/portal-command-center";
import { Suspense } from "react";

import { CrmFirstVisitBoard } from "@/components/employee-portal/dashboards/crm-first-visit-board";
import { EarlyBirdsSyncButton } from "@/components/crm/early-birds-sync-button";
import { EarlyBirdOfTheFortnightCard } from "@/components/early-birds/early-bird-of-the-fortnight-card";
import { DoubleVisitFocusSection } from "@/components/employee-portal/dashboards/double-visit-focus-section";
import { LineSalesPacingSection, MmSectionSkeleton } from "@/components/employee-portal/dashboards/mm-intel-sections";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import type { AccessContext } from "@/lib/auth/permissions";

/* ── Region performance keycards ───────────────────────────────────── */

function RegionKeycards({ rmRegional }: { rmRegional: PortalHomeSnapshot["rmRegional"] }) {
  const pct = rmRegional ? Math.max(0, Math.round(rmRegional.achievementPercent)) : null;
  const sales = rmRegional?.totalSales ?? 0;
  const target = rmRegional?.totalTarget ?? 0;
  const threshold90 = target * 0.9;
  const eligible = target > 0 && sales >= threshold90;
  const gapTo90 = Math.max(0, threshold90 - sales);
  const pctNum = pct ?? 0;

  const achAccent =
    pctNum >= 100 ? "bg-emerald-500" : pctNum >= 90 ? "bg-amber-400" : pctNum >= 70 ? "bg-orange-500" : "bg-rose-500";
  const achValueClass =
    pctNum >= 100 ? "text-emerald-600" : pctNum >= 90 ? "text-amber-600" : pctNum >= 70 ? "text-orange-600" : "text-rose-600";

  const cards: Keycard[] = [
    {
      icon: TrendingUp,
      label: "Achievement",
      value: pct !== null ? `${pct}%` : "—",
      sub: "vs region target",
      accent: achAccent,
      valueClass: achValueClass,
    },
    {
      icon: Wallet,
      label: "Region Sales",
      value: egpCompact(sales),
      sub: "achieved this period",
      accent: "bg-slate-900",
      valueClass: "text-slate-900",
    },
    {
      icon: Target,
      label: "Target",
      value: egpCompact(target),
      sub: "region target",
      accent: "bg-slate-900",
      valueClass: "text-slate-900",
    },
    {
      icon: eligible ? CheckCircle2 : Flag,
      label: "Gap to 90%",
      value: target <= 0 ? "—" : eligible ? "Eligible" : egpCompact(gapTo90),
      sub: eligible ? "incentive threshold cleared" : "sales to reach incentive",
      accent: eligible ? "bg-emerald-500" : "bg-orange-500",
      valueClass: eligible ? "text-emerald-600" : "text-orange-600",
    },
  ];

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <SectionHead
        title="Region Performance"
        right={
          rmRegional ? (
            <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400">
              {rmRegional.dsmCount} {rmRegional.dsmCount === 1 ? "district" : "districts"}
            </span>
          ) : undefined
        }
      />
      {rmRegional ? (
        <KeycardGrid cards={cards} />
      ) : (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">
          No region sales data synced for the current period yet.
        </p>
      )}
    </div>
  );
}

/* ── Districts needing attention ───────────────────────────────────── */

/**
 * Districts below the 90% incentive threshold, worst first. Deliberately keyed to the same 90%
 * line the Gap-to-90% keycard uses, so "needs attention" and "gap to incentive" always agree.
 */
function DistrictsAttention({ rmRegional }: { rmRegional: PortalHomeSnapshot["rmRegional"] }) {
  if (!rmRegional || rmRegional.dsms.length === 0) return null;

  const behind = rmRegional.dsms
    .filter((d) => d.totalTarget > 0 && d.achievementPercent < 90)
    .slice()
    .sort((a, b) => a.achievementPercent - b.achievementPercent);

  // A district with no target loaded is not "behind" — it is unmeasurable. Surfaced separately so a
  // data gap never reads as a performance problem, nor gets swallowed by a green all-clear.
  const unmeasured = rmRegional.dsms.filter((d) => d.totalTarget <= 0);

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <SectionHead
        title="Districts Needing Attention"
        right={<span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400">below 90%</span>}
      />
      {behind.length === 0 && unmeasured.length === 0 ? (
        <div className="flex items-center gap-2 bg-white px-4 py-5 sm:px-5">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <p className="text-sm font-medium text-emerald-700">Every district in your region is at or above 90%.</p>
        </div>
      ) : (
        <div className="space-y-px bg-slate-200">
          {behind.map((d) => {
            const pct = Math.max(0, Math.round(d.achievementPercent));
            const gap = Math.max(0, d.totalTarget * 0.9 - d.totalSales);
            const tone = pct >= 70 ? "text-orange-600" : "text-rose-600";
            return (
              <div key={d.hrId || d.name} className="flex items-center justify-between gap-3 bg-white px-4 py-3 sm:px-5">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800">{d.name}</p>
                  <p className="mt-0.5 text-[11px] font-medium text-slate-500">
                    {egpCompact(d.totalSales)} of {egpCompact(d.totalTarget)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={`text-lg font-black tabular-nums ${tone}`}>{pct}%</p>
                  <p className="mt-0.5 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {egpCompact(gap)} to 90%
                  </p>
                </div>
              </div>
            );
          })}
          {unmeasured.length > 0 && (
            <div className="flex items-start gap-2 bg-white px-4 py-3 sm:px-5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p className="text-sm text-slate-500">
                {unmeasured.length} {unmeasured.length === 1 ? "district has" : "districts have"} no target loaded for this
                period, so {unmeasured.length === 1 ? "its" : "their"} achievement cannot be measured:{" "}
                <span className="font-semibold text-slate-700">{unmeasured.map((d) => d.name).join(", ")}</span>.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Dashboards + quick actions ────────────────────────────────────── */

// Every destination here is reachable by a Regional Manager (see resolveEmployeePortalNavVisibility
// + each page's own role gate). Med Reps Performance is deliberately NOT listed: that page is
// NSM-only and bounces an RM straight back to /employee-portals.
const DASHBOARDS: readonly DashboardLink[] = [
  { href: "/employee-portals/source-of-sales", icon: TrendingUp, label: "Source of Sales" },
  { href: "/employee-portals/territory-drilldown", icon: MapIcon, label: "Territory" },
  { href: "/employee-portals/approvals-hub", icon: ClipboardCheck, label: "Approvals Hub" },
  { href: "/employee-portals/plans", icon: CalendarDays, label: "Region Plans" },
  { href: "/employee-portals/expense-dashboard", icon: ReceiptText, label: "Expenses" },
];

const ACTIONS: readonly ActionStripItem[] = [
  { href: "/employee-portals/approvals-hub", icon: ClipboardCheck, label: "Approve" },
  { href: "/employee-portals/vacation-request", icon: CalendarX2, label: "Leave" },
  { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Expense" },
  { href: "/employee-portals/double-visit-report", icon: Users, label: "Double Visits" },
];

/* ── RM region command center ──────────────────────────────────────── */

export function RmCommandCenter({ snapshot, access }: { snapshot: PortalHomeSnapshot; access?: AccessContext }) {
  const {
    shell,
    pendingVacationCount,
    pendingExcuseCount,
    leaveEntitlementDays,
    plansAwaitingManagerApproval,
    rmRegional,
    dvFocus,
    earlyBirdWinner,
  } = snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount + plansCount;

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />
      <PortalContextBar role="Regional Manager" context={shell.employee.territory || "—"} />

      {totalPending > 0 && (
        <PendingActions
          pendingVacationCount={pendingVacationCount}
          pendingExcuseCount={pendingExcuseCount}
          plansAwaitingApproval={plansCount}
        />
      )}

      <RegionKeycards rmRegional={rmRegional} />

      <DashboardsGrid items={DASHBOARDS} />

      <div className="flex items-center gap-1.5 border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Incentives shown below are not yet confirmed by HR.
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <RankingPanel title="My Districts" subtitle="by achievement %" icon={Network} rows={rmRegional?.dsms ?? []} />
        <RankingPanel
          title="Top Medical Reps"
          subtitle="by achievement %"
          icon={Trophy}
          rows={rmRegional?.topReps ?? []}
          showManager
        />
      </div>

      <DistrictsAttention rmRegional={rmRegional} />

      <EarlyBirdOfTheFortnightCard winner={earlyBirdWinner} />

      <CrmFirstVisitBoard
        action={<EarlyBirdsSyncButton />}
        crm={rmRegional?.crm ?? null}
        allClearMessage="Everyone in your region has submitted their first visit."
      />

      {access ? (
        <Suspense fallback={<MmSectionSkeleton title="Line Sales Pacing" />}>
          <LineSalesPacingSection access={access} />
        </Suspense>
      ) : null}

      <DoubleVisitFocusSection focus={dvFocus} />

      <ActionStrip items={ACTIONS} />

      {/* Personal strip — deliberately last: the RM's own approvals/leave still matter, but the
          region board above is what they open this page for.
          NO PAYSLIP TILE: payslip data (amount OR month) must never render on any overview/landing
          surface for any role — owner rule. It lives only on /employee-portals/payslips. */}
      <GlanceStrip
        items={[
          {
            icon: ClipboardCheck,
            value: String(plansCount),
            label: plansCount === 1 ? "plan awaiting approval" : "plans awaiting approval",
            href: "/employee-portals/approvals-hub",
            urgent: plansCount > 0,
          },
          {
            icon: CalendarX2,
            value: String(pendingVacationCount + pendingExcuseCount),
            label: pendingVacationCount + pendingExcuseCount === 1 ? "my pending request" : "my pending requests",
            href: "/employee-portals/approvals-hub",
          },
          {
            icon: CalendarDays,
            value: leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "—",
            label: "leave balance",
            href: "/employee-portals/vacation-request",
          },
        ]}
      />
    </div>
  );
}
