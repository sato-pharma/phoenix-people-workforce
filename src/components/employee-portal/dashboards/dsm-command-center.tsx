import {
  CalendarDays,
  ChartColumnBig,
  ClipboardCheck,
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
  KeycardGrid,
  PendingActions,
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
import { DoubleVisitFocusSection } from "@/components/employee-portal/dashboards/double-visit-focus-section";
import { LineSalesPacingSection, MmSectionSkeleton } from "@/components/employee-portal/dashboards/mm-intel-sections";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import type { AccessContext } from "@/lib/auth/permissions";

const DASHBOARDS: readonly DashboardLink[] = [
  { href: "/employee-portals/team-performance", icon: Users, label: "Team Performance" },
  { href: "/employee-portals/coaching-analytics", icon: ChartColumnBig, label: "Coaching Analytics" },
  { href: "/employee-portals/approvals-hub", icon: ClipboardCheck, label: "Approvals Hub" },
  { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Vacation Request" },
  { href: "/employee-portals/med-reps-performance", icon: Target, label: "Med Rep Performance" },
  { href: "/employee-portals/expenses", icon: ReceiptText, label: "My Expenses" },
];

const ACTIONS: readonly ActionStripItem[] = [
  { href: "/employee-portals/team-performance", icon: Users, label: "Review Team Plan" },
  { href: "/employee-portals/coaching-analytics", icon: ChartColumnBig, label: "Coaching Analytics" },
  { href: "/employee-portals/approvals-hub", icon: ClipboardCheck, label: "Approve Requests" },
  { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
];

export function DsmCommandCenter({ snapshot, access }: { snapshot: PortalHomeSnapshot; access?: AccessContext }) {
  const { shell, pendingVacationCount, pendingExcuseCount, dsmTeam, dvFocus } = snapshot;
  const totalPending = pendingVacationCount + pendingExcuseCount;
  const pct = dsmTeam ? Math.max(0, Math.round(dsmTeam.achievementPercent)) : null;
  const pctNum = pct ?? 0;

  const achAccent =
    pctNum >= 100 ? "bg-emerald-500" : pctNum >= 90 ? "bg-amber-400" : pctNum >= 70 ? "bg-orange-500" : "bg-rose-500";
  const achValueClass =
    pctNum >= 100 ? "text-emerald-600" : pctNum >= 90 ? "text-amber-600" : pctNum >= 70 ? "text-orange-600" : "text-rose-600";

  const cards: Keycard[] = [
    { icon: Users, label: "Team Size", value: dsmTeam ? String(dsmTeam.memberCount) : "—", sub: "medical reps", accent: "bg-slate-900", valueClass: "text-slate-900" },
    { icon: Wallet, label: "Sales", value: dsmTeam ? egpCompact(dsmTeam.totalSales) : "—", sub: "achieved this period", accent: "bg-slate-900", valueClass: "text-slate-900" },
    { icon: Target, label: "Target", value: dsmTeam ? egpCompact(dsmTeam.totalTarget) : "—", sub: "district target", accent: "bg-slate-900", valueClass: "text-slate-900" },
    { icon: TrendingUp, label: "Achievement", value: pct !== null ? `${pct}%` : "—", sub: "vs district target", accent: achAccent, valueClass: achValueClass },
  ];

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />

      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      )}

      <div className="overflow-hidden border border-slate-200 bg-white">
        <SectionHead title="District Performance" />
        {dsmTeam ? <KeycardGrid cards={cards} /> : <p className="bg-white px-5 py-6 text-sm text-slate-500">No team sales data synced for the current period yet.</p>}
      </div>

      <DashboardsGrid items={DASHBOARDS} />

      <RankingPanel title="My Reps" subtitle="by achievement %" icon={Trophy} rows={dsmTeam?.members ?? []} />

      <CrmFirstVisitBoard
        crm={dsmTeam?.crm ?? null}
        allClearMessage="Every rep on your team has submitted their first visit."
        rankHint="all submitters, ranked"
        showAccount
      />

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
