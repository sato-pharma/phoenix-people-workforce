import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { VacationApprovalsBody } from "@/components/approvals-hub/vacation-approvals-body";
import { getVacationWorkspaceData } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PortalVacationApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") redirect("/admin/approvals/vacation");
  const data = await getVacationWorkspaceData(access);
  return (
    <EmployeePortalPageShell
      badge="Approvals Hub"
      title="Vacation Approvals"
      description="Leave requests waiting on your response, and your full response history."
    >
      <VacationApprovalsBody data={data} />
    </EmployeePortalPageShell>
  );
}
