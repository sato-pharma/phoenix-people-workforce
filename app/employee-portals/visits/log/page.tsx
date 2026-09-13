import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { NativeVisitEntryWorkspace } from "@/components/employee-portal/native-visit-entry-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function LogVisitPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "crm_visit_entry", "create"))) {
    redirect("/employee-portals/visits");
  }

  return (
    <EmployeePortalPageShell
      badge="Visits"
      description="Enter today's or yesterday's visits. A visit saved with no signal waits on your phone and sends itself when you are back online."
      title="Log a Visit"
    >
      <NativeVisitEntryWorkspace />
    </EmployeePortalPageShell>
  );
}
