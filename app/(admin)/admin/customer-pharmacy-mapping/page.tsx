import { redirect } from "next/navigation";

import { CustomerPharmacyMappingWorkspace } from "@/components/customer-pharmacy-mapping/customer-pharmacy-mapping-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessCustomerPharmacyMapping } from "@/lib/customer-pharmacy-mapping/readiness";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

export default async function CustomerPharmacyMappingPage() {
  const access = await resolveAccessContextFromPage();
  if (!canAccessCustomerPharmacyMapping(access)) {
    redirect("/");
  }

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Master Data</p>
          <h1 className={pageHeaderTitleClassName}>Customer Pharmacy Mapping</h1>
          <p className={pageHeaderDescriptionClassName}>
            Governance of the relationship between customers and their pharmacies. Review which customers
            are ready, which have links awaiting validation, and which have no pharmacy links yet. Approve
            or reject pending links directly — links are never deleted. Links inferred from historical
            marketing requests stay flagged as not GPS field-validated even after a decision.
          </p>
        </div>
      </div>
      <CustomerPharmacyMappingWorkspace />
    </div>
  );
}
