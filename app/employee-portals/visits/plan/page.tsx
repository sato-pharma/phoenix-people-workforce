import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { NativePlanWorkspace } from "@/components/employee-portal/native-plan-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function NativeWeeklyPlanPage() {
  const access = await resolveAccessContextFromPage();
  // A district manager holds create only for his rare single visits: he files no weekly plan.
  if (!(await canAccess(access, "crm_visit_entry", "create")) || (await canAccess(access, "crm_visit_entry", "approve"))) {
    redirect("/employee-portals/visits");
  }

  return (
    <EmployeePortalPageShell
      badge="Visits"
      description="Plan which doctors you will visit on each day of the pilot, AM or PM, and send the week to your manager."
      title="My Weekly Plan"
    >
      <NativePlanWorkspace />
    </EmployeePortalPageShell>
  );
}
