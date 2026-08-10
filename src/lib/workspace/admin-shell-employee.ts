import { redirect } from "next/navigation";

import {
  adminShellEmployeeRoles,
  canAccess,
  type AccessContext,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessAdminShellEmployeeWorkspacePage } from "@/lib/workspace/admin-shell-employee-roles";

// The role sets live in ./admin-shell-employee-roles (no next/navigation import, so tests can
// import them directly). Re-exported here so existing call sites keep their import path.
export {
  canAccessAdminShellEmployeeWorkspacePage,
  workspaceExpenseDashboardRoles,
  workspaceMarketingRoles,
} from "@/lib/workspace/admin-shell-employee-roles";

type WorkspaceAccessOptions = {
  action?: PermissionAction;
  allowedRoles?: readonly PhoenixRole[];
  resource?: PermissionResource;
};

export async function requireAdminShellEmployeeWorkspaceAccess({
  action = "read",
  allowedRoles = adminShellEmployeeRoles,
  resource,
}: WorkspaceAccessOptions = {}): Promise<AccessContext> {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  if (!canAccessAdminShellEmployeeWorkspacePage(access.role, allowedRoles)) {
    redirect(resolveLandingPathForRole(access.role));
  }

  if (resource && !(await canAccess(access, resource, action))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  return access;
}
