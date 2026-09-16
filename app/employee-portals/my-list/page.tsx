// My List — a Medical Rep's own contact list: Reps List at a rep's reach.
//
// The owner's instruction, 2026-09-16: "show in medical reps accounts the reps-list scoped to
// everyone scope and call is My List". Every seat reads the board at its own reach; a manager's
// reach is their reps and a rep's is the rep alone, so this page opens one list and offers no picker.
//
// THE REACH IS THE SESSION'S HR ID, AND NOTHING ELSE. `getMyListScope` reads no URL parameter, so a
// hand-typed `?rep=` cannot open anyone else's list — there is no parameter here that names a rep.
//
// A SEPARATE PAGE, NOT A RELABELLED REPS LIST. The portal nav registry holds one entry per href, and
// the manager board's role list is pinned as reviewed (doctor-list-roles.ts), so the rep's door is
// its own route with its own gate. The two pages send each other's viewers across: a rep who lands
// on Reps List is sent here, and a manager who lands here is sent to Reps List.
import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MyListBoardView } from "@/components/crm/reps-list-board";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessDoctorList, canAccessMyList, getMyListScope } from "@/lib/crm/doctor-list-access";
import { getMyListBoard } from "@/lib/crm/reps-list-board";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PATH = "/employee-portals/my-list";
const ROUTE = BASE_PATH;

type PageProps = {
  searchParams?: Promise<{ month?: string }>;
};

export default async function PortalMyListPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") redirect("/overview");

  // A manager's door onto the same board is Reps List, where their reps are.
  if (canAccessDoctorList(access) && !canAccessMyList(access)) redirect("/employee-portals/reps-list");

  if (!canAccessMyList(access) || !(await canAccess(access, "crm_visits", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="My List is available to medical reps with CRM access — it shows your own CRM contact list, grouped by brick."
        title="My List Unavailable"
      />
    );
  }

  const params = await searchParams;

  let board: Awaited<ReturnType<typeof getMyListBoard>> | null = null;
  try {
    board = await getMyListBoard({ params: { month: params?.month }, scope: getMyListScope(access) });
  } catch (error) {
    logPortalFailure({ hrId: access.hrId, module: "my-list", role: access.role, route: ROUTE }, error);
    board = null;
  }

  if (!board) {
    return (
      <EmployeePortalEmptyState
        message="My List could not load. The CRM mirror is unavailable right now — this is a load failure, not an empty list."
        title="My List Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Your own CRM contact list, grouped by the brick each contact sits in, with this month's plan and visits beside each contact."
      title="My List"
    >
      <MyListBoardView basePath={BASE_PATH} board={board} />
    </EmployeePortalPageShell>
  );
}
