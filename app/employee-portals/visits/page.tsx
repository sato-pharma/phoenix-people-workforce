import Link from "next/link";
import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MyVisitsWorkspace } from "@/components/employee-portal/my-visits-workspace";
import { buttonVariants } from "@/components/ui/button";
import { canAccess, normalizeHrIdForAccess, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getContactListAvailability } from "@/lib/crm/contact-lists/service";
import { addDaysIso, todayIso } from "@/lib/crm/dates";
import { getPhoenixCrmAccess } from "@/lib/crm/native-visits/phoenix-crm";
import { getVacationDayRequestAvailability } from "@/lib/crm/native-visits/vacation-days";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { isWithinManagerHierarchy, reportsToManagerSeat } from "@/lib/workforce/hierarchy-resolver";
import { fetchMyCheckins, fetchMyDoubleVisits, fetchMyVisits, fetchTeamVisits } from "@/lib/employee-portal/my-crm-visits";
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
 */
async function resolveVisitsTeamHrIds(access: AccessContext): Promise<string[]> {
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

export default async function MyVisitsPage() {
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
  let teamVisits: TeamCrmVisitRow[] = [];
  let loadError: string | null = null;
  try {
    [visits, doubleVisits, checkins] = await Promise.all([
      fetchMyVisits(hrId, window),
      fetchMyDoubleVisits(hrId, window),
      fetchMyCheckins(hrId, window),
    ]);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Visit data failed to load.";
  }

  // Team Visits — a manager's own people. Resolved HERE, never inside the CRM helper: fetchTeamVisits
  // takes the hrId set as an explicit argument and fails closed on an empty one, so the scope decision
  // stays visible at the call site. A Medical Rep resolves to nobody and the tab never renders.
  try {
    const teamHrIds = await resolveVisitsTeamHrIds(access);
    if (teamHrIds.length > 0) teamVisits = await fetchTeamVisits(teamHrIds, window);
  } catch {
    // The manager view is additive — never let it break the viewer's own visits.
    teamVisits = [];
  }

  // Native visit entry and weekly plans (the pilot). Offered to a pilot-line rep, and to a manager a
  // rep has named on a visit or sent a plan to. Neither throws, so the viewer's own visits always render.
  // The vacation-day requests link (CRM phase 6, rule 9) appears only once the cutover date is set.
  // The doctor-list link (CRM phase 7) likewise appears only once the cutover date is set.
  // The Super Admin enters visits for reps and reads every rep's saved visits (the owner, 2026-09-14).
  // Phoenix CRM (the owner, 2026-09-14) now holds visit entry, weekly plans, confirmations, plan reviews
  // and entry for reps in its own space: one button, for the Super Admin, the pilot reps and their managers.
  const [phoenixCrm, vacationDays, doctorList] = await Promise.all([
    getPhoenixCrmAccess(access),
    getVacationDayRequestAvailability(access),
    getContactListAvailability(access),
  ]);
  const showNativeLinks = phoenixCrm.seat != null || vacationDays.show || doctorList.show;

  return (
    <EmployeePortalPageShell
      badge="Visits"
      description={
        teamVisits.length > 0
          ? "Your own field visits, double visits, GPS check-ins — and your team's visits — from the last 90 days."
          : "Your own field visits, double visits, and GPS check-ins from the last 90 days."
      }
      title="My Visits"
    >
      {showNativeLinks ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {phoenixCrm.seat ? (
            <Link className={buttonVariants({ variant: "default" })} href="/employee-portals/phoenix-crm">
              {phoenixCrm.waiting > 0 ? `Phoenix CRM (${phoenixCrm.waiting} waiting)` : "Phoenix CRM"}
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
      {loadError ? (
        <p className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>
      ) : null}
      <MyVisitsWorkspace
        checkins={checkins}
        dateFrom={dateFrom}
        dateTo={dateTo}
        doubleVisits={doubleVisits}
        teamVisits={teamVisits}
        visits={visits}
      />
    </EmployeePortalPageShell>
  );
}
