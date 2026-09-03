import { redirect } from "next/navigation";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

import { SupportRequestsWorkspace } from "@/components/admin/support-requests-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listAllSupportRequests } from "@/lib/support-requests/service";

export const dynamic = "force-dynamic";

export default async function AdminSupportRequestsPage() {
  const access = await resolveAccessContextFromPage();
  const canRead = await canAccess(access, "support_requests", "read");
  if (!canRead) {
    redirect("/overview");
  }
  const canManage = await canAccess(access, "support_requests", "update");

  let initialItems = [] as Awaited<ReturnType<typeof listAllSupportRequests>>;
  try {
    initialItems = await listAllSupportRequests(access, { status: "all", limit: 100 });
  } catch {
    initialItems = [];
  }

  return (
    <div className="space-y-6">
      {/* No dark band. This page built one from the hero TOKENS directly instead of using
          `AdminPageHero`, so flattening that component on 2026-09-03 did not reach it — it is
          spelled out light here to match the other 131. Owner: "remove from all pages this dump
          block". */}
      <section className="min-w-0">
        <div className="relative space-y-1.5 pb-4 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Employee Care</p>
          <h1 className={pageHeaderTitleClassName}>HR Support Requests</h1>
          <p className={pageHeaderDescriptionClassName}>
            Review tickets opened by employees and move each one through Pending, In Progress,
            Resolved, and Closed.
          </p>
        </div>
        <div aria-hidden="true" className={pageHeaderRuleClassName} />
      </section>
      <SupportRequestsWorkspace canManage={canManage} initialItems={initialItems} />
    </div>
  );
}
