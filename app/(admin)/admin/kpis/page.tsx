// KPIs — the owner's three field measures on one board, in four tabs.
//
// THIS IS THE REBUILD ordered on 2026-08-28, when Doctor Coverage and Rep Doctor Lists were retired
// with the instruction to "rebuild from the beginning". Their fault was two boards answering one
// question with disagreeing measures; this page assembles the measures that were already right and
// adds no fourth one. The retired routes stay as redirect stubs.
//
// The owner's specification, 2026-09-02: "a new tab in the sidebar of everyone who is applicable...
// called KPIs. In this page you will show four tabs. The first tab is the summary. The second tab is
// called call rate. The third tab is called coverage. The fourth tab is called frequency."
//
// WHO SEES WHAT is not decided here. src/lib/crm/doctor-coverage-roles.ts is the single role list
// and src/lib/crm/doctor-coverage-scope.ts resolves the reach — company for Super Admin/CEO/SFE,
// one line for NSM/PM/GPM, own team for Regional and District Managers, own panel for a Medical Rep.
// The board applies that scope to every row before returning it; the nav hiding a link is UX only.
//
// The whole selection rides in the URL, so every change re-runs the gate server-side.
import { redirect } from "next/navigation";

import { KpisBoardView } from "@/components/crm/kpis-board-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoTodayIso } from "@/lib/crm/dates";
import { canSeeDoctorCoverage } from "@/lib/crm/doctor-coverage-roles";
import { getKpisBoard, kpiMonthOptions, kpiPeriodOptions } from "@/lib/crm/kpis-board";
import { parseKpiFilters } from "@/lib/crm/kpis-filters";
import { resolveKpiTab } from "@/lib/crm/kpis-tabs";
import { getKpisTrend, type KpiTrend } from "@/lib/crm/kpis-trend";
import { KPI_TREND_PARAMS, resolveKpiTrendMetric, resolveKpiTrendScale } from "@/lib/crm/kpis-trend-options";
import { resolveRepsPlansMonth } from "@/lib/crm/reps-plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PATH = "/admin/kpis";

// The whole board rides in the URL — month, period, tab and every advanced filter — so the
// parameter bag is left open rather than enumerated. parseKpiFilters drops anything it does not
// recognise, so an unknown key can only ever be ignored, never widen what the gates above allow.
type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** First value only: a repeated `?tab=a&tab=b` must resolve to one tab, not to an array. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminKpisPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  // Two gates, both server-side: the explicit role list, then the permission matrix that is the real
  // security boundary. No access redirects rather than explaining — inside the admin shell an
  // unreachable page should behave as if it does not exist for that role.
  if (!canSeeDoctorCoverage(access.role)) redirect("/admin");
  if (!(await canAccess(access, "crm_visits", "read"))) redirect("/admin");

  const params = await searchParams;
  const today = cairoTodayIso();
  const month = resolveRepsPlansMonth(one(params?.month), today);
  const tab = resolveKpiTab(one(params?.tab));
  const filters = parseKpiFilters(params ?? {});
  // The Weekly tab's two switches. Resolved on every tab and ignored off it, so a stray value can only
  // ever fall back to its default.
  const trendScale = resolveKpiTrendScale(one(params?.[KPI_TREND_PARAMS.scale]));
  const trendMetric = resolveKpiTrendMetric(one(params?.[KPI_TREND_PARAMS.metric]));

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). A data failure renders a plain explanation, never a crash page — and never a
  // zero, which on this board would read as "every rep did nothing".
  let board: Awaited<ReturnType<typeof getKpisBoard>> | null = null;
  let trend: KpiTrend | null = null;
  let loadError: string | null = null;
  try {
    if (tab === "weekly") {
      // One board per week (or month) and the total they add up to — each one built through
      // getKpisBoard, so the scope gate runs for every column. Its anchor board drives the header.
      trend = await getKpisTrend({ access, scale: trendScale, month, todayIso: today, filters });
      board = trend.anchor;
    } else {
      board = await getKpisBoard({
        access,
        month,
        period: one(params?.period),
        todayIso: today,
        filters,
        // The Coverage and Frequency tabs' doctor lists — the open rep's list, the team's By brick table
        // and each row's not-validated count all ride on them. `rep` is only a request: getKpisBoard
        // honours it for a rep already on this viewer's board, and ignores it otherwise.
        coverageDoctors: tab === "coverage" || tab === "frequency" ? { rep: one(params?.rep) ?? null } : null,
      });
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "KPI data is unavailable.";
  }

  if (!board) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">KPIs could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  return (
    <KpisBoardView
      basePath={BASE_PATH}
      board={board}
      monthOptions={kpiMonthOptions(today)}
      periodOptions={kpiPeriodOptions(month, today)}
      tab={tab}
      trend={trend}
      trendMetric={trendMetric}
      trendScale={trendScale}
    />
  );
}
