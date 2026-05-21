import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingCustomerDatabase } from "@/components/employee-portal/marketing-customer-database";

export const dynamic = "force-dynamic";

export default function EmployeePortalMarketingCustomerDatabasePage() {
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
