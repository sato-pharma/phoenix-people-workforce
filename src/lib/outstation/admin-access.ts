import {
  assertPermission,
  type AccessContext,
  type PermissionAction,
  type PhoenixRole,
} from "@/lib/auth/permissions";

const adminOutstationRoles = new Set<PhoenixRole>([
  "Super Admin",
  "Finance Manager",
  "CEO",
]);

export function canUseAdminOutstationWorkspace(access: AccessContext) {
  return access.scope === "system" || adminOutstationRoles.has(access.role);
}

export async function assertOutstationAdminAccess(
  access: AccessContext,
  action: PermissionAction = "approve",
) {
  await assertPermission(access, "outstation", action);

  if (!canUseAdminOutstationWorkspace(access)) {
    throw new Error(
      "Forbidden: only Super Admin, Finance Manager, or CEO can access admin outstation expenses.",
    );
  }
}
