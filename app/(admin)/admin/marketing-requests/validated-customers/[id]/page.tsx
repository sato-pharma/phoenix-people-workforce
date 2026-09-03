import { redirect } from "next/navigation";

import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenValidatedCustomerRegister } from "@/lib/marketing-requests/validated-customer-transfer";
import { ValidatedCustomerDetailView } from "@/components/marketing-requests/validated-customer-detail";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

/**
 * One validated customer, in full — the page behind a row in the register. The owner's ask:
 * "when I press on the customer… a new page, and they have all details in it. His brick, his area,
 * the location, the photo, evidence, everything."
 */
export default async function AdminValidatedCustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!canOpenValidatedCustomerRegister(access)) redirect("/admin/marketing-requests");

  const { id } = await params;

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Customer Check</h1>
          <p className={pageHeaderDescriptionClassName}>
            Everything captured for this customer, what is still missing, and the hand-off to Direct Orders.
          </p>
        </div>
      </div>
      <ValidatedCustomerDetailView customerId={id} />
    </div>
  );
}
