import { redirect } from "next/navigation";
import { ReceiptText } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DirectOrdersWorkspace } from "@/components/direct-orders/workspace/direct-orders-workspace";
import { directOrdersPageItems } from "@/config/system-navigation";
import { loadDirectOrderWorkspaceView, resolveDirectOrderWorkspaceTab } from "@/lib/direct-orders/workspace-data";
import { parseRequestedOrdersScope } from "@/lib/direct-orders/orders-scope";
import { resolveDirectOrderStatusGroup } from "@/lib/direct-orders/operational-query";
import { buildPermissionLookup, getPermissionMatrix, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { navigationItemVisible } from "@/lib/navigation/active-path";
import { assertDirectOrdersPageAccess } from "@/lib/direct-orders/page-access";

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
  searchParams: Promise<{
    view?: string;
    scope?: string;
    status?: string;
    group?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const access = await resolveAccessContextFromPage();
  await assertDirectOrdersPageAccess(access);
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/direct-orders");
  }

  const { view, scope, status, group, q, page } = await searchParams;
  // Honours the pre-2026-08-11 tab names (my-orders, all-orders, customers, admin-tools) so
  // bookmarks, the sidebar history and next.config.ts's retired-route redirects keep landing on
  // the view that replaced them instead of silently falling back to Overview.
  const requestedTab = resolveDirectOrderWorkspaceTab(view);

  // The view is resolved BEFORE the load so the loader can skip data this view cannot show.
  const workspace = await loadDirectOrderWorkspaceView(access, {
    basePath: BASE_PATH,
    view: requestedTab,
    ordersPage: Number(page) || 1,
    // Filters go INTO the query, not onto a fetched array. An absent ?scope= is NOT "mine": it means
    // the URL left the choice open, and the loader picks the default for this viewer.
    ordersFilters: {
      scopeFilter: parseRequestedOrdersScope(scope),
      status: status ?? null,
      // The filter chips' vocabulary, resolved server-side so an unknown value in a hand-edited URL
      // falls back to "all" rather than reaching the query.
      statusGroup: resolveDirectOrderStatusGroup(group),
      q: q ?? null,
    },
  });

  // The admin desks, gated exactly as the existing hub page gates them — same
  // lookup, same helpers. This component owns no permission rule of its own.
  const matrix = await getPermissionMatrix();
  const permissionLookup = buildPermissionLookup(matrix, access.role);
  // navigationItemVisible also applies excludedRoles, which this call site had omitted. No item in
  // directOrdersPageItems carries one, so that is a no-op today — and the list can no longer grow
  // an excludedRoles this page would silently ignore.
  const adminTools = directOrdersPageItems
    .filter((item) => navigationItemVisible(item, permissionLookup, access.role))
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
        ordersPage={workspace.orders}
        ordersScope={workspace.ordersScope}
        recentOrders={workspace.recentOrders}
        recentOrdersScope={workspace.recentOrdersScope}
        viewerHrId={access.hrId ?? null}
        adminTools={adminTools}
        canSeeAllOrders={workspace.capabilities.canSeeAllOrders}
        reportHref={`/admin/direct-orders/report`}
        customersHref={
          // Kept verbatim from the deleted `isSystemAdministratorWorkspace` local. This is a
          // one-off "who gets the pharmacies link" rule, not the navigation gate this change
          // consolidates, so it keeps its own expression rather than borrowing one.
          access.scope === "system" || access.role === "Super Admin" || access.role === "SFE Manager"
            ? `${BASE_PATH}/pharmacies`
            : null
        }
      />
    </div>
  );
}
