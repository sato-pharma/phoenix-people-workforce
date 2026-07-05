import { redirect } from "next/navigation";

import { PlanRequestDetail } from "@/components/approvals-hub/plan-request-detail";
import { getPlanApprovalDetail } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminPlanApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/approvals/plan/${encodeURIComponent(id)}`);
  }
  const detail = await getPlanApprovalDetail(access, id);
  return (
    <div className="space-y-5">
      <PlanRequestDetail detail={detail} backHref="/admin/approvals/plan" />
    </div>
  );
}
