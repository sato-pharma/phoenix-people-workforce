import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrdersWorkspace } from "@/components/direct-orders/workspace/direct-orders-workspace";
import { loadDirectOrderWorkspaceView, resolveDirectOrderWorkspaceTab } from "@/lib/direct-orders/workspace-data";
import { parseRequestedOrdersScope } from "@/lib/direct-orders/orders-scope";
import { resolveDirectOrderStatusGroup } from "@/lib/direct-orders/operational-query";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { assertDirectOrdersPageAccess } from "@/lib/direct-orders/page-access";

export const dynamic = "force-dynamic";

const BASE_PATH = "/employee-portals/direct-orders";

/**
 * The consolidated Direct Orders workspace, portal shell.
 *
 * This is the shell the people who actually RAISE direct orders land in —
 * `portalShellRoles` sends District / Regional / National Sales Managers and
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
  searchParams: Promise<{
    view?: string;
    scope?: string;
    status?: string;
    group?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  await assertDirectOrdersPageAccess(access);
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/direct-orders");
  }

  const { view, scope, status, group, q, page } = await searchParams;
  // Same legacy-alias handling as the admin shell — the portal's old ?view= links are in
  // bookmarks and in next.config.ts's retired-approvals redirect.
  const requestedTab = resolveDirectOrderWorkspaceTab(view);

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

  // The portal shell carries no admin desks (adminTools is empty below), so the three authority
  // views are filtered out here rather than rendered as empty sections. The Report stays reachable
  // from the Overview header via reportHref, exactly as before.
  const portalTabs = workspace.tabs.filter(
    (tab) => tab !== "pharmacy-control" && tab !== "reports" && tab !== "controls",
  );

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
        tabs={portalTabs}
        initialTab={requestedTab}
        summary={workspace.summary}
        needsAction={workspace.needsAction}
        myOrders={workspace.myOrders}
        ordersPage={workspace.orders}
        ordersScope={workspace.ordersScope}
        recentOrders={workspace.recentOrders}
        recentOrdersScope={workspace.recentOrdersScope}
        viewerHrId={access.hrId ?? null}
        adminTools={[]}
        canSeeAllOrders={workspace.capabilities.canSeeAllOrders}
        reportHref={`/employee-portals/direct-orders/report`}
        customersHref={null}
      />
    </EmployeePortalPageShell>
  );
}
