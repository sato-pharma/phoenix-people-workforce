import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrderPortalSubmit } from "@/components/employee-portal/direct-order-portal-submit";
import { loadDirectOrderCaps } from "@/lib/direct-orders/caps";
import {
  listDirectOrderBrickOptions,
  listDirectOrderDistributorOptions,
  listDirectOrderProductOptions,
  listMyDirectOrderPharmacies,
  listMyDirectOrders,
} from "@/lib/direct-orders/service";
import { isDirectOrderRequesterRole } from "@/lib/direct-orders/types";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PortalDirectOrdersPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") redirect("/admin/direct-orders");
  const canSubmit = isDirectOrderRequesterRole(access.role) || access.role === "Super Admin";
  const [products, bricks, distributors, pharmacies, myRequests, capsData] = await Promise.all([
    listDirectOrderProductOptions(access),
    listDirectOrderBrickOptions(),
    listDirectOrderDistributorOptions(),
    listMyDirectOrderPharmacies(access),
    listMyDirectOrders(access),
    loadDirectOrderCaps(),
  ]);
  const caps = {
    globalBonusCapPct: capsData.globalBonusCapPct,
    globalDiscountCapPct: capsData.globalDiscountCapPct,
    byProduct: Object.fromEntries(capsData.byProduct),
  };
  return (
    <EmployeePortalPageShell
      badge="Sales"
      title="Direct Orders"
      description="Submit a direct (company) order for approval up your management line to the CEO."
    >
      {canSubmit ? (
        <DirectOrderPortalSubmit products={products} bricks={bricks} distributors={distributors} caps={caps} initialPharmacies={pharmacies} myRequests={myRequests} />
      ) : (
        <p className="rounded border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          Your role cannot submit direct orders. Approvers review them under Approvals Hub &gt; Direct Orders Approvals.
        </p>
      )}
    </EmployeePortalPageShell>
  );
}
