import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { EmployeeLeaveWorkspace } from "@/components/leave/leave-workspaces";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeeLeaveWorkspace } from "@/lib/leave/service";

export const dynamic = "force-dynamic";

export default async function EmployeeLeavePage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/leave");
  }

  if (!(await canAccess(access, "leave", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to view leave records."
        title="Leave Access Unavailable"
      />
    );
  }

  let data = null;
  try {
    data = await getEmployeeLeaveWorkspace(access);
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Leave data is temporarily unavailable. Please try again in a moment."
        title="Leave Workspace Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Vacation / Leave"
      description="Manage annual leave balance, submit requests, and review approval history."
      title="Vacation / Leave Management"
    >
      <EmployeeLeaveWorkspace {...data} />
    </EmployeePortalPageShell>
  );
}
