import { redirect } from "next/navigation";

import { ActionsWorkspace } from "@/components/action-center/actions-workspace";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import type { ActionHubData, ActionHubModule } from "@/components/action-center/types";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getAwaitingMyActionItems, getMyRequestItems, getMyApprovalHistory } from "@/lib/action-center/service";
import type { ActionHubItem, HistoricalApprovalItem, MyRequestItem } from "@/components/action-center/types";

export const dynamic = "force-dynamic";

function preservedQuery(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const key of ["module", "id", "tab"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

function myRequestMatchesDeepLink(itemId: string, module: ActionHubModule | null, id: string | null) {
  if (!id) return false;
  return itemId === id || (module ? itemId === `${module}:${id}` : itemId.endsWith(`:${id}`));
}

export default async function PortalApprovalsHubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const params = await searchParams;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/admin/approvals-hub${preservedQuery(params)}`);
  }

  const initialModule = (typeof params.module === "string" ? params.module : null) as ActionHubModule | null;
  const initialId = typeof params.id === "string" ? params.id : null;

  // Portal audience: only access-scoped, manager-relevant sources (vacation + excuse + weekly_plan).
  // Unscoped HR/admin sources never reach a portal manager — see getAwaitingMyActionItems.
  const [items, myRequests, historicalItems]: [ActionHubItem[], MyRequestItem[], HistoricalApprovalItem[]] = await Promise.all([
    getAwaitingMyActionItems(access, "portal"),
    getMyRequestItems(access).catch((): MyRequestItem[] => []),
    getMyApprovalHistory(access).catch((): HistoricalApprovalItem[] => []),
  ]);

  const data: ActionHubData = {
    generatedAt: new Date().toISOString(),
    items,
  };

  const linkedInboxItem = initialId
    ? items.some((item) => item.id === initialId && (!initialModule || item.module === initialModule))
    : false;
  const linkedMyRequest = initialId
    ? myRequests.some((item) => myRequestMatchesDeepLink(item.id, initialModule, initialId))
    : false;
  const initialTab: "inbox" | "mine" | "historical" =
    linkedInboxItem ? "inbox" : linkedMyRequest ? "mine" : items.length > 0 ? "inbox" : "mine";

  return (
    <EmployeePortalPageShell
      badge="Approvals Hub"
      description="Approvals waiting on your decision, the live status of your requests, and your full approval history."
      title="Approvals Hub"
    >
      <ActionsWorkspace
        inboxData={data}
        myRequests={myRequests}
        historicalItems={historicalItems}
        initialModule={initialModule}
        initialId={initialId}
        callerRole={access.role}
        initialTab={initialTab}
        embedded
      />
    </EmployeePortalPageShell>
  );
}
