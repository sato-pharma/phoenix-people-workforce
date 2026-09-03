import { redirect } from "next/navigation";

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
      <section className="space-y-1.5 border-b border-phx-line pb-4">
        <p className="text-[11px] font-black uppercase tracking-[0.22em] text-orange-600">Employee Care</p>
        <h1 className="max-w-4xl text-[1.15rem] font-black tracking-[-0.03em] text-slate-900 sm:text-[1.3rem]">
          HR Support Requests
        </h1>
        <p className="max-w-3xl text-[13px] leading-5 text-slate-600">
          Review tickets opened by employees and move each one through Pending, In Progress,
          Resolved, and Closed.
        </p>
      </section>
      <SupportRequestsWorkspace canManage={canManage} initialItems={initialItems} />
    </div>
  );
}
