import { redirect } from "next/navigation";

import { DirectOrderRequestDetail } from "@/components/approvals-hub/direct-order-request-detail";
import { getDirectOrderApprovalDetail } from "@/lib/direct-orders/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminDirectOrderApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/approvals/direct-orders/${encodeURIComponent(id)}`);
  }
  const detail = await getDirectOrderApprovalDetail(access, id);
  return (
    <div className="space-y-5">
      <DirectOrderRequestDetail detail={detail} backHref="/admin/approvals/direct-orders" />
    </div>
  );
}
