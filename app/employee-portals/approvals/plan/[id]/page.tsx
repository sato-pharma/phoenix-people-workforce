import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { ManagerPlanRequestDetail } from "@/components/approvals-hub/manager-plan-request-detail";
import { PlanRequestDetail } from "@/components/approvals-hub/plan-request-detail";
import { getPlanApprovalDetail } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadManagerPlanHubDetail } from "@/lib/phoenix-crm/server/manager-plan-hub";

export const dynamic = "force-dynamic";

export default async function PortalPlanApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/admin/approvals/plan/${encodeURIComponent(id)}`);
  }
  const detail = await getPlanApprovalDetail(access, id);
  // Not a legacy plan: a district manager's Phoenix CRM week, his ask to edit it, or his ask to take a
  // customer off his own list (owner, 2026-10-16 — decided here, in the Hub).
  if (detail.notFound) {
    const crm = await loadManagerPlanHubDetail(access, id);
    if (crm.kind !== "not_found") {
      return (
        <EmployeePortalPageShell badge="Approvals Hub" title="Plan Approval" description="Review and respond to this district manager's weekly plan.">
          <ManagerPlanRequestDetail detail={crm} backHref="/employee-portals/approvals/plan" plannerHref="/employee-portals/field-crm?tab=plan" />
        </EmployeePortalPageShell>
      );
    }
  }
  return (
    <EmployeePortalPageShell badge="Approvals Hub" title="Plan Approval" description="Review and respond to this weekly / monthly plan.">
      <PlanRequestDetail detail={detail} backHref="/employee-portals/approvals/plan" />
    </EmployeePortalPageShell>
  );
}
