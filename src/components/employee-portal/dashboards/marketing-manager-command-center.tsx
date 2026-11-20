import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, ChartColumnBig, ClipboardCheck, Inbox, ShieldCheck } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  GlanceStrip,
  PendingActions,
  PendingCountsUnavailable,
  PortalContextBar,
  PortalIdentityBand,
  QuickActions,
  egp,
} from "@/components/employee-portal/portal-command-center";
import { LANDING_ROW_LINK, LandingEmpty, LandingPanel, LandingRow } from "@/components/employee-portal/landing-kit";
import {
  MmFieldHealthSection,
  LineSalesPacingSection,
  MmPeopleSection,
  MmRoiBoardSkeleton,
  MmRoiSection,
  MmSectionSkeleton,
} from "@/components/employee-portal/dashboards/mm-intel-sections";
import { EarlyBirdOfTheFortnightCard } from "@/components/early-birds/early-bird-of-the-fortnight-card";
import { MmInboxClient } from "@/components/employee-portal/dashboards/mm-inbox-client";
import { AwaitCard, AwaitRoleExtras, roleExtrasOf } from "@/components/employee-portal/dashboards/role-extras-stream";
import type { AccessContext } from "@/lib/auth/permissions";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";


/** Whole days since an ISO timestamp (clamped at 0). null when the timestamp is missing. */
function ageInDays(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

const INTEL_TILES: Array<{ href: string; label: string; description: string }> = [
  { href: "/employee-portals/roi", label: "ROI Intelligence", description: "Coverage, spend at risk, gap" },
  { href: "/employee-portals/coaching-analytics", label: "Coaching Analytics", description: "Scores and coverage" },
  { href: "/employee-portals/double-visit-analytics", label: "Double-Visit Analytics", description: "Field execution health" },
  { href: "/employee-portals/source-of-sales", label: "Source of Sales", description: "Distributor sell-in by line, region, product" },
  { href: "/employee-portals/organogram", label: "Organogram", description: "Structure and vacancies" },
];

/**
 * The glance strip's place while the marketing overview is still loading: three cells at the
 * strip's height, each a figure-sized and a label-sized shimmer, on the strip's own three-column
 * break. It shows no value and no label — a "—" there would read as a real zero.
 */
function GlanceStripSkeleton() {
  return (
    <div aria-busy="true" className="@container">
      <span className="sr-only">Loading</span>
      <div aria-hidden="true" className={`grid grid-cols-1 gap-px border border-slate-200 bg-slate-200 @2xl:grid-cols-3 ${adminSoftDepthClassName}`}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex min-h-[64px] flex-col justify-center gap-2 bg-white px-3 py-3 @2xl:px-4">
            <div className="employee-portal-skeleton h-[22px] w-12" />
            <div className="employee-portal-skeleton h-3 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

function MmGlanceStrip({ mmOverview }: { mmOverview: PortalHomeSnapshot["mmOverview"] }) {
  // `asOf` is server-stamped in the snapshot so we never call Date.now() during render.
  const now = mmOverview?.asOf ?? 0;
  const pendingForMe = mmOverview?.topPendingForMe ?? [];
  const oldestAge = pendingForMe.reduce<number>((max, row) => {
    const d = ageInDays(row.submittedAt, now);
    return d != null && d > max ? d : max;
  }, 0);
  const hasAwaiting = !!mmOverview && mmOverview.awaitingMyDecision > 0;
  const awaitingLabel = hasAwaiting && oldestAge >= 7 ? `awaiting · oldest ${oldestAge}d` : "awaiting my approval";

  return (
    <GlanceStrip
      items={[
        {
          icon: Inbox,
          value: mmOverview ? String(mmOverview.awaitingMyDecision) : "—",
          label: awaitingLabel,
          href: "/employee-portals/marketing-requests/inbox",
          urgent: hasAwaiting,
        },
        {
          icon: ShieldCheck,
          value: mmOverview ? String(mmOverview.validationPending) : "—",
          label: "validation pending",
          href: "/employee-portals/marketing-requests/roi-tracking",
        },
        {
          icon: ChartColumnBig,
          value: mmOverview ? String(mmOverview.inApprovalTotal) : "—",
          label: "in approval (company)",
          href: "/employee-portals/marketing-requests",
        },
        // NO PAYSLIP TILE: payslip data (amount OR month) must never render on any
        // overview/landing surface for any role — owner rule. It lives only on
        // /employee-portals/payslips.
      ]}
    />
  );
}

/** One part of a pay date, in Cairo — the day, the month and the year each stand on their own line. */
function payDatePart(iso: string, part: "day" | "month" | "year"): string {
  const options: Intl.DateTimeFormatOptions =
    part === "day" ? { day: "2-digit" } : part === "month" ? { month: "short" } : { year: "numeric" };
  return new Date(iso).toLocaleDateString("en-GB", { ...options, timeZone: PHOENIX_BUSINESS_TIME_ZONE });
}

/**
 * Approved campaigns paying out soon. Each row leads with its pay date as a flat calendar leaf —
 * the day as a figure, the month and year in small capitals under it — so the column of dates reads
 * down the panel at a glance; the request code takes the middle and wraps, the cost sits right.
 */
function UpcomingPayDates({ mmOverview }: { mmOverview: PortalHomeSnapshot["mmOverview"] }) {
  return (
    <LandingPanel title="Upcoming Pay Dates">
      {mmOverview && mmOverview.upcoming.length > 0 ? (
        <ul>
          {mmOverview.upcoming.map((row) => (
            <li key={row.id} className="border-b border-slate-200 last:border-b-0">
              <Link
                href="/employee-portals/marketing-requests/roi-tracking"
                className={`group flex min-w-0 items-center gap-3 px-3 py-2.5 sm:px-4 ${LANDING_ROW_LINK}`}
              >
                <span className="flex w-12 shrink-0 flex-col border-r border-slate-200 pr-3">
                  <span className="text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums text-[#08111f]">
                    {payDatePart(row.payDate, "day")}
                  </span>
                  <span className="mt-1 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">{payDatePart(row.payDate, "month")}</span>
                  <span className="text-phx-xs font-bold tabular-nums text-slate-400">{payDatePart(row.payDate, "year")}</span>
                </span>
                <span className="min-w-0 flex-1 break-words text-phx-md font-bold leading-snug text-[#08111f]">{row.requestCode}</span>
                <span className="min-w-0 max-w-[45%] break-words text-right text-phx-md font-bold tabular-nums text-[#08111f]">
                  {egp(row.estimatedCost)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <LandingEmpty>No approved campaigns paying out soon.</LandingEmpty>
      )}
    </LandingPanel>
  );
}

export function MarketingManagerCommandCenter({ snapshot, access }: { snapshot: PortalHomeSnapshot; access?: AccessContext }) {
  const {
    shell,
    pendingVacationCount,
    pendingExcuseCount,
    pendingCountsAvailable,
    leaveEntitlementDays,
    plansAwaitingManagerApproval,
    plansCountAvailable,
    earlyBirdStars,
  } = snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount;
  // Both legs must have loaded for either "needs your decision" or "all clear" to be trustworthy —
  // a failed plans lookup defaults to 0 and would otherwise silently hide a real plan approval.
  const pendingAvailable = pendingCountsAvailable && plansCountAvailable;

  // The marketing overview is the slow read; the identity band, quick actions and pending actions
  // paint without it, and the glance strip, the inbox and the pay dates fill under their own Suspense.
  const extras = roleExtrasOf(snapshot);

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} myInterviews={snapshot.myInterviews} />
      <PortalContextBar role="Marketing Manager" context="Marketing & Commercial" />

      <Suspense fallback={<GlanceStripSkeleton />}>
        <AwaitRoleExtras extras={extras}>{({ mmOverview }) => <MmGlanceStrip mmOverview={mmOverview} />}</AwaitRoleExtras>
      </Suspense>

      <QuickActions
        actions={[
          { href: "/employee-portals/marketing-requests/inbox", icon: Inbox, label: "Review Marketing Requests" },
          { href: "/employee-portals/marketing-requests/roi-tracking", icon: ChartColumnBig, label: "ROI Tracking" },
          { href: "/employee-portals/source-of-sales", icon: ClipboardCheck, label: "Source of Sales" },
          { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
        ]}
      />

      {!pendingAvailable ? (
        <PendingCountsUnavailable />
      ) : (totalPending > 0 || plansCount > 0) ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      ) : null}

      <Suspense fallback={null}>
        <AwaitCard value={earlyBirdStars}>{(stars) => <EarlyBirdOfTheFortnightCard stars={stars} />}</AwaitCard>
      </Suspense>

      <Suspense fallback={<MmSectionSkeleton title="Needs Your Decision" />}>
        <AwaitRoleExtras extras={extras}>
          {({ mmOverview }) => <MmInboxClient rows={mmOverview?.topPendingForMe ?? []} now={mmOverview?.asOf ?? 0} />}
        </AwaitRoleExtras>
      </Suspense>

      {access ? (
        <>
          {/* The one night-navy board on this landing: the line's ROI against its spend, the Marketing
              Manager's headline figures. Its loading shape is the board itself, so nothing flips
              from white to navy when the figures arrive. */}
          <Suspense fallback={<MmRoiBoardSkeleton />}>
            <MmRoiSection access={access} />
          </Suspense>
          <Suspense fallback={<MmSectionSkeleton title="Field Activity Health" />}>
            <MmFieldHealthSection access={access} />
          </Suspense>
          <Suspense fallback={<MmSectionSkeleton title="Line Sales Pacing" />}>
            <LineSalesPacingSection access={access} />
          </Suspense>
          <Suspense fallback={<MmSectionSkeleton title="My Line People" />}>
            <MmPeopleSection access={access} />
          </Suspense>
        </>
      ) : null}

      <Suspense fallback={<MmSectionSkeleton title="Upcoming Pay Dates" />}>
        <AwaitRoleExtras extras={extras}>{({ mmOverview }) => <UpcomingPayDates mmOverview={mmOverview} />}</AwaitRoleExtras>
      </Suspense>

      <LandingPanel title="Commercial & Field Intelligence">
        {/* Five links, two to a row from 36rem of PANEL width and three from 56rem. A flex row, not a
            fixed grid: `grow` lets the last link of a short row take what is left, so five never
            leave the solid grey cell a fixed grid draws — the "empty square" the owner banned. */}
        <div className="@container">
          <div className="flex flex-wrap gap-px bg-slate-200">
            {INTEL_TILES.map((tile) => (
              <Link
                key={tile.href}
                href={tile.href}
                className={`group flex min-h-[64px] min-w-0 grow basis-full items-center gap-3 bg-white px-3 py-3 sm:px-4 @xl:basis-[calc(50%-1px)] @4xl:basis-[calc(33.333%-1px)] ${LANDING_ROW_LINK}`}
              >
                <div className="min-w-0 flex-1">
                  {/* No `whitespace-nowrap` on either line. This card used to be `overflow-hidden`, so
                      a pinned line was CLIPPED rather than scrolled: measured 2026-09-05 at 1024px,
                      "Distributor sell-in by line, region, product" lost its last 20px and read
                      "…region, produc", with the page reporting a clean 795/795 throughout. Wrapping
                      is the remedy the golden rule allows (AGENTS.md §4); the ellipsis ban is untouched. */}
                  <p className="break-words text-phx-md font-bold leading-snug text-[#08111f]">{tile.label}</p>
                  <p className="mt-0.5 break-words text-phx-xs leading-snug text-slate-500">{tile.description}</p>
                </div>
                <ArrowUpRight
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-slate-400 transition-colors motion-reduce:transition-none group-hover:text-[#08111f]"
                />
              </Link>
            ))}
          </div>
        </div>
      </LandingPanel>

      {leaveEntitlementDays != null && totalPending === 0 && (
        <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <LandingRow label="Leave days remaining this cycle" value={String(leaveEntitlementDays)} />
        </div>
      )}
    </div>
  );
}
