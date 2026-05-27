import Link from "next/link";
import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { Card } from "@/components/ui/card";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { toPeriodLabel } from "@/lib/employee-portal/period";
import { getNsmDsmPerformance } from "@/lib/employee-portal/service";

import {
  TeamAchievementChart,
  TeamLeaderboardTable,
  TeamMembersBreakdown,
  TeamSalesVsTargetChart,
} from "../team-performance/team-members-breakdown.client";

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
    ? `/employee-portals/dsms-performance?period=${period}`
    : "/employee-portals/dsms-performance";
}

/** Returns a Tailwind text-color class driven by achievement percentage. */
function achievementColor(pct: number): string {
  if (pct >= 100) return "text-emerald-700";
  if (pct >= 90) return "text-emerald-600";
  if (pct >= 70) return "text-amber-600";
  return "text-red-600";
}

/** Thin left-border color per stat context. */
const statBorders: Record<string, string> = {
  "Line Target": "border-l-orange-400",
  "Line Sales": "border-l-emerald-400",
  Achievement: "border-l-amber-400",
  "Eligible DSMs": "border-l-sky-400",
};

// Print stylesheet + dir="auto" + page-level error boundary are now
// provided automatically by EmployeePortalPageShell.

/* ---------- page ---------- */

export default async function DsmsPerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  // Only NSM should access this page
  if (!access.role.toLowerCase().includes("national sales manager")) {
    redirect("/employee-portals");
  }

  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;
  const requestedPeriod = resolvedParams.period?.trim() ?? null;
  const data = await getNsmDsmPerformance(access, { period: requestedPeriod });

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load district managers performance data for your line."
        title="DSMs Performance Data Unavailable"
      />
    );
  }

  const { dsms, periods, lineAchievementPercent, dsmCount, lineTotalSales, lineTotalTarget } = data;

  const validPeriod =
    requestedPeriod && periods.includes(requestedPeriod) ? requestedPeriod : null;
  const eligibleCount = dsms.filter((d) => d.achievementPercent >= 90).length;

  /* Achievement distribution zones */
  const zoneExcellent = dsms.filter((d) => d.achievementPercent >= 100).length;
  const zoneGood = dsms.filter(
    (d) => d.achievementPercent >= 90 && d.achievementPercent < 100,
  ).length;
  const zoneFair = dsms.filter(
    (d) => d.achievementPercent >= 70 && d.achievementPercent < 90,
  ).length;
  const zoneLow = dsms.filter((d) => d.achievementPercent < 70).length;
  const totalDsms = dsms.length || 1;

  const stats = [
    { label: "Line Target", value: egp(lineTotalTarget) },
    { label: "Line Sales", value: egp(lineTotalSales) },
    { label: "Achievement", value: `${lineAchievementPercent.toFixed(1)}%` },
    { label: "Eligible DSMs", value: `${eligibleCount} / ${dsmCount}` },
  ];

  return (
    <EmployeePortalPageShell
      badge="Team Performance"
      description={`${validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"} across ${
        dsmCount > 0 ? `${dsmCount} district managers in line` : "no available district data"
      }.`}
      errorBoundaryTitle="DSMs Performance unavailable"
      title="DSMs Performance"
    >
      <div className="max-w-full min-w-0 space-y-5 overflow-x-hidden text-slate-900 sm:space-y-7">
        {/* ── Line Snapshot Card ── */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
          <div className="mb-4 grid gap-4 sm:mb-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div className="min-w-0">
              <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-orange-600">
                District Managers View
              </span>
              <h2 className="mt-3 break-words text-xl font-black tracking-tight text-slate-900 sm:text-2xl">
                Line Snapshot
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm font-medium text-slate-500">
                {validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"}
                {" | "}
                {dsmCount > 0 ? `${dsmCount} district managers in line` : "No data"}
              </p>
            </div>

            <div className="w-full rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-left sm:w-auto sm:text-right">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Line achievement
              </p>
              <p className={`mt-1 text-2xl font-bold ${achievementColor(lineAchievementPercent)}`}>
                {lineAchievementPercent.toFixed(1)}%
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
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  {stat.label}
                </p>
                <p className="mt-1.5 break-words text-lg font-bold text-slate-900 sm:text-xl">
                  {stat.value}
                </p>
              </div>
            ))}
          </div>
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
                style={{ width: `${(zoneExcellent / totalDsms) * 100}%` }}
                title={`${zoneExcellent} DSMs at 100%+`}
              />
            )}
            {zoneGood > 0 && (
              <div
                className="bg-emerald-300 transition-all"
                style={{ width: `${(zoneGood / totalDsms) * 100}%` }}
                title={`${zoneGood} DSMs at 90-99%`}
              />
            )}
            {zoneFair > 0 && (
              <div
                className="bg-amber-400 transition-all"
                style={{ width: `${(zoneFair / totalDsms) * 100}%` }}
                title={`${zoneFair} DSMs at 70-89%`}
              />
            )}
            {zoneLow > 0 && (
              <div
                className="bg-red-400 transition-all"
                style={{ width: `${(zoneLow / totalDsms) * 100}%` }}
                title={`${zoneLow} DSMs below 70%`}
              />
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-medium text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
              {zoneExcellent} at 100%+
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm bg-emerald-300" />
              {zoneGood} at 90-99%
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

        {/* ── Charts (Achievement Ranking + Sales vs Target) ── */}
        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
            <h3 className="mb-4 break-words text-sm font-semibold text-slate-900">
              DSM Achievement Ranking
            </h3>
            <WorkspaceErrorBoundary fallbackTitle="Chart failed to render">
              <TeamAchievementChart members={dsms} teamAchievementPercent={lineAchievementPercent} />
            </WorkspaceErrorBoundary>
          </Card>

          <Card className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
            <h3 className="mb-4 break-words text-sm font-semibold text-slate-900">
              DSM Sales vs Target
            </h3>
            <WorkspaceErrorBoundary fallbackTitle="Chart failed to render">
              <TeamSalesVsTargetChart members={dsms} />
            </WorkspaceErrorBoundary>
          </Card>
        </div>

        {/* ── Leaderboard Table ── */}
        <Card className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
          <div className="mb-4 min-w-0 sm:mb-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
              Leaderboard
            </p>
            <h2 className="mt-1 break-words text-lg font-bold text-slate-900">
              DSMs Comparison
            </h2>
          </div>
          <TeamLeaderboardTable members={dsms} />
        </Card>

        {/* ── Product Depth Section Divider ── */}
        <div className="flex items-center gap-3 px-1">
          <div className="h-px flex-1 bg-gray-200" />
          <p className="shrink-0 text-xs font-semibold uppercase tracking-wider text-slate-400">
            DSMs Product Breakdown ({dsmCount} managers)
          </p>
          <div className="h-px flex-1 bg-gray-200" />
        </div>

        {/* ── Product Comparison ── */}
        <Card className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6 print:shadow-none print:break-inside-avoid">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
              Product depth
            </p>
            <h3 className="mt-1 break-words text-sm font-semibold text-slate-900">
              DSMs Product Comparison
            </h3>
          </div>
          <WorkspaceErrorBoundary fallbackTitle="Product breakdown failed to render">
            <TeamMembersBreakdown members={dsms} />
          </WorkspaceErrorBoundary>
        </Card>
      </div>
    </EmployeePortalPageShell>
  );
}
