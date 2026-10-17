import { redirect } from "next/navigation";

import { PlansHistory } from "@/components/employee-portal/plans-history";
import { PlansWorkspace } from "@/components/employee-portal/plans-workspace";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { hrIdsMatch } from "@/lib/hr-id";
import { getEmployeePlansWorkspace } from "@/lib/weekly-planning/service";

export const dynamic = "force-dynamic";

export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  const canReadProfile = await canAccess(access, "employee_profile", "read");
  const canReadPlans = await canAccess(access, "weekly_plans", "read");
  if (
    !canReadProfile ||
    (!canReadPlans && access.role !== "CEO" && access.role !== "Super Admin")
  ) {
    return (
      <EmployeePortalEmptyState
        message="Your position is not enabled for weekly/monthly planning."
        title="Planning Unavailable"
      />
    );
  }

  const params = await searchParams;
  const selectedPlanId = Array.isArray(params.plan) ? params.plan[0] : params.plan;
  // A manager whose Phoenix CRM team is live plans his week there now (owner, 2026-10-16). This page stays
  // open to him as the HISTORY of the plans he filed here before, to read only (owner, 2026-10-17: "make it
  // unhidden, but make them not able to submit … only able to see their historical plans").
  const workspace = await getEmployeePlansWorkspace(access);
  const ownPlans = workspace.plans.filter((plan) => hrIdsMatch(plan.employeeHrId, workspace.currentEmployee?.hrId));
  // A link to somebody ELSE's plan (an approver's notice) still opens the full review workspace — the
  // history below is only ever his own plans.
  const openedPlan = selectedPlanId ? workspace.plans.find((plan) => plan.id === selectedPlanId) ?? null : null;
  const reviewsSomeoneElse = openedPlan !== null && !ownPlans.some((plan) => plan.id === openedPlan.id);

  if (workspace.plansInPhoenixCrm && !reviewsSomeoneElse) {
    return (
      <EmployeePortalPageShell
        badge="Weekly / Monthly Plan"
        description="The plans you filed here before your week moved to Phoenix CRM. They are kept to read only."
        title="Weekly / Monthly Plan history"
      >
        <PlansHistory openPlanId={openedPlan?.id ?? null} plans={ownPlans} />
      </EmployeePortalPageShell>
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Weekly / Monthly Plan"
      description="Submit structured weekly and monthly plans and route approvals through your manager, CEO, and HR."
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
