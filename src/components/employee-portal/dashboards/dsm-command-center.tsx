import {
  CalendarDays,
  ClipboardCheck,
  ListChecks,
  ReceiptText,
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
  type Keycard,
} from "@/components/employee-portal/portal-command-center";
import { Suspense } from "react";

import { CrmFirstVisitBoard } from "@/components/employee-portal/dashboards/crm-first-visit-board";
import { ManagerCvFoldersRow } from "@/components/employee-portal/dashboards/manager-cv-folders-row";
import { EarlyBirdsSyncAction } from "@/components/crm/early-birds-sync-action";
import { EarlyBirdOfTheFortnightCard } from "@/components/early-birds/early-bird-of-the-fortnight-card";
import { StreamedDoubleVisitFocus } from "@/components/employee-portal/dashboards/double-visit-focus-stream";
import { LineSalesPacingSection, MmSectionSkeleton } from "@/components/employee-portal/dashboards/mm-intel-sections";
import { AwaitRoleExtras, roleExtrasOf } from "@/components/employee-portal/dashboards/role-extras-stream";
import { MyMapSnapshotCard } from "@/components/employee-portal/dashboards/my-map-snapshot-card";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import {
  NO_PUBLISHED_CLOSING_NOTE,
  achievementTone,
  closingSalesSub,
  hasPublishedWindow,
  publishedFigure,
} from "@/lib/employee-portal/published-window";
import type { AccessContext } from "@/lib/auth/permissions";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

const DASHBOARDS: readonly DashboardLink[] = [
  { href: "/employee-portals/team-performance", icon: Users, label: "Team Performance" },
  // The Team Coaching Skills Survey (owner, 2026-10-31) took the Coaching Analytics tile: no District
  // Manager ever wrote an old-form report, so that dashboard was always empty for them.
  { href: "/employee-portals/coaching-skills-survey", icon: ListChecks, label: "Skills Survey" },
  { href: "/employee-portals/approvals-hub", icon: ClipboardCheck, label: "Approvals Hub" },
  { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Vacation Request" },
  { href: "/employee-portals/med-reps-performance", icon: Target, label: "Med Rep Performance" },
  { href: "/employee-portals/expense-dashboard", icon: ReceiptText, label: "My Expenses" },
];

const ACTIONS: readonly ActionStripItem[] = [
  { href: "/employee-portals/team-performance", icon: Users, label: "Review Team Plan" },
  { href: "/employee-portals/coaching-skills-survey", icon: ListChecks, label: "Rate My Team" },
  { href: "/employee-portals/approvals-hub", icon: ClipboardCheck, label: "Approve Requests" },
  { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
];

/**
 * The district's four money tiles. Drawn from the role extras, so on the landing page it fills under
 * its own Suspense once the team read lands (2026-10-23, performance roadmap phase 2).
 */
function DistrictPerformanceCard({ dsmTeam }: { dsmTeam: PortalHomeSnapshot["dsmTeam"] }) {
  const pct = dsmTeam ? Math.max(0, Math.round(dsmTeam.achievementPercent)) : null;
  const pctNum = pct ?? 0;

  // Which closing month these figures cover. Published closings only, so on 3 September the
  // newest is July's — see SectionMeta for why every one of these headers now says so.
  //
  // 🔒 A null label means NOTHING is published in this district's scope, so the three money tiles
  // are WITHHELD rather than printed as zero (owner, 2026-08-13 — "a blank keycard is the correct
  // state until a period is published, never a live-but-unclosed number"). Team Size still counts:
  // it does not come from a closing. See lib/employee-portal/published-window.ts.
  const windowLabel = dsmTeam?.windowLabel ?? null;
  const published = hasPublishedWindow(windowLabel);
  const figureInk = published ? "text-slate-900" : "text-slate-500";
  const salesSub = closingSalesSub(windowLabel);
  const { accent: achAccent, valueClass: achValueClass } = achievementTone(windowLabel, pctNum);

  const cards: Keycard[] = [
    { icon: Users, label: "Team Size", value: dsmTeam ? String(dsmTeam.memberCount) : "—", sub: "medical reps", accent: "bg-slate-900", valueClass: "text-slate-900" },
    { icon: Wallet, label: "Sales", value: dsmTeam ? publishedFigure(windowLabel, () => egpCompact(dsmTeam.totalSales)) : "—", sub: salesSub, accent: "bg-slate-900", valueClass: figureInk },
    { icon: Target, label: "Target", value: dsmTeam ? publishedFigure(windowLabel, () => egpCompact(dsmTeam.totalTarget)) : "—", sub: "district target", accent: "bg-slate-900", valueClass: figureInk },
    { icon: TrendingUp, label: "Achievement", value: pct !== null ? publishedFigure(windowLabel, () => `${pct}%`) : "—", sub: "vs district target", accent: achAccent, valueClass: achValueClass },
  ];

  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <SectionHead
        title="District Performance"
        right={
          <SectionMeta
            items={[
              windowLabel,
              dsmTeam ? `${dsmTeam.memberCount} ${dsmTeam.memberCount === 1 ? "rep" : "reps"}` : null,
            ]}
          />
        }
      />
      {dsmTeam ? (
        <>
          <KeycardGrid cards={cards} />
          {!published && (
            <p className="bg-white px-5 pb-4 text-phx-2xs text-slate-500">{NO_PUBLISHED_CLOSING_NOTE}</p>
          )}
        </>
      ) : (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">No team sales data synced for the current period yet.</p>
      )}
    </div>
  );
}

export function DsmCommandCenter({ snapshot, access }: { snapshot: PortalHomeSnapshot; access?: AccessContext }) {
  const { shell, pendingVacationCount, pendingExcuseCount, earlyBirdStars } = snapshot;
  const totalPending = pendingVacationCount + pendingExcuseCount;
  // The team read is the slow one; the identity band, pending actions, CV folders and dashboards
  // paint without it, and each section below that needs it fills under its own Suspense.
  const extras = roleExtrasOf(snapshot);

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} myInterviews={snapshot.myInterviews} />

      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      )}

      <ManagerCvFoldersRow summary={snapshot.cvFolders} />

      <Suspense fallback={<MmSectionSkeleton title="District Performance" />}>
        <AwaitRoleExtras extras={extras}>{({ dsmTeam }) => <DistrictPerformanceCard dsmTeam={dsmTeam} />}</AwaitRoleExtras>
      </Suspense>

      <DashboardsGrid items={DASHBOARDS} />

      {access ? (
        <Suspense fallback={<MmSectionSkeleton title="My map" />}>
          <MyMapSnapshotCard access={access} />
        </Suspense>
      ) : null}

      <Suspense fallback={<MmSectionSkeleton title="My Reps" />}>
        <AwaitRoleExtras extras={extras}>
          {({ dsmTeam }) => (
            <RankingPanel
              title="My Reps"
              subtitle="by achievement %"
              icon={Trophy}
              rows={dsmTeam?.members ?? []}
              windowLabel={dsmTeam?.windowLabel ?? null}
              footer={
                <DepartedFromBoardNote
                  count={dsmTeam?.departedCount ?? 0}
                  sales={dsmTeam?.departedSales ?? 0}
                  totalLabel="District Performance"
                />
              }
            />
          )}
        </AwaitRoleExtras>
      </Suspense>

      <EarlyBirdOfTheFortnightCard stars={earlyBirdStars} />

      <Suspense fallback={<MmSectionSkeleton title="CRM First Visit" />}>
        <AwaitRoleExtras extras={extras}>
          {({ dsmTeam }) => (
            <CrmFirstVisitBoard
              action={<EarlyBirdsSyncAction />}
              crm={dsmTeam?.crm ?? null}
              allClearMessage="Every rep on your team has submitted their first visit."
              rankHint="all submitters, ranked"
              showAccount
            />
          )}
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
