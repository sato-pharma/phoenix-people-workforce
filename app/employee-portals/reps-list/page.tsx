// Reps List — the portal twin of the admin board, scoped to the manager's own team.
//
// The owner's specification, 2026-08-31: "every manager in the employee portal has a scoped reps
// list". Same board, same source, same cascade; the only difference is reach, and that difference is
// made once in src/lib/crm/doctor-list-access.ts rather than here — a Regional or District Manager
// resolves to `team` basis and sees his own reps, a company seat sees everyone.
//
// THE SCOPE IS NOT A FILTER APPLIED TO A WIDE BOARD. getRepsListBoard restricts the cascade tree
// before it derives an option, so a manager's dropdowns cannot offer a rep his rows would then
// refuse to show. That is the exact fault the owner caught on 2026-08-28 — scoped rows behind an
// unscoped picker — and the reason both entry points call one assembly function.
//
// ## THIS PAGE IS THE ONLY DOOR A DISTRICT MANAGER HAS TO PLAN VERIFICATION
//
// The Reps Weekly Plans tab (2026-09-01) matters more here than on the admin twin, because the seats
// that hold `crm_plans:approve` — District Manager and Regional Manager — are PORTAL seats.
// `/admin/plan-verification` lives in the admin shell, `app/(admin)/layout.tsx` redirects every
// portal-mode viewer out of it. Until this tab existed, the two roles the whole feature was written
// for could not reach the only screen that used their permission, leaving Super Admin the sole
// account able to press Verify. Nothing errored, which is why green CI and a clean deploy never
// showed it. The plan notification links to that admin page; a portal twin (audit, 2026-09-21) now
// forwards its recipients here — with `?plan` and `?week` carried — instead of to the portal home,
// and a `?plan` opens this tab (see the tab resolution below).
//
// ## THE CALL RATE MOVED TO KPIs
//
// It was a tab here for a few hours on 2026-09-21; the owner then took it off both shells ("since the
// call rate is already in the KPIs tab ... no need for it to be in the reps list tab in ... managers
// portals and in admin accounts"). This board is back to three tabs, and a bookmarked or hand-typed
// ?tab=call-rate forwards to /employee-portals/kpis?tab=call-rate for a viewer who can open KPIs, and
// falls to the contact list for one who cannot — never a refusal.
import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { RepsListBoardView } from "@/components/crm/reps-list-board";
import { RepsListTabs, resolveRepsListTab } from "@/components/crm/reps-list-tabs";
import { RepsListVacantAreasView } from "@/components/crm/reps-list-vacant-areas";
import { RepsWeeklyPlansBoardView } from "@/components/crm/reps-weekly-plans-board";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canSeeDoctorCoverage } from "@/lib/crm/doctor-coverage-roles";
import { canAccessDoctorList, canAccessMyList, getDoctorListScope } from "@/lib/crm/doctor-list-access";
import { kpisCallRateHref, PORTAL_KPIS_PATH } from "@/lib/crm/kpis-call-rate-route";
import { canAccessPlanVerification, getPlanVerificationScope } from "@/lib/crm/plan-verification-access";
import { getRepsListBoard } from "@/lib/crm/reps-list-board";
import { getVacantAreasBoard } from "@/lib/crm/reps-list-vacant-areas";
import { getRepsWeeklyPlansBoard } from "@/lib/crm/reps-weekly-plans-board";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PATH = "/employee-portals/reps-list";
const ROUTE = BASE_PATH;

type PageProps = {
  searchParams?: Promise<{
    area?: string;
    line?: string;
    month?: string;
    /** Carried to KPIs when an old `?tab=call-rate` link forwards there: `month`, `w1`…`w5`, or a range. */
    period?: string;
    plan?: string;
    region?: string;
    rep?: string;
    status?: string;
    tab?: string;
    vacancy?: string;
    week?: string;
  }>;
};

export default async function PortalRepsListPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") redirect("/overview");

  // A medical rep's door onto this board is My List, which opens their own list (2026-09-16).
  if (canAccessMyList(access)) redirect("/employee-portals/my-list");

  // Unlike the admin page this explains rather than redirects: a portal user who lands here from a
  // stale bookmark should be told the board is for manager seats, not bounced to the dashboard with
  // no reason given.
  if (!canAccessDoctorList(access) || !(await canAccess(access, "crm_visits", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Reps List is available to manager seats with CRM access — it shows the contact list of the reps who report to you."
        title="Reps List Unavailable"
      />
    );
  }

  const params = await searchParams;
  const cascade = { area: params?.area, line: params?.line, region: params?.region, rep: params?.rep };

  // The plans tab's own gate, strictly narrower than the one above. Passed INTO the tab resolver,
  // so a hand-typed `?tab=plans` from a seat without it lands on the contact list.
  const canSeePlans = canAccessPlanVerification(access) && (await canAccess(access, "crm_plans", "read"));
  // The call rate moved to KPIs (owner, 2026-09-21). An old link forwards there for a viewer who can
  // open KPIs, and falls to the contact list for one who cannot — never a refusal.
  if (params?.tab === "call-rate" && canSeeDoctorCoverage(access.role)) {
    redirect(
      kpisCallRateHref({ basePath: PORTAL_KPIS_PATH, query: { month: params?.month, period: params?.period } }),
    );
  }
  // A plan-verification notification links here with `?plan=` and no `?tab` (its admin twin forwards
  // the plan and week — see portal-twins.ts). Default such a link to the plans tab so the recipient
  // lands on the plan they were told about; resolveRepsListTab still gates `plans` on canSeePlans, so
  // a seat without it falls to the contact list rather than a refusal.
  const tab = resolveRepsListTab(params?.tab ?? (params?.plan ? "plans" : undefined), canSeePlans);

  // TAB THREE — VACANT AREAS (2026-09-14): the doctors of the areas with nobody in the seat, read
  // under the Reps List scope because they are the same lists the contact tab reads.
  if (tab === "vacant") {
    let vacantBoard: Awaited<ReturnType<typeof getVacantAreasBoard>> | null = null;
    try {
      const scope = await getDoctorListScope(access);
      vacantBoard = await getVacantAreasBoard({
        params: { ...cascade, month: params?.month, vacancy: params?.vacancy },
        scope,
      });
    } catch (error) {
      logPortalFailure({ hrId: access.hrId, module: "reps-list", role: access.role, route: ROUTE }, error);
      vacantBoard = null;
    }

    if (!vacantBoard) {
      return (
        <EmployeePortalEmptyState
          message="Vacant Areas could not load. The organogram or the CRM mirror is unavailable right now — this is a load failure, not a company with no vacant areas."
          title="Reps List Unavailable"
        />
      );
    }

    return (
      <EmployeePortalPageShell
        badge="CRM"
        description="Pick a vacant area to read the contact list its last rep left behind, grouped by the brick each contact sits in."
        title="Reps List"
      >
        <RepsListTabs
          active="vacant"
          basePath={BASE_PATH}
          canSeePlans={canSeePlans}
          selection={vacantBoard.selection}
          week={params?.week ?? null}
        />
        <RepsListVacantAreasView basePath={BASE_PATH} board={vacantBoard} />
      </EmployeePortalPageShell>
    );
  }

  if (tab === "plans") {
    // Hiding the button is UX. POST /api/phoenix-crm/plans/decide re-runs this check and checks the
    // viewer reviews the plan's territory, server-side, which is the boundary.
    const canApprove = await canAccess(access, "phoenix_crm", "approve");

    let plansBoard: Awaited<ReturnType<typeof getRepsWeeklyPlansBoard>> | null = null;
    try {
      // The PLAN scope, never the Reps List one — a district manager reaches the same reps either
      // way, but a National Sales Manager reads lists he may not sign, and that difference is the
      // whole reason there are two access modules.
      const scope = await getPlanVerificationScope(access);
      plansBoard = await getRepsWeeklyPlansBoard({
        params: { ...cascade, plan: params?.plan, status: params?.status, week: params?.week },
        scope,
      });
    } catch (error) {
      logPortalFailure({ hrId: access.hrId, module: "reps-list", role: access.role, route: ROUTE }, error);
      plansBoard = null;
    }

    if (!plansBoard) {
      return (
        <EmployeePortalEmptyState
          message="Reps Weekly Plans could not load. The CRM plan mirror is unavailable right now — this is a load failure, not a week nobody planned."
          title="Reps List Unavailable"
        />
      );
    }

    return (
      <EmployeePortalPageShell
        badge="CRM"
        description="Pick one of your reps and a week to read the plan they filed, and approve a week sent in Phoenix CRM."
        title="Reps List"
      >
        <RepsListTabs
          active="plans"
          basePath={BASE_PATH}
          canSeePlans={canSeePlans}
          selection={plansBoard.selection}
          week={plansBoard.week.key}
        />
        <RepsWeeklyPlansBoardView basePath={BASE_PATH} board={plansBoard} canApprove={canApprove} />
      </EmployeePortalPageShell>
    );
  }

  let board: Awaited<ReturnType<typeof getRepsListBoard>> | null = null;
  try {
    const scope = await getDoctorListScope(access);
    board = await getRepsListBoard({ params: { ...cascade, month: params?.month }, scope });
  } catch (error) {
    logPortalFailure({ hrId: access.hrId, module: "reps-list", role: access.role, route: ROUTE }, error);
    board = null;
  }

  if (!board) {
    return (
      <EmployeePortalEmptyState
        message="Reps List could not load. The CRM mirror is unavailable right now — this is a load failure, not an empty team."
        title="Reps List Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Filter to a line, region and area, then open a rep to see their own CRM contact list grouped by the brick each contact sits in."
      title="Reps List"
    >
      <RepsListTabs
        active="contacts"
        basePath={BASE_PATH}
        canSeePlans={canSeePlans}
        selection={board.selection}
        week={params?.week ?? null}
      />
      <RepsListBoardView basePath={BASE_PATH} board={board} />
    </EmployeePortalPageShell>
  );
}
