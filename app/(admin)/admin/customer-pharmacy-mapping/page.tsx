import { redirect } from "next/navigation";

import { CustomerPharmacyMappingWorkspace } from "@/components/customer-pharmacy-mapping/customer-pharmacy-mapping-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessCustomerPharmacyMapping } from "@/lib/customer-pharmacy-mapping/readiness";

export const dynamic = "force-dynamic";

export default async function CustomerPharmacyMappingPage() {
  const access = await resolveAccessContextFromPage();
  if (!canAccessCustomerPharmacyMapping(access)) {
    redirect("/");
  }

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Master Data</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Customer Pharmacy Mapping</h1>
        <p className="max-w-3xl text-[13px] font-medium leading-6 text-slate-600">
          Governance of the relationship between customers and their pharmacies. Review which customers
          are ready, which have links awaiting validation, and which have no pharmacy links yet. Approve
          or reject pending links directly — links are never deleted. Links inferred from historical
          marketing requests stay flagged as not GPS field-validated even after a decision.
        </p>
      </div>
      <CustomerPharmacyMappingWorkspace />
    </div>
  );
}
