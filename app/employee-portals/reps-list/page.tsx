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
import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { RepsListBoardView } from "@/components/crm/reps-list-board";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessDoctorList, getDoctorListScope } from "@/lib/crm/doctor-list-access";
import { getRepsListBoard } from "@/lib/crm/reps-list-board";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ area?: string; line?: string; region?: string; rep?: string }>;
};

export default async function PortalRepsListPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") redirect("/overview");

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

  let board: Awaited<ReturnType<typeof getRepsListBoard>> | null = null;
  try {
    const scope = await getDoctorListScope(access);
    board = await getRepsListBoard({
      params: { area: params?.area, line: params?.line, region: params?.region, rep: params?.rep },
      scope,
    });
  } catch (error) {
    logPortalFailure(
      { hrId: access.hrId, module: "reps-list", role: access.role, route: "/employee-portals/reps-list" },
      error,
    );
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
      description="Filter to a line, region and area, then open a rep to see his own CRM contact list grouped by the brick each contact sits in."
      title="Reps List"
    >
      <RepsListBoardView basePath="/employee-portals/reps-list" board={board} />
    </EmployeePortalPageShell>
  );
}
