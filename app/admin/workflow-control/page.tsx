import { redirect } from "next/navigation";

import { WorkflowRegistryManager } from "@/components/admin/workflow-registry-manager";
import { WorkflowControlCenter } from "@/components/workflow-control/workflow-control-center";
import { AppShell } from "@/components/layout/app-shell";
import { canAccess, canAccessWorkflowControlCenter, canEditWorkflowControlCenter } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getWorkflowRegistryDashboard } from "@/lib/workflow-registry/service";

export const dynamic = "force-dynamic";

export default async function AdminWorkflowControlPage() {
  const access = await resolveAccessContextFromPage();

  // Phase 1 governance gate: Super Admin + HR Specialist (HR governance) only.
  if (!canAccessWorkflowControlCenter(access)) {
    redirect("/employee-portals");
  }

  let initialData = null;
  let initialError: string | null = null;
  // The advanced Registry Manager keeps its own (existing) manage capability.
  const canManageRegistry = access.role === "Super Admin" && (await canAccess(access, "workflow_registry", "update"));

  try {
    initialData = await getWorkflowRegistryDashboard();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Workflow registry failed to load.";
  }

  return (
    <AppShell navigationMode="admin">
      <WorkflowControlCenter
        canEdit={canEditWorkflowControlCenter(access)}
        registrySlot={
          <WorkflowRegistryManager
            canManage={canManageRegistry}
            initialData={initialData}
            initialError={initialError}
          />
        }
      />
    </AppShell>
  );
}
