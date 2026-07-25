import { redirect } from "next/navigation";

import { SupportRequestsWorkspace } from "@/components/admin/support-requests-workspace";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listAllSupportRequests } from "@/lib/support-requests/service";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/admin/support-requests/page.tsx — the HR-side
// ticket queue (manage), distinct from /employee-portals/contact-hr-support
// (the employee-side ticket submission form).
export default async function EmployeePortalSupportRequestsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/support-requests");
  }
  const canRead = await canAccess(access, "support_requests", "read");
  if (!canRead) {
    return (
      <EmployeePortalEmptyState
        message="HR support ticket management is available to Talent Acquisition and Super Admin only."
        title="HR Support Requests Unavailable"
      />
    );
  }
  const canManage = await canAccess(access, "support_requests", "update");

  let initialItems = [] as Awaited<ReturnType<typeof listAllSupportRequests>>;
  try {
    initialItems = await listAllSupportRequests(access, { status: "all", limit: 100 });
  } catch {
    initialItems = [];
  }

  return (
    <EmployeePortalPageShell
      badge="Employee Care"
      description="Review tickets opened by employees and move each one through Pending, In Progress, Resolved, and Closed."
      errorBoundaryTitle="HR Support Requests unavailable"
      title="HR Support Requests"
    >
      <SupportRequestsWorkspace canManage={canManage} initialItems={initialItems} />
    </EmployeePortalPageShell>
  );
}
