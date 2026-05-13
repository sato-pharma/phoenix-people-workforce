import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { ManagerLeaveApprovalWorkspace } from "@/components/leave/leave-workspaces";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getManagerLeaveWorkspace } from "@/lib/leave/service";

export const dynamic = "force-dynamic";

export default async function ManagerLeaveApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/leave");
  }
  if (access.role === "Training Manager") {
    redirect("/employee-portals/training-manager");
  }

  if (!(await canAccess(access, "leave", "approve"))) {
    return (
      <EmployeePortalEmptyState
        message="Leave approvals are available only to managers and authorized approvers."
        title="Leave Approval Access Unavailable"
      />
    );
  }

  let data = null;
  try {
    data = await getManagerLeaveWorkspace(access);
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Manager leave approvals are temporarily unavailable."
        title="Leave Approvals Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Manager Workflow"
      description="Approve or reject leave requests for employees under your reporting hierarchy."
      title="Team Leave Approvals"
    >
      <ManagerLeaveApprovalWorkspace {...data} />
    </EmployeePortalPageShell>
  );
}
