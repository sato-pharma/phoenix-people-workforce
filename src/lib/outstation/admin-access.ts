import {
  assertPermission,
  scopeForRole,
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

/**
 * Whether the person a Super Admin is VIEWING AS in the Approvals Hub may decide outstation
 * requests — and so whether that person's queue holds any.
 *
 * The hub's other feeds are scoped to the viewed person; the outstation feed is one unscoped,
 * company-wide read (listOutstationRequests), so until 2026-09-19 every submitted trip in the
 * company appeared in the queue of whichever manager was picked (audit F-31). This applies the
 * Action Center's own gate — canUseAdminOutstationWorkspace(access, "approve") — to the VIEWED
 * person instead.
 *
 * It is built from the viewed person's own role and that role's own scope, never from the caller's
 * context: the caller is a Super Admin (or a system context, whose scope alone opens the gate), so
 * reusing his context would open the feed for everyone he views. An unknown role — no account, or a
 * value that is not a Phoenix role — answers false.
 */
export function viewedPersonCanApproveOutstation(role: string | null | undefined): boolean {
  if (!role) return false;
  const viewed = role as PhoenixRole;
  return canUseAdminOutstationWorkspace(
    { hrId: null, role: viewed, scope: scopeForRole(viewed), source: "session" },
    "approve",
  );
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
