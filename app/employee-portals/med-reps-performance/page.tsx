import Link from "next/link";
import { redirect } from "next/navigation";
import { TrendingUp, Trophy, Users } from "lucide-react";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { PerformanceReconciliationNote } from "@/components/employee-portal/performance-reconciliation-note";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import { Card } from "@/components/ui/card";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { toPeriodLabel } from "@/lib/employee-portal/period";
import { medicalRepCountLabel } from "@/lib/employee-portal/rep-target-gap";
import { getMedRepsPerformance } from "@/lib/employee-portal/service";
import { INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT } from "@/lib/incentives/eligibility-threshold";
import { buildSalesManagerPerformanceGroups } from "@/lib/sales/metrics";
import { formatEmployeeDisplayName } from "@/lib/utils";

import {
  TeamLeaderboardTable,
  TeamMembersBreakdown,
  TeamSalesVsTargetChart,
} from "../team-performance/team-members-breakdown-dynamic";

export const dynamic = "force-dynamic";

/* ---------- helpers ---------- */

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function periodHref(period: string | null) {
  return period
    ? `/employee-portals/med-reps-performance?period=${period}`
    : "/employee-portals/med-reps-performance";
}

/** Returns a Tailwind text-color class driven by achievement percentage. */
function achievementColor(pct: number): string {
  if (pct >= 100) return "text-emerald-700";
  if (pct >= INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT) return "text-emerald-600";
  if (pct >= 70) return "text-amber-600";
  return "text-red-600";
}

/** Lighter variant of {@link achievementColor} for dark (slate-900) backgrounds. */
function achievementColorOnDark(pct: number): string {
  if (pct >= 100) return "text-emerald-400";
  if (pct >= INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT) return "text-emerald-300";
  if (pct >= 70) return "text-amber-400";
  return "text-rose-400";
}

/** Thin left-border color per stat context. */
const statBorders: Record<string, string> = {
  "Line Target": "border-l-orange-400",
  "Line Sales": "border-l-emerald-400",
  "Region Target": "border-l-orange-400",
  "Region Sales": "border-l-emerald-400",
  "District Target": "border-l-orange-400",
  "District Sales": "border-l-emerald-400",
  Achievement: "border-l-amber-400",
  "Eligible Reps": "border-l-sky-400",
};

// The National Sales Manager reads the line here; the Regional Manager, since 2026-10-20 (owner),
// reads the region — the same builder, bounded to the seat's areas. The nav flag
// (showMedRepsPerformanceTab) offers the page to exactly these two roles. A District Manager opens it
// from the overview's Med Rep Performance tile over their own district (owner, 2026-11-09: "open Med
// Rep Performance to District Managers over their own district") — the same builder and the same area
// bound as their Team Performance page, so the two agree to the pound.
const PERFORMANCE_ROLLUP_ROLES = new Set(["National Sales Manager", "Regional Manager", "District Manager"]);

// Print stylesheet + dir="auto" + page-level error boundary are now
// provided automatically by EmployeePortalPageShell.

/* ---------- page ---------- */

export default async function MedRepsPerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const access = await resolveAuthenticatedPageAccess();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  if (!PERFORMANCE_ROLLUP_ROLES.has(access.role)) {
    redirect("/employee-portals");
  }

  await assertPermission(access, "sales", "read");

  const isRegionView = access.role === "Regional Manager";
  const isDistrictView = access.role === "District Manager";
  const scopeWord = isDistrictView ? "District" : isRegionView ? "Region" : "Line";
  const inScope = isDistrictView ? "in your district" : isRegionView ? "in your region" : "in line";

  const resolvedParams = await searchParams;
  const requestedPeriod = resolvedParams.period?.trim() ?? null;
  const data = await getMedRepsPerformance(access, { period: requestedPeriod });

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message={`Unable to load medical reps performance data for your ${scopeWord.toLowerCase()}.`}
        title="Performance Data Unavailable"
      />
    );
  }

  const {
    members,
    periods,
    teamAchievementPercent,
    teamMemberCount,
    teamTotalSales,
    teamTotalTarget,
    unattributedSales,
  } = data;

  const validPeriod =
    requestedPeriod && periods.includes(requestedPeriod) ? requestedPeriod : null;
  const eligibleCount = members.filter((m) => m.achievementPercent >= INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT).length;

  /* Achievement distribution zones */
  const zoneExcellent = members.filter((m) => m.achievementPercent >= 100).length;
  const zoneGood = members.filter(
    (m) => m.achievementPercent >= INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT && m.achievementPercent < 100,
  ).length;
  const zoneFair = members.filter(
    (m) => m.achievementPercent >= 70 && m.achievementPercent < INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT,
  ).length;
  const zoneLow = members.filter((m) => m.achievementPercent < 70).length;
  const totalMembers = members.length || 1;

  const stats = [
    { label: `${scopeWord} Target`, value: egp(teamTotalTarget) },
    { label: `${scopeWord} Sales`, value: egp(teamTotalSales) },
    { label: "Achievement", value: `${teamAchievementPercent.toFixed(1)}%` },
    { label: "Eligible Reps", value: `${eligibleCount} / ${teamMemberCount}` },
  ];

  const bestPerformer = members[0] ?? null;
  const totalGap = Math.max(0, teamTotalTarget - teamTotalSales);
  const dsmGroups = buildSalesManagerPerformanceGroups(members);

  return (
    <EmployeePortalPageShell
      badge="Team Performance"
      description={`${validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"} across ${
        teamMemberCount > 0
          ? `${medicalRepCountLabel(teamMemberCount)} ${inScope}`
          : "no available medical reps data"
      }.`}
      errorBoundaryTitle="Medical Reps Performance unavailable"
      title="Medical Reps Performance"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={access.scope} />
      </div>
      <div className="max-w-full min-w-0 space-y-5 overflow-x-hidden text-slate-900 sm:space-y-7">
        {/* ── Line Snapshot Card ── */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
          <div className="mb-4 grid gap-4 sm:mb-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div className="min-w-0">
              <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
                Medical Reps View
              </span>
              <h2 className="mt-3 break-words text-xl font-black tracking-tight text-slate-900 sm:text-2xl">
                {scopeWord} Snapshot
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm font-medium text-slate-500">
                {validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"}
                {" | "}
                {teamMemberCount > 0 ? `${medicalRepCountLabel(teamMemberCount)} ${inScope}` : "No data"}
              </p>
            </div>

            <div className="w-full rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-left sm:w-auto sm:text-right">
              <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                {scopeWord} achievement
              </p>
              <p className={`mt-1 text-2xl font-bold ${achievementColor(teamAchievementPercent)}`}>
                {teamAchievementPercent.toFixed(1)}%
              </p>
            </div>
          </div>

          {/* Period filter pills */}
          {periods.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5 sm:mb-5">
              {[null, ...periods.slice(0, 5)].map((period) => {
                const active =
                  period === null ? !validPeriod : validPeriod === period;
                return (
                  <Link
                    className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-semibold transition ${
                      active
                        ? "border-orange-500 bg-orange-500 text-white"
                        : "border-gray-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
                    }`}
                    href={periodHref(period)}
                    key={period ?? "all"}
                  >
                    {period ? toPeriodLabel(period) : "All Periods"}
                  </Link>
                );
              })}
            </div>
          )}

          {/* Stat cards with thin gridlines */}
          <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y divide-gray-100">
            {stats.map((stat) => (
              <div
                className={`min-w-0 border-l-2 ${statBorders[stat.label] ?? "border-l-gray-300"} bg-white px-3 py-3 sm:px-4 sm:py-4`}
                key={stat.label}
              >
                <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                  {stat.label}
                </p>
                <p className="mt-1.5 break-words text-lg font-bold text-slate-900 sm:text-xl">
                  {stat.value}
                </p>
              </div>
            ))}
          </div>

          {/* Reconciliation: Line Sales includes Direct Orders + vacant seats no rep below carries */}
          <PerformanceReconciliationNote
            className="mt-3 rounded-md"
            totalLabel={`${scopeWord} Sales`}
            unattributedSales={unattributedSales}
          />
        </Card>

        {/* ── Achievement Distribution Bar ── */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-5 print:shadow-none print:break-inside-avoid">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Achievement distribution
          </p>
          <div className="flex h-5 w-full overflow-hidden rounded">
            {zoneExcellent > 0 && (
              <div
                className="bg-emerald-500 transition-all"
                style={{ width: `${(zoneExcellent / totalMembers) * 100}%` }}
                title={`${zoneExcellent} reps at 100%+`}
              />
            )}
            {zoneGood > 0 && (
              <div
                className="bg-emerald-300 transition-all"
                style={{ width: `${(zoneGood / totalMembers) * 100}%` }}
                title={`${zoneGood} reps at ${INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT}-99%`}
              />
            )}
            {zoneFair > 0 && (
              <div
                className="bg-amber-400 transition-all"
                style={{ width: `${(zoneFair / totalMembers) * 100}%` }}
                title={`${zoneFair} reps at 70-89%`}
              />
            )}
            {zoneLow > 0 && (
              <div
                className="bg-red-400 transition-all"
                style={{ width: `${(zoneLow / totalMembers) * 100}%` }}
                title={`${zoneLow} reps below 70%`}
              />
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-phx-xs font-medium text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
              {zoneExcellent} at 100%+
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm bg-emerald-300" />
              {zoneGood} at {INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT}-99%
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm bg-amber-400" />
              {zoneFair} at 70-89%
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm bg-red-400" />
              {zoneLow} below 70%
            </span>
          </div>
        </Card>

        {/* ── Sales vs Target (full width, premium) ── */}
        <Card className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br from-white via-white to-orange-50/40 shadow-[0_4px_20px_rgba(15,23,42,0.08)] print:shadow-none print:break-inside-avoid">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 bg-gradient-to-r from-slate-900 to-slate-800 px-5 py-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/15">
                <TrendingUp className="h-4.5 w-4.5 text-orange-400" />
              </div>
              <div className="min-w-0">
                <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-orange-400">
                  Field Performance
                </p>
                <h3 className="break-words text-base font-black text-white sm:text-lg">
                  Medical Reps Sales vs Target
                </h3>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 sm:gap-6">
              {bestPerformer && (
                <div className="flex items-center gap-2">
                  <Trophy className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <div className="min-w-0 text-left">
                    <p className="text-phx-3xs font-semibold uppercase tracking-wider text-slate-400">
                      Top rep
                    </p>
                    <p className="max-w-[10rem] break-words text-xs font-bold leading-snug text-white">
                      {formatEmployeeDisplayName(bestPerformer.name)}
                    </p>
                  </div>
                  <span className={`text-xs font-bold ${achievementColorOnDark(bestPerformer.achievementPercent)}`}>
                    {bestPerformer.achievementPercent.toFixed(1)}%
                  </span>
                </div>
              )}
              <div className="text-right">
                <p className="text-phx-3xs font-semibold uppercase tracking-wider text-slate-400">
                  {scopeWord} achievement
                </p>
                <p className={`text-sm font-black ${achievementColorOnDark(teamAchievementPercent)}`}>
                  {teamAchievementPercent.toFixed(1)}%
                </p>
              </div>
              <div className="text-right">
                <p className="text-phx-3xs font-semibold uppercase tracking-wider text-slate-400">
                  Gap to target
                </p>
                <p className="text-sm font-black text-white">{egp(totalGap)}</p>
              </div>
            </div>
          </div>

          <div className="p-4 sm:p-6">
            <WorkspaceErrorBoundary fallbackTitle="Chart failed to render">
              <TeamSalesVsTargetChart members={members} minHeightPx={420} />
            </WorkspaceErrorBoundary>
          </div>
        </Card>

        {/* ── Leaderboard Table ── */}
        <Card className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
          <div className="mb-4 min-w-0 sm:mb-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
              Leaderboard
            </p>
            <h2 className="mt-1 break-words text-lg font-bold text-slate-900">
              Medical Reps Comparison
            </h2>
          </div>
          <TeamLeaderboardTable members={members} />
        </Card>

        {/* ── Product Depth Section Divider ── the title wraps on a phone; at 375px it is wider than the card. */}
        <div className="flex items-center gap-3 px-1">
          <div className="h-px min-w-6 flex-1 bg-gray-200" />
          <p className="min-w-0 text-center text-xs font-semibold uppercase tracking-wider text-slate-400">
            Medical Reps Product Breakdown ({medicalRepCountLabel(teamMemberCount)})
          </p>
          <div className="h-px min-w-6 flex-1 bg-gray-200" />
        </div>

        {/* ── Product Comparison (grouped by district / DSM) ── */}
        <Card className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6 print:shadow-none print:break-inside-avoid">
          <div className="mb-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
              Product depth
            </p>
            <h3 className="mt-1 break-words text-sm font-semibold text-slate-900">
              Medical Reps Product Comparison
            </h3>
          </div>

          <div className="space-y-6">
            {dsmGroups.map((group, index) => (
              <div key={group.managerHrId}>
                {index > 0 && <div className="mb-6 h-px bg-gray-200" />}

                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-slate-900 text-phx-2xs font-bold text-white">
                      <Users className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0">
                      <p className="break-words text-sm font-bold text-slate-900">
                        {formatEmployeeDisplayName(group.managerName)}
                      </p>
                      <p className="text-phx-2xs font-medium text-slate-400">
                        {/* A vacant district has no manager to title (owner, 2026-10-20). */}
                        {group.isVacantSeat ? "Vacant seat" : "District Manager"} &middot; {medicalRepCountLabel(group.members.length)}
                      </p>
                    </div>
                  </div>
                  <span className={`shrink-0 text-sm font-bold ${achievementColor(group.achievementPercent)}`}>
                    {group.achievementPercent.toFixed(1)}%
                  </span>
                </div>

                <WorkspaceErrorBoundary fallbackTitle="Product breakdown failed to render">
                  <TeamMembersBreakdown members={group.members} />
                </WorkspaceErrorBoundary>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </EmployeePortalPageShell>
  );
}
