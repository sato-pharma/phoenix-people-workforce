// KPIs — the portal twin of /admin/kpis, scoped to the viewer's own reach.
//
// This is the door a District Manager, Regional Manager, NSM, Product Manager or Medical Rep uses:
// app/(admin)/layout.tsx redirects every portal-mode role away from the admin shell before that
// page's gate could run, so both routes must exist for one board.
//
// SAME BOARD, SAME SCOPE, SAME GATE. Nothing here widens what the admin page shows — the reach is
// resolved from the live AccessContext by getDoctorCoverageScope inside getKpisBoard, so a District
// Manager gets his own reps whichever route he arrives by, and a Medical Rep gets only himself.
import { redirect } from "next/navigation";

import { KpisBoardView } from "@/components/crm/kpis-board-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoTodayIso } from "@/lib/crm/dates";
import { canSeeDoctorCoverage } from "@/lib/crm/doctor-coverage-roles";
import { getKpisBoard, kpiMonthOptions, kpiPeriodOptions } from "@/lib/crm/kpis-board";
import { resolveKpiTab } from "@/lib/crm/kpis-tabs";
import { resolveRepsPlansMonth } from "@/lib/crm/reps-plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PATH = "/employee-portals/kpis";

type PageProps = {
  searchParams?: Promise<{ month?: string; period?: string; tab?: string }>;
};

export default async function PortalKpisPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!canSeeDoctorCoverage(access.role)) redirect("/employee-portals");
  if (!(await canAccess(access, "crm_visits", "read"))) redirect("/employee-portals");

  const params = await searchParams;
  const today = cairoTodayIso();
  const month = resolveRepsPlansMonth(params?.month, today);
  const tab = resolveKpiTab(params?.tab);

  let board: Awaited<ReturnType<typeof getKpisBoard>> | null = null;
  let loadError: string | null = null;
  try {
    board = await getKpisBoard({ access, month, period: params?.period, todayIso: today });
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
    />
  );
}
