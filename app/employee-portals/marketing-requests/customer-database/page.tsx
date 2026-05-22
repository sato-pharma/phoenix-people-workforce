import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingCustomerDatabase } from "@/components/employee-portal/marketing-customer-database";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingCustomerDatabasePage() {
  await assertEmployeePortalMarketingPageAccess("customer-database");

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Admin validation dev database for customer, pharmacy, and distributor-code rows."
      title="SCP / PH Database"
    >
      <MarketingCustomerDatabase />
    </EmployeePortalPageShell>
  );
}
