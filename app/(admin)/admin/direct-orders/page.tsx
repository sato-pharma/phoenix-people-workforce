import { redirect } from "next/navigation";
import { ReceiptText } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DirectOrderSubmitForm } from "@/components/direct-orders/direct-order-submit-form";
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

export default async function AdminDirectOrdersPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/direct-orders");
  const canSubmit = isDirectOrderRequesterRole(access.role) || access.role === "Super Admin";
  const [products, bricks, distributors, pharmacies, myRequests, capsData] = await Promise.all([
    listDirectOrderProductOptions(),
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
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders"
        description="Submit a direct (company) order for approval up your management line to the CEO."
        icon={<ReceiptText className="h-3.5 w-3.5" />}
      />
      {canSubmit ? (
        <DirectOrderSubmitForm products={products} bricks={bricks} distributors={distributors} caps={caps} initialPharmacies={pharmacies} myRequests={myRequests} />
      ) : (
        <p className="border border-[#e4e9ec] bg-white px-4 py-6 text-sm text-slate-500">
          Your role cannot submit direct orders. Approvers review them under Approvals Hub › Direct Orders Approvals.
        </p>
      )}
    </div>
  );
}
