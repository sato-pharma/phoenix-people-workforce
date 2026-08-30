/**
 * The accounts a system administrator can lock a module on, and — per account — the modules that
 * account NORMALLY holds.
 *
 * This lives beside the lock service rather than inside it to keep the import graph acyclic:
 * `permissions.ts` calls into `module-locks.ts` on every access check, so `module-locks.ts` may only
 * take TYPES back from it. This file is downstream of both and is free to read the live permission
 * matrix.
 *
 * "Modules he normally has access to" is the owner's own framing, and it is the whole point of the
 * picker: offering all 47 resources against every account would invite locking something the person
 * could never open anyway, which does nothing and reads afterwards as a lock that failed.
 */

import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { isLockableModule } from "./module-locks";
import { moduleLabel } from "@/lib/navigation/module-catalog";
import {
  getPermissionMatrix,
  permissionResources,
  phoenixRoles,
  type AccessContext,
  type PermissionResource,
  type PhoenixRole,
} from "./permissions";

export type LockableModuleOption = {
  key: PermissionResource;
  label: string;
};

export type LockableAccount = {
  loginId: string;
  hrId: string | null;
  fullName: string | null;
  displayName: string | null;
  role: PhoenixRole | null;
  /** Modules this account's role can READ, minus the ones a lock may never be placed on. */
  modules: LockableModuleOption[];
};

type AuthUserRow = {
  login_id: string | null;
  hr_id: string | null;
  role: string | null;
};

function asPhoenixRole(value: string | null): PhoenixRole | null {
  if (!value) return null;
  const match = phoenixRoles.find((role) => role.toLowerCase() === value.trim().toLowerCase());
  return match ?? null;
}

/**
 * The administrator's own name, for the "locked by" line. A login id is a code, and the owner's
 * standing rule is that a screen shows people by name — so the id is only ever the last resort.
 */
export async function resolveAdministratorName(access: AccessContext): Promise<string | null> {
  const supabase = getSupabaseAdmin();

  if (access.loginId) {
    const { data } = await supabase
      .from("app_auth_users")
      .select("name")
      .eq("login_id", access.loginId)
      .maybeSingle();
    const name = (data as { name?: string | null } | null)?.name?.trim();
    if (name) return name;
  }

  if (access.hrId) {
    const { data } = await supabase
      .from("employees")
      .select("full_name")
      .ilike("hr_id", access.hrId)
      .maybeSingle();
    const fullName = (data as { full_name?: string | null } | null)?.full_name?.trim();
    if (fullName) return fullName;
  }

  return access.loginId || null;
}

export async function listLockableAccounts(): Promise<LockableAccount[]> {
  const supabase = getSupabaseAdmin();

  const [{ data, error }, matrix] = await Promise.all([
    supabase
      .from("app_auth_users")
      .select("login_id, hr_id, role")
      .eq("is_active", true)
      .order("login_id", { ascending: true }),
    getPermissionMatrix(),
  ]);

  if (error) throw error;

  const rows = ((data ?? []) as AuthUserRow[]).filter((row) => Boolean(row.login_id));

  // Names come from `employees`, in batches: PostgREST folds every `.in()` value into the request
  // URL, and this list is every active login in the company.
  const hrIds = rows.map((row) => row.hr_id).filter((value): value is string => Boolean(value));
  const nameByHrId = new Map<string, string | null>();
  const nicknameByHrId = new Map<string, string | null>();
  for (let index = 0; index < hrIds.length; index += 100) {
    const batch = hrIds.slice(index, index + 100);
    const { data: employeeRows } = await supabase
      .from("employees")
      .select("hr_id, full_name, nickname")
      .in("hr_id", batch);
    for (const row of (employeeRows ?? []) as Array<{
      hr_id: string;
      full_name: string | null;
      nickname: string | null;
    }>) {
      if (!row.hr_id) continue;
      const key = canonicalHrIdForDisplay(row.hr_id) ?? row.hr_id.toUpperCase();
      nameByHrId.set(key, row.full_name ?? null);
      nicknameByHrId.set(key, row.nickname ?? null);
    }
  }

  // One module list per ROLE rather than per account — 20-odd roles against ~160 accounts.
  const modulesByRole = new Map<PhoenixRole, LockableModuleOption[]>();
  function modulesForRole(role: PhoenixRole): LockableModuleOption[] {
    const cached = modulesByRole.get(role);
    if (cached) return cached;
    const options = permissionResources
      .filter((resource) => isLockableModule(resource))
      .filter((resource) => (matrix[role]?.[resource] ?? []).includes("read"))
      .map((resource) => ({ key: resource, label: moduleLabel(resource) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    modulesByRole.set(role, options);
    return options;
  }

  return rows.map((row) => {
    const key = row.hr_id ? canonicalHrIdForDisplay(row.hr_id) ?? row.hr_id.toUpperCase() : null;
    const fullName = key ? nameByHrId.get(key) ?? null : null;
    const role = asPhoenixRole(row.role);
    return {
      loginId: row.login_id as string,
      hrId: row.hr_id ?? null,
      fullName,
      displayName: fullName
        ? resolveEmployeeDisplayName(fullName, key ? nicknameByHrId.get(key) ?? null : null, key)
        : null,
      role,
      modules: role ? modulesForRole(role) : [],
    };
  });
}
