import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { PlanApprovalsBody } from "@/components/approvals-hub/plan-approvals-body";
import { getPlanWorkspaceData } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PortalPlanApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") redirect("/admin/approvals/plan");
  const data = await getPlanWorkspaceData(access);
  return (
    <EmployeePortalPageShell
      badge="Approvals Hub"
      title="Weekly / Monthly Plan Approvals"
      description="Plans waiting on your response, and your full response history."
    >
      <PlanApprovalsBody data={data} />
    </EmployeePortalPageShell>
  );
}
