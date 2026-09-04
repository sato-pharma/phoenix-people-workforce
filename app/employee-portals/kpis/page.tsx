// KPIs — the portal twin of /admin/kpis, scoped to the viewer's own reach.
//
// This is the door a District Manager, Regional Manager, NSM, Product Manager or Medical Rep uses:
// app/(admin)/layout.tsx redirects every portal-mode role away from the admin shell before that
// page's gate could run, so both routes must exist for one board.
//
// SAME BOARD, SAME SCOPE, SAME GATE. Nothing here widens what the admin page shows — the reach is
// resolved from the live AccessContext by getDoctorCoverageScope inside getKpisBoard, so a District
// Manager gets his own reps whichever route he arrives by, and a Medical Rep gets only himself.
//
// ## IT IS A PORTAL PAGE, NOT THE ADMIN PAGE WITH THE REDIRECT SWAPPED
//
// It was the second of those until 2026-09-04: a copy of the admin body with `/admin` changed to
// `/employee-portals` and nothing else. Four things came with the copy, and each one is a portal
// convention this page was silently outside of — the audit that day found them by reading this page
// against its two siblings in the same Field Activity group, Reps List and Reps Plans:
//
//  1. NO PORTAL SHELL. The board drew the admin page header ("Field performance / KPIs" on white)
//     while every sibling drew the navy command header with the orange CRM badge. Inside one nav
//     group that reads as two different applications. The board now takes `chrome="portal"` and the
//     shell supplies the header; see the note on KpiHero in components/crm/kpis-board-view.tsx.
//  2. NO NAVIGATION-MODE GUARD. Both siblings bounce an admin-mode viewer to /overview so that a
//     seat which belongs in the admin shell cannot end up reading a portal-framed copy of a page it
//     owns a better door onto.
//  3. NO logPortalFailure. A KPI load failure left no row anywhere: this was one of the portal pages
//     whose load path is not instrumented, and the only one of these three.
//  4. A REDIRECT, AND A RAW ERROR STRING. The gate bounced to /employee-portals with no reason
//     given, and a load failure printed `error.message` — a Supabase or PostgREST sentence — to a
//     medical rep. Both now explain, in the siblings' own words and their own component. Inside the
//     ADMIN shell the redirect is right and stays: an unreachable page there should behave as if it
//     does not exist for that role. In the portal a person arrives from a bookmark or a shared link
//     and is owed a sentence.
//
// The whole selection rides in the URL, so every change re-runs the gate server-side.
import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { KpisBoardView } from "@/components/crm/kpis-board-view";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoTodayIso } from "@/lib/crm/dates";
import { canSeeDoctorCoverage } from "@/lib/crm/doctor-coverage-roles";
import { getKpisBoard, kpiMonthOptions, kpiPeriodOptions } from "@/lib/crm/kpis-board";
import { parseKpiFilters } from "@/lib/crm/kpis-filters";
import { resolveKpiTab } from "@/lib/crm/kpis-tabs";
import { resolveRepsPlansMonth } from "@/lib/crm/reps-plans";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PATH = "/employee-portals/kpis";

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

export default async function PortalKpisPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") redirect("/overview");

  // Unlike the admin page this EXPLAINS rather than redirects, exactly as both siblings do.
  if (!canSeeDoctorCoverage(access.role) || !(await canAccess(access, "crm_visits", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="KPIs is available to field seats with CRM access — it shows the call rate, coverage and frequency of the reps in your reach, and a medical rep's own three measures."
        title="KPIs Unavailable"
      />
    );
  }

  const params = await searchParams;
  const today = cairoTodayIso();
  const month = resolveRepsPlansMonth(one(params?.month), today);
  const tab = resolveKpiTab(one(params?.tab));
  const filters = parseKpiFilters(params ?? {});

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). A data failure renders a plain explanation, never a crash page — and never a
  // zero, which on this board would read as "every rep did nothing".
  let board: Awaited<ReturnType<typeof getKpisBoard>> | null = null;
  try {
    board = await getKpisBoard({ access, month, period: one(params?.period), todayIso: today, filters });
  } catch (error) {
    logPortalFailure({ hrId: access.hrId, module: "kpis", role: access.role, route: BASE_PATH }, error);
    board = null;
  }

  if (!board) {
    return (
      <EmployeePortalEmptyState
        message="KPIs could not load. The CRM mirror is unavailable right now — this is a load failure, not a month in which nobody called anyone."
        title="KPIs Unavailable"
      />
    );
  }

  return (
    // NO `description`. The owner asked for the bare title on 2026-09-04: the board's own verdict
    // line sits directly beneath this header and says what the month actually looks like, so a
    // standing sentence explaining what a KPI is only pushed the numbers further down the page.
    <EmployeePortalPageShell badge="CRM" title="KPIs">
      <KpisBoardView
        basePath={BASE_PATH}
        board={board}
        chrome="portal"
        monthOptions={kpiMonthOptions(today)}
        periodOptions={kpiPeriodOptions(month, today)}
        tab={tab}
      />
    </EmployeePortalPageShell>
  );
}
