import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingCustomerDatabase } from "@/components/employee-portal/marketing-customer-database";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingCustomerDatabasePage() {
  try {
    await assertEmployeePortalMarketingPageAccess("customer-database");
  } catch (error) {
    if (typeof (error as { digest?: string }).digest === "string") throw error;
    console.error("[employee-portal] marketing-customer-database access check failed:", error);
    return (
      <EmployeePortalEmptyState
        message="Unable to verify your access. Please try again or contact your administrator."
        title="Access Check Failed"
      />
    );
  }

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
