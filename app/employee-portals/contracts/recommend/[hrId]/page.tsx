import { redirect } from "next/navigation";

import { ManagerRecommendationBody } from "@/components/contracts/manager-recommendation-body";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getManagerRecommendationContext } from "@/lib/contracts/manager-recommendation";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ hrId: string }> };

/**
 * Portal twin of app/(admin)/contracts/recommend/[hrId]/page.tsx — where a district manager, the
 * National Sales Manager or any other portal-shell manager lands from the renewal reminder and says
 * Renew or Do not renew. Access is the domain's record-level rule (getManagerRecommendationContext).
 */
export default async function PortalContractRecommendationPage({ params }: PageProps) {
  const access = await resolveAccessContextFromPage();
  const { hrId } = await params;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/contracts/recommend/${encodeURIComponent(hrId)}`);
  }

  const context = await getManagerRecommendationContext(access, hrId);

  return (
    <EmployeePortalPageShell
      badge="Contract Renewal"
      description="Say whether this employee's contract should be renewed. HR reads your answer on Contract Renewal."
      errorBoundaryTitle="Manager recommendation unavailable"
      title="Manager recommendation"
    >
      <ManagerRecommendationBody
        boardHref="/employee-portals/contracts"
        context={context}
        teamHref="/employee-portals/contracts"
      />
    </EmployeePortalPageShell>
  );
}
