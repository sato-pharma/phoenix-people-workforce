import Link from "next/link";
import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MyVisitsWorkspace } from "@/components/employee-portal/my-visits-workspace";
import { buttonVariants } from "@/components/ui/button";
import { canAccess, normalizeHrIdForAccess, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getContactListAvailability } from "@/lib/crm/contact-lists/service";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { addDaysIso, todayIso } from "@/lib/crm/dates";
import { getVacationDayRequestAvailability } from "@/lib/crm/native-visits/vacation-days";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { phoenixCrmEntryAvailable } from "@/lib/phoenix-crm/server/sidebar-entries";
import { isWithinManagerHierarchy, reportsToManagerSeat } from "@/lib/workforce/hierarchy-resolver";
import { fetchMyCheckins, fetchMyDoubleVisits, fetchMyVisits, fetchTeamVisits } from "@/lib/employee-portal/my-crm-visits";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { buildMyVisitsView } from "@/lib/employee-portal/my-visits-view";
import type {
  MyCrmCheckinRow,
  MyCrmDoubleVisitRow,
  MyCrmVisitRow,
  TeamCrmVisitRow,
} from "@/lib/employee-portal/my-crm-visits";

export const dynamic = "force-dynamic";

/**
 * The people whose visits this viewer may see in the Team Visits tab: their own reporting subtree,
 * excluding themselves (their own visits are the other tabs).
 *
 * `hierarchy` roles (Regional Manager) get every level beneath them — the reps who actually log the
 * visits report to a District Manager, so a one-level rule would show an RM nothing useful. `team`
 * roles (District Manager / Manager) get their direct reports, which for a DSM already IS their reps.
 * Everyone else resolves to an empty list and the tab does not render.
 *
 * Seat-continuity aware via isWithinManagerHierarchy, so a district whose manager seat is mid
 * replacement is not silently dropped.
 *
 * The National Sales Manager is `line`-scoped, so the subtree rule above gave him an empty tab while
 * every DSM and RM beneath him had one (owner, 2026-10-20: every role that applies must appear). He
 * gets his own line's people through the doctor-coverage line scope — the downward rule's chain cut
 * and seat-rank ladder, plus any line override — so a peer or a manager above him never lands in it.
 */
async function resolveVisitsTeamHrIds(access: AccessContext): Promise<string[]> {
  if (access.role === "National Sales Manager") {
    const viewerKey = normalizeHrIdForAccess(access.hrId);
    if (!viewerKey) return [];
    const lineScope = await getDoctorCoverageScope(access);
    if (lineScope.kind !== "agents") return [];
    return lineScope.agentHrIds.filter((hrId) => normalizeHrIdForAccess(hrId) !== viewerKey);
  }
  if (access.scope !== "hierarchy" && access.scope !== "team") return [];
  const viewerKey = normalizeHrIdForAccess(access.hrId);
  if (!viewerKey) return [];

  const directory = await getEmployeeDirectory();
  const byCanonicalHrId = new Map<string, EmployeeDirectoryRow>();
  for (const row of directory.employees) {
    const key = normalizeHrIdForAccess(row.hrId);
    if (key) byCanonicalHrId.set(key, row);
  }

  return directory.employees
    .filter((row) => normalizeHrIdForAccess(row.hrId) !== viewerKey)
    .filter((row) =>
      access.scope === "hierarchy"
        ? isWithinManagerHierarchy({
            employee: row,
            byCanonicalHrId,
            viewerCanonicalHrId: viewerKey,
            canonicalize: normalizeHrIdForAccess,
          })
        : reportsToManagerSeat({ employee: row, viewerCanonicalHrId: viewerKey, canonicalize: normalizeHrIdForAccess }),
    )
    .map((row) => row.hrId);
}

type PageProps = { searchParams?: Promise<{ tab?: string | string[]; page?: string | string[] }> };

export default async function MyVisitsPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "crm_visits", "read"))) {
    redirect("/employee-portals");
  }

  const hrId = access.hrId;
  if (!hrId) {
    redirect("/employee-portals");
  }

  const dateTo = todayIso();
  const dateFrom = addDaysIso(dateTo, -90);
  const window = { dateFrom, dateTo };

  let visits: MyCrmVisitRow[] = [];
  let doubleVisits: MyCrmDoubleVisitRow[] = [];
  let checkins: MyCrmCheckinRow[] = [];
  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): the viewer's own visits,
  // the Team Visits tab and the three link checks read nothing from one another, so all three batches
  // run at once instead of one after another. Each keeps its own failure handling exactly as before,
  // attached where it starts so no batch's failure waits unhandled on another.
  const [own, teamVisits, [phoenixCrm, vacationDays, doctorList]] = await Promise.all([
    // A load failure is LOGGED, and the rep reads a sentence — never `error.message`, which on this path
    // is a Supabase or PostgREST string (the same fix the KPIs page carries).
    Promise.all([
      fetchMyVisits(hrId, window),
      fetchMyDoubleVisits(hrId, window),
      fetchMyCheckins(hrId, window),
    ]).catch((error: unknown) => {
      logPortalFailure({ hrId, module: "visits", role: access.role, route: "/employee-portals/visits" }, error);
      return null;
    }),
    // Team Visits — a manager's own people. Resolved HERE, never inside the CRM helper: fetchTeamVisits
    // takes the hrId set as an explicit argument and fails closed on an empty one, so the scope decision
    // stays visible at the call site. A Medical Rep resolves to nobody and the tab never renders.
    resolveVisitsTeamHrIds(access)
      .then((teamHrIds): Promise<TeamCrmVisitRow[]> | TeamCrmVisitRow[] =>
        teamHrIds.length > 0 ? fetchTeamVisits(teamHrIds, window) : [],
      )
      // The manager view is additive — never let it break the viewer's own visits.
      .catch((): TeamCrmVisitRow[] => []),
    // None of these three throws, so the viewer's own visits always render.
    // The vacation-day requests link (CRM phase 6, rule 9) appears only once the cutover date is set.
    // The doctor-list link (CRM phase 7) likewise appears only once the cutover date is set.
    // Phoenix CRM (the owner, 2026-09-16) holds customer lists, weekly plans, visits and reports, built
    // clean in Phoenix: one button, for the reps and managers of a line that has opened. It replaced the
    // 2026-09-14 pilot's button, which the owner asked to hide when this module shipped; the old visit and
    // plan addresses now land in it too.
    Promise.all([
      phoenixCrmEntryAvailable(access),
      getVacationDayRequestAvailability(access),
      getContactListAvailability(access),
    ]),
  ]);
  const loadFailed = own === null;
  if (own) [visits, doubleVisits, checkins] = own;
  // SLIM (owner, 12 Nov 2026, "slim My Visits"): every tab's count, and only the 25 rows on screen.
  // The whole window used to travel to the phone — 956 KB for one rep — to show 25 of them.
  // See src/lib/employee-portal/my-visits-view.ts.
  const params = (await searchParams) ?? {};
  const view = buildMyVisitsView({ visits, doubleVisits, checkins, teamVisits, tab: params.tab, page: params.page });
  const showNativeLinks = phoenixCrm || vacationDays.show || doctorList.show;

  return (
    // One badge for the whole Field Activity group: the sidebar section's own title.
    <EmployeePortalPageShell
      badge="Field Activity"
      description={
        view.hasTeam
          ? "Your own field visits, double visits, GPS check-ins — and your team's visits — from the last 90 days."
          : "Your own field visits, double visits, and GPS check-ins from the last 90 days."
      }
      title="My Visits"
    >
      {showNativeLinks ? (
        <div className="flex flex-wrap gap-2">
          {phoenixCrm ? (
            <Link className={buttonVariants({ variant: "default" })} href="/employee-portals/field-crm">
              Phoenix CRM
            </Link>
          ) : null}
          {vacationDays.show ? (
            <Link className={buttonVariants({ variant: "outline" })} href="/employee-portals/visits/vacation-day-requests">
              {vacationDays.waitingForYou > 0
                ? `Vacation-day requests (${vacationDays.waitingForYou} waiting)`
                : "Vacation-day requests"}
            </Link>
          ) : null}
          {doctorList.show ? (
            <Link className={buttonVariants({ variant: "outline" })} href="/employee-portals/visits/doctor-list">
              {doctorList.canRequest
                ? "My doctor list"
                : doctorList.waitingForYou > 0
                  ? `Doctor list requests (${doctorList.waitingForYou} waiting)`
                  : "Doctor list requests"}
            </Link>
          ) : null}
        </div>
      ) : null}
      {loadFailed ? (
        <p className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          Your visits could not load just now. This is a loading problem, not an empty record — refresh the page in a
          minute.
        </p>
      ) : null}
      <MyVisitsWorkspace dateFrom={dateFrom} dateTo={dateTo} view={view} />
    </EmployeePortalPageShell>
  );
}
