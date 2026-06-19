import { redirect } from "next/navigation";

import { ActionsWorkspace } from "@/components/action-center/actions-workspace";
import type { ActionHubData, ActionHubModule } from "@/components/action-center/types";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getAwaitingMyActionItems, getMyRequestItems } from "@/lib/action-center/service";

export const dynamic = "force-dynamic";

export default async function ActionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  const params = await searchParams;
  const initialModule = (typeof params.module === "string" ? params.module : null) as ActionHubModule | null;
  const initialId = typeof params.id === "string" ? params.id : null;

  // Admin audience: the full cross-module inbox (marketing always excluded — it keeps
  // its own dedicated inbox). "My requests" resolves in parallel.
  const [items, myRequests] = await Promise.all([
    getAwaitingMyActionItems(access, "admin"),
    getMyRequestItems(access).catch(() => []),
  ]);

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
