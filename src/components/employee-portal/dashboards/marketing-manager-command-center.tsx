import { Suspense } from "react";
import Link from "next/link";
import {
  Activity,
  BarChart3,
  CalendarClock,
  CalendarDays,
  ChartColumnBig,
  ClipboardCheck,
  Inbox,
  Network,
  ShieldCheck,
  Stethoscope,
  TrendingUp,
} from "lucide-react";

import {
  GlanceStrip,
  PendingActions,
  PendingCountsUnavailable,
  PortalContextBar,
  PortalIdentityBand,
  QuickActions,
  egp,
} from "@/components/employee-portal/portal-command-center";
import {
  MmFieldHealthSection,
  LineSalesPacingSection,
  MmPeopleSection,
  MmRoiSection,
  MmSectionSkeleton,
} from "@/components/employee-portal/dashboards/mm-intel-sections";
import { EarlyBirdOfTheFortnightCard } from "@/components/early-birds/early-bird-of-the-fortnight-card";
import { MmInboxClient } from "@/components/employee-portal/dashboards/mm-inbox-client";
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

const INTEL_TILES: Array<{ href: string; icon: typeof Activity; label: string; description: string }> = [
  { href: "/employee-portals/roi", icon: TrendingUp, label: "ROI Intelligence", description: "Coverage, spend at risk, gap" },
  { href: "/employee-portals/coaching-analytics", icon: Stethoscope, label: "Coaching Analytics", description: "Scores and coverage" },
  { href: "/employee-portals/double-visit-analytics", icon: Activity, label: "Double-Visit Analytics", description: "Field execution health" },
  { href: "/employee-portals/source-of-sales", icon: BarChart3, label: "Source of Sales", description: "Distributor sell-in by line, region, product" },
  { href: "/employee-portals/organogram", icon: Network, label: "Organogram", description: "Structure and vacancies" },
];

export function MarketingManagerCommandCenter({ snapshot, access }: { snapshot: PortalHomeSnapshot; access?: AccessContext }) {
  const { shell, pendingVacationCount, pendingExcuseCount, pendingCountsAvailable, leaveEntitlementDays, mmOverview, plansAwaitingManagerApproval, earlyBirdStars } =
    snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount;

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
    <div className="mx-auto w-full space-y-3" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} />
      <PortalContextBar role="Marketing Manager" context="Marketing & Commercial" />

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

      <QuickActions
        actions={[
          { href: "/employee-portals/marketing-requests/inbox", icon: Inbox, label: "Review Marketing Requests" },
          { href: "/employee-portals/marketing-requests/roi-tracking", icon: ChartColumnBig, label: "ROI Tracking" },
          { href: "/employee-portals/source-of-sales", icon: ClipboardCheck, label: "Source of Sales" },
          { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
        ]}
      />

      {!pendingCountsAvailable ? (
        <PendingCountsUnavailable />
      ) : (totalPending > 0 || plansCount > 0) ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      ) : null}

      <EarlyBirdOfTheFortnightCard stars={earlyBirdStars} />

      <MmInboxClient rows={pendingForMe} now={now} />

      {access ? (
        <>
          <Suspense fallback={<MmSectionSkeleton title="Line ROI vs Spend" />}>
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

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-phx-2xs font-bold uppercase tracking-widest text-slate-300">Upcoming Pay Dates</h2>
        </div>
        {mmOverview && mmOverview.upcoming.length > 0 ? (
          <div className="divide-y divide-slate-100 bg-white">
            {mmOverview.upcoming.map((row) => (
              <Link
                key={row.id}
                href="/employee-portals/marketing-requests/roi-tracking"
                className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-orange-50"
              >
                <CalendarClock className="h-4 w-4 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900 whitespace-nowrap">{row.requestCode}</p>
                  <p className="text-phx-xs text-slate-500 whitespace-nowrap">
                    {new Date(row.payDate).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                      timeZone: PHOENIX_BUSINESS_TIME_ZONE,
                    })}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-bold text-slate-700 whitespace-nowrap">{egp(row.estimatedCost)}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="bg-white px-5 py-6 text-sm text-slate-500">No approved campaigns paying out soon.</p>
        )}
      </div>

      <div className="overflow-hidden border border-slate-200">
        <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
          <h2 className="text-phx-2xs font-bold uppercase tracking-widest text-slate-300">Commercial &amp; Field Intelligence</h2>
          <div className="h-1.5 w-12 bg-orange-500" />
        </div>
        <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2 lg:grid-cols-3">
          {INTEL_TILES.map((tile) => (
            <Link
              key={tile.href}
              href={tile.href}
              className="group flex min-h-[72px] items-center gap-3 bg-white px-4 py-3 transition-colors hover:bg-orange-50"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white">
                <tile.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-800 whitespace-nowrap">{tile.label}</p>
                <p className="text-phx-xs text-slate-500 whitespace-nowrap">{tile.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {leaveEntitlementDays != null && totalPending === 0 && (
        <p className="px-1 text-phx-xs text-slate-400">{leaveEntitlementDays} leave days remaining this cycle.</p>
      )}
    </div>
  );
}
