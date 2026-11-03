import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MarketingListCheckBoard } from "@/components/marketing-requests/marketing-list-check-board";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadListCheckBoard } from "@/lib/marketing-requests/crm-list-check-board-service";
import { canReadListCheckBoard } from "@/lib/marketing-requests/crm-list-check-rules";

export const dynamic = "force-dynamic";

/** The Doctor-List Check for those who work in the portal: the same board, behind its own four readers. */
export default async function EmployeePortalMarketingListCheckPage() {
  const access = await resolveAccessContextFromPage();
  if (!canReadListCheckBoard(access.role)) redirect("/employee-portals/marketing-requests");
  const board = await loadListCheckBoard(access);

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Every validated marketing customer against the rep's own Phoenix CRM list: the same name, on the right list, within 500 m. It flags and never stops a request."
      title="Doctor-List Check"
    >
      <MarketingListCheckBoard board={board} />
    </EmployeePortalPageShell>
  );
}
