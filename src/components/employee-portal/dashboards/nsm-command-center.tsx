import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChartColumnBig,
  CheckCircle2,
  CircleDollarSign,
  Flag,
  ListChecks,
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

import {
  ActionStrip,
  DashboardsGrid,
  DepartedFromBoardNote,
  KeycardGrid,
  PendingActions,
  PortalIdentityBand,
  RankingPanel,
  SectionHead,
  SectionMeta,
  egpCompact,
  type ActionStripItem,
  type DashboardLink,
} from "@/components/employee-portal/portal-command-center";
import { Suspense } from "react";

import { CrmFirstVisitBoard } from "@/components/employee-portal/dashboards/crm-first-visit-board";
import { ManagerCvFoldersRow } from "@/components/employee-portal/dashboards/manager-cv-folders-row";
import { EarlyBirdOfTheFortnightCard } from "@/components/early-birds/early-bird-of-the-fortnight-card";
import { StreamedDoubleVisitFocus } from "@/components/employee-portal/dashboards/double-visit-focus-stream";
import { LineSalesPacingSection, MmSectionSkeleton } from "@/components/employee-portal/dashboards/mm-intel-sections";
import { AwaitCard, AwaitRoleExtras, roleExtrasOf } from "@/components/employee-portal/dashboards/role-extras-stream";
import { MyMapSnapshotCard } from "@/components/employee-portal/dashboards/my-map-snapshot-card";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import {
  NO_PUBLISHED_CLOSING_NOTE,
  NO_PUBLISHED_CLOSING_SUB,
  achievementTone,
  closingSalesSub,
  hasPublishedWindow,
  publishedFigure,
} from "@/lib/employee-portal/published-window";
import type { AccessContext } from "@/lib/auth/permissions";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/* ── National performance keycards ─────────────────────────────────── */

function NationalKeycards({ nsmNational }: { nsmNational: PortalHomeSnapshot["nsmNational"] }) {
  const pct = nsmNational ? Math.max(0, Math.round(nsmNational.achievementPercent)) : null;
  const sales = nsmNational?.totalSales ?? 0;
  const target = nsmNational?.totalTarget ?? 0;
  const threshold90 = target * 0.9;
  const eligible = target > 0 && sales >= threshold90;
  const gapTo90 = Math.max(0, threshold90 - sales);
  const pctNum = pct ?? 0;

  // 🔒 A null windowLabel means NOTHING is published for this line, so every money tile is WITHHELD
  // rather than printed as zero (owner, 2026-08-13). See lib/employee-portal/published-window.ts.
  const windowLabel = nsmNational?.windowLabel ?? null;
  const published = hasPublishedWindow(windowLabel);
  const figureInk = published ? "text-slate-900" : "text-slate-500";
  const { accent: achAccent, valueClass: achValueClass } = achievementTone(windowLabel, pctNum);

  const cards = [
    {
      icon: TrendingUp,
      label: "Achievement",
      value: pct !== null ? publishedFigure(windowLabel, () => `${pct}%`) : "—",
      sub: "vs national target",
      accent: achAccent,
      valueClass: achValueClass,
    },
    {
      icon: Wallet,
      label: "Line Sales",
      value: publishedFigure(windowLabel, () => egpCompact(sales)),
      // Names the closing month rather than "this period" — see SectionMeta.
      sub: closingSalesSub(windowLabel),
      accent: "bg-slate-900",
      valueClass: figureInk,
    },
    { icon: Target, label: "Target", value: publishedFigure(windowLabel, () => egpCompact(target)), sub: "national target", accent: "bg-slate-900", valueClass: figureInk },
    {
      icon: eligible ? CheckCircle2 : Flag,
      label: "Gap to 90%",
      value: publishedFigure(windowLabel, () => (target <= 0 ? "—" : eligible ? "Eligible" : egpCompact(gapTo90))),
      sub: published ? (eligible ? "incentive threshold cleared" : "sales to reach incentive") : NO_PUBLISHED_CLOSING_SUB,
      accent: published && eligible ? "bg-emerald-500" : published ? "bg-orange-500" : "bg-slate-900",
      valueClass: published ? (eligible ? "text-emerald-600" : "text-orange-600") : "text-slate-500",
    },
  ];

  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <SectionHead
        title="National Performance"
        right={
          <SectionMeta
            items={[
              nsmNational?.windowLabel,
              nsmNational ? `${nsmNational.dsmCount} ${nsmNational.dsmCount === 1 ? "district" : "districts"}` : null,
            ]}
          />
        }
      />
      {nsmNational ? (
        <>
          <KeycardGrid cards={cards} />
          {!published && (
            <p className="bg-white px-5 pb-4 text-phx-sm text-slate-500">{NO_PUBLISHED_CLOSING_NOTE}</p>
          )}
        </>
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
  // The Team Coaching Skills Survey (owner, 2026-10-31) replaced the old coaching reports, so it takes
  // their tile. The old reports stay readable on each rep's Employee 360.
  { href: "/employee-portals/coaching-skills-survey", icon: ListChecks, label: "Skills Survey" },
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
  const { shell, pendingVacationCount, pendingExcuseCount, earlyBirdStars } = snapshot;
  const totalPending = pendingVacationCount + pendingExcuseCount;
  // The national figures and the boards are the slow reads; everything else paints without them,
  // and each section that needs them fills under its own Suspense.
  const extras = roleExtrasOf(snapshot);

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} myInterviews={snapshot.myInterviews} />

      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      )}

      <Suspense fallback={null}>
        <AwaitCard value={snapshot.cvFolders}>{(summary) => <ManagerCvFoldersRow summary={summary} />}</AwaitCard>
      </Suspense>

      <Suspense fallback={<MmSectionSkeleton title="National Performance" />}>
        <AwaitRoleExtras extras={extras}>{({ nsmNational }) => <NationalKeycards nsmNational={nsmNational} />}</AwaitRoleExtras>
      </Suspense>

      <DashboardsGrid items={DASHBOARDS} />

      {access ? (
        <Suspense fallback={<MmSectionSkeleton title="My map" />}>
          <MyMapSnapshotCard access={access} />
        </Suspense>
      ) : null}

      <div className="flex items-center gap-1.5 border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-phx-xs font-semibold text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Incentives shown below are not yet confirmed by HR.
      </div>

      <Suspense fallback={<MmSectionSkeleton title="Top Medical Reps" />}>
        <AwaitRoleExtras extras={extras}>
          {({ nsmNational, nsmBoard }) => (
            <>
              <div className="grid gap-3 lg:grid-cols-2">
                <RankingPanel
                  title="Top Medical Reps"
                  subtitle="by achievement %"
                  icon={Trophy}
                  rows={nsmBoard?.topReps ?? []}
                  showManager
                  windowLabel={nsmNational?.windowLabel ?? null}
                />
                <RankingPanel
                  title="Districts (DSMs)"
                  subtitle="by achievement %"
                  icon={Network}
                  rows={nsmBoard?.dsms ?? []}
                  windowLabel={nsmNational?.windowLabel ?? null}
                />
              </div>

              {/* One note for BOTH boards: departedCount spans the reps and the DSMs together, so
                  repeating it under each panel would state the same people twice. */}
              {nsmBoard && nsmBoard.departedCount > 0 ? (
                <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
                  <DepartedFromBoardNote
                    count={nsmBoard.departedCount}
                    sales={nsmBoard.departedSales}
                    totalLabel="National Performance"
                  />
                </div>
              ) : null}
            </>
          )}
        </AwaitRoleExtras>
      </Suspense>

      <Suspense fallback={null}>
        <AwaitCard value={earlyBirdStars}>{(stars) => <EarlyBirdOfTheFortnightCard stars={stars} />}</AwaitCard>
      </Suspense>

      <Suspense fallback={<MmSectionSkeleton title="CRM First Visit" />}>
        <AwaitRoleExtras extras={extras}>
          {({ nsmBoard }) => <CrmFirstVisitBoard crm={nsmBoard?.crm ?? null} />}
        </AwaitRoleExtras>
      </Suspense>

      <ActionStrip items={ACTIONS} />

      {access ? (
        <Suspense fallback={<MmSectionSkeleton title="Line Sales Pacing" />}>
          <LineSalesPacingSection access={access} />
        </Suspense>
      ) : null}

      <StreamedDoubleVisitFocus snapshot={snapshot} />
    </div>
  );
}
