import { redirect } from "next/navigation";

import {
  adminShellEmployeeRoles,
  canAccess,
  isAdminShellEmployeeRole,
  type AccessContext,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const workspaceMarketingRoles = [
  "SFE Manager",
  // Finance Execution of marketing requests runs from the workspace shell. Financial Advisor is the
  // designated executor. Finance Manager is included so they can monitor requests as observers.
  "Finance Manager",
  "Financial Advisor",
] as const satisfies readonly PhoenixRole[];

type WorkspaceAccessOptions = {
  action?: PermissionAction;
  allowedRoles?: readonly PhoenixRole[];
  resource?: PermissionResource;
};

function includesRole(roles: readonly PhoenixRole[], role: PhoenixRole) {
  return roles.some((entry) => entry === role);
}

export function canUseAdminShellEmployeeWorkspace(role: PhoenixRole) {
  return isAdminShellEmployeeRole(role);
}

export async function requireAdminShellEmployeeWorkspaceAccess({
  action = "read",
  allowedRoles = adminShellEmployeeRoles,
  resource,
}: WorkspaceAccessOptions = {}): Promise<AccessContext> {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  if (
    access.role !== "Super Admin" &&
    (!canUseAdminShellEmployeeWorkspace(access.role) || !includesRole(allowedRoles, access.role))
  ) {
    redirect(resolveLandingPathForRole(access.role));
  }

  if (resource && !(await canAccess(access, resource, action))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  return access;
}
