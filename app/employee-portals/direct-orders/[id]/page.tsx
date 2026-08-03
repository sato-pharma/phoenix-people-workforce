import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrderPortalDetail } from "@/components/employee-portal/direct-order-portal-detail";
import { getDirectOrderApprovalDetail } from "@/lib/direct-orders/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/**
 * Portal mirror of the requester's tracking view — see the admin route for why there is no extra
 * permission gate. Same component, same payload, same detail the approver sees; only the framing
 * and the back link differ.
 */
export default async function PortalMyDirectOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/admin/direct-orders/${encodeURIComponent(id)}`);
  }
  const detail = await getDirectOrderApprovalDetail(access, id);
  return (
    <EmployeePortalPageShell
      badge="Direct Orders"
      title="My Direct Order"
      description="Track this request: every detail your approvers see, and exactly which rung it is waiting on."
    >
      <DirectOrderPortalDetail
        detail={detail}
        backHref="/employee-portals/direct-orders"
        backLabel="Back to My Direct Orders"
      />
    </EmployeePortalPageShell>
  );
}
