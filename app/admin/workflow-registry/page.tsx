import { redirect } from "next/navigation";

import { WorkflowRegistryManager } from "@/components/admin/workflow-registry-manager";
import { AppShell } from "@/components/layout/app-shell";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getWorkflowRegistryDashboard } from "@/lib/workflow-registry/service";

export const dynamic = "force-dynamic";

export default async function AdminWorkflowRegistryPage() {
  const access = await resolveAccessContextFromPage();

  if (!await canAccess(access, "workflow_registry", "read")) {
    redirect("/employee-portals");
  }

  let initialData = null;
  let initialError: string | null = null;
  const canManage = access.role === "Super Admin" && await canAccess(access, "workflow_registry", "update");

  try {
    initialData = await getWorkflowRegistryDashboard();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Workflow Registry failed to load.";
  }

  return (
    <AppShell navigationMode="admin">
      <WorkflowRegistryManager
        canManage={canManage}
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
