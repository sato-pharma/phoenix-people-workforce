import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { NativeVisitConfirmationsWorkspace } from "@/components/employee-portal/native-visit-confirmations-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function NativeVisitConfirmationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "crm_visit_entry", "approve"))) {
    redirect("/employee-portals/visits");
  }

  return (
    <EmployeePortalPageShell
      badge="Visits"
      description="Visits your reps entered in Phoenix during the pilot that name you as accompanying them."
      title="Visit Confirmations"
    >
      <NativeVisitConfirmationsWorkspace />
    </EmployeePortalPageShell>
  );
}
