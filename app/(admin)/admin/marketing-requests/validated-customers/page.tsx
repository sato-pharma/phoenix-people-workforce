import { redirect } from "next/navigation";

import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenValidatedCustomerRegister } from "@/lib/marketing-requests/validated-customer-transfer";
import { ValidatedCustomerRegister } from "@/components/marketing-requests/validated-customer-register";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

/**
 * Admin register of every validated marketing customer.
 *
 * Guarded with the SAME predicate the service uses rather than
 * `assertMarketingAdminPageAccess({ customerDatabase: true })` — that option resolves to
 * `canAccessSystemAdministratorWorkspace`, which is Super Admin only, and would lock out the SFE
 * Manager who runs customer validation. The service would have admitted them; the page would not.
 */
export default async function AdminValidatedCustomersPage() {
  const access = await resolveAccessContextFromPage();
  if (!canOpenValidatedCustomerRegister(access)) redirect("/admin/marketing-requests");

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Validated Customers</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every customer validated in Marketing, by whom and when. Open one to check its data and hand it to Direct Orders.
          </p>
        </div>
      </div>
      <ValidatedCustomerRegister />
    </div>
  );
}
