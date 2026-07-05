import { redirect } from "next/navigation";

import { VacationRequestDetail } from "@/components/approvals-hub/vacation-request-detail";
import { getVacationApprovalDetail } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminVacationApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/approvals/vacation/${encodeURIComponent(id)}`);
  }
  const detail = await getVacationApprovalDetail(access, id);
  return (
    <div className="space-y-5">
      <VacationRequestDetail detail={detail} backHref="/admin/approvals/vacation" />
    </div>
  );
}
