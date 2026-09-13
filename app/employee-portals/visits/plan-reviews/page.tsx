import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { NativePlanReviewsWorkspace } from "@/components/employee-portal/native-plan-reviews-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function NativePlanReviewsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "crm_visit_entry", "approve"))) {
    redirect("/employee-portals/visits");
  }

  return (
    <EmployeePortalPageShell
      badge="Visits"
      description="Weekly plans your reps sent you during the pilot. Verify a plan, or return it with a note saying what to change."
      title="Plan Reviews"
    >
      <NativePlanReviewsWorkspace />
    </EmployeePortalPageShell>
  );
}
