import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MyVisitsWorkspace } from "@/components/employee-portal/my-visits-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { addDaysIso, todayIso } from "@/lib/crm/dates";
import { fetchMyCheckins, fetchMyJointVisits, fetchMyVisits } from "@/lib/employee-portal/my-crm-visits";
import type { MyCrmCheckinRow, MyCrmJointVisitRow, MyCrmVisitRow } from "@/lib/employee-portal/my-crm-visits";

export const dynamic = "force-dynamic";

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
  let jointVisits: MyCrmJointVisitRow[] = [];
  let checkins: MyCrmCheckinRow[] = [];
  let loadError: string | null = null;
  try {
    [visits, jointVisits, checkins] = await Promise.all([
      fetchMyVisits(hrId, window),
      fetchMyJointVisits(hrId, window),
      fetchMyCheckins(hrId, window),
    ]);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Visit data failed to load.";
  }

  return (
    <EmployeePortalPageShell
      badge="Visits"
      description="Your own field visits, joint visits, and GPS check-ins from the last 90 days."
      title="My Visits"
    >
      {loadError ? (
        <p className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>
      ) : null}
      <MyVisitsWorkspace checkins={checkins} dateFrom={dateFrom} dateTo={dateTo} jointVisits={jointVisits} visits={visits} />
    </EmployeePortalPageShell>
  );
}
