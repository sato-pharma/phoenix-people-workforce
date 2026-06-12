import { redirect } from "next/navigation";

import {
  adminHeroDescriptionClassName,
  adminHeroKickerClassName,
  adminHeroSurfaceClassName,
  adminHeroTitleClassName,
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
      <section className={`${adminHeroSurfaceClassName} p-6 sm:p-7`}>
        <div className="relative z-10 space-y-3">
          <p className={adminHeroKickerClassName}>Employee Care</p>
          <h1 className={adminHeroTitleClassName}>HR Support Requests</h1>
          <p className={adminHeroDescriptionClassName}>
            Review tickets opened by employees and move each one through Pending, In Progress,
            Resolved, and Closed.
          </p>
        </div>
      </section>
      <SupportRequestsWorkspace canManage={canManage} initialItems={initialItems} />
    </div>
  );
}
