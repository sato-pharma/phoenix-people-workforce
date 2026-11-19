import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MarketingWatchedRequests } from "@/components/marketing-requests/marketing-watched-requests";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isMarketingProductWatcher } from "@/lib/marketing-requests/product-watchers";
import { getMarketingWatchedProductRequests } from "@/lib/marketing-requests/service";

export const dynamic = "force-dynamic";

/**
 * Watched Products — every marketing request, past and present, for the products the viewer follows
 * by name (owner, 2026-11-19, for Ahmed SharafEldeen: Guamusin and Ivyronc).
 *
 * 🔴 THE GATE IS THE NAMED LIST, NOT `canAccess`: a watcher holds no marketing permission beyond his
 * role's, and granting one to Product Managers would open every line's requests to all of them.
 * `getMarketingWatchedProductRequests` refuses a non-watcher again on its own, so the page gate is UX
 * and the service is the boundary. Read-only: each row opens the request's Case File to comment.
 */
export default async function EmployeePortalMarketingWatchedRequestsPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal" || !isMarketingProductWatcher(access.hrId)) {
    redirect("/employee-portals");
  }

  const workspace = await getMarketingWatchedProductRequests(access);

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Every marketing request for the products you follow, from the first one raised. Open one to read its approval trail and comment."
      title="Watched Products"
    >
      <MarketingWatchedRequests workspace={workspace} />
    </EmployeePortalPageShell>
  );
}
