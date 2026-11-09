// One KPI report on a page of its own, in the employee portal — Frequency, Coverage or Call Rate.
//
// The owner split the portal's KPIs page on 2026-10-14: KPIs became a heading in the sidebar with the
// consolidated page and these three reports beneath it, each a measure told in as much detail as the
// data allows. The board is the same KpisBoardView the KPIs page and the admin shell render, so a number
// here is the number there; what changes is the tab strip (none — the page IS the measure), the tiles
// (only the report's own) and the detail under each rep.
//
// SAME GATES AS THE KPIs PAGE, and for the same reasons (see app/employee-portals/kpis/page.tsx): an
// admin-mode viewer is bounced to /overview, a refusal and a load failure EXPLAIN inside the portal
// shell, a failure leaves a row, and a raw error string never reaches the screen. The reach is resolved
// from the live AccessContext inside getKpisBoard on every load, so a district manager gets his own reps
// and a Medical Rep only himself, whichever of these pages he arrives at.
import { redirect } from "next/navigation";

import { BackToPreviousPage } from "@/components/crm/back-to-previous-page";
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { KpisBoardView } from "@/components/crm/kpis-board-view";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoTodayIso } from "@/lib/crm/dates";
import { canSeeDoctorCoverage } from "@/lib/crm/doctor-coverage-roles";
import { getKpisBoard, kpiMonthOptions, kpiPeriodOptions } from "@/lib/crm/kpis-board";
import { parseKpiFilters } from "@/lib/crm/kpis-filters";
import { PORTAL_KPIS_ROOT_PATH, PORTAL_KPI_REPORT_PATH, resolveKpiCallRateView, type KpiReportTab } from "@/lib/crm/kpis-tabs";
import { resolveRepsPlansMonth } from "@/lib/crm/reps-plans";
import { logPortalFailure } from "@/lib/observability/portal-logging";

/** The page title, and what the report is about in a sentence for the refusal. */
const REPORT_TITLE: Record<KpiReportTab, string> = {
  frequency: "Frequency",
  coverage: "Coverage",
  "call-rate": "Call Rate",
};

type SearchParams = Record<string, string | string[] | undefined>;

/** First value only: a repeated `?month=a&month=b` must resolve to one value, not to an array. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function PortalKpiReportPage({
  report,
  searchParams,
}: {
  report: KpiReportTab;
  searchParams?: Promise<SearchParams>;
}) {
  const title = REPORT_TITLE[report];
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") redirect("/overview");

  if (!canSeeDoctorCoverage(access.role) || !(await canAccess(access, "crm_visits", "read"))) {
    return (
      <EmployeePortalPageShell badge="CRM" title={title}>
        <EmployeePortalEmptyState
          message={`${title} is available to field seats with CRM access — it shows the reps in your reach, and a medical rep's own figures.`}
          title={`${title} Unavailable`}
        />
      </EmployeePortalPageShell>
    );
  }

  const params = await searchParams;
  const today = cairoTodayIso();
  const month = resolveRepsPlansMonth(one(params?.month), today);
  const filters = parseKpiFilters(params ?? {});
  const callRateView = report === "call-rate" ? resolveKpiCallRateView(one(params?.view)) : "total";
  const basePath = PORTAL_KPI_REPORT_PATH[report];

  // Data fetch and JSX stay separated (react-hooks/error-boundaries). A data failure renders a plain
  // explanation, never a crash page — and never a zero, which here would read as "every rep did nothing".
  let board: Awaited<ReturnType<typeof getKpisBoard>> | null = null;
  try {
    board = await getKpisBoard({
      access,
      month,
      period: one(params?.period),
      todayIso: today,
      filters,
      // The doctor lists belong to Coverage and Frequency, one rep at a time. `rep` is only a request:
      // getKpisBoard honours it for a rep already on this viewer's board and ignores it otherwise.
      coverageDoctors: report === "call-rate" ? null : { rep: one(params?.rep) ?? null },
      // The AM·PM and Pharmacies reports belong to the KPIs page; nothing here prints them.
      includeReports: false,
    });
  } catch (error) {
    logPortalFailure({ hrId: access.hrId, module: "kpis", role: access.role, route: basePath }, error);
    board = null;
  }

  if (!board) {
    return (
      <EmployeePortalPageShell badge="CRM" title={title}>
        <EmployeePortalEmptyState
          message={`${title} could not load. The CRM mirror is unavailable right now — this is a load failure, not a month in which nobody called anyone.`}
          title={`${title} Unavailable`}
        />
      </EmployeePortalPageShell>
    );
  }

  return (
    <EmployeePortalPageShell badge="CRM" title={title}>
      {/* A rep opened on Coverage or Frequency gets "Back" to the page he was pressed on (owner, 2026-11-09). */}
      {report !== "call-rate" && one(params?.rep) ? <BackToPreviousPage fallbackHref={PORTAL_KPI_REPORT_PATH[report]} /> : null}
      <KpisBoardView
        basePath={basePath}
        board={board}
        callRateView={callRateView}
        chrome="portal"
        monthOptions={kpiMonthOptions(today)}
        periodOptions={kpiPeriodOptions(month, today)}
        rootPath={PORTAL_KPIS_ROOT_PATH}
        tab={report}
        tabs={[]}
      />
    </EmployeePortalPageShell>
  );
}
