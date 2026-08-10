import { redirect } from "next/navigation";
import { ReceiptText } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DirectOrdersWorkspace } from "@/components/direct-orders/workspace/direct-orders-workspace";
import { directOrdersPageItems } from "@/config/system-navigation";
import { loadDirectOrderWorkspaceView, type DirectOrderWorkspaceTabKey } from "@/lib/direct-orders/workspace-data";
import {
  canAccess,
  getPermissionMatrix,
  permissionActions,
  permissionResources,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { permissionAllowed, roleAllowed, type PermissionLookup } from "@/lib/navigation/active-path";

export const dynamic = "force-dynamic";

const BASE_PATH = "/admin/direct-orders";

/**
 * The consolidated Direct Orders workspace, admin shell.
 *
 * ADDITIVE ON PURPOSE. Every existing route still resolves exactly as it did —
 * this is Phase B of the owner's own migration plan ("create the new workspace
 * using existing APIs"), not the replacement. Nothing is redirected here until
 * the workspace is confirmed equivalent, because the old URLs are in people's
 * bookmarks, in the sidebar, and in the approved-order email.
 */
export default async function AdminDirectOrdersWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/direct-orders");
  }
  // Mirrors the sidebar button's gate. The four service reads behind the view
  // each assert `direct_orders:read` again — this only avoids rendering a shell
  // around a guaranteed 403.
  if (!(await canAccess(access, "direct_orders", "read"))) redirect("/employee-portals");

  const { view } = await searchParams;
  const requestedTab = (view ?? "overview") as DirectOrderWorkspaceTabKey;

  const workspace = await loadDirectOrderWorkspaceView(access, { basePath: BASE_PATH });

  // The admin desks, gated exactly as the existing hub page gates them — same
  // lookup, same helpers. This component owns no permission rule of its own.
  const matrix = await getPermissionMatrix();
  const permissionLookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      permissionLookup[`${resource}:${action}`] =
        matrix[access.role]?.[resource]?.includes(action) ?? false;
    }
  }
  const isSystemAdministratorWorkspace = access.scope === "system" || access.role === "Super Admin";
  const adminTools = (
    isSystemAdministratorWorkspace
      ? directOrdersPageItems
      : directOrdersPageItems.filter(
          (item) => permissionAllowed(permissionLookup, item.permissions) && roleAllowed(access.role, item.roles),
        )
  )
    // The submit form and the report are reachable from the workspace itself, so
    // repeating them under "Admin Tools" would restate the two things the
    // workspace already does — the exact duplication this consolidation removes.
    .filter((item) => item.href !== BASE_PATH && item.href !== `${BASE_PATH}/report`)
    .map((item) => ({ href: item.href, label: item.label, description: item.description }));

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders"
        description="Raise an order, act on what is waiting for you, and follow any order to completion — in one place."
        icon={<ReceiptText className="h-3.5 w-3.5" />}
      />
      <DirectOrdersWorkspace
        variant="admin"
        basePath={BASE_PATH}
        newOrderHref={workspace.capabilities.canCreate ? `${BASE_PATH}/new` : null}
        tabs={workspace.tabs}
        initialTab={requestedTab}
        summary={workspace.summary}
        needsAction={workspace.needsAction}
        myOrders={workspace.myOrders}
        allOrders={workspace.allOrders}
        adminTools={adminTools}
        reportHref={`/admin/direct-orders/report`}
        customersHref={
          isSystemAdministratorWorkspace || access.role === "SFE Manager" ? `${BASE_PATH}/pharmacies` : null
        }
      />
    </div>
  );
}
