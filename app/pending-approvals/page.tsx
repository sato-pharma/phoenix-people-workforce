import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { EmployeePortalServerShell } from "@/components/employee-portal/employee-portal-server-shell";
import { AppShell } from "@/components/layout/app-shell";
import { PageContainer } from "@/components/layout/page-container";
import { PendingApprovalsWorkspace } from "@/components/pending-approvals/pending-approvals-workspace";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listPendingApprovals } from "@/lib/pending-approvals/service";

export const dynamic = "force-dynamic";

export default async function PendingApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  const items = await listPendingApprovals(access);

  if (resolveNavigationMode(access) === "employee-portal") {
    return (
      <EmployeePortalServerShell access={access}>
        <EmployeePortalPageShell
          badge="Workflow"
          description="Review the approval decisions assigned to your hierarchy and current workflow step."
          title="Pending Approvals"
        >
          <PendingApprovalsWorkspace initialItems={items} />
        </EmployeePortalPageShell>
      </EmployeePortalServerShell>
    );
  }

  return (
    <AppShell navigationMode="admin">
      <PageContainer className="max-w-none">
        <PendingApprovalsWorkspace initialItems={items} />
      </PageContainer>
    </AppShell>
  );
}
