import Link from "next/link";
import { redirect } from "next/navigation";

import { PerformanceReconciliationNote } from "@/components/employee-portal/performance-reconciliation-note";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import {
  assertPermission,
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { toPeriodLabel } from "@/lib/employee-portal/period";
import {
  getCompanyMedRepPerformance,
  normalizeTeamComparisonPeriods,
} from "@/lib/employee-portal/service";
import { buildSalesManagerPerformanceGroups } from "@/lib/sales/metrics";

import {
  TeamLeaderboardTable,
  TeamMembersBreakdown,
} from "@/app/employee-portals/team-performance/team-members-breakdown-dynamic";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Company-wide medical-rep performance for the CEO / Super Admin — every line's reps,
// computed by the SAME per-line builder the NSM's Med Reps Performance view uses
// (getCompanyMedRepPerformance → buildTeamPerformanceForScope), so company totals
// reconcile exactly with the per-line NSM views, seat-continuity included.

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

const BASE_PATH = "/admin/field-sales/med-reps-performance";

function periodHref(periods: string[]) {
  return periods.length > 0 ? `${BASE_PATH}?period=${periods.join(",")}` : BASE_PATH;
}

function togglePeriodHref(selectedPeriods: string[], period: string) {
  const next = selectedPeriods.includes(period)
    ? selectedPeriods.filter((p) => p !== period)
    : [...selectedPeriods, period];
  return periodHref(next);
}

function periodsSummaryLabel(selectedPeriods: string[]) {
  if (selectedPeriods.length === 0) return "All periods";
  if (selectedPeriods.length === 1) return `Period: ${toPeriodLabel(selectedPeriods[0])}`;
  return `Periods: ${selectedPeriods.map(toPeriodLabel).join(", ")}`;
}

function achievementColor(pct: number): string {
  if (pct >= 100) return "text-emerald-700";
  if (pct >= 90) return "text-emerald-600";
  if (pct >= 70) return "text-amber-600";
  return "text-red-600";
}

const statBorders: Record<string, string> = {
  "Company Target": "border-l-orange-400",
  "Company Sales": "border-l-emerald-400",
  Achievement: "border-l-amber-400",
  Lines: "border-l-sky-400",
  "Eligible Reps": "border-l-violet-400",
};

export default async function CompanyMedRepsPerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  if (
    !(
      access.role === "CEO" ||
      access.role === "SFE Manager" ||
      canAccessSystemAdministratorWorkspace(access)
    )
  ) {
    redirect("/admin");
  }
  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;
  const requestedPeriod = resolvedParams.period?.trim() ?? null;
  const data = await getCompanyMedRepPerformance(access, { period: requestedPeriod });

  if (!data || data.lines.length === 0) {
    return (
      <div className="mx-auto max-w-7xl p-6">
        <div className="border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="text-sm font-black text-amber-900">Med-Rep Performance unavailable</p>
          <p className="mt-1 text-xs font-medium text-amber-800">
            Medical-rep performance data could not be loaded. This is a data-source state, not a zero.
          </p>
        </div>
      </div>
    );
  }

  const selectedPeriods = normalizeTeamComparisonPeriods(requestedPeriod).filter((period) =>
    data.periods.includes(period),
  );

  const allReps = data.lines
    .flatMap((line) => line.performance.members)
    .sort((a, b) => b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales)
    .map((m, i) => ({ ...m, position: i + 1 }));
  const eligibleCount = allReps.filter((m) => m.achievementPercent >= 90).length;

  const stats = [
    { label: "Company Target", value: egp(data.companyTotalTarget) },
    { label: "Company Sales", value: egp(data.companyTotalSales) },
    { label: "Achievement", value: `${data.companyAchievementPercent.toFixed(1)}%` },
    { label: "Lines", value: `${data.lineCount}` },
    { label: "Eligible Reps", value: `${eligibleCount} / ${data.repCount}` },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-6">
      {/* ── Page header ── */}
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Field Sales · Company Scope</p>
          <h1 className={pageHeaderTitleClassName}>Med-Rep Performance</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every line&apos;s medical reps — targets, sales, achievement and product depth, grouped by district.
            Computed by the same engine each NSM sees, so company totals reconcile exactly.
          </p>
        </div>
      </div>

      <div className="max-w-full min-w-0 space-y-5 text-slate-900">
        {/* ── Company snapshot ── */}
        <div className="border border-slate-200 bg-white p-4 sm:p-6">
          <div className="mb-4 grid gap-4 sm:mb-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div className="min-w-0">
              <span className="inline-flex border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
                Company View
              </span>
              <h2 className="mt-3 break-words text-xl font-black tracking-tight text-slate-900 sm:text-2xl">
                Company Snapshot
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm font-medium text-slate-500">
                {periodsSummaryLabel(selectedPeriods)}
                {" | "}
                {data.repCount} medical reps across {data.lineCount} lines
              </p>
            </div>
            <div className="w-full border border-slate-100 bg-slate-50 px-4 py-3 text-left sm:w-auto sm:text-right">
              <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                Company achievement
              </p>
              <p className={`mt-1 text-2xl font-bold ${achievementColor(data.companyAchievementPercent)}`}>
                {data.companyAchievementPercent.toFixed(1)}%
              </p>
            </div>
          </div>

          {data.periods.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5 sm:mb-5">
              <Link
                className={`shrink-0 border px-3 py-1.5 text-xs font-semibold transition ${
                  selectedPeriods.length === 0
                    ? "border-orange-500 bg-orange-500 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
                }`}
                href={periodHref([])}
              >
                All Periods
              </Link>
              {data.periods.slice(0, 12).map((period) => {
                const active = selectedPeriods.includes(period);
                return (
                  <Link
                    className={`shrink-0 border px-3 py-1.5 text-xs font-semibold transition ${
                      active
                        ? "border-orange-500 bg-orange-500 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
                    }`}
                    href={togglePeriodHref(selectedPeriods, period)}
                    key={period}
                  >
                    {toPeriodLabel(period)}
                  </Link>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-2 divide-x divide-y divide-slate-100 lg:grid-cols-5">
            {stats.map((stat) => (
              <div
                className={`min-w-0 border-l-2 ${statBorders[stat.label] ?? "border-l-slate-300"} bg-white px-3 py-3 sm:px-4 sm:py-4`}
                key={stat.label}
              >
                <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">{stat.label}</p>
                <p className="mt-1.5 break-words text-lg font-bold text-slate-900 sm:text-xl">{stat.value}</p>
              </div>
            ))}
          </div>

          {/* Reconciliation: Company Sales includes Direct Orders + vacant seats no rep below carries */}
          <PerformanceReconciliationNote
            className="mt-3"
            totalLabel="Company Sales"
            unattributedSales={data.companyUnattributedSales}
          />
        </div>

        {/* ── Company top reps leaderboard ── */}
        <div className="min-w-0 overflow-hidden border border-slate-200 bg-white p-4 sm:p-6">
          <div className="mb-4 min-w-0 sm:mb-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">Leaderboard</p>
            <h2 className="mt-1 break-words text-lg font-bold text-slate-900">Top 20 medical reps — company ranking</h2>
          </div>
          <TeamLeaderboardTable members={allReps.slice(0, 20)} />
        </div>

        {/* ── Per-line sections — each computed exactly as its NSM sees it ── */}
        {data.lines.map((line) => {
          const groups = buildSalesManagerPerformanceGroups(line.performance.members);
          return (
            <div className="border border-slate-200 bg-white" key={`${line.lineId ?? ""}-${line.lineName}`}>
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 bg-slate-900 px-5 py-4">
                <div>
                  <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-400">Line</p>
                  <h2 className="text-sm font-black uppercase tracking-[0.12em] text-white">{line.lineName}</h2>
                  <p className="mt-0.5 text-phx-xs text-slate-400">
                    NSM: {line.nsmName ?? "Seat vacant"} · {line.performance.teamMemberCount} reps · {groups.length} districts
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400">
                    {egp(line.performance.teamTotalSales)} / {egp(line.performance.teamTotalTarget)}
                  </p>
                  <p className={`text-xl font-black ${line.performance.teamAchievementPercent >= 90 ? "text-emerald-400" : line.performance.teamAchievementPercent >= 70 ? "text-amber-400" : "text-rose-400"}`}>
                    {line.performance.teamAchievementPercent.toFixed(1)}%
                  </p>
                </div>
              </div>
              <div className="space-y-5 p-4 sm:p-6">
                <TeamLeaderboardTable members={line.performance.members} />
                <PerformanceReconciliationNote
                  totalLabel="Line Sales"
                  unattributedSales={line.performance.unattributedSales}
                />
                {groups.map((group) => (
                  <details className="group border border-slate-100" key={group.managerHrId}>
                    <summary className="cursor-pointer bg-slate-50 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-600 hover:text-orange-700">
                      {/* "Vacant — Alex-BHR" already names the district (owner, 2026-10-20). */}
                      {group.isVacantSeat ? group.managerName : `${group.managerName} district`} — {group.members.length} reps ·{" "}
                      <span className={achievementColor(group.achievementPercent)}>
                        {group.achievementPercent.toFixed(1)}%
                      </span>
                    </summary>
                    <div className="p-4">
                      <WorkspaceErrorBoundary fallbackTitle="Product breakdown failed to render">
                        <TeamMembersBreakdown members={group.members} />
                      </WorkspaceErrorBoundary>
                    </div>
                  </details>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
