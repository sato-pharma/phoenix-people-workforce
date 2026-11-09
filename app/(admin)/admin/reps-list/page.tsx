// Reps List — READ-ONLY board inside the Phoenix admin shell, in four tabs.
//
// The owner's specification, 2026-08-31: filter by line, then the line's regions appear, then the
// region, then the area and the medical rep; click the rep and "all his customers, his contact list"
// appear, "grouped by bricks". This page is the admin/SFE door; the portal twin at
// /employee-portals/reps-list is the same board scoped to a manager's own team.
//
// TAB TWO — REPS WEEKLY PLANS — was added on 2026-09-01, in his words: "another tab called Reps
// Weekly Plans... I can filter by medical rep name, and then I can choose the week, either
// historical or in the future. If historical, I see the status of this plan — was it verified or no.
// And if it will be not yet, I have a verify button that every district manager can verify his
// medical reps plan." One picker, two questions about the same rep.
//
// IT REPLACES /admin/doctor-list, which now redirects here. Same source (the CRM's own contact list,
// not visits), same access module, one board — the owner asked for the old one and its District
// Manager tab to be retired rather than left beside this as a second door onto the same data.
//
// THE TWO TABS DO NOT SHARE A GATE, and must not. Reps List admits National Sales Manager and SFE
// Manager; plan verification deliberately admits neither, because reading a rep's list and signing
// his plan are not the same authority. So the plans tab is gated separately here, the tab strip
// offers no plans tab to a viewer holding only the first, and a hand-typed `?tab=plans` falls back
// to the contact list rather than explaining what it is refusing.
//
// TAB THREE — VACANT AREAS — was added on 2026-09-14 ("the doctors list in vacant areas exactly as
// the other tab"). It reads the same lists under the same Reps List gate and scope, so every viewer
// of the contact tab gets it. Assembly: src/lib/crm/reps-list-vacant-areas.ts.
//
// THE CALL RATE WAS A TAB HERE for a few hours on 2026-09-21, then the owner took it off: "since the
// call rate is already in the KPIs tab ... no need for it to be in the reps list tab in ... managers
// portals and in admin accounts." So this board is back to THREE tabs, and a hand-typed or bookmarked
// ?tab=call-rate forwards to /admin/kpis?tab=call-rate for a viewer who can open KPIs (the same
// board that scores the rate), and falls to the contact list for one who cannot.
//
// Nothing about WHO may open this lives in this file. The role lists and the scopes are in
// src/lib/crm/doctor-list-access.ts and src/lib/crm/plan-verification-access.ts; the assemblies are
// in src/lib/crm/reps-list-board.ts and src/lib/crm/reps-weekly-plans-board.ts — both of which
// restrict the cached company-wide cascade tree BEFORE deriving a single dropdown option, because a
// picker is never wider than its viewer.
//
// The whole selection rides in the URL, so every change re-runs both gates server-side.
import { redirect } from "next/navigation";

import { RepsListBoardView } from "@/components/crm/reps-list-board";
import { RepsListTabs, resolveRepsListTab } from "@/components/crm/reps-list-tabs";
import { RepsListVacantAreasView } from "@/components/crm/reps-list-vacant-areas";
import { RepsWeeklyPlansBoardView } from "@/components/crm/reps-weekly-plans-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canSeeDoctorCoverage } from "@/lib/crm/doctor-coverage-roles";
import { canAccessDoctorList, getDoctorListScope } from "@/lib/crm/doctor-list-access";
import { ADMIN_KPIS_PATH, kpisCallRateHref } from "@/lib/crm/kpis-call-rate-route";
import { canAccessPlanVerification, getPlanVerificationScope } from "@/lib/crm/plan-verification-access";
import { getRepsListBoard } from "@/lib/crm/reps-list-board";
import { countVacantAreas, getVacantAreasBoard } from "@/lib/crm/reps-list-vacant-areas";
import { getRepsWeeklyPlansBoard } from "@/lib/crm/reps-weekly-plans-board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PATH = "/admin/reps-list";

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

function LoadFailure({ message }: { message: string | null }) {
  return (
    <div className="border border-rose-200 bg-rose-50 px-5 py-4">
      <p className="text-sm font-bold text-rose-800">Reps List could not load.</p>
      <p className="mt-1 text-xs text-rose-700">{message}</p>
    </div>
  );
}

export default async function RepsListPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  // Two gates, both server-side: the explicit role list, then the permission matrix that is the real
  // security boundary. No access redirects rather than explaining — inside the admin shell an
  // unreachable page should behave as if it does not exist for that role.
  if (!canAccessDoctorList(access)) redirect("/admin");
  if (!(await canAccess(access, "crm_visits", "read"))) redirect("/admin");

  const params = await searchParams;
  const cascade = { area: params?.area, line: params?.line, region: params?.region, rep: params?.rep };

  // The plans tab's own gate, passed INTO the tab resolver so an unauthorised `?tab=plans` lands on
  // the contact list instead of a refusal.
  const canSeePlans = canAccessPlanVerification(access) && (await canAccess(access, "crm_plans", "read"));
  // The call rate moved to KPIs (owner, 2026-09-21). An old link forwards there for a viewer who can
  // open KPIs, and falls to the contact list for one who cannot — never a refusal.
  if (params?.tab === "call-rate" && canSeeDoctorCoverage(access.role)) {
    redirect(
      kpisCallRateHref({ basePath: ADMIN_KPIS_PATH, query: { month: params?.month, period: params?.period } }),
    );
  }
  const tab = resolveRepsListTab(params?.tab, canSeePlans);

  // TAB THREE — VACANT AREAS, added 2026-09-14: the doctors of the areas with nobody in the seat,
  // read under the Reps List scope because they are the same lists.
  if (tab === "vacant") {
    let vacantBoard: Awaited<ReturnType<typeof getVacantAreasBoard>> | null = null;
    let vacantError: string | null = null;
    try {
      const scope = await getDoctorListScope(access);
      vacantBoard = await getVacantAreasBoard({
        params: { ...cascade, month: params?.month, vacancy: params?.vacancy },
        scope,
      });
    } catch (error) {
      vacantError = error instanceof Error ? error.message : "Vacant Areas data is unavailable.";
    }

    return (
      <>
        <RepsListTabs
          active="vacant"
          basePath={BASE_PATH}
          canSeePlans={canSeePlans}
          selection={vacantBoard?.selection ?? cascade}
          week={params?.week ?? null}
        />
        {vacantBoard ? (
          <RepsListVacantAreasView basePath={BASE_PATH} board={vacantBoard} />
        ) : (
          <LoadFailure message={vacantError} />
        )}
      </>
    );
  }

  if (tab === "plans") {
    // Read separately from `crm_plans:read`: more seats may READ a plan than may approve one. This
    // hides the button; POST /api/phoenix-crm/plans/decide re-checks it, which is the boundary — an
    // absent button is UX, never the control.
    const canApprove = await canAccess(access, "phoenix_crm", "approve");

    // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
    // inside try/catch). A data failure renders a plain explanation, never a crash page.
    let plansBoard: Awaited<ReturnType<typeof getRepsWeeklyPlansBoard>> | null = null;
    let plansError: string | null = null;
    try {
      // The PLAN scope, never the Reps List one. They are different reaches on purpose.
      const scope = await getPlanVerificationScope(access);
      plansBoard = await getRepsWeeklyPlansBoard({
        params: { ...cascade, plan: params?.plan, status: params?.status, week: params?.week },
        scope,
      });
    } catch (error) {
      plansError = error instanceof Error ? error.message : "Reps List data is unavailable.";
    }

    // The "Vacant seats" key card (owner, 2026-11-09): read under the Reps List scope and the board's own
    // cascade, exactly as the Vacant Areas tab it opens. Its failure costs the card a number, never the board.
    let vacantSeats: number | null = null;
    if (plansBoard) {
      try {
        vacantSeats = await countVacantAreas({ params: plansBoard.selection, scope: await getDoctorListScope(access) });
      } catch {
        vacantSeats = null;
      }
    }

    return (
      <>
        {/* The strip renders even when the board below it failed, so a manager can step back to the
            contact list rather than being stranded on an error. */}
        <RepsListTabs
          active="plans"
          basePath={BASE_PATH}
          canSeePlans={canSeePlans}
          selection={plansBoard?.selection ?? cascade}
          week={plansBoard?.week.key ?? params?.week ?? null}
        />
        {plansBoard ? (
          <RepsWeeklyPlansBoardView basePath={BASE_PATH} board={plansBoard} canApprove={canApprove} vacantSeats={vacantSeats} />
        ) : (
          <LoadFailure message={plansError} />
        )}
      </>
    );
  }

  let board: Awaited<ReturnType<typeof getRepsListBoard>> | null = null;
  let loadError: string | null = null;
  try {
    // The scope comes from the live AccessContext, never from the query string — a role read off a
    // URL would let any viewer name himself Super Admin and take the company branch.
    const scope = await getDoctorListScope(access);
    board = await getRepsListBoard({ params: { ...cascade, month: params?.month }, scope });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Reps List data is unavailable.";
  }

  return (
    <>
      <RepsListTabs
        active="contacts"
        basePath={BASE_PATH}
        canSeePlans={canSeePlans}
        selection={board?.selection ?? cascade}
        week={params?.week ?? null}
      />
      {board ? <RepsListBoardView basePath={BASE_PATH} board={board} /> : <LoadFailure message={loadError} />}
    </>
  );
}
