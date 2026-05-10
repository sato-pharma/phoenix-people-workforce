import Link from "next/link";
import { redirect } from "next/navigation";
import { Award, BarChart3, ShieldCheck, Target, TrendingUp, Users } from "lucide-react";

import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { Card } from "@/components/ui/card";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { toPeriodLabel } from "@/lib/employee-portal/period";
import { getDsmTeamPerformance } from "@/lib/employee-portal/service";

import {
  TeamAchievementChart,
  TeamLeaderboardTable,
  TeamMembersBreakdown,
  TeamSalesVsTargetChart,
} from "../team-performance/team-members-breakdown.client";

export const dynamic = "force-dynamic";

const shellCardClass =
  "rounded-[30px] border border-orange-100/80 bg-white/95 shadow-[0_24px_70px_rgba(15,23,42,0.08)] ring-1 ring-slate-950/[0.03]";

const chartCardClass =
  "rounded-[28px] border border-orange-100/80 bg-white/96 p-6 shadow-[0_20px_56px_rgba(15,23,42,0.075)] ring-1 ring-slate-950/[0.03]";

const statCardClass =
  "group relative overflow-hidden rounded-[24px] border border-orange-100 bg-white/90 p-5 shadow-[0_16px_42px_rgba(15,23,42,0.065)] transition hover:-translate-y-1 hover:shadow-[0_24px_58px_rgba(249,115,22,0.13)]";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function periodHref(period: string | null) {
  return period ? `/employee-portals/med-reps-performance?period=${period}` : "/employee-portals/med-reps-performance";
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

  const { members, periods, teamAchievementPercent, teamMemberCount, teamTotalSales, teamTotalTarget } = data;
  const validPeriod = requestedPeriod && periods.includes(requestedPeriod) ? requestedPeriod : null;
  const eligibleCount = members.filter((member) => member.achievementPercent >= 90).length;

  const groupsMap = new Map<string, { managerName: string; members: typeof members }>();
  members.forEach((member) => {
    const managerId = member.managerHrId || "unassigned";
    const group = groupsMap.get(managerId) ?? {
      managerName: member.managerName || "Unassigned District",
      members: [],
    };
    group.members.push(member);
    groupsMap.set(managerId, group);
  });

  const dsmGroups = Array.from(groupsMap.values()).sort((left, right) => left.managerName.localeCompare(right.managerName));

  const stats = [
    { icon: Target, label: "Line Target", tone: "text-orange-600", value: egp(teamTotalTarget) },
    { icon: TrendingUp, label: "Line Sales", tone: "text-emerald-600", value: egp(teamTotalSales) },
    { icon: Award, label: "Achievement", tone: "text-amber-600", value: `${teamAchievementPercent.toFixed(1)}%` },
    { icon: Users, label: "Eligible Reps", tone: "text-sky-600", value: `${eligibleCount} / ${teamMemberCount}` },
  ];

  return (
    <div className="space-y-8 text-slate-950">
      <Card className={`${shellCardClass} relative overflow-hidden p-6 md:p-7`}>
        <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-orange-200/45 blur-3xl" />
        <div className="absolute -bottom-24 left-12 h-56 w-56 rounded-full bg-amber-100/70 blur-3xl" />
        <div className="relative mb-6 flex flex-wrap items-end justify-between gap-5">
          <div>
            <span className="inline-flex rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">
              Line-wide performance
            </span>
            <h1 className="mt-4 text-3xl font-black tracking-tight text-slate-950 md:text-4xl">Medical Reps Performance</h1>
            <p className="mt-2 max-w-2xl text-sm font-medium text-slate-600">
              {validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"}
              {" | "}
              {teamMemberCount > 0 ? `${teamMemberCount} medical reps in line` : "No data"}
            </p>
          </div>

          <div className="rounded-2xl border border-white/80 bg-white/80 px-4 py-3 text-right shadow-[0_14px_35px_rgba(15,23,42,0.07)]">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">Line achievement</p>
            <p className="mt-1 text-2xl font-black text-orange-600">{teamAchievementPercent.toFixed(1)}%</p>
          </div>
        </div>

        {periods.length > 0 ? (
          <div className="relative mb-6 flex flex-wrap items-center gap-2">
            {[null, ...periods.slice(0, 5)].map((period) => {
              const active = period === null ? !validPeriod : validPeriod === period;
              return (
                <Link
                  className={`rounded-2xl border px-3 py-2 text-xs font-black transition ${
                    active
                      ? "border-orange-500 bg-orange-500 text-white shadow-[0_14px_30px_rgba(249,115,22,0.26)]"
                      : "border-orange-100 bg-white/85 text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
                  }`}
                  href={periodHref(period)}
                  key={period ?? "all"}
                >
                  {period ? toPeriodLabel(period) : "All Periods"}
                </Link>
              );
            })}
          </div>
        ) : null}

        <div className="relative grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div className={statCardClass} key={stat.label}>
                <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-orange-100/70 blur-2xl transition group-hover:bg-orange-200/80" />
                <div className={`relative mb-3 inline-flex rounded-2xl border border-orange-100 bg-orange-50 p-2 ${stat.tone}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <p className="relative text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{stat.label}</p>
                <p className="relative mt-2 text-2xl font-black text-slate-950">{stat.value}</p>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className={`${shellCardClass} overflow-hidden p-6`}>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Leadership board</p>
            <h2 className="mt-1 text-xl font-black text-slate-950">Medical Reps Comparison</h2>
          </div>
          <div className="inline-flex items-center gap-2 rounded-2xl border border-orange-100 bg-orange-50 px-3 py-2 text-xs font-black text-orange-700">
            <BarChart3 className="h-4 w-4" />
            Ranked by performance
          </div>
        </div>
        <TeamLeaderboardTable members={members} />
      </Card>

      <section className="relative overflow-hidden rounded-[30px] border border-orange-100 bg-[linear-gradient(135deg,#fff7ed_0%,#ffffff_48%,#fff1e6_100%)] p-6 shadow-[0_22px_64px_rgba(15,23,42,0.075)]">
        <div className="absolute -right-16 -top-20 h-48 w-48 rounded-full bg-orange-200/45 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">DSM breakdown</p>
            <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">District-Wise Performance</h2>
            <p className="mt-2 max-w-2xl text-sm font-medium text-slate-600">
              Performance breakdown and product analysis grouped by District Sales Manager.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-2xl border border-white/80 bg-white/80 px-4 py-3 text-sm font-black text-slate-700 shadow-[0_14px_35px_rgba(15,23,42,0.07)]">
            <ShieldCheck className="h-4 w-4 text-orange-600" />
            {dsmGroups.length} districts
          </div>
        </div>
      </section>

      {dsmGroups.map((group) => {
        const groupTotalSales = group.members.reduce((sum, member) => sum + member.totalSales, 0);
        const groupTotalTarget = group.members.reduce((sum, member) => sum + member.totalTarget, 0);
        const groupAchievement = groupTotalTarget > 0 ? (groupTotalSales / groupTotalTarget) * 100 : 0;

        return (
          <section className="space-y-5" key={group.managerName}>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[26px] border border-orange-100 bg-white/92 px-5 py-4 shadow-[0_16px_42px_rgba(15,23,42,0.06)]">
              <div className="flex items-center gap-3">
                <div className="h-12 w-1.5 rounded-full bg-orange-500 shadow-[0_0_24px_rgba(249,115,22,0.45)]" />
                <div>
                  <h2 className="text-xl font-black text-slate-950">{group.managerName}</h2>
                  <p className="mt-1 text-sm font-medium text-slate-500">
                    District Performance: <span className="font-black text-slate-800">{groupAchievement.toFixed(1)}%</span>
                    {" | "}
                    {group.members.length} Medical Reps
                  </p>
                </div>
              </div>
              <div className="rounded-2xl border border-orange-100 bg-orange-50 px-4 py-2 text-right">
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-orange-600">District sales</p>
                <p className="mt-1 text-sm font-black text-slate-950">{egp(groupTotalSales)}</p>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card className={chartCardClass}>
                <h3 className="mb-6 text-lg font-black text-slate-950">District Achievement Ranking</h3>
                <TeamAchievementChart members={group.members} teamAchievementPercent={groupAchievement} />
              </Card>

              <Card className={chartCardClass}>
                <h3 className="mb-6 text-lg font-black text-slate-950">District Sales vs Target</h3>
                <TeamSalesVsTargetChart members={group.members} />
              </Card>
            </div>

            <Card className={`${shellCardClass} p-6`}>
              <div className="mb-5">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Product depth</p>
                <h3 className="mt-1 text-lg font-black text-slate-950">Medical Reps Product Breakdown</h3>
              </div>
              <TeamMembersBreakdown members={group.members} />
            </Card>
          </section>
        );
      })}
    </div>
  );
}
