import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MarketAwarenessWorkspace } from "@/components/market-awareness/market-awareness-workspace";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canCreateActivity, seesEveryActivity } from "@/lib/market-awareness/scope";

export const dynamic = "force-dynamic";

/**
 * The gate is INLINE, not behind a helper. `PortalNavEntry.permission` is a mirror of the permission
 * the page itself enforces, and the guard that keeps the two honest re-derives the truth by reading
 * this file — so a gate hidden in another module reads as "this page enforces nothing", and the
 * mirror silently becomes a claim nothing checks.
 *
 * This is UX, not the security boundary: every route under /api/market-awareness calls
 * assertPermission and then narrows by identity, because the matrix has no per-row layer and a
 * Product Manager may see only his own activities.
 */
export default async function EmployeePortalMarketAwarenessPage() {
  const access = await resolveAccessContextFromPage();

  // Notification links (`?activity=…`) name this address for every recipient, the admin-shell CEO
  // and Finance Manager included, so the hop goes to the admin workspace rather than /overview.
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/market-awareness");
  }
  if (!(await canAccess(access, "market_awareness", "read"))) {
    redirect("/employee-portals");
  }

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Raise a conference, round table, symposium or speaker programme against your products in one brick, and watch what that brick and its area sell afterwards."
      title="Market Awareness"
    >
      {/* `canCreate` decides whether the button is drawn. The route re-checks it on every POST — a
          hidden button is not access control. */}
      <MarketAwarenessWorkspace canCreate={canCreateActivity(access)} seesAll={seesEveryActivity(access)} />
    </EmployeePortalPageShell>
  );
}
