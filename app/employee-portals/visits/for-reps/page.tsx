import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { NativeVisitForRepWorkspace } from "@/components/employee-portal/native-visit-for-rep-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// The portal twin of /admin/visit-entry: the Super Admin enters a visit for a rep and reads every rep's
// saved visits (the owner, 2026-09-14).
export default async function VisitsForRepsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "crm_visit_entry", "update"))) {
    redirect("/employee-portals/visits");
  }

  return (
    <EmployeePortalPageShell
      badge="Visits"
      description="Enter a visit for a rep on any open day, to any doctor on the rep's list. It saves with no location, marked as entered by the Super Admin, and the rep is told in the app."
      title="Visits for Reps"
    >
      <NativeVisitForRepWorkspace />
    </EmployeePortalPageShell>
  );
}
