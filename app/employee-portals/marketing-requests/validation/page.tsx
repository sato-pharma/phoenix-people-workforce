import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingValidationWorkspace } from "@/components/employee-portal/marketing-validation-workspace";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingValidationPage() {
  try {
    await assertEmployeePortalMarketingPageAccess("requests");
  } catch (error) {
    if (typeof (error as { digest?: string }).digest === "string") throw error;
    console.error("[employee-portal] marketing-validation access check failed:", error);
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
      description="Validate healthcare providers, pharmacy locations, and distributor pharmacy codes before they can feed activity requests."
      descriptionClassName="mt-3 max-w-none overflow-hidden text-ellipsis whitespace-nowrap text-sm leading-6"
      title="HCP / PH Validation"
    >
      <MarketingValidationWorkspace />
    </EmployeePortalPageShell>
  );
}
