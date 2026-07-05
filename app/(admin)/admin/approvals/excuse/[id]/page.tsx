import { redirect } from "next/navigation";

import { ExcuseRequestDetail } from "@/components/approvals-hub/excuse-request-detail";
import { getExcuseApprovalDetail } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminExcuseApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/approvals/excuse/${encodeURIComponent(id)}`);
  }
  const detail = await getExcuseApprovalDetail(access, id);
  return (
    <div className="space-y-5">
      <ExcuseRequestDetail detail={detail} backHref="/admin/approvals/excuse" />
    </div>
  );
}
