import Link from "next/link";
import { redirect } from "next/navigation";
import { Users, TrendingUp, Target, Award, BarChart3 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getDsmTeamPerformance } from "@/lib/employee-portal/service";
import { toPeriodLabel } from "@/lib/employee-portal/period";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  TeamAchievementChart,
  TeamSalesVsTargetChart,
  TeamLeaderboardTable,
  TeamMembersBreakdown,
} from "../team-performance/team-members-breakdown.client";

export const dynamic = "force-dynamic";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

export default async function MedRepsPerformancePage({
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

  const data = await getDsmTeamPerformance(access, { period: requestedPeriod });

  if (!data) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <Users className="mx-auto h-10 w-10 text-slate-300 mb-3" />
        <p className="text-lg font-semibold text-slate-900">Performance Data Unavailable</p>
        <p className="mt-2 text-sm text-slate-500">
          Unable to load medical reps performance data for your line.
        </p>
      </div>
    );
  }

  const { members, periods, teamAchievementPercent, teamMemberCount, teamTotalSales, teamTotalTarget } = data;

  // Validate requested period
  const validPeriod =
    requestedPeriod && periods.includes(requestedPeriod) ? requestedPeriod : null;

  const eligibleCount = members.filter((m) => m.achievementPercent >= 90).length;

  // Group members by DSM
  const groupsMap = new Map<string, { managerName: string; members: typeof members }>();
  members.forEach((m) => {
    const managerId = m.managerHrId || "unassigned";
    const group = groupsMap.get(managerId) ?? { 
      managerName: m.managerName || "Unassigned District", 
      members: [] 
    };
    group.members.push(m);
    groupsMap.set(managerId, group);
  });

  const dsmGroups = Array.from(groupsMap.values()).sort((a, b) => 
    a.managerName.localeCompare(b.managerName)
  );

  return (
    <div className="space-y-10">
      {/* ── Page header + period filter ────────────────────────────────── */}
      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Line-wide Performance</p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">Medical Reps Performance</h1>
            <p className="mt-1 text-sm text-slate-500">
              {validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"}
              {" · "}
              {teamMemberCount > 0 ? `${teamMemberCount} medical reps in line` : "No data"}
            </p>
          </div>

          {/* Period filter buttons */}
          {periods.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Link
                className={`rounded-xl border px-3 py-2 text-xs font-medium transition hover:bg-slate-50 ${
                  !validPeriod
                    ? "bg-slate-900 text-white border-slate-900"
                    : "text-slate-600 border-slate-200 hover:text-slate-900"
                }`}
                href="/employee-portals/med-reps-performance"
              >
                All Periods
              </Link>
              {periods.slice(0, 5).map((p) => (
                <Link
                  key={p}
                  className={`rounded-xl border px-3 py-2 text-xs font-medium transition hover:bg-slate-50 ${
                    validPeriod === p
                      ? "bg-slate-900 text-white border-slate-900"
                      : "text-slate-600 border-slate-200 hover:text-slate-900"
                  }`}
                  href={`/employee-portals/med-reps-performance?period=${p}`}
                >
                  {toPeriodLabel(p)}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* ── Top stats ─────────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100">
            <div className="flex items-center gap-2 text-slate-500 mb-1">
              <Target className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Line Target</span>
            </div>
            <p className="text-xl font-bold text-slate-900">{egp(teamTotalTarget)}</p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100">
            <div className="flex items-center gap-2 text-slate-500 mb-1">
              <TrendingUp className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Line Sales</span>
            </div>
            <p className="text-xl font-bold text-slate-900">{egp(teamTotalSales)}</p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100">
            <div className="flex items-center gap-2 text-slate-500 mb-1">
              <Award className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Achievement</span>
            </div>
            <p className="text-xl font-bold text-slate-900">{teamAchievementPercent.toFixed(1)}%</p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100">
            <div className="flex items-center gap-2 text-slate-500 mb-1">
              <BarChart3 className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Eligible Reps</span>
            </div>
            <p className="text-xl font-bold text-slate-900">{eligibleCount} / {teamMemberCount}</p>
          </div>
        </div>
      </Card>

      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <h3 className="text-lg font-semibold text-slate-900 mb-6">Medical Reps Comparison</h3>
        <TeamLeaderboardTable members={members} />
      </Card>

      <div className="h-px w-full bg-slate-200 my-10" />

      <h2 className="text-2xl font-bold text-slate-900 px-2">District-Wise Performance</h2>
      <p className="text-sm text-slate-500 mb-8 px-2">Performance breakdown and product analysis grouped by District Sales Manager</p>

      {/* ── Grouped DSM Sections ────────────────────────────────────────── */}
      {dsmGroups.map((group) => {
        const groupTotalSales = group.members.reduce((s, m) => s + m.totalSales, 0);
        const groupTotalTarget = group.members.reduce((s, m) => s + m.totalTarget, 0);
        const groupAchievement = groupTotalTarget > 0 ? (groupTotalSales / groupTotalTarget) * 100 : 0;

        return (
          <div key={group.managerName} className="space-y-6">
            <div className="flex items-center gap-3 px-2">
              <div className="h-8 w-1 rounded-full bg-orange-500" />
              <div>
                <h2 className="text-xl font-bold text-slate-900">{group.managerName}</h2>
                <p className="text-sm text-slate-500">
                  District Performance: <span className="font-semibold text-slate-700">{groupAchievement.toFixed(1)}%</span>
                  {" · "}
                  {group.members.length} Medical Reps
                </p>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
                <h3 className="text-lg font-semibold text-slate-900 mb-6">District Achievement Ranking</h3>
                <TeamAchievementChart members={group.members} teamAchievementPercent={groupAchievement} />
              </Card>

              <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
                <h3 className="text-lg font-semibold text-slate-900 mb-6">District Sales vs Target</h3>
                <TeamSalesVsTargetChart members={group.members} />
              </Card>
            </div>

            <div className="pt-2">
              <h3 className="text-lg font-semibold text-slate-900 mb-4 px-2">Medical Reps Product Breakdown</h3>
              <TeamMembersBreakdown members={group.members} />
            </div>
            
            <div className="h-px w-full bg-slate-100 my-8" />
          </div>
        );
      })}
    </div>
  );
}
