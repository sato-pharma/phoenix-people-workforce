import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChartColumnBig,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  Flag,
  Network,
  PieChart,
  ReceiptText,
  Send,
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
  KeycardGrid,
  PendingActions,
  ProfileIntelBar,
  RankingPanel,
  SectionHead,
  egpCompact,
  type ActionStripItem,
  type DashboardLink,
} from "@/components/employee-portal/portal-command-center";
import { Suspense } from "react";

import { CrmFirstVisitBoard } from "@/components/employee-portal/dashboards/crm-first-visit-board";
import { EarlyBirdsSyncButton } from "@/components/crm/early-birds-sync-button";
import { EarlyBirdOfTheFortnightCard } from "@/components/early-birds/early-bird-of-the-fortnight-card";
import { DoubleVisitFocusSection } from "@/components/employee-portal/dashboards/double-visit-focus-section";
import { LineSalesPacingSection, MmSectionSkeleton } from "@/components/employee-portal/dashboards/mm-intel-sections";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import type { AccessContext } from "@/lib/auth/permissions";

/* ── National performance keycards ─────────────────────────────────── */

function NationalKeycards({ nsmNational }: { nsmNational: PortalHomeSnapshot["nsmNational"] }) {
  const pct = nsmNational ? Math.max(0, Math.round(nsmNational.achievementPercent)) : null;
  const sales = nsmNational?.totalSales ?? 0;
  const target = nsmNational?.totalTarget ?? 0;
  const threshold90 = target * 0.9;
  const eligible = target > 0 && sales >= threshold90;
  const gapTo90 = Math.max(0, threshold90 - sales);
  const pctNum = pct ?? 0;

  const achAccent =
    pctNum >= 100 ? "bg-emerald-500" : pctNum >= 90 ? "bg-amber-400" : pctNum >= 70 ? "bg-orange-500" : "bg-rose-500";
  const achValueClass =
    pctNum >= 100 ? "text-emerald-600" : pctNum >= 90 ? "text-amber-600" : pctNum >= 70 ? "text-orange-600" : "text-rose-600";

  const cards = [
    {
      icon: TrendingUp,
      label: "Achievement",
      value: pct !== null ? `${pct}%` : "—",
      sub: "vs national target",
      accent: achAccent,
      valueClass: achValueClass,
    },
    { icon: Wallet, label: "Line Sales", value: egpCompact(sales), sub: "achieved this period", accent: "bg-slate-900", valueClass: "text-slate-900" },
    { icon: Target, label: "Target", value: egpCompact(target), sub: "national target", accent: "bg-slate-900", valueClass: "text-slate-900" },
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
        title="National Performance"
        right={
          nsmNational ? (
            <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400">
              {nsmNational.dsmCount} {nsmNational.dsmCount === 1 ? "district" : "districts"}
            </span>
          ) : undefined
        }
      />
      {nsmNational ? (
        <KeycardGrid cards={cards} />
      ) : (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">No line sales data synced for the current period yet.</p>
      )}
    </div>
  );
}

/* ── Dashboards grid ───────────────────────────────────────────────── */

const DASHBOARDS: readonly DashboardLink[] = [
  { href: "/employee-portals/source-of-sales", icon: ChartColumnBig, label: "Source of Sales" },
  { href: "/employee-portals/weekly-sales", icon: CalendarRange, label: "Weekly Sales" },
  { href: "/employee-portals/roi", icon: PieChart, label: "ROI" },
  { href: "/employee-portals/expense-dashboard", icon: CircleDollarSign, label: "Expenses" },
  { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Coaching" },
  { href: "/employee-portals/med-reps-performance", icon: Users, label: "Med Reps" },
  { href: "/employee-portals/dsms-performance", icon: Network, label: "DSMs" },
  { href: "/employee-portals/organogram", icon: Building2, label: "Organogram" },
];

/* ── Quick-submit action strip ─────────────────────────────────────── */

const ACTIONS: readonly ActionStripItem[] = [
  { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Leave" },
  { href: "/employee-portals/excuses", icon: CalendarClock, label: "Excuse" },
  { href: "/employee-portals/marketing-requests", icon: Send, label: "Marketing" },
  { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Expense" },
];

/* ── NSM command center ────────────────────────────────────────────── */

export function NsmCommandCenter({ snapshot, access }: { snapshot: PortalHomeSnapshot; access?: AccessContext }) {
  const { shell, pendingVacationCount, pendingExcuseCount, nsmNational, nsmBoard, dvFocus, earlyBirdWinner } = snapshot;
  const totalPending = pendingVacationCount + pendingExcuseCount;

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />

      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      )}

      <NationalKeycards nsmNational={nsmNational} />

      <DashboardsGrid items={DASHBOARDS} />

      <div className="flex items-center gap-1.5 border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Incentives shown below are not yet confirmed by HR.
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <RankingPanel
          title="Top Medical Reps"
          subtitle="by achievement %"
          icon={Trophy}
          rows={nsmBoard?.topReps ?? []}
          showManager
        />
        <RankingPanel title="Districts (DSMs)" subtitle="by achievement %" icon={Network} rows={nsmBoard?.dsms ?? []} />
      </div>

      <EarlyBirdOfTheFortnightCard winner={earlyBirdWinner} />

      <CrmFirstVisitBoard action={<EarlyBirdsSyncButton />} crm={nsmBoard?.crm ?? null} />

      <ActionStrip items={ACTIONS} />

      {access ? (
        <Suspense fallback={<MmSectionSkeleton title="Line Sales Pacing" />}>
          <LineSalesPacingSection access={access} />
        </Suspense>
      ) : null}

      <DoubleVisitFocusSection focus={dvFocus} />
    </div>
  );
}
