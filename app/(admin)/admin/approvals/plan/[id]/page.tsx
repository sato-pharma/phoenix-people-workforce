import { redirect } from "next/navigation";

import { ManagerPlanRequestDetail } from "@/components/approvals-hub/manager-plan-request-detail";
import { PlanRequestDetail } from "@/components/approvals-hub/plan-request-detail";
import { getPlanApprovalDetail } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadManagerPlanHubDetail } from "@/lib/phoenix-crm/server/manager-plan-hub";

export const dynamic = "force-dynamic";

export default async function AdminPlanApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/admin/approvals/plan/[id]");
  const { id } = await params;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/approvals/plan/${encodeURIComponent(id)}`);
  }
  const detail = await getPlanApprovalDetail(access, id);
  // Not a legacy plan: a district manager's Phoenix CRM week, his ask to edit it, or his ask to take a
  // customer off his own list (owner, 2026-10-16 — decided here, in the Hub).
  if (detail.notFound) {
    const crm = await loadManagerPlanHubDetail(access, id);
    if (crm.kind !== "not_found") {
      return (
        <div className="space-y-5">
          <ManagerPlanRequestDetail detail={crm} backHref="/admin/approvals/plan" plannerHref="/admin/field-crm?tab=plan" />
        </div>
      );
    }
  }
  return (
    <div className="space-y-5">
      <PlanRequestDetail detail={detail} backHref="/admin/approvals/plan" />
    </div>
  );
}
