import { redirect } from "next/navigation";

import { AdminPageHero, adminPanelClassName } from "@/components/admin/admin-design-system";
import { ManagerRecommendationBody } from "@/components/contracts/manager-recommendation-body";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getManagerRecommendationContext } from "@/lib/contracts/manager-recommendation";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ hrId: string }> };

/**
 * The address the contract renewal reminder's button opens, for every recipient (owner, 2026-11-11).
 * A portal-shell manager is forwarded to the portal twin; an admin-shell reader (the CEO, HR, the
 * Super Admin) answers or reads here. Who may see it is the domain's record-level rule — the manager
 * chain, or contracts:read — decided in getManagerRecommendationContext.
 */
export default async function ContractRecommendationPage({ params }: PageProps) {
  const access = await resolveAccessContextFromPage();
  const { hrId } = await params;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/contracts/recommend/${encodeURIComponent(hrId)}`);
  }

  const context = await getManagerRecommendationContext(access, hrId);

  return (
    <div className="space-y-4">
      <AdminPageHero
        compact
        description="The employee's managers say whether the contract should be renewed. HR reads every answer on Contract Renewal."
        eyebrow="Contract Renewal"
        title="Manager recommendation"
      />
      <div className={adminPanelClassName}>
        <ManagerRecommendationBody boardHref="/contracts" context={context} teamHref="/contracts" />
      </div>
    </div>
  );
}
