import {
  assertPermission,
  type AccessContext,
  type PermissionAction,
  type PhoenixRole,
} from "@/lib/auth/permissions";

// Only HR Manager (Super Admin with HR Manager title) may review and reject outstation
// requests. The CEO is not an approver — read-only oversight.
const adminOutstationRoles = new Set<PhoenixRole>([
  "Super Admin",
]);

// Explicitly named to prevent accidental promotion: these roles see outstation data but
// must NEVER gain approval authority. Exported for governance tests.
//
// Finance Manager removed 2026-08-10 (owner: "exclude him 100% from outstation or expenses").
// He is not read-only here any more, he is OUT — the `outstation` key was deleted from his matrix
// in the same change, so assertOutstationAdminAccess would reject him at the assertPermission on
// line 43 regardless. Removing him from this list too matters because canUseAdminOutstationWorkspace
// is ALSO called on its own, without that assertPermission, by the Action Center inbox and the CEO
// command center's expense snapshot — the list is the only gate on those paths.
export const executionOnlyOutstationRoles: ReadonlyArray<PhoenixRole> = [
  "CEO",
];

export function canUseAdminOutstationWorkspace(
  access: AccessContext,
  action: PermissionAction = "approve",
) {
  if (access.scope === "system") return true;
  if (adminOutstationRoles.has(access.role)) return true;
  if (action === "read" && executionOnlyOutstationRoles.includes(access.role)) return true;
  return false;
}

export async function assertOutstationAdminAccess(
  access: AccessContext,
  action: PermissionAction = "approve",
) {
  if (!canUseAdminOutstationWorkspace(access, action)) {
    throw new Error(
      action === "approve"
        ? "Forbidden: only HR Manager (Super Admin) can access admin outstation expenses."
        : "Forbidden: only HR Manager (Super Admin) and approved read-only finance roles can access this admin workspace.",
    );
  }

  await assertPermission(access, "outstation", action);
}
