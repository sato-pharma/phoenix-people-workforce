import { redirect } from "next/navigation";

import { ActionsWorkspace, type MovedOutQueue } from "@/components/action-center/actions-workspace";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import type { ActionHubData, ActionHubModule } from "@/components/action-center/types";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getActionCenterDeepLinkItem, getAwaitingMyActionItems, getMyRequestItems, getMyApprovalHistory } from "@/lib/action-center/service";
import {
  DECIDED_FOR_ME_WINDOW_DAYS,
  getDecisionsMadeForMe,
  type DecidedForMeItem,
} from "@/lib/action-center/decided-for-me";
import type { ActionHubItem, HistoricalApprovalItem, MyRequestItem } from "@/components/action-center/types";
import { canUseEmployeePortalMarketingRequests } from "@/lib/employee-portal/navigation";
import { getMarketingInboxQueueLink } from "@/lib/marketing-requests/service";

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

// Vacation, excuse and weekly/monthly plans left the "Other Approvals" inbox for their own
// dedicated portal pages. A stale link that still points at ?module=leave|excuse|weekly_plan must
// never inject that request back into this inbox — bounce it to the dedicated page instead so
// Other Approvals only ever shows resignation/contract/outstation.
const MIGRATED_DEEPLINK_BASES: Record<string, string> = {
  leave: "/employee-portals/approvals/vacation",
  excuse: "/employee-portals/approvals/excuse",
  weekly_plan: "/employee-portals/approvals/plan",
};

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

  // Migrated modules never render inside this hub — redirect to their dedicated portal page.
  if (initialModule && MIGRATED_DEEPLINK_BASES[initialModule]) {
    const base = MIGRATED_DEEPLINK_BASES[initialModule];
    redirect(initialId ? `${base}/${encodeURIComponent(initialId)}` : base);
  }

  // Portal audience: after the migrated-module redirect above, the live inbox only carries the
  // access-scoped residual modules (contract renewal). Unscoped HR/admin sources (resignation,
  // outstation) never reach a portal manager — see getAwaitingMyActionItems.
  const [items, rawMyRequests, rawHistoricalItems, decidedForMe, marketingInbox]: [
    ActionHubItem[],
    MyRequestItem[],
    HistoricalApprovalItem[],
    DecidedForMeItem[] | null,
    MovedOutQueue | null,
  ] = await Promise.all([
    getAwaitingMyActionItems(access, "portal"),
    getMyRequestItems(access).catch((): MyRequestItem[] => []),
    getMyApprovalHistory(access).catch((): HistoricalApprovalItem[] => []),
    // null, not [] — see the admin hub: an empty list would claim nothing happened.
    getDecisionsMadeForMe(access).catch((): DecidedForMeItem[] | null => null),
    // Marketing keeps its own inbox: the hub only says what is waiting there, and only to a role
    // the portal's inbox page admits.
    canUseEmployeePortalMarketingRequests(access.role)
      ? getMarketingInboxQueueLink(access, "/employee-portals/marketing-requests/inbox")
      : Promise.resolve(null),
  ]);
  // Every migrated module (leave/excuse/weekly_plan) has its own "My Requests"/"History" tabs on
  // its dedicated hub (approvals-hub/service.ts filters these same shared functions down to one
  // module each) — drop them here too, reusing MIGRATED_DEEPLINK_BASES as the one list of which
  // modules that applies to, so a request never shows twice.
  const myRequests = rawMyRequests.filter((item) => !MIGRATED_DEEPLINK_BASES[item.module]);
  const historicalItems = rawHistoricalItems.filter((item) => !MIGRATED_DEEPLINK_BASES[item.module]);

  // A deep link (from a notification or the history tab) may point at a decided item that is no
  // longer in the live pending inbox. Resolve it read-only and surface it inline so "View request"
  // always renders the item instead of dead-ending. Mirrors the admin hub page.
  const resolvedItems = [...items];
  if (initialModule && initialId && !resolvedItems.some((item) => item.id === initialId && item.module === initialModule)) {
    const linkedItem = await getActionCenterDeepLinkItem(access, initialModule, initialId).catch(() => null);
    if (linkedItem) resolvedItems.unshift(linkedItem);
  }

  const data: ActionHubData = {
    generatedAt: new Date().toISOString(),
    items: resolvedItems,
  };

  const linkedInboxItem = initialId
    ? resolvedItems.some((item) => item.id === initialId && (!initialModule || item.module === initialModule))
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
        movedOutQueues={marketingInbox ? [marketingInbox] : undefined}
        decidedForMe={decidedForMe}
        decidedForMeWindowDays={DECIDED_FOR_ME_WINDOW_DAYS}
        embedded
      />
    </EmployeePortalPageShell>
  );
}
