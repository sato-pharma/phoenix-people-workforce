import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { PlanRequestDetail } from "@/components/approvals-hub/plan-request-detail";
import { getPlanApprovalDetail } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PortalPlanApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/admin/approvals/plan/${encodeURIComponent(id)}`);
  }
  const detail = await getPlanApprovalDetail(access, id);
  return (
    <EmployeePortalPageShell badge="Approvals Hub" title="Plan Approval" description="Review and respond to this weekly / monthly plan.">
      <PlanRequestDetail detail={detail} backHref="/employee-portals/approvals/plan" />
    </EmployeePortalPageShell>
  );
}
