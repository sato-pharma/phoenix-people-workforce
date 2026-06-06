import { redirect } from "next/navigation";

import { PlansWorkspace } from "@/components/employee-portal/plans-workspace";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeePlansWorkspace } from "@/lib/weekly-planning/service";

export const dynamic = "force-dynamic";

export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  await assertPermission(access, "employee_profile", "read");

  const canReadPlans = await canAccess(access, "weekly_plans", "read");
  if (!canReadPlans && access.role !== "CEO" && access.role !== "Super Admin") {
    return (
      <EmployeePortalEmptyState
        message="Your position is not enabled for weekly/monthly planning."
        title="Planning Unavailable"
      />
    );
  }

  const workspace = await getEmployeePlansWorkspace(access);
  const params = await searchParams;
  const selectedPlanId = Array.isArray(params.plan) ? params.plan[0] : params.plan;

  return (
    <EmployeePortalPageShell
      badge="Weekly / Monthly Plan"
      description="Submit structured weekly and monthly plans, route approvals through your manager and CEO, and sync approved activities to Google Calendar."
      title="Weekly / Monthly Plan"
    >
      <PlansWorkspace
        access={access}
        initialWorkspace={workspace}
        selectedPlanId={selectedPlanId ?? null}
      />
    </EmployeePortalPageShell>
  );
}
