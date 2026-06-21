import {
  assertPermission,
  type AccessContext,
  type PermissionAction,
  type PhoenixRole,
} from "@/lib/auth/permissions";

// Only HR Manager (Super Admin with HR Manager title) may review and reject outstation
// requests. Finance Manager and CEO are not approvers — they are execution/read-only.
const adminOutstationRoles = new Set<PhoenixRole>([
  "Super Admin",
]);

// Explicitly named to prevent accidental promotion: these roles see outstation data but
// must NEVER gain approval authority. Exported for governance tests.
export const executionOnlyOutstationRoles: ReadonlyArray<PhoenixRole> = [
  "Finance Manager",
  "CEO",
];

export function canUseAdminOutstationWorkspace(access: AccessContext) {
  return access.scope === "system" || adminOutstationRoles.has(access.role);
}

export async function assertOutstationAdminAccess(
  access: AccessContext,
  action: PermissionAction = "approve",
) {
  await assertPermission(access, "outstation", action);

  // CEO and Finance Manager are read-only observers — they can view the dashboard
  // but must never gain approval authority (enforced by executionOnlyOutstationRoles).
  const isReadOnly = action === "read";
  const isExecutionOnly = executionOnlyOutstationRoles.includes(access.role);
  if (!canUseAdminOutstationWorkspace(access) && !(isReadOnly && isExecutionOnly)) {
    throw new Error(
      "Forbidden: only HR Manager (Super Admin) can access admin outstation expenses.",
    );
  }
}
