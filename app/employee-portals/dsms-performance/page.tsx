import Link from "next/link";
import { redirect } from "next/navigation";
import { Users, TrendingUp, Target, Award, BarChart3, BriefcaseBusiness } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getNsmDsmPerformance } from "@/lib/employee-portal/service";
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
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <BriefcaseBusiness className="mx-auto h-10 w-10 text-slate-300 mb-3" />
        <p className="text-lg font-semibold text-slate-900">DSMs Performance Data Unavailable</p>
        <p className="mt-2 text-sm text-slate-500">
          Unable to load district managers performance data for your line.
        </p>
      </div>
    );
  }

  const { dsms, periods, lineAchievementPercent, dsmCount, lineTotalSales, lineTotalTarget } = data;

  // Validate requested period
  const validPeriod =
    requestedPeriod && periods.includes(requestedPeriod) ? requestedPeriod : null;

  const eligibleCount = dsms.filter((d) => d.achievementPercent >= 90).length;

  return (
    <div className="space-y-6">
      {/* ── Page header + period filter ────────────────────────────────── */}
      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-500">District Managers View</p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">DSMs Performance</h1>
            <p className="mt-1 text-sm text-slate-500">
              {validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"}
              {" · "}
              {dsmCount > 0 ? `${dsmCount} district managers in line` : "No data"}
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
                href="/employee-portals/dsms-performance"
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
                  href={`/employee-portals/dsms-performance?period=${p}`}
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
            <p className="text-xl font-bold text-slate-900">{egp(lineTotalTarget)}</p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100">
            <div className="flex items-center gap-2 text-slate-500 mb-1">
              <TrendingUp className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Line Sales</span>
            </div>
            <p className="text-xl font-bold text-slate-900">{egp(lineTotalSales)}</p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100">
            <div className="flex items-center gap-2 text-slate-500 mb-1">
              <Award className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Achievement</span>
            </div>
            <p className="text-xl font-bold text-slate-900">{lineAchievementPercent.toFixed(1)}%</p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100">
            <div className="flex items-center gap-2 text-slate-500 mb-1">
              <BarChart3 className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Eligible DSMs</span>
            </div>
            <p className="text-xl font-bold text-slate-900">{eligibleCount} / {dsmCount}</p>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
          <h3 className="text-lg font-semibold text-slate-900 mb-6">DSM Achievement Ranking</h3>
          <TeamAchievementChart members={dsms} teamAchievementPercent={lineAchievementPercent} />
        </Card>

        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
          <h3 className="text-lg font-semibold text-slate-900 mb-6">DSM Sales vs Target</h3>
          <TeamSalesVsTargetChart members={dsms} />
        </Card>
      </div>

      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <h3 className="text-lg font-semibold text-slate-900 mb-6">DSMs Leaderboard</h3>
        <TeamLeaderboardTable members={dsms} />
      </Card>

      <div className="mt-8">
        <h3 className="text-xl font-bold text-slate-900 mb-6 px-2">DSMs Product Comparison</h3>
        <TeamMembersBreakdown members={dsms} />
      </div>
    </div>
  );
}
