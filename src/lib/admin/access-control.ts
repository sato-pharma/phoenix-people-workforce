import bcrypt from "bcryptjs";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  clearPermissionMatrixCache,
  getPayrollScope,
  getPermissionMatrix,
  getRolePrivilegeRank,
  getSalesScope,
  parsePermissionActionStrict,
  parsePermissionResourceStrict,
  parseRoleStrict,
  phoenixRoles,
  type BusinessScope,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import {
  mapPhoenixRoleToAccessScopeType,
  mapPhoenixRoleToCoarseAccessRole,
  deleteSupabaseAuthIdentity,
  provisionSupabaseAuthIdentity,
  setSupabaseAuthIdentityAccess,
} from "@/lib/auth/supabase-identity";
import { createTemporaryAuthPassword } from "@/lib/auth/password-setup";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const phoenixLines = ["CNS", "Pedia", "Anti-Infective", "Office", "Other"] as const;
export type PhoenixLine = (typeof phoenixLines)[number];

export type AccessUserRow = {
  createdAt: string;
  email: string | null;
  forcePasswordReset: boolean;
  hrId: string | null;
  isActive: boolean;
  line: PhoenixLine;
  loginId: string;
  managerHrId: string | null;
  name: string;
  payrollScope: BusinessScope;
  role: PhoenixRole;
  salesScope: BusinessScope;
  salesScopeOverride: BusinessScope | null;
  updatedAt: string;
};

export type AuditLogRow = {
  actorLoginId: string | null;
  createdAt: string;
  entityId: string | null;
  entityType: string;
  id: string;
  newValues: Record<string, unknown> | null;
  oldValues: Record<string, unknown> | null;
  summary: string;
};

export type PermissionOverrideRow = {
  action: PermissionAction;
  isAllowed: boolean;
  resource: PermissionResource;
  role: PhoenixRole;
};

type AccessUserDbRow = {
  auth_email?: string | null;
  auth_user_id?: string | null;
  created_at: string;
  email?: string | null;
  force_password_reset?: boolean | null;
  hr_id: string | null;
  is_active: boolean;
  line?: string | null;
  login_id: string;
  manager_hr_id?: string | null;
  name?: string | null;
  role: string;
  sales_scope_override?: string | null;
  session_version?: number | null;
  updated_at: string;
};

export type AccessUserMutation = {
  email?: string | null;
  governanceReason?: string | null;
  hrId?: string | null;
  isActive?: boolean;
  loginId: string;
  managerHrId?: string | null;
  name?: string | null;
  line?: string | null;
  role: PhoenixRole | string;
  salesScopeOverride?: BusinessScope | null;
};

export type AccessActor = {
  loginId: string | null;
  role: PhoenixRole;
};

type AccessUserRecord = Record<string, unknown> & {
  auth_email?: string | null;
  auth_user_id?: string | null;
  email?: string | null;
  force_password_reset?: boolean | null;
  hr_id?: string | null;
  is_active?: boolean | null;
  line?: string | null;
  login_id?: string | null;
  manager_hr_id?: string | null;
  name?: string | null;
  password_hash?: string | null;
  role?: string | null;
  sales_scope_override?: string | null;
  session_version?: number | null;
};

function normalizeLine(value: string | null | undefined): PhoenixLine {
  const normalized = String(value ?? "").trim().toLowerCase();
  // Exact match first
  const matched = phoenixLines.find((line) => line.toLowerCase() === normalized);
  if (matched) return matched;
  // Alias map for legacy / abbreviated line names from DB (e.g. "Anti Inf" → "Anti-Infective")
  const aliases: Record<string, PhoenixLine> = {
    "anti inf": "Anti-Infective",
    "anti-inf": "Anti-Infective",
    "antiinfective": "Anti-Infective",
    "anti infective": "Anti-Infective",
  };
  return aliases[normalized] ?? "Other";
}

function normalizeScope(value: string | null | undefined): BusinessScope | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return ["SELF", "TEAM", "HIERARCHY", "LINE", "COMPANY", "NONE"].includes(normalized)
    ? (normalized as BusinessScope)
    : null;
}

function employeeByHrId(directory: EmployeeDirectoryRow[]) {
  return new Map(directory.map((employee) => [employee.hrId.trim().toLowerCase(), employee]));
}

function toUser(row: AccessUserDbRow, employee?: EmployeeDirectoryRow): AccessUserRow {
  const role = parseRoleStrict(row.role);
  const salesScopeOverride = normalizeScope(row.sales_scope_override);
  const line = normalizeLine(row.line ?? employee?.lineName);
  const managerHrId = row.manager_hr_id ?? employee?.managerHrId ?? null;
  const hrId = row.hr_id ?? null;
  const name = row.name ?? employee?.fullName ?? row.login_id;

  return {
    createdAt: row.created_at,
    email: row.email ?? employee?.workEmail ?? null,
    forcePasswordReset: Boolean(row.force_password_reset),
    hrId,
    isActive: row.is_active,
    line,
    loginId: row.login_id,
    managerHrId,
    name,
    payrollScope: getPayrollScope({ role }),
    role,
    salesScope: getSalesScope({ role, salesScopeOverride }),
    salesScopeOverride,
    updatedAt: row.updated_at,
  };
}

async function listAuditLogs(): Promise<AuditLogRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id,actor_login_id,entity_type,entity_id,summary,old_values,new_values,created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return [];

  return (data ?? []).map((row) => {
    const item = row as Record<string, unknown>;
    return {
      actorLoginId: item.actor_login_id ? String(item.actor_login_id) : null,
      createdAt: String(item.created_at),
      entityId: item.entity_id ? String(item.entity_id) : null,
      entityType: String(item.entity_type ?? "user"),
      id: String(item.id),
      newValues: (item.new_values as Record<string, unknown> | null) ?? null,
      oldValues: (item.old_values as Record<string, unknown> | null) ?? null,
      summary: String(item.summary ?? "Access control change"),
    };
  });
}

async function listPermissionOverrides(): Promise<PermissionOverrideRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("role_permission_overrides")
    .select("role_name,resource,action,is_allowed");

  if (error || !data) {
    return [];
  }

  return (data as Array<{ action: string | null; is_allowed: boolean | null; resource: string | null; role_name: string | null }>)
    .map((row) => {
      try {
        if (typeof row.is_allowed !== "boolean") return null;
        return {
          action: parsePermissionActionStrict(row.action),
          isAllowed: row.is_allowed,
          resource: parsePermissionResourceStrict(row.resource),
          role: parseRoleStrict(row.role_name),
        };
      } catch {
        return null;
      }
    })
    .filter((row): row is PermissionOverrideRow => row !== null);
}

async function auditUserChange(input: {
  actor?: AccessActor | null;
  entityId: string;
  newValues?: Record<string, unknown> | null;
  oldValues?: Record<string, unknown> | null;
  summary: string;
}) {
  await writeRequiredAuditLog({
    actorLoginId: input.actor?.loginId ?? null,
    entityId: input.entityId,
    entityType: "user",
    newValues: input.newValues,
    oldValues: input.oldValues,
    summary: input.summary,
  });
}

function getStoredRole(record: AccessUserRecord | null) {
  return record?.role ? parseRoleStrict(record.role) : null;
}

function getStoredSessionVersion(record: AccessUserRecord | null) {
  return Number.isFinite(record?.session_version) ? Number(record?.session_version) : 1;
}

function isStoredActive(record: AccessUserRecord | null) {
  return Boolean(record?.is_active);
}

function logCompensationFailure(context: string, error: unknown) {
  console.error(JSON.stringify({
    context,
    error: error instanceof Error ? error.message : String(error),
    event: "access_control_compensation_failed",
  }));
}

async function countActiveSuperAdmins() {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("app_auth_users")
    .select("*", { count: "exact", head: true })
    .eq("role", "Super Admin")
    .eq("is_active", true);

  if (error) throw error;
  return count ?? 0;
}

async function assertLastSuperAdminInvariant(
  existing: AccessUserRecord | null,
  nextRole: PhoenixRole,
  nextIsActive: boolean,
) {
  const existingRole = getStoredRole(existing);
  if (!existing || existingRole !== "Super Admin") return;
  if (!isStoredActive(existing)) return;
  if (nextRole === "Super Admin" && nextIsActive) return;

  const activeSuperAdmins = await countActiveSuperAdmins();
  if (activeSuperAdmins <= 1) {
    throw new Error("Cannot remove or deactivate the last active Super Admin.");
  }
}

export function assertActorMayManageUser(input: {
  actor?: AccessActor | null;
  existing: AccessUserRecord | null;
  loginId: string;
  nextIsActive: boolean;
  nextRole: PhoenixRole;
}) {
  const actor = input.actor;
  if (!actor?.loginId) return;

  const existingRole = getStoredRole(input.existing);
  const actorRank = getRolePrivilegeRank(actor.role);
  const nextRank = getRolePrivilegeRank(input.nextRole);
  const existingRank = existingRole ? getRolePrivilegeRank(existingRole) : null;
  const isSelf = actor.loginId === input.loginId;

  if (isSelf && isStoredActive(input.existing) && !input.nextIsActive) {
    throw new Error("You cannot deactivate your own active account.");
  }

  if (isSelf && existingRole && input.nextRole !== existingRole && nextRank < getRolePrivilegeRank(existingRole)) {
    throw new Error("You cannot downgrade your own role.");
  }

  if (actor.role === "Super Admin") {
    return;
  }

  if (input.nextRole === "Super Admin" || existingRole === "Super Admin") {
    throw new Error("Only Super Admin can manage Super Admin accounts.");
  }

  if (!isSelf) {
    if (existingRank !== null && existingRank >= actorRank) {
      throw new Error("You cannot modify peer or higher-privilege accounts.");
    }
    if (nextRank >= actorRank) {
      throw new Error("You cannot assign peer or higher-privilege roles.");
    }
  } else if (input.nextRole !== actor.role && nextRank >= actorRank) {
    throw new Error("You cannot elevate your own role.");
  }

}

export function assertSuperAdminUserAdminActor(actor?: AccessActor | null) {
  // Internal system flows may provision users without an interactive actor.
  // Any authenticated API/user-admin actor must be Super Admin only.
  if (!actor?.loginId) return;
  if (actor.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can manage user access.");
  }
}

export async function getAccessControlDashboard() {
  const supabase = getSupabaseAdmin();
  let result: {
    data: unknown[] | null;
    error: { message?: string } | null;
  } = await supabase
    .from("app_auth_users")
    .select("login_id,role,hr_id,is_active,created_at,updated_at,name,email,line,manager_hr_id,sales_scope_override,force_password_reset")
    .order("login_id", { ascending: true });

  if (result.error) {
    const fallbackResult = await supabase
      .from("app_auth_users")
      .select("login_id,role,hr_id,is_active,created_at,updated_at")
      .order("login_id", { ascending: true });
    result = fallbackResult;
  }

  const { data, error } = result;
  if (error) throw error;

  const directory = await getEmployeeDirectory().catch(() => null);
  const employeeMap = employeeByHrId(directory?.employees ?? []);

  return {
    auditLogs: await listAuditLogs(),
    employees: (directory?.employees ?? []).map((employee) => ({
      hrId: employee.hrId,
      line: normalizeLine(employee.lineName),
      managerHrId: employee.managerHrId,
      name: employee.fullName,
    })),
    lines: phoenixLines,
    permissions: await getPermissionMatrix(),
    permissionOverrides: await listPermissionOverrides(),
    roles: phoenixRoles,
    users: ((data ?? []) as AccessUserDbRow[]).map((row) =>
      toUser(row, row.hr_id ? employeeMap.get(row.hr_id.trim().toLowerCase()) : undefined),
    ),
  };
}

export type PermissionUpdateInput = {
  action: PermissionAction | string;
  governanceReason?: string | null;
  isAllowed: boolean;
  resource: PermissionResource | string;
  role: PhoenixRole | string;
};

export async function upsertRolePermissionOverride(
  input: PermissionUpdateInput,
  actor?: AccessActor | null,
) {
  if (actor?.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can update permission overrides.");
  }

  const permissionRole = parseRoleStrict(input.role);
  const resource = parsePermissionResourceStrict(input.resource);
  const action = parsePermissionActionStrict(input.action);

  const supabase = getSupabaseAdmin();
  const { data: previousRow } = await supabase
    .from("role_permission_overrides")
    .select("role_name,resource,action,is_allowed")
    .eq("role_name", permissionRole)
    .eq("resource", resource)
    .eq("action", action)
    .maybeSingle();

  try {
    const { error } = await supabase
      .from("role_permission_overrides")
      .upsert({
        role_name: permissionRole,
        resource,
        action,
        is_allowed: input.isAllowed,
        updated_by: actor.loginId ?? null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "role_name,resource,action",
      });

    if (error) {
      if ((error as { code?: string }).code === "42P01") {
        throw new Error("Role permission override table is missing. Please run migration for dynamic permissions.");
      }
      throw error;
    }

    clearPermissionMatrixCache();

    await writeRequiredAuditLog({
      actorLoginId: actor.loginId,
      entityId: `${permissionRole}.${resource}.${action}`,
      entityType: "permission_override",
      newValues: {
        action,
        isAllowed: input.isAllowed,
        reason: input.governanceReason ?? null,
        resource,
        role: permissionRole,
      },
      oldValues: previousRow ? {
        action: previousRow.action,
        isAllowed: previousRow.is_allowed,
        resource: previousRow.resource,
        role: previousRow.role_name,
      } : null,
      summary: `${permissionRole} ${action.toUpperCase()} ${resource} => ${input.isAllowed ? "allow" : "deny"}`,
    });
  } catch (mutationError) {
    try {
      if (previousRow) {
        const { error: restoreError } = await supabase
          .from("role_permission_overrides")
          .upsert(previousRow, { onConflict: "role_name,resource,action" });
        if (restoreError) throw restoreError;
      } else {
        const { error: deleteError } = await supabase
          .from("role_permission_overrides")
          .delete()
          .eq("role_name", permissionRole)
          .eq("resource", resource)
          .eq("action", action);
        if (deleteError) throw deleteError;
      }
      clearPermissionMatrixCache();
    } catch (rollbackError) {
      logCompensationFailure("permission_override_restore", rollbackError);
    }

    throw mutationError;
  }

  return getAccessControlDashboard();
}

export async function upsertAccessUser(input: AccessUserMutation, actor?: AccessActor | null) {
  assertSuperAdminUserAdminActor(actor);

  const loginId = (input.loginId || input.hrId || "").trim();
  if (!loginId) throw new Error("HR_ID or login ID is required.");

  const role = parseRoleStrict(input.role);
  const line = normalizeLine(input.line);
  const salesScopeOverride = normalizeScope(input.salesScopeOverride);

  if (input.hrId?.trim()) {
    const directory = await getEmployeeDirectory();
    const exists = directory.employees.some((employee) => employee.hrId.trim().toLowerCase() === input.hrId?.trim().toLowerCase());
    if (!exists) throw new Error(`HR_ID ${input.hrId} does not exist in employees.`);
  }

  if (input.salesScopeOverride && !salesScopeOverride) {
    throw new Error("Sales scope override is invalid.");
  }

  const existing = await supabaseUser(loginId);
  const nextIsActive = typeof input.isActive === "boolean"
    ? input.isActive
    : existing
      ? isStoredActive(existing)
      : true;
  assertActorMayManageUser({
    actor,
    existing,
    loginId,
    nextIsActive,
    nextRole: role,
  });
  await assertLastSuperAdminInvariant(existing, role, nextIsActive);

  const requiresInitialPassword = !existing;
  const existingRole = getStoredRole(existing);
  const metadataChanged = Boolean(
    existing &&
    (
      (existing.hr_id ?? null) !== (input.hrId?.trim() || null) ||
      (existing.email ?? null) !== (input.email?.trim().toLowerCase() || null) ||
      normalizeLine(existing.line) !== line ||
      (existing.manager_hr_id ?? null) !== (input.managerHrId?.trim() || null) ||
      (existing.name ?? loginId) !== (input.name?.trim() || loginId) ||
      existingRole !== role ||
      isStoredActive(existing) !== nextIsActive
    )
  );
  const shouldInvalidateSessions = Boolean(
    existing &&
    (
      existingRole !== role ||
      (isStoredActive(existing) && !nextIsActive) ||
      Boolean(existing.force_password_reset)
    )
  );
  const nextSessionVersion = shouldInvalidateSessions
    ? getStoredSessionVersion(existing) + 1
    : getStoredSessionVersion(existing);

  const payload: Record<string, unknown> = {
    email: input.email?.trim().toLowerCase() || null,
    force_password_reset: requiresInitialPassword ? true : Boolean(existing?.force_password_reset),
    hr_id: input.hrId?.trim() || null,
    is_active: nextIsActive,
    line,
    login_id: loginId,
    manager_hr_id: input.managerHrId?.trim() || null,
    name: input.name?.trim() || loginId,
    role,
    sales_scope_override: salesScopeOverride,
    session_version: nextSessionVersion,
    updated_at: new Date().toISOString(),
  };

  if (requiresInitialPassword) {
    const password = createTemporaryAuthPassword();
    payload.password_hash = await bcrypt.hash(password, 12);

    const supabaseIdentity = await provisionSupabaseAuthIdentity({
      authUserId: null,
      email: input.email?.trim().toLowerCase() || null,
      hrId: input.hrId?.trim() || loginId,
      isActive: nextIsActive,
      line,
      loginId,
      managerHrId: input.managerHrId?.trim() || null,
      name: input.name?.trim() || loginId,
      password,
      role,
    });

    payload.auth_email = supabaseIdentity.authEmail;
    payload.auth_user_id = supabaseIdentity.authUserId;
    payload.__created_auth_user_id = supabaseIdentity.authUserId;
  } else if (metadataChanged || !existing?.auth_user_id) {
    const bridgePassword = existing?.auth_user_id ? null : createTemporaryAuthPassword();
    const supabaseIdentity = await provisionSupabaseAuthIdentity({
      authUserId: typeof existing?.auth_user_id === "string" ? existing.auth_user_id : null,
      email: input.email?.trim().toLowerCase() || null,
      hrId: input.hrId?.trim() || loginId,
      isActive: nextIsActive,
      line,
      loginId,
      managerHrId: input.managerHrId?.trim() || null,
      name: input.name?.trim() || loginId,
      password: bridgePassword,
      role,
    });

    payload.auth_email = supabaseIdentity.authEmail;
    payload.auth_user_id = supabaseIdentity.authUserId;
    if (!existing?.auth_user_id) {
      payload.__created_auth_user_id = supabaseIdentity.authUserId;
    }

    if (bridgePassword) {
      payload.password_hash = await bcrypt.hash(bridgePassword, 12);
      payload.force_password_reset = true;
    }
  }

  const supabase = getSupabaseAdmin();
  const authUserId = typeof payload.auth_user_id === "string"
    ? payload.auth_user_id
    : typeof existing?.auth_user_id === "string"
      ? existing.auth_user_id
      : null;
  const createdAuthUserId = typeof payload.__created_auth_user_id === "string"
    ? payload.__created_auth_user_id
    : null;
  delete payload.__created_auth_user_id;
  let appUserWritten = false;
  let profileWritten = false;
  const previousProfile = authUserId
    ? await supabase
      .from("user_access_profiles")
      .select("*")
      .eq("auth_user_id", authUserId)
      .maybeSingle()
    : null;

  try {
    const { error } = await supabase
      .from("app_auth_users")
      .upsert(payload, { onConflict: "login_id" });

    if (error) throw error;
    appUserWritten = true;

    if (authUserId) {
      const { error: profileError } = await supabase
        .from("user_access_profiles")
        .upsert({
          auth_user_id: authUserId,
          hr_id: input.hrId?.trim() || loginId,
          is_active: nextIsActive,
          line,
          login_id: loginId,
          manager_hr_id: input.managerHrId?.trim() || null,
          phoenix_role: role,
          role: mapPhoenixRoleToCoarseAccessRole(role),
          scope_type: mapPhoenixRoleToAccessScopeType(role),
          updated_at: new Date().toISOString(),
        }, {
          onConflict: "auth_user_id",
        });

      if (profileError) {
        throw profileError;
      }
      profileWritten = true;
    }

    const roleChanged = Boolean(existingRole && existingRole !== role);
    const summary = !existing
      ? `Created ${loginId}`
      : roleChanged
        ? `Updated role for ${loginId}`
        : `Updated ${loginId}`;

    await auditUserChange({
      actor,
      entityId: loginId,
      oldValues: existing,
      newValues: {
        ...payload,
        password_hash: payload.password_hash ? "[managed]" : "[unchanged]",
        reason: input.governanceReason ?? null,
      },
      summary,
    });
  } catch (mutationError) {
    if (profileWritten && authUserId) {
      try {
        if (previousProfile?.data) {
          const { error: restoreProfileError } = await supabase
            .from("user_access_profiles")
            .upsert(previousProfile.data as Record<string, unknown>, { onConflict: "auth_user_id" });
          if (restoreProfileError) throw restoreProfileError;
        } else {
          const { error: deleteProfileError } = await supabase
            .from("user_access_profiles")
            .delete()
            .eq("auth_user_id", authUserId);
          if (deleteProfileError) throw deleteProfileError;
        }
      } catch (rollbackError) {
        logCompensationFailure("user_access_profiles", rollbackError);
      }
    }

    if (appUserWritten) {
      try {
        if (existing) {
          const { error: restoreUserError } = await supabase
            .from("app_auth_users")
            .upsert({
              auth_email: existing.auth_email ?? null,
              auth_user_id: existing.auth_user_id ?? null,
              email: existing.email ?? null,
              force_password_reset: Boolean(existing.force_password_reset),
              hr_id: existing.hr_id ?? null,
              is_active: Boolean(existing.is_active),
              line: existing.line ?? null,
              login_id: loginId,
              manager_hr_id: existing.manager_hr_id ?? null,
              name: existing.name ?? loginId,
              password_hash: existing.password_hash ?? null,
              role: existing.role,
              sales_scope_override: existing.sales_scope_override ?? null,
              session_version: getStoredSessionVersion(existing),
              updated_at: new Date().toISOString(),
            }, { onConflict: "login_id" });
          if (restoreUserError) throw restoreUserError;
        } else {
          const { error: deleteUserError } = await supabase
            .from("app_auth_users")
            .delete()
            .eq("login_id", loginId);
          if (deleteUserError) throw deleteUserError;
        }
      } catch (rollbackError) {
        logCompensationFailure("app_auth_users", rollbackError);
      }
    }

    if (createdAuthUserId) {
      try {
        await deleteSupabaseAuthIdentity(createdAuthUserId);
      } catch (rollbackError) {
        logCompensationFailure("supabase_auth_delete", rollbackError);
      }
    } else if (typeof existing?.auth_user_id === "string") {
      try {
        await provisionSupabaseAuthIdentity({
          authUserId: existing.auth_user_id,
          email: existing.email ?? null,
          hrId: existing.hr_id ?? loginId,
          isActive: isStoredActive(existing),
          line: existing.line ?? null,
          loginId,
          managerHrId: existing.manager_hr_id ?? null,
          name: existing.name ?? loginId,
          role: getStoredRole(existing) ?? role,
        });
      } catch (rollbackError) {
        logCompensationFailure("supabase_auth_restore", rollbackError);
      }
    }

    throw mutationError;
  }

  return getAccessControlDashboard();
}

async function supabaseUser(loginId: string) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("app_auth_users")
    .select("login_id,role,hr_id,is_active,name,email,line,manager_hr_id,sales_scope_override,auth_user_id,auth_email,session_version,force_password_reset,password_hash")
    .eq("login_id", loginId)
    .maybeSingle();
  return (data as AccessUserRecord | null) ?? null;
}

export async function updateAccessUserStatus(
  loginId: string,
  isActive: boolean,
  actor?: AccessActor | null,
  governanceReason?: string | null,
) {
  assertSuperAdminUserAdminActor(actor);

  const supabase = getSupabaseAdmin();
  const existing = await supabaseUser(loginId);
  if (!existing) {
    throw new Error(`User ${loginId} was not found.`);
  }

  const existingRole = getStoredRole(existing);
  if (!existingRole) {
    throw new Error(`User ${loginId} has an invalid role.`);
  }

  assertActorMayManageUser({
    actor,
    existing,
    loginId,
    nextIsActive: isActive,
    nextRole: existingRole,
  });
  await assertLastSuperAdminInvariant(existing, existingRole, isActive);

  const nextSessionVersion = isStoredActive(existing) && !isActive
    ? getStoredSessionVersion(existing) + 1
    : getStoredSessionVersion(existing);
  const previousIsActive = isStoredActive(existing);
  const previousSessionVersion = getStoredSessionVersion(existing);
  let appStatusWritten = false;
  let authStatusWritten = false;
  let profileStatusWritten = false;

  try {
    const { error } = await supabase
      .from("app_auth_users")
      .update({
        is_active: isActive,
        session_version: nextSessionVersion,
        updated_at: new Date().toISOString(),
      })
      .eq("login_id", loginId);

    if (error) throw error;
    appStatusWritten = true;

    if (typeof existing.auth_user_id === "string") {
      await setSupabaseAuthIdentityAccess({
        authUserId: existing.auth_user_id,
        isActive,
      });
      authStatusWritten = true;

      const { error: profileError } = await supabase
        .from("user_access_profiles")
        .update({ is_active: isActive, updated_at: new Date().toISOString() })
        .eq("auth_user_id", existing.auth_user_id);

      if (profileError) throw profileError;
      profileStatusWritten = true;
    }

    await auditUserChange({
      actor,
      entityId: loginId,
      oldValues: existing,
      newValues: {
        auth_identity_access: isActive ? "unbanned" : "banned",
        is_active: isActive,
        reason: governanceReason ?? null,
        session_version: nextSessionVersion,
      },
      summary: `${isActive ? "Activated" : "Deactivated"} ${loginId}`,
    });
  } catch (mutationError) {
    if (profileStatusWritten && typeof existing.auth_user_id === "string") {
      try {
        const { error: profileRollbackError } = await supabase
          .from("user_access_profiles")
          .update({ is_active: previousIsActive, updated_at: new Date().toISOString() })
          .eq("auth_user_id", existing.auth_user_id);
        if (profileRollbackError) throw profileRollbackError;
      } catch (rollbackError) {
        logCompensationFailure("status_profile_restore", rollbackError);
      }
    }

    if (authStatusWritten && typeof existing.auth_user_id === "string") {
      try {
        await setSupabaseAuthIdentityAccess({
          authUserId: existing.auth_user_id,
          isActive: previousIsActive,
        });
      } catch (rollbackError) {
        logCompensationFailure("status_auth_restore", rollbackError);
      }
    }

    if (appStatusWritten) {
      try {
        const { error: userRollbackError } = await supabase
          .from("app_auth_users")
          .update({
            is_active: previousIsActive,
            session_version: previousSessionVersion,
            updated_at: new Date().toISOString(),
          })
          .eq("login_id", loginId);
        if (userRollbackError) throw userRollbackError;
      } catch (rollbackError) {
        logCompensationFailure("status_user_restore", rollbackError);
      }
    }

    throw mutationError;
  }

  return getAccessControlDashboard();
}
