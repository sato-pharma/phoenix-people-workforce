import { redirect } from "next/navigation";

import { PlansWorkspace } from "@/components/employee-portal/plans-workspace";
import { PremiumHero } from "@/components/ui/premium-hero";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeePlansWorkspace } from "@/lib/weekly-planning/service";

export const dynamic = "force-dynamic";

export default async function AdminWeeklyPlansPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  const access = await resolveAccessContextFromPage();
  const canReadPlans = await canAccess(access, "weekly_plans", "read");
  if (!canReadPlans && access.role !== "CEO" && access.role !== "Super Admin") {
    redirect("/employee-portals");
  }

  const [workspace, params] = await Promise.all([
    getEmployeePlansWorkspace(access),
    searchParams,
  ]);
  const selectedPlanId = Array.isArray(params.plan) ? params.plan[0] : params.plan;

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Planning Workflow"
        title="Weekly / Monthly Plans"
        subtitle="Review manager-approved plans, finalize CEO decisions, and track HR acknowledgements after approval."
      />
      <PlansWorkspace
        access={access}
        basePath="/admin/weekly-plans"
        initialWorkspace={workspace}
        selectedPlanId={selectedPlanId ?? null}
      />
    </div>
  );
}
