import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingValidationWorkspace } from "@/components/employee-portal/marketing-validation-workspace";

export const dynamic = "force-dynamic";

export default function EmployeePortalMarketingValidationPage() {
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
