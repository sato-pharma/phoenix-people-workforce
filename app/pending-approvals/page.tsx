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

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PendingApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string | string[]; type?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams;
  const initialTab = firstSearchParam(resolvedSearchParams?.tab);
  const initialTypeFilter = firstSearchParam(resolvedSearchParams?.type);
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
          description="Review approval decisions assigned to you and pending requests submitted by you."
          title="Pending Approvals"
        >
          <PendingApprovalsWorkspace
            initialItems={items}
            initialTab={initialTab === "by-me" ? "by-me" : "for-me"}
            initialTypeFilter={initialTypeFilter}
          />
        </EmployeePortalPageShell>
      </EmployeePortalServerShell>
    );
  }

  return (
    <AppShell navigationMode="admin">
      <PageContainer className="max-w-none">
        <PendingApprovalsWorkspace
          initialItems={items}
          initialTab={initialTab === "by-me" ? "by-me" : "for-me"}
          initialTypeFilter={initialTypeFilter}
        />
      </PageContainer>
    </AppShell>
  );
}
