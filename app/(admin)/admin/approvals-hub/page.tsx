import { redirect } from "next/navigation";

import { ActionsWorkspace } from "@/components/action-center/actions-workspace";
import type { ActionHubData, ActionHubModule, HistoricalApprovalItem, MyRequestItem } from "@/components/action-center/types";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getActionCenterDeepLinkItem,
  getAwaitingMyActionItems,
  getMyRequestItems,
  getMyApprovalHistory,
} from "@/lib/action-center/service";

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

// Vacation, excuse and weekly/monthly plans left the "Other Approvals" inbox for their own
// dedicated pages. A stale link (old notification, bookmarked history URL) that still points at
// ?module=leave|excuse|weekly_plan must never inject that request back into this inbox — bounce it
// to the dedicated page instead so Other Approvals only ever shows resignation/contract/outstation.
const MIGRATED_DEEPLINK_BASES: Record<string, string> = {
  leave: "/admin/approvals/vacation",
  excuse: "/admin/approvals/excuse",
  weekly_plan: "/admin/approvals/plan",
};

export default async function AdminApprovalsHubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const params = await searchParams;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/approvals-hub${preservedQuery(params)}`);
  }

  const initialModule = (typeof params.module === "string" ? params.module : null) as ActionHubModule | null;
  const initialId = typeof params.id === "string" ? params.id : null;

  // Migrated modules never render inside this hub — redirect to their dedicated page.
  if (initialModule && MIGRATED_DEEPLINK_BASES[initialModule]) {
    const base = MIGRATED_DEEPLINK_BASES[initialModule];
    redirect(initialId ? `${base}/${encodeURIComponent(initialId)}` : base);
  }

  // Admin audience: the full cross-module inbox (marketing always excluded — it keeps
  // its own dedicated inbox). "My requests" and history resolve in parallel.
  const [baseItems, rawMyRequests, rawHistoricalItems]: [Awaited<ReturnType<typeof getAwaitingMyActionItems>>, MyRequestItem[], HistoricalApprovalItem[]] = await Promise.all([
    getAwaitingMyActionItems(access, "admin"),
    getMyRequestItems(access).catch((): MyRequestItem[] => []),
    getMyApprovalHistory(access).catch((): HistoricalApprovalItem[] => []),
  ]);
  // Every migrated module (leave/excuse/weekly_plan) has its own "My Requests"/"History" tabs on
  // its dedicated hub (approvals-hub/service.ts filters these same shared functions down to one
  // module each) — drop them here too, reusing MIGRATED_DEEPLINK_BASES as the one list of which
  // modules that applies to, so a request never shows twice.
  const myRequests = rawMyRequests.filter((item) => !MIGRATED_DEEPLINK_BASES[item.module]);
  const historicalItems = rawHistoricalItems.filter((item) => !MIGRATED_DEEPLINK_BASES[item.module]);
  const items = [...baseItems];
  if (initialModule && initialId && !items.some((item) => item.id === initialId && item.module === initialModule)) {
    const linkedItem = await getActionCenterDeepLinkItem(access, initialModule, initialId);
    if (linkedItem) items.unshift(linkedItem);
  }

  const data: ActionHubData = {
    generatedAt: new Date().toISOString(),
    items,
  };

  // Approvers land on their inbox; pure requesters (empty inbox) land on "My requests".
  const initialTab: "inbox" | "mine" | "historical" =
    initialModule || initialId || items.length > 0 ? "inbox" : myRequests.length > 0 ? "mine" : "inbox";

  return (
    <ActionsWorkspace
      inboxData={data}
      myRequests={myRequests}
      historicalItems={historicalItems}
      initialModule={initialModule}
      initialId={initialId}
      callerRole={access.role}
      initialTab={initialTab}
    />
  );
}
