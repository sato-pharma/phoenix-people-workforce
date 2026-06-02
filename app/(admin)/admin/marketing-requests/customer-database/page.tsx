import { MarketingCustomerDatabase } from "@/components/employee-portal/marketing-customer-database";

import { assertMarketingAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

export default async function AdminMarketingCustomerDatabasePage() {
  await assertMarketingAdminPageAccess({ customerDatabase: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">SCP / PH Database</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Admin validation dev database for customer, pharmacy, and distributor-code rows.
        </p>
      </div>
      <MarketingCustomerDatabase />
    </div>
  );
}
