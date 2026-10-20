import { redirect } from "next/navigation";

import { SupportRequestsWorkspace } from "@/components/admin/support-requests-workspace";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
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
        message="HR support ticket management is available to the HR Generalist and the Super Admin only."
        title="HR Support Requests Unavailable"
      />
    );
  }
  const canManage = await canAccess(access, "support_requests", "update");

  let initialItems = [] as Awaited<ReturnType<typeof listAllSupportRequests>>;
  let loadFailed = false;
  try {
    initialItems = await listAllSupportRequests(access, { status: "all", limit: 100 });
  } catch (error) {
    // A FAILED READ IS NOT AN EMPTY QUEUE. This catch handed the workspace `[]`, and an empty
    // ticket board reads to HR Advisory as "no employee is waiting on us" — on the one screen whose
    // whole job is that nobody is left waiting. AGENTS.md §1: a confident zero is worse than an
    // error. The pattern here is attendance/page.tsx's: record it, say so, and never dress the
    // failure up as a fact about the queue.
    logPortalFailure(
      {
        route: "/employee-portals/support-requests",
        module: "support-requests-queue",
        role: access.role,
        hrId: access.hrId,
      },
      error,
    );
    loadFailed = true;
    initialItems = [];
  }

  if (loadFailed) {
    return (
      <EmployeePortalEmptyState
        message="The support queue could not be loaded just now. No ticket has been lost or closed — reload the page to try again."
        title="Could not load the support queue"
      />
    );
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
