import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { NativeVisitVacationDaysWorkspace } from "@/components/employee-portal/native-visit-vacation-days-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertVacationDayAccess } from "@/lib/crm/native-visits/vacation-days";

export const dynamic = "force-dynamic";

export default async function NativeVisitVacationDayRequestsPage() {
  const access = await resolveAccessContextFromPage();
  const allowed = await assertVacationDayAccess(access).then(
    () => true,
    () => false,
  );
  if (!allowed) redirect("/employee-portals/visits");

  return (
    <EmployeePortalPageShell
      badge="Visits"
      description="Asking to enter visits on a day HR approved as vacation. The day opens only when the manager and HR both approve."
      title="Vacation-Day Requests"
    >
      <NativeVisitVacationDaysWorkspace />
    </EmployeePortalPageShell>
  );
}
