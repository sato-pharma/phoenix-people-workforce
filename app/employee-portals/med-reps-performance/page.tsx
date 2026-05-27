import Link from "next/link";
import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { Card } from "@/components/ui/card";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { toPeriodLabel } from "@/lib/employee-portal/period";
import { getDsmTeamPerformance } from "@/lib/employee-portal/service";
import { buildSalesManagerPerformanceGroups } from "@/lib/sales/metrics";

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
    ? `/employee-portals/med-reps-performance?period=${period}`
    : "/employee-portals/med-reps-performance";
}

/** Returns a Tailwind text-color class driven by achievement percentage. */
function achievementColor(pct: number): string {
  if (pct >= 100) return "text-emerald-700";
  if (pct >= 90) return "text-emerald-600";
  if (pct >= 70) return "text-amber-600";
  return "text-red-600";
}

/** Returns a Tailwind bg-color class for achievement zone indicators. */
function achievementBg(pct: number): string {
  if (pct >= 100) return "bg-emerald-500";
  if (pct >= 90) return "bg-emerald-400";
  if (pct >= 70) return "bg-amber-400";
  return "bg-red-400";
}

/** Thin left-border color per stat context. */
const statBorders: Record<string, string> = {
  "Line Target": "border-l-orange-400",
  "Line Sales": "border-l-emerald-400",
  Achievement: "border-l-amber-400",
  "Eligible Reps": "border-l-sky-400",
};

/* ---------- print stylesheet ---------- */

const printStyles = `
@media print {
  body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  nav, header, footer, button, [data-no-print] { display: none !important; }
  .print\\:break-inside-avoid { break-inside: avoid; }
  .print\\:shadow-none { box-shadow: none !important; }
  * { border-color: #e2e8f0 !important; }
}
`;

/* ---------- page ---------- */

export default async function MedRepsPerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  if (!access.role.toLowerCase().includes("national sales manager")) {
    redirect("/employee-portals");
  }

  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;
  const requestedPeriod = resolvedParams.period?.trim() ?? null;
  const data = await getDsmTeamPerformance(access, { period: requestedPeriod });

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load medical reps performance data for your line."
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
  } = data;

  const validPeriod =
    requestedPeriod && periods.includes(requestedPeriod) ? requestedPeriod : null;
  const eligibleCount = members.filter((m) => m.achievementPercent >= 90).length;
  const dsmGroups = buildSalesManagerPerformanceGroups(members);

  /* Achievement distribution zones */
  const zoneExcellent = members.filter((m) => m.achievementPercent >= 100).length;
  const zoneGood = members.filter(
    (m) => m.achievementPercent >= 90 && m.achievementPercent < 100,
  ).length;
  const zoneFair = members.filter(
    (m) => m.achievementPercent >= 70 && m.achievementPercent < 90,
  ).length;
  const zoneLow = members.filter((m) => m.achievementPercent < 70).length;
  const totalMembers = members.length || 1;

  const stats = [
    { label: "Line Target", value: egp(teamTotalTarget) },
    { label: "Line Sales", value: egp(teamTotalSales) },
    { label: "Achievement", value: `${teamAchievementPercent.toFixed(1)}%` },
    { label: "Eligible Reps", value: `${eligibleCount} / ${teamMemberCount}` },
  ];

  return (
    <EmployeePortalPageShell
      badge="Team Performance"
      description={`${validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"} across ${
        teamMemberCount > 0
          ? `${teamMemberCount} medical reps in line`
          : "no available medical reps data"
      }.`}
      title="Medical Reps Performance"
    >
      {/* Print stylesheet */}
      <style dangerouslySetInnerHTML={{ __html: printStyles }} />

      <div
        className="max-w-full min-w-0 space-y-5 overflow-x-hidden text-slate-900 sm:space-y-7"
        dir="auto"
      >
        {/* ── Line Snapshot Card ── */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
          <div className="mb-4 grid gap-4 sm:mb-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div className="min-w-0">
              <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-orange-600">
                Line-wide performance
              </span>
              <h2 className="mt-3 break-words text-xl font-black tracking-tight text-slate-900 sm:text-2xl">
                Line Snapshot
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm font-medium text-slate-500">
                {validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"}
                {" | "}
                {teamMemberCount > 0
                  ? `${teamMemberCount} medical reps in line`
                  : "No data"}
              </p>
            </div>

            <div className="w-full rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-left sm:w-auto sm:text-right">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Line achievement
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
                style={{ width: `${(zoneExcellent / totalMembers) * 100}%` }}
                title={`${zoneExcellent} reps at 100%+`}
              />
            )}
            {zoneGood > 0 && (
              <div
                className="bg-emerald-300 transition-all"
                style={{ width: `${(zoneGood / totalMembers) * 100}%` }}
                title={`${zoneGood} reps at 90-99%`}
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

        {/* ── District-Wise Performance Section Divider ── */}
        <div className="flex items-center gap-3 px-1">
          <div className="h-px flex-1 bg-gray-200" />
          <p className="shrink-0 text-xs font-semibold uppercase tracking-wider text-slate-400">
            District-Wise Performance ({dsmGroups.length} districts)
          </p>
          <div className="h-px flex-1 bg-gray-200" />
        </div>

        {/* ── DSM Groups ── */}
        {dsmGroups.map((group) => (
          <section
            className="min-w-0 space-y-4 print:break-inside-avoid"
            key={group.managerName}
          >
            {/* DSM group header */}
            <div className="grid gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:px-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className="flex min-w-0 items-center gap-3">
                <div
                  className={`h-10 w-1 rounded-sm ${achievementBg(group.achievementPercent)}`}
                />
                <div className="min-w-0">
                  <h2 className="break-words text-base font-bold text-slate-900 sm:text-lg">
                    {group.managerName}
                  </h2>
                  <p className="mt-0.5 text-sm font-medium text-slate-500">
                    District:{" "}
                    <span className={`font-bold ${achievementColor(group.achievementPercent)}`}>
                      {group.achievementPercent.toFixed(1)}%
                    </span>
                    {" | "}
                    {group.members.length} reps
                  </p>
                </div>
              </div>
              <div className="w-full rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-left md:w-auto md:text-right">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  District sales
                </p>
                <p className="mt-0.5 text-sm font-bold text-slate-900">
                  {egp(group.totalSales)}
                </p>
              </div>
            </div>

            {/* Charts with error boundaries */}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5 print:shadow-none">
                <h3 className="mb-4 break-words text-sm font-semibold text-slate-900">
                  District Achievement Ranking
                </h3>
                <WorkspaceErrorBoundary fallbackTitle="Chart failed to render">
                  <TeamAchievementChart
                    members={group.members}
                    teamAchievementPercent={group.achievementPercent}
                  />
                </WorkspaceErrorBoundary>
              </Card>

              <Card className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5 print:shadow-none">
                <h3 className="mb-4 break-words text-sm font-semibold text-slate-900">
                  District Sales vs Target
                </h3>
                <WorkspaceErrorBoundary fallbackTitle="Chart failed to render">
                  <TeamSalesVsTargetChart members={group.members} />
                </WorkspaceErrorBoundary>
              </Card>
            </div>

            {/* Product breakdown */}
            <Card className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6 print:shadow-none">
              <div className="mb-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
                  Product depth
                </p>
                <h3 className="mt-1 break-words text-sm font-semibold text-slate-900">
                  Medical Reps Product Breakdown
                </h3>
              </div>
              <WorkspaceErrorBoundary fallbackTitle="Product breakdown failed to render">
                <TeamMembersBreakdown members={group.members} />
              </WorkspaceErrorBoundary>
            </Card>
          </section>
        ))}
      </div>
    </EmployeePortalPageShell>
  );
}
