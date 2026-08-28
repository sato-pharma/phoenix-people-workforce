import { redirect } from "next/navigation";

import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenValidatedCustomerRegister } from "@/lib/marketing-requests/validated-customer-transfer";
import { ValidatedCustomerRegister } from "@/components/marketing-requests/validated-customer-register";

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
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Validated Customers</h1>
        <p className="max-w-none overflow-hidden text-ellipsis whitespace-nowrap text-phx-md font-medium leading-6 text-slate-600">
          Every customer validated in Marketing, by whom and when. Open one to check its data and hand it to Direct Orders.
        </p>
      </div>
      <ValidatedCustomerRegister />
    </div>
  );
}
