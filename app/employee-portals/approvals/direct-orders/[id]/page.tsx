import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrderRequestDetail } from "@/components/approvals-hub/direct-order-request-detail";
import { getDirectOrderApprovalDetail } from "@/lib/direct-orders/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PortalDirectOrderApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/admin/approvals/direct-orders/${encodeURIComponent(id)}`);
  }
  const detail = await getDirectOrderApprovalDetail(access, id);
  return (
    <EmployeePortalPageShell badge="Approvals Hub" title="Direct Order Approval" description="Review and respond to this direct order request.">
      <DirectOrderRequestDetail detail={detail} backHref="/employee-portals/approvals/direct-orders" />
    </EmployeePortalPageShell>
  );
}
