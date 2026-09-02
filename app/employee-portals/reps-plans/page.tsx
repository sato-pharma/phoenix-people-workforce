// Reps Plans — the portal twin of /admin/reps-plans, scoped to the manager's own team.
//
// ## WHY A TWIN EXISTS AT ALL
//
// The board was Super Admin only until 2026-09-03, and the note in src/lib/crm/reps-plans-access.ts
// said widening it was "one entry in the list plus the roles array on the nav item". It was not.
// The two seats the owner wanted on it — Regional Manager and District Manager — are PORTAL seats,
// and app/(admin)/layout.tsx redirects a portal-mode viewer out of the admin shell BEFORE the admin
// page's own gate could run. Adding the entry alone would have shipped green, deployed cleanly, and
// been reachable by nobody; zero usage and a working feature look identical from the outside. This
// page is the door.
//
// Same board, same builder, same shaping as the admin twin. The only difference is reach, and that
// difference is made by getDoctorCoverageScope — the same resolver the KPIs board asks — so a
// district manager's team cannot mean one set of reps here and another one there.
//
// THE SCOPE IS NOT A FILTER ON A WIDE BOARD. buildRepsPlansBoard applies it to the rows AND to the
// rep picker built from them, in one pass, before any tile is totalled. Scoping rows behind an
// unscoped picker is the fault the owner caught on 2026-08-28 — a cached filter tree offered a
// Medical Rep the names of all ~73 reps — and it is why both entry points call one function.
import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { RepsPlansBoardView } from "@/components/crm/reps-plans-board";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadCallRateReport, loadJobTitlesByHrId, loadRepNamesByHrId } from "@/lib/crm/call-rate-service";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { loadOrgPlacementTree } from "@/lib/crm/org-placement-data";
import { buildRepsPlansBoard, repsPlansRange, repsPlansWeeks, resolveRepsPlansMonth } from "@/lib/crm/reps-plans";
import { canAccessRepsPlans } from "@/lib/crm/reps-plans-access";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PATH = "/employee-portals/reps-plans";

type PageProps = {
  searchParams?: Promise<{
    line?: string;
    month?: string;
    /** `month` (default), `w1`…`w5`, or an explicit `YYYY-MM-DD..YYYY-MM-DD`. */
    period?: string;
    region?: string;
    rep?: string;
  }>;
};

export default async function PortalRepsPlansPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") redirect("/overview");

  // Unlike the admin page this EXPLAINS rather than redirects. A portal user who lands here from a
  // stale bookmark or a shared link should be told the board is for manager seats, not bounced to
  // the dashboard with no reason given.
  if (!canAccessRepsPlans(access) || !(await canAccess(access, "crm_visits", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Reps Plans is available to manager seats with CRM access — it shows the call rate of the reps who report to you, reported twice: what each one recorded, and what the check-ins prove."
        title="Reps Plans Unavailable"
      />
    );
  }

  const params = await searchParams;
  const today = cairoTodayIso();
  const month = resolveRepsPlansMonth(params?.month, today);
  // The window bounds the FETCH as well as the caption, so a week's rate is a week's calls over a
  // week's working days (owner, 2026-08-28).
  const range = repsPlansRange(month, today, params?.period);
  const weekOptions = repsPlansWeeks(month, today);

  let board: Awaited<ReturnType<typeof buildRepsPlansBoard>> | null = null;
  try {
    // The organogram and the two directory reads degrade to a poorer board and are caught
    // individually, exactly as on the admin twin. The SCOPE is not caught: it degrades to a WIDER
    // board, and a scope that failed must take the page down rather than quietly show this manager
    // every rep in the company.
    const scope = await getDoctorCoverageScope(access);
    const [report, repNameByHrId, jobTitleByHrId, tree] = await Promise.all([
      loadCallRateReport({ dateFrom: range.dateFrom, dateTo: range.dateTo }),
      loadRepNamesByHrId().catch(() => undefined),
      loadJobTitlesByHrId().catch(() => undefined),
      loadOrgPlacementTree().catch(() => null),
    ]);
    board = buildRepsPlansBoard(report, {
      geography: { line: params?.line ?? null, region: params?.region ?? null },
      isCurrentMonth: range.isCurrentMonth,
      jobTitleByHrId,
      month,
      range,
      repKey: params?.rep ?? null,
      repNameByHrId,
      scope,
      tree,
      weekOptions,
    });
  } catch (error) {
    logPortalFailure({ hrId: access.hrId, module: "reps-plans", role: access.role, route: BASE_PATH }, error);
    board = null;
  }

  if (!board) {
    return (
      <EmployeePortalEmptyState
        message="Reps Plans could not load. The CRM visit mirror is unavailable right now — this is a load failure, not a team that recorded nothing."
        title="Reps Plans Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Two AM accounts and ten PM clinics every working day, for each of your reps — what he recorded, and what the GPS check-ins prove."
      title="Reps Plans"
    >
      <RepsPlansBoardView basePath={BASE_PATH} board={board} />
    </EmployeePortalPageShell>
  );
}
