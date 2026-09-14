import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrderSubmitForm } from "@/components/direct-orders/direct-order-submit-form";
import { InvoiceValidatedPharmacies } from "@/components/direct-orders/invoice-validated-pharmacies";
import { loadDirectOrderCaps } from "@/lib/direct-orders/caps";
import { getDirectOrderInvoiceValidationSlots } from "@/lib/direct-orders/pharmacy-validation";
import {
  listDirectOrderAreaAndBrickOptions,
  listDirectOrderDistributorOptions,
  listDirectOrderProductOptions,
  listMyDirectOrderPharmacies,
  listMyDirectOrders,
} from "@/lib/direct-orders/service";
import { isDirectOrderRequesterRole } from "@/lib/direct-orders/types";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertDirectOrdersPageAccess } from "@/lib/direct-orders/page-access";

export const dynamic = "force-dynamic";

export default async function PortalDirectOrdersPage() {
  const access = await resolveAccessContextFromPage();
  await assertDirectOrdersPageAccess(access);
  if (resolveNavigationMode(access) !== "employee-portal") redirect("/admin/direct-orders/new");
  const canSubmit = isDirectOrderRequesterRole(access.role) || access.role === "Super Admin";
  const [products, areaBrickOptions, distributors, pharmacies, myRequests, capsData, invoiceSlots] = await Promise.all([
    listDirectOrderProductOptions(access),
    listDirectOrderAreaAndBrickOptions(access),
    listDirectOrderDistributorOptions(),
    listMyDirectOrderPharmacies(access),
    listMyDirectOrders(access),
    loadDirectOrderCaps(),
    canSubmit ? getDirectOrderInvoiceValidationSlots(access) : Promise.resolve(null),
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
        <div className="space-y-5">
          <DirectOrderSubmitForm products={products} areas={areaBrickOptions.areas} bricks={areaBrickOptions.bricks} distributors={distributors} caps={caps} initialPharmacies={pharmacies} myRequests={myRequests} basePath="/employee-portals/direct-orders" />
          {/* "2 of 5 pharmacies validated by invoice", and the way to free a slot (owner, 2026-09-14). */}
          {invoiceSlots && invoiceSlots.used > 0 ? <InvoiceValidatedPharmacies slots={invoiceSlots} /> : null}
        </div>
      ) : (
        <p className="rounded border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          Your role cannot submit direct orders. Approvers review them under Approvals Hub &gt; D.Orders Approval.
        </p>
      )}
    </EmployeePortalPageShell>
  );
}
