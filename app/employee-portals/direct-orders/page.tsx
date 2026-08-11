import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrdersWorkspace } from "@/components/direct-orders/workspace/direct-orders-workspace";
import { loadDirectOrderWorkspaceView, type DirectOrderWorkspaceTabKey } from "@/lib/direct-orders/workspace-data";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertDirectOrdersPageAccess } from "@/lib/direct-orders/page-access";

export const dynamic = "force-dynamic";

const BASE_PATH = "/employee-portals/direct-orders";

/**
 * The consolidated Direct Orders workspace, portal shell.
 *
 * This is the shell the people who actually RAISE direct orders land in —
 * `portalNavigationRoles` sends District / Regional / National Sales Managers and
 * Product / Group Product Managers here, which is why the module ended up built
 * twice. The workspace component is shared with the admin route above it; only
 * `variant` and `basePath` differ.
 *
 * No Admin Tools tab is offered: every desk behind it (validation, held, cleanup,
 * caps, variances, reconciliation) refuses these roles in its own service, so the
 * links would only lead to a 403. `loadDirectOrderWorkspaceView` reaches the same
 * conclusion from the viewer's capabilities, and this passes an empty list so the
 * page cannot disagree with it.
 */
export default async function PortalDirectOrdersWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  await assertDirectOrdersPageAccess(access);
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/direct-orders");
  }

  const { view } = await searchParams;
  const requestedTab = (view ?? "overview") as DirectOrderWorkspaceTabKey;

  const workspace = await loadDirectOrderWorkspaceView(access, { basePath: BASE_PATH });

  return (
    <EmployeePortalPageShell
      badge="Sales"
      title="Direct Orders"
      description="Raise an order, act on what is waiting for you, and follow any order to completion — in one place."
    >
      <DirectOrdersWorkspace
        variant="portal"
        basePath={BASE_PATH}
        newOrderHref={workspace.capabilities.canCreate ? `${BASE_PATH}/new` : null}
        tabs={workspace.tabs.filter((tab) => tab !== "admin-tools")}
        initialTab={requestedTab}
        summary={workspace.summary}
        needsAction={workspace.needsAction}
        myOrders={workspace.myOrders}
        allOrders={workspace.allOrders}
        adminTools={[]}
        reportHref={`/employee-portals/direct-orders/report`}
        customersHref={null}
      />
    </EmployeePortalPageShell>
  );
}
