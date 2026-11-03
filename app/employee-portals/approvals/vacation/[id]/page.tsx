import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { VacationRequestDetail } from "@/components/approvals-hub/vacation-request-detail";
import { getVacationApprovalDetail, getWhoElseIsOffForApprovalDetail } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PortalVacationApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/admin/approvals/vacation/${encodeURIComponent(id)}`);
  }
  const detail = await getVacationApprovalDetail(access, id);
  const whoElseIsOff = await getWhoElseIsOffForApprovalDetail(access, detail);
  return (
    <EmployeePortalPageShell badge="Approvals Hub" title="Vacation Approval" description="Review and respond to this leave request.">
      <VacationRequestDetail detail={detail} backHref="/employee-portals/approvals/vacation" whoElseIsOff={whoElseIsOff} />
    </EmployeePortalPageShell>
  );
}
