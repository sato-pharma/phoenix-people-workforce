import {
  AlertTriangle,
  BookUser,
  CalendarDays,
  CalendarX2,
  ChartColumnBig,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  FileSpreadsheet,
  Flag,
  ListChecks,
  Map as MapIcon,
  Network,
  Radar,
  ReceiptText,
  Repeat2,
  Target,
  TrendingUp,
  Trophy,
  Users,
  Wallet,
} from "lucide-react";

import { PerformanceReconciliationNote } from "@/components/employee-portal/performance-reconciliation-note";
import {
  ActionStrip,
  DashboardsGrid,
  DepartedFromBoardNote,
  GlanceStrip,
  KeycardGrid,
  PendingActions,
  PendingCountsUnavailable,
  PortalContextBar,
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
import { cairoTodayIso } from "@/lib/crm/dates";
import { regionalTeamReportLinks, type RegionalTeamReportKey } from "@/lib/employee-portal/regional-team-reports";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/* ── Region performance keycards ───────────────────────────────────── */

function RegionKeycards({ rmRegional }: { rmRegional: PortalHomeSnapshot["rmRegional"] }) {
  const pct = rmRegional ? Math.max(0, Math.round(rmRegional.achievementPercent)) : null;
  const sales = rmRegional?.totalSales ?? 0;
  const target = rmRegional?.totalTarget ?? 0;
  const threshold90 = target * 0.9;
  const eligible = target > 0 && sales >= threshold90;
  const gapTo90 = Math.max(0, threshold90 - sales);
  const pctNum = pct ?? 0;

  // 🔒 A null windowLabel means NOTHING is published in this region's scope, so every money tile is
  // WITHHELD rather than printed as zero (owner, 2026-08-13). See lib/employee-portal/published-window.ts.
  const windowLabel = rmRegional?.windowLabel ?? null;
  const published = hasPublishedWindow(windowLabel);
  const figureInk = published ? "text-slate-900" : "text-slate-500";
  const { accent: achAccent, valueClass: achValueClass } = achievementTone(windowLabel, pctNum);

  const cards: Keycard[] = [
    {
      icon: TrendingUp,
      label: "Achievement",
      value: pct !== null ? publishedFigure(windowLabel, () => `${pct}%`) : "—",
      sub: "vs region target",
      accent: achAccent,
      valueClass: achValueClass,
    },
    {
      icon: Wallet,
      label: "Region Sales",
      value: publishedFigure(windowLabel, () => egpCompact(sales)),
      // Names the closing month rather than "this period" — see SectionMeta.
      sub: closingSalesSub(windowLabel),
      accent: "bg-slate-900",
      valueClass: figureInk,
    },
    {
      icon: Target,
      label: "Target",
      value: publishedFigure(windowLabel, () => egpCompact(target)),
      sub: "region target",
      accent: "bg-slate-900",
      valueClass: figureInk,
    },
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
        title="Region Performance"
        right={
          <SectionMeta
            items={[
              rmRegional?.windowLabel,
              rmRegional ? `${rmRegional.dsmCount} ${rmRegional.dsmCount === 1 ? "district" : "districts"}` : null,
            ]}
          />
        }
      />
      {rmRegional ? (
        <>
          <KeycardGrid cards={cards} />
          {!published && (
            <p className="bg-white px-5 pb-4 text-phx-2xs text-slate-500">{NO_PUBLISHED_CLOSING_NOTE}</p>
          )}
          {/* Region Sales counts vacant-district reps + in-region direct orders no DSM row below carries */}
          <PerformanceReconciliationNote
            className="mx-4 mb-4"
            totalLabel="Region Sales"
            unattributedSales={rmRegional.unattributedSales}
          />
        </>
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
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <SectionHead
        title="Districts Needing Attention"
        right={<span className="whitespace-nowrap text-phx-2xs font-bold uppercase tracking-widest text-slate-400">below 90%</span>}
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
                  <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
                    {egpCompact(d.totalSales)} of {egpCompact(d.totalTarget)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={`text-lg font-black tabular-nums ${tone}`}>{pct}%</p>
                  <p className="mt-0.5 whitespace-nowrap text-phx-2xs font-semibold uppercase tracking-wide text-slate-400">
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
  // The Team Coaching Skills Survey (owner, 2026-10-31) — read only, across the whole region.
  { href: "/employee-portals/coaching-skills-survey", icon: ListChecks, label: "Skills Survey" },
];

const TEAM_REPORT_ICONS: Record<RegionalTeamReportKey, DashboardLink["icon"]> = {
  "reps-plans": BookUser,
  "team-visits": Clock,
  coverage: Radar,
  "coverage-last-month": Radar,
  "frequency-last-month": Repeat2,
  "district-manager-plans": Users,
  "region-plans": CalendarDays,
  "weekly-sheet": FileSpreadsheet,
  "roi-tracking": ChartColumnBig,
};

function teamReportTiles(today: string): DashboardLink[] {
  return regionalTeamReportLinks(today).map((link) => ({ href: link.href, icon: TEAM_REPORT_ICONS[link.key], label: link.label }));
}

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
    pendingCountsAvailable,
    leaveDaysRemaining,
    plansAwaitingManagerApproval,
    plansCountAvailable,
    earlyBirdStars,
  } = snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount + plansCount;
  // Both legs must have loaded for the sum to mean anything — a failed plans lookup defaults to 0
  // and would otherwise silently understate totalPending rather than reading as unknown.
  const pendingAvailable = pendingCountsAvailable && plansCountAvailable;
  // The region's figures and boards are the slow reads; the identity band, pending actions,
  // dashboards and the personal strip paint without them, and each section that needs them fills
  // under its own Suspense.
  const extras = roleExtrasOf(snapshot);

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} myInterviews={snapshot.myInterviews} />
      <PortalContextBar role="Regional Manager" context={shell.employee.territory || "—"} />

      {!pendingAvailable ? (
        <PendingCountsUnavailable />
      ) : totalPending > 0 ? (
        <PendingActions
          pendingVacationCount={pendingVacationCount}
          pendingExcuseCount={pendingExcuseCount}
          plansAwaitingApproval={plansCount}
        />
      ) : null}

      <Suspense fallback={null}>
        <AwaitCard value={snapshot.cvFolders}>{(summary) => <ManagerCvFoldersRow summary={summary} />}</AwaitCard>
      </Suspense>

      <Suspense fallback={<MmSectionSkeleton title="Region Performance" />}>
        <AwaitRoleExtras extras={extras}>{({ rmRegional }) => <RegionKeycards rmRegional={rmRegional} />}</AwaitRoleExtras>
      </Suspense>

      <DashboardsGrid items={DASHBOARDS} />

      {/* Dr. Hany Saad's team reports (owner, 2026-11-08) — one shortcut per report, in his order. */}
      <DashboardsGrid items={teamReportTiles(cairoTodayIso())} title="My Team's Reports" />

      {access ? (
        <Suspense fallback={<MmSectionSkeleton title="My map" />}>
          <MyMapSnapshotCard access={access} />
        </Suspense>
      ) : null}

      <div className="flex items-center gap-1.5 border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-phx-xs font-semibold text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Incentives shown below are not yet confirmed by HR.
      </div>

      <Suspense fallback={<MmSectionSkeleton title="My Districts" />}>
        <AwaitRoleExtras extras={extras}>
          {({ rmRegional }) => (
            <>
              <div className="grid gap-3 lg:grid-cols-2">
                <RankingPanel
                  title="My Districts"
                  subtitle="by achievement %"
                  icon={Network}
                  rows={rmRegional?.dsms ?? []}
                  windowLabel={rmRegional?.windowLabel ?? null}
                />
                <RankingPanel
                  title="Top Medical Reps"
                  subtitle="by achievement %"
                  icon={Trophy}
                  rows={rmRegional?.topReps ?? []}
                  showManager
                  windowLabel={rmRegional?.windowLabel ?? null}
                />
              </div>

              {/* One note for BOTH boards: departedCount spans the districts and the reps together. */}
              {rmRegional && rmRegional.departedCount > 0 ? (
                <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
                  <DepartedFromBoardNote
                    count={rmRegional.departedCount}
                    sales={rmRegional.departedSales}
                    totalLabel="Region Performance"
                  />
                </div>
              ) : null}

              <DistrictsAttention rmRegional={rmRegional} />
            </>
          )}
        </AwaitRoleExtras>
      </Suspense>

      <Suspense fallback={null}>
        <AwaitCard value={earlyBirdStars}>{(stars) => <EarlyBirdOfTheFortnightCard stars={stars} />}</AwaitCard>
      </Suspense>

      <Suspense fallback={<MmSectionSkeleton title="CRM First Visit" />}>
        <AwaitRoleExtras extras={extras}>
          {({ rmRegional }) => (
            <CrmFirstVisitBoard
              crm={rmRegional?.crm ?? null}
              allClearMessage="Everyone in your region has submitted their first visit."
            />
          )}
        </AwaitRoleExtras>
      </Suspense>

      {access ? (
        <Suspense fallback={<MmSectionSkeleton title="Line Sales Pacing" />}>
          <LineSalesPacingSection access={access} />
        </Suspense>
      ) : null}

      <StreamedDoubleVisitFocus snapshot={snapshot} />

      <ActionStrip items={ACTIONS} />

      {/* Personal strip — deliberately last: the RM's own approvals/leave still matter, but the
          region board above is what they open this page for.
          NO PAYSLIP TILE: payslip data (amount OR month) must never render on any overview/landing
          surface for any role — owner rule. It lives only on /employee-portals/payslips. */}
      <GlanceStrip
        items={[
          {
            icon: ClipboardCheck,
            value: plansCountAvailable ? String(plansCount) : "—",
            label: plansCountAvailable && plansCount === 1 ? "plan awaiting approval" : "plans awaiting approval",
            href: "/employee-portals/approvals-hub",
            urgent: plansCountAvailable && plansCount > 0,
          },
          {
            icon: CalendarX2,
            value: pendingCountsAvailable ? String(pendingVacationCount + pendingExcuseCount) : "—",
            label:
              pendingCountsAvailable && pendingVacationCount + pendingExcuseCount === 1
                ? "my pending request"
                : "my pending requests",
            href: "/employee-portals/approvals-hub",
          },
          {
            icon: CalendarDays,
            value: leaveDaysRemaining != null ? `${leaveDaysRemaining} days` : "—",
            label: "annual leave left",
            href: "/employee-portals/vacation-request",
          },
        ]}
      />
    </div>
  );
}
