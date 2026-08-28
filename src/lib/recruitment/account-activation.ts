// Narrow, portal-only account activate/deactivate tool for Talent Acquisition.
//
// Deliberately kept separate from src/lib/admin/access-control.ts: this surface must never
// grow into role/permission/scope management. It only lists and toggles `is_active` on
// regular-rank accounts (Employee, Medical Rep, District Manager, ...) — Super Admin, CEO,
// and other Talent Acquisition accounts are unreachable, enforced server-side by
// getRolePrivilegeRank/assertActorMayManageUser inside updateAccountActiveForRecruiting, not
// just hidden in the UI.

import { assertPermission, getRolePrivilegeRank, parseRoleStrict, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { updateAccountActiveForRecruiting } from "@/lib/admin/access-control";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AccountActivationRow = {
  isActive: boolean;
  loginId: string;
  name: string;
  role: PhoenixRole;
};

const HR_ADVISORY_RANK = getRolePrivilegeRank("HR Advisory");

function isEligibleRole(role: PhoenixRole) {
  return getRolePrivilegeRank(role) < HR_ADVISORY_RANK;
}

/**
 * Accounts a Talent Acquisition actor may activate/deactivate — regular-rank roles only.
 * Returns just {loginId, name, role, isActive}: no permissions, overrides, audit log, or
 * scope data (unlike getAccessControlDashboard).
 */
export async function listAccountActivationEligibleUsers(): Promise<AccountActivationRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("login_id,role,is_active,name")
    .order("login_id", { ascending: true });

  if (error) throw error;

  const rows: AccountActivationRow[] = [];
  for (const row of data ?? []) {
    let role: PhoenixRole;
    try {
      role = parseRoleStrict((row as { role: string }).role);
    } catch {
      continue;
    }
    if (!isEligibleRole(role)) continue;

    const typedRow = row as { login_id: string; is_active: boolean; name?: string | null };
    rows.push({
      isActive: typedRow.is_active,
      loginId: typedRow.login_id,
      name: typedRow.name ?? typedRow.login_id,
      role,
    });
  }
  return rows;
}

/**
 * Activate/deactivate one account on behalf of a Talent Acquisition actor. Asserts the
 * `account_activation:update` permission, then delegates the actual mutation (GoTrue sync,
 * forced session invalidation, audit log, rollback-on-failure) to the shared core in
 * access-control.ts via its Talent-Acquisition-only entry point.
 */
export async function setAccountActiveForRecruiting(
  access: AccessContext,
  loginId: string,
  isActive: boolean,
) {
  await assertPermission(access, "account_activation", "update");
  return updateAccountActiveForRecruiting(
    loginId,
    isActive,
    { loginId: access.loginId ?? null, role: access.role },
    isActive ? "Activated via the HR account-activation tool" : "Deactivated via the HR account-activation tool",
  );
}
