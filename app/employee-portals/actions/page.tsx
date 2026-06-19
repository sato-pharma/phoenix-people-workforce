import { redirect } from "next/navigation";

import { ActionsWorkspace } from "@/components/action-center/actions-workspace";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import type { ActionHubData } from "@/components/action-center/types";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getAwaitingMyActionItems, getMyRequestItems } from "@/lib/action-center/service";

export const dynamic = "force-dynamic";

export default async function PortalActionsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/action-center");
  }

  // Portal audience: only access-scoped, manager-relevant sources (vacation + excuse).
  // Unscoped HR/admin sources never reach a portal manager — see getAwaitingMyActionItems.
  const [items, myRequests] = await Promise.all([
    getAwaitingMyActionItems(access, "portal"),
    getMyRequestItems(access).catch(() => []),
  ]);

  const data: ActionHubData = {
    generatedAt: new Date().toISOString(),
    items,
  };

  const initialTab: "inbox" | "mine" = items.length > 0 ? "inbox" : "mine";

  return (
    <EmployeePortalPageShell
      badge="Action Center"
      description="Approvals waiting on your decision, and the live status of the requests you submitted."
      title="Actions"
    >
      <ActionsWorkspace
        inboxData={data}
        myRequests={myRequests}
        callerRole={access.role}
        initialTab={initialTab}
        embedded
      />
    </EmployeePortalPageShell>
  );
}
