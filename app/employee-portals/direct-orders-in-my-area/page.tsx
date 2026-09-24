import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { RepAreaDirectOrders } from "@/components/direct-orders/rep-area-direct-orders";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getRepAreaDirectOrders } from "@/lib/direct-orders/rep-area-view-service";
import { canUseEmployeePortalAreaDirectOrders } from "@/lib/employee-portal/navigation";

export const dynamic = "force-dynamic";

/**
 * Direct Orders in my area — the Medical Rep's view-only window (owner instruction, 2026-09-24).
 *
 * The rep does not raise direct orders (that workspace, /employee-portals/direct-orders, is for
 * DIRECT_ORDER_REQUESTER_ROLES). This page lets them SEE the direct orders their District Manager
 * booked on pharmacies in the rep's own area — to whom, when, and which sales month Finance counted
 * them in. Read-only, area-scoped, system direct-request path only.
 *
 * The page redirect is UX; the real boundary is the service's assertAreaDirectOrdersAccess throw.
 */
export default async function EmployeePortalAreaDirectOrdersPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (!canUseEmployeePortalAreaDirectOrders(access.role)) {
    redirect("/employee-portals");
  }

  const report = await getRepAreaDirectOrders(access);

  return (
    <EmployeePortalPageShell
      badge="Sales"
      title="Direct Orders"
      description="The direct orders booked on pharmacies in your area — who each was for, when it was collected, and the sales month it counted in. View only."
    >
      <RepAreaDirectOrders report={report} />
    </EmployeePortalPageShell>
  );
}
