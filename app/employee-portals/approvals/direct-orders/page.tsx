import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrderPortalApprovals } from "@/components/employee-portal/direct-order-portal-approvals";
import { getDirectOrderWorkspaceData } from "@/lib/direct-orders/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PortalDirectOrderApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") redirect("/admin/approvals/direct-orders");
  const data = await getDirectOrderWorkspaceData(access);
  return (
    <EmployeePortalPageShell
      badge="Approvals Hub"
      title="Direct Orders Approvals"
      description="Direct order requests waiting on your approval, and your full response history. This is the only place to approve direct orders."
    >
      <DirectOrderPortalApprovals data={data} backHrefBase="/employee-portals/approvals/direct-orders" />
    </EmployeePortalPageShell>
  );
}
