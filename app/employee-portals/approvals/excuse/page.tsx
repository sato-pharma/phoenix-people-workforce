import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { ExcuseApprovalsBody } from "@/components/approvals-hub/excuse-approvals-body";
import { getExcuseWorkspaceData } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isExcuseExcludedRole } from "@/lib/excuses/service";

export const dynamic = "force-dynamic";

export default async function PortalExcuseApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") redirect("/admin/approvals/excuse");
  // District/Regional Managers hold no excuse authority — the sidebar link is gone for them, so
  // send a direct URL hit home rather than rendering a permanently empty approvals page.
  if (isExcuseExcludedRole(access.role)) redirect("/employee-portals");
  const data = await getExcuseWorkspaceData(access);
  return (
    <EmployeePortalPageShell
      badge="Approvals Hub"
      title="Excuse Approvals"
      description="Excuse requests waiting on your response, and your full response history."
    >
      <ExcuseApprovalsBody data={data} />
    </EmployeePortalPageShell>
  );
}
