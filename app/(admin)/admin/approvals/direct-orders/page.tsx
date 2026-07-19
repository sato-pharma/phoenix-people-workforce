import { redirect } from "next/navigation";
import { ReceiptText } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DirectOrderApprovalsBody } from "@/components/approvals-hub/direct-order-approvals-body";
import { getDirectOrderWorkspaceData } from "@/lib/direct-orders/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminDirectOrderApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/approvals/direct-orders");
  const data = await getDirectOrderWorkspaceData(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Approvals Hub"
        title="Direct Orders Approvals"
        description="Direct order requests waiting on your approval, and your full response history. This is the only place to approve direct orders."
        icon={<ReceiptText className="h-3.5 w-3.5" />}
      />
      <DirectOrderApprovalsBody data={data} backHrefBase="/admin/approvals/direct-orders" />
    </div>
  );
}
