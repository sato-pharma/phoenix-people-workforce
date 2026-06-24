import { redirect } from "next/navigation";

import { ActionsWorkspace } from "@/components/action-center/actions-workspace";
import type { ActionHubData, ActionHubModule } from "@/components/action-center/types";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getActionCenterDeepLinkItem,
  getAwaitingMyActionItems,
  getMyRequestItems,
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

export default async function ActionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const params = await searchParams;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/actions${preservedQuery(params)}`);
  }

  const initialModule = (typeof params.module === "string" ? params.module : null) as ActionHubModule | null;
  const initialId = typeof params.id === "string" ? params.id : null;

  // Admin audience: the full cross-module inbox (marketing always excluded — it keeps
  // its own dedicated inbox). "My requests" resolves in parallel.
  const [baseItems, myRequests] = await Promise.all([
    getAwaitingMyActionItems(access, "admin"),
    getMyRequestItems(access).catch(() => []),
  ]);
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
  const initialTab: "inbox" | "mine" =
    initialModule || initialId || items.length > 0 ? "inbox" : myRequests.length > 0 ? "mine" : "inbox";

  return (
    <ActionsWorkspace
      inboxData={data}
      myRequests={myRequests}
      initialModule={initialModule}
      initialId={initialId}
      callerRole={access.role}
      initialTab={initialTab}
    />
  );
}
