import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingRequestDraftWorkspace } from "@/components/employee-portal/marketing-request-drafts";

export const dynamic = "force-dynamic";

export default function EmployeePortalMarketingRequestsPage() {
  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Create draft activities, forecast product ROI, and keep request rows ready for validation."
      title="Marketing Requests"
    >
      <MarketingRequestDraftWorkspace />
    </EmployeePortalPageShell>
  );
}
