import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { ExcuseRequestDetail } from "@/components/approvals-hub/excuse-request-detail";
import { getExcuseApprovalDetail } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PortalExcuseApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/admin/approvals/excuse/${encodeURIComponent(id)}`);
  }
  const detail = await getExcuseApprovalDetail(access, id);
  return (
    <EmployeePortalPageShell badge="Approvals Hub" title="Excuse Approval" description="Review and respond to this excuse request.">
      <ExcuseRequestDetail detail={detail} backHref="/employee-portals/approvals/excuse" />
    </EmployeePortalPageShell>
  );
}
