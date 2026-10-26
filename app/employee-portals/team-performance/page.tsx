import Link from "next/link";
import { redirect } from "next/navigation";
import { Users, TrendingUp, Target, Award } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getDsmTeamPerformance } from "@/lib/employee-portal/service";
import { INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT } from "@/lib/incentives/eligibility-threshold";
import { toPeriodLabel } from "@/lib/employee-portal/period";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { PerformanceReconciliationNote } from "@/components/employee-portal/performance-reconciliation-note";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import {
  TeamAchievementChart,
  TeamSalesVsTargetChart,
  TeamLeaderboardTable,
  TeamMembersBreakdown,
} from "./team-members-breakdown-dynamic";

export const dynamic = "force-dynamic";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function pct(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(1) : "0.0"}%`;
}

export default async function EmployeePortalTeamPerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  // A Regional Manager's team is several districts, so his page is MRs Performance (owner,
  // 2026-10-20) — this one is the single-district view and used to tell him it was for District
  // Sales Managers only.
  if (access.role === "Regional Manager") {
    redirect("/employee-portals/med-reps-performance");
  }

  if (!(await canAccess(access, "sales", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Team performance is available for manager roles with sales access."
        title="Team Performance Unavailable"
      />
    );
  }

  const resolvedParams = await searchParams;
  const requestedPeriod = resolvedParams.period?.trim() ?? null;

  let data = null;
  try {
    data = await getDsmTeamPerformance(access, { period: requestedPeriod, creditRepsByTenure: true });
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/team-performance", module: "team-performance", role: access.role, hrId: access.hrId },
      error,
    );
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load your team&apos;s data. This page is only available for District Sales Managers."
        title="Team Performance Unavailable"
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

  // Validate requested period
  const validPeriod =
    requestedPeriod && periods.includes(requestedPeriod) ? requestedPeriod : null;

  // If a period was requested but is not in the data, redirect to clear view
  if (requestedPeriod && !validPeriod) {
    redirect("/employee-portals/team-performance");
  }

  const eligibleCount = members.filter((m) => m.achievementPercent >= INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT).length;

  return (
    <EmployeePortalPageShell
      badge="Team Performance"
      description={`${validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"} across ${
        teamMemberCount > 0 ? `${teamMemberCount} medical reps` : "no available team data"
      }.`}
      title="Team Performance"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={access.scope} />
      </div>
      <div className="space-y-6">
      {/* ── Page header + period filter ────────────────────────────────── */}
      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-orange-600">District Performance</p>
            <h2 className="mt-1 text-2xl font-semibold text-slate-900">Team Snapshot</h2>
            <p className="mt-1 text-sm text-slate-500">
              {validPeriod ? `Period: ${toPeriodLabel(validPeriod)}` : "All periods"}
              {" · "}
              {teamMemberCount > 0 ? `${teamMemberCount} medical reps` : "No team data"}
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
                href="/employee-portals/team-performance"
              >
                All periods
              </Link>
              {periods.map((period) => (
                <Link
                  key={period}
                  className={`rounded-xl border px-3 py-2 text-xs font-medium transition hover:bg-slate-50 ${
                    validPeriod === period
                      ? "bg-slate-900 text-white border-slate-900"
                      : "text-slate-600 border-slate-200 hover:text-slate-900"
                  }`}
                  href={`/employee-portals/team-performance?period=${period}`}
                >
                  {toPeriodLabel(period)}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* ── KPI cards ───────────────────────────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-slate-100 bg-gradient-to-br from-orange-50 to-amber-50 px-4 py-4">
            <div className="flex items-center gap-2 mb-1">
              <Award className="h-4 w-4 text-orange-500" />
              <p className="text-xs font-medium text-slate-500">Team Achievement</p>
            </div>
            {/* No "Avg" line under it (owner, 2026-10-23): a plain mean of the reps' own percentages
                read as a second, contradicting team figure — 28.2% beside 59.5% for Upper Egypt 2. */}
            <p className="text-2xl font-black text-slate-900">{pct(teamAchievementPercent)}</p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-slate-400" />
              <p className="text-xs font-medium text-slate-500">Total Sales</p>
            </div>
            <p className="text-2xl font-black text-slate-900">{egp(teamTotalSales)}</p>
            <p className="text-xs text-slate-400 mt-0.5">Combined team</p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-4">
            <div className="flex items-center gap-2 mb-1">
              <Target className="h-4 w-4 text-slate-400" />
              <p className="text-xs font-medium text-slate-500">Total Target</p>
            </div>
            <p className="text-2xl font-black text-slate-900">{egp(teamTotalTarget)}</p>
            <p className="text-xs text-slate-400 mt-0.5">Combined target</p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-4">
            <div className="flex items-center gap-2 mb-1">
              <Users className="h-4 w-4 text-slate-400" />
              <p className="text-xs font-medium text-slate-500">Incentive Eligible</p>
            </div>
            <p className="text-2xl font-black text-slate-900">
              {eligibleCount}
              <span className="text-base font-medium text-slate-400"> / {teamMemberCount}</span>
            </p>
            <p className="text-xs text-slate-400 mt-0.5">≥ {INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT}% achievement</p>
          </div>
        </div>

        {/* Reconciliation: Total Sales includes Direct Orders + vacant seats no rep below carries */}
        <PerformanceReconciliationNote
          className="mt-4 rounded-xl"
          totalLabel="Total Sales"
          unattributedSales={unattributedSales}
        />
      </Card>

      {members.length === 0 ? (
        // The shared empty state, not a hand-rolled card. This page already renders
        // EmployeePortalEmptyState twice above, for its two access refusals; a third shape doing
        // the same job was drift, and it carried a `rounded-3xl` that only the shell's
        // square-corner sweep was saving.
        <EmployeePortalEmptyState
          message={
            validPeriod
              ? `No records found for ${toPeriodLabel(validPeriod)}.`
              : "Sales data has not been uploaded yet."
          }
          title="No sales data"
        />
      ) : (
        <>
          {/* ── Charts ──────────────────────────────────────────────────── */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Achievement chart */}
            <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500 mb-1">Ranking</p>
              <h3 className="text-lg font-semibold text-slate-900 mb-4">Achievement Rate</h3>
              <TeamAchievementChart
                members={members}
                teamAchievementPercent={teamAchievementPercent}
              />
            </Card>

            {/* Sales vs Target chart */}
            <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500 mb-1">Comparison</p>
              <h3 className="text-lg font-semibold text-slate-900 mb-4">Sales vs Target</h3>
              <TeamSalesVsTargetChart members={members} />
            </Card>
          </div>

          {/* ── Full leaderboard table ───────────────────────────────────── */}
          <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Leaderboard</p>
                <h3 className="text-lg font-semibold text-slate-900">Full Rankings</h3>
              </div>
              <span className="text-xs text-phx-ink-soft bg-phx-paper px-3 py-1.5 rounded-full">
                {members.length} reps
              </span>
            </div>
            <TeamLeaderboardTable members={members} />
          </Card>

          {/* ── Per-rep product breakdown ────────────────────────────────── */}
          <div>
            <div className="mb-4">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Detailed View</p>
              <h3 className="text-lg font-semibold text-slate-900">Per-Rep Product Breakdown</h3>
              <p className="text-sm text-slate-400 mt-0.5">Tap any card to see the full product breakdown</p>
            </div>
            <TeamMembersBreakdown members={members} />
          </div>
        </>
      )}
      </div>
    </EmployeePortalPageShell>
  );
}
