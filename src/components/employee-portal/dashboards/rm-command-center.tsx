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
import { regionalTeamReportLinks, RSM_PLAN_BOARD_HREF, type RegionalTeamReportKey } from "@/lib/employee-portal/regional-team-reports";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  INCENTIVE_NOT_CONFIRMED_NOTE,
  REGION_FIGURES_UNAVAILABLE,
  districtsNeedingAttention,
  incentiveGap,
  ownRequestsHref,
  ownRequestsLabel,
  wholePercent,
} from "@/lib/employee-portal/rsm-home-summary";

/* ── Region performance keycards ───────────────────────────────────── */

function RegionKeycards({ rmRegional }: { rmRegional: PortalHomeSnapshot["rmRegional"] }) {
  // Never rounded UP across a line (rsm-home-summary.ts): 89.6% reads 89%, beside a gap to 90%.
  const pct = rmRegional ? wholePercent(rmRegional.achievementPercent) : null;
  const sales = rmRegional?.totalSales ?? 0;
  const target = rmRegional?.totalTarget ?? 0;
  // Measured on the money, the same test Districts Needing Attention uses, so the two always agree.
  const gap = incentiveGap(sales, target);
  const pctNum = pct ?? 0;

  // 🔒 A null windowLabel means NOTHING is published in this region's scope, so every money tile is
  // WITHHELD rather than printed as zero (owner, 2026-08-13). See lib/employee-portal/published-window.ts.
  const windowLabel = rmRegional?.windowLabel ?? null;
  const published = hasPublishedWindow(windowLabel);
  const figureInk = published ? "text-slate-900" : "text-slate-500";
  const { accent: achAccent, valueClass: achValueClass } = achievementTone(windowLabel, pctNum);
  const cleared = gap.state === "cleared";

  const cards: Keycard[] = [
    {
      icon: TrendingUp,
      label: "Achievement",
      value: pct !== null ? publishedFigure(windowLabel, () => `${pct}%`) : "—",
      sub: published && target <= 0 ? "no region target loaded" : "vs region target",
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
      value: publishedFigure(windowLabel, () => (target <= 0 ? "—" : egpCompact(target))),
      sub: published && target <= 0 ? "no region target loaded" : "region target",
      accent: "bg-slate-900",
      valueClass: figureInk,
    },
    {
      icon: cleared ? CheckCircle2 : Flag,
      label: "Gap to 90%",
      value: publishedFigure(windowLabel, () => (gap.state === "short" ? egpCompact(gap.gap) : gap.state === "cleared" ? "Cleared" : "—")),
      sub: published ? gap.sub : NO_PUBLISHED_CLOSING_SUB,
      accent: published && cleared ? "bg-emerald-500" : published && gap.state === "short" ? "bg-orange-500" : "bg-slate-900",
      valueClass: published ? (cleared ? "text-emerald-600" : gap.state === "short" ? "text-orange-600" : "text-slate-500") : "text-slate-500",
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
            <p className="bg-white px-5 pb-4 text-phx-sm text-slate-500">{NO_PUBLISHED_CLOSING_NOTE}</p>
          )}
          {/* The Gap to 90% tile is the only incentive figure on this page, so its caveat sits here,
              under it. It used to float further down the page, above boards that show no incentive. */}
          {published && target > 0 ? (
            <p className="mx-4 mb-4 mt-3 flex items-start gap-1.5 border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-phx-xs font-semibold text-amber-700">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{INCENTIVE_NOT_CONFIRMED_NOTE}</span>
            </p>
          ) : null}
          {/* Region Sales counts vacant-district reps + in-region direct orders no DSM row below carries */}
          <PerformanceReconciliationNote
            className="mx-4 mb-4"
            totalLabel="Region Sales"
            unattributedSales={rmRegional.unattributedSales}
          />
        </>
      ) : (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">{REGION_FIGURES_UNAVAILABLE}</p>
      )}
    </div>
  );
}

/* ── Districts needing attention ───────────────────────────────────── */

const ATTENTION_INK = { met: "text-emerald-600", near: "text-amber-600", behind: "text-orange-600", far: "text-rose-600" } as const;

/**
 * Districts below the 90% incentive line, worst first. The list, the order and every word come from
 * `districtsNeedingAttention` (rsm-home-summary.ts), measured on the money the same way the Gap to 90%
 * tile is, so "needs attention" and "gap to incentive" always agree. Nothing shows while no closing
 * is published.
 */
function DistrictsAttention({ rmRegional }: { rmRegional: PortalHomeSnapshot["rmRegional"] }) {
  if (!rmRegional) return null;
  const attention = districtsNeedingAttention(rmRegional.dsms, rmRegional.windowLabel);
  if (attention.state === "hidden") return null;

  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <SectionHead title="Districts Needing Attention" right={<SectionMeta items={[rmRegional.windowLabel, "below 90%"]} />} />
      {attention.state === "all-clear" ? (
        <div className="flex items-center gap-2 bg-white px-4 py-5 sm:px-5">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <p className="text-sm font-medium text-emerald-700">{attention.text}</p>
        </div>
      ) : (
        <div className="space-y-px bg-slate-200">
          {attention.behind.map((d) => (
            <div key={d.key} className="flex items-center justify-between gap-3 bg-white px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold text-slate-800">{d.name}</p>
                <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">{d.salesText}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className={`text-lg font-black tabular-nums ${ATTENTION_INK[d.band]}`}>{d.percent}%</p>
                <p className="mt-0.5 whitespace-nowrap text-phx-sm font-semibold uppercase tracking-wide text-slate-400">
                  {d.gapText}
                </p>
              </div>
            </div>
          ))}
          {attention.unmeasuredText ? (
            <div className="flex items-start gap-2 bg-white px-4 py-3 sm:px-5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p className="break-words text-sm text-slate-500">{attention.unmeasuredText}</p>
            </div>
          ) : null}
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
  // His board in Phoenix CRM, never the read-only plan history at /employee-portals/plans (owner, 2026-11-09).
  { href: RSM_PLAN_BOARD_HREF, icon: CalendarDays, label: "Region Plans" },
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
                  unranked={rmRegional?.dsmsWithoutPublishedMonth ?? []}
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
        <Suspense fallback={<MmSectionSkeleton title="Region Sales Pacing" />}>
          {/* Scoped to the region's areas (loadPortalClosingTrend), so it is never called the line's. */}
          <LineSalesPacingSection access={access} title="Region Sales Pacing" />
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
            // The viewer's OWN vacation and excuse requests, waiting on a manager or HR: they open the
            // viewer's own request page, where they are, never the Approvals Hub (rsm-home-summary.ts).
            label: ownRequestsLabel(pendingCountsAvailable ? pendingVacationCount + pendingExcuseCount : null),
            href: ownRequestsHref(pendingVacationCount, pendingExcuseCount),
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
