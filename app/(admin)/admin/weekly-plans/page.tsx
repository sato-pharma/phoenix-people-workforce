import { redirect } from "next/navigation";

import { adminHeroDescriptionClassName, adminHeroKickerClassName, adminHeroSurfaceClassName, adminHeroTitleClassName } from "@/components/admin/admin-design-tokens";
import { PlansWorkspace } from "@/components/employee-portal/plans-workspace";
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
      <section className={`${adminHeroSurfaceClassName} p-6 sm:p-7`}>
        <div className="relative z-10 space-y-3">
          <p className={adminHeroKickerClassName}>Planning Workflow</p>
          <h1 className={adminHeroTitleClassName}>Weekly / Monthly Plans</h1>
          <p className={adminHeroDescriptionClassName}>
            Review manager-approved plans, finalize CEO decisions, and track HR acknowledgements after approval.
          </p>
        </div>
      </section>
      <PlansWorkspace
        access={access}
        basePath="/admin/weekly-plans"
        initialWorkspace={workspace}
        selectedPlanId={selectedPlanId ?? null}
      />
    </div>
  );
}
