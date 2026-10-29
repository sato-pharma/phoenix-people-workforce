import bcrypt from "bcryptjs";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveStoredHrId } from "@/lib/hr-id";
import {
  clearPermissionMatrixCache,
  getPayrollScope,
  getPermissionMatrix,
  getRolePrivilegeRank,
  getSalesScope,
  isDenialBlockedByMinimumPermission,
  isRolePermissionWithinHardBoundary,
  parsePermissionActionStrict,
  parsePermissionResourceStrict,
  parseRoleStrict,
  assignablePhoenixRoles,
  retiredPhoenixRoles,
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
import { revokeAllCredentialsForLogin } from "@/lib/auth/webauthn";
import { disableTelegramForIdentity } from "@/lib/notifications/settings";
import { logError } from "@/lib/observability/log";
import { hasWhatsAppNumber } from "@/lib/reports/organogram-whatsapp";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const phoenixLines = ["CNS", "Pedia", "Anti Infective", "Office", "Other"] as const;
export type PhoenixLine = (typeof phoenixLines)[number];

export type AccessUserRow = {
  createdAt: string;
  email: string | null;
  forcePasswordReset: boolean;
  /**
   * Whether the register holds a mobile number this person can be reached on in WhatsApp. Drives
   * whether the row offers the WhatsApp link button at all — no button is always better than a live
   * password link opened in the wrong chat.
   */
  hasWhatsApp: boolean;
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
  // Alias map for legacy / abbreviated line names from DB (e.g. "Anti Inf" / hyphenated
  // "Anti-Infective" → canonical "Anti Infective"). Keys are lowercased inputs.
  const aliases: Record<string, PhoenixLine> = {
    "anti inf": "Anti Infective",
    "anti-inf": "Anti Infective",
    "antiinfective": "Anti Infective",
    "anti infective": "Anti Infective",
    "anti-infective": "Anti Infective",
    // lines.name id=4 was renamed "Office" → "Head Office"; keep classifying it as the Office bucket.
    "head office": "Office",
    "headoffice": "Office",
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
  const name = row.name ?? employee?.displayName ?? row.login_id;

  return {
    createdAt: row.created_at,
    email: row.email ?? employee?.workEmail ?? null,
    forcePasswordReset: Boolean(row.force_password_reset),
    // The same repair the organogram's WhatsApp button uses: seven in ten stored numbers lost their
    // leading zero to a spreadsheet import, and one that cannot be read with confidence is no number.
    hasWhatsApp: hasWhatsAppNumber(employee?.mobileNumber),
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
    // Observable, not silent: a failed load makes the access dashboard show
    // "no overrides", which misrepresents the live policy to an admin. Log it
    // so the discrepancy is diagnosable rather than invisible.
    if (error) {
      logError("role_permission_overrides provenance load failed", { labels: { event: "access_control_permission_overrides_load_failed" }, error });
    }
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
  logError("Access-control compensation step failed", { labels: { event: "access_control_compensation_failed", context }, error });
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
      name: employee.displayName,
    })),
    lines: phoenixLines,
    permissions: await getPermissionMatrix(),
    permissionOverrides: await listPermissionOverrides(),
    roles: assignablePhoenixRoles,
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
  if (retiredPhoenixRoles.has(permissionRole)) {
    throw new Error("That seat is retired; it holds no permissions to change.");
  }
  const resource = parsePermissionResourceStrict(input.resource);
  const action = parsePermissionActionStrict(input.action);
  if (input.isAllowed && !isRolePermissionWithinHardBoundary(permissionRole, resource, action)) {
    throw new Error(
      `Forbidden: ${permissionRole} cannot be granted ${action} ${resource}; this is blocked by the hard role-authority boundary.`,
    );
  }
  if (!input.isAllowed && isDenialBlockedByMinimumPermission(permissionRole, resource, action)) {
    throw new Error(
      `Forbidden: ${permissionRole} must retain ${action} on ${resource}; this is a portal-required minimum permission.`,
    );
  }

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
  return upsertAccessUserCore(input, actor);
}

/**
 * Narrow entry point for provisioning a NEW hire's portal login from the employee-add flow
 * (HR Operations only — Super Admin keeps using upsertAccessUser above).
 *
 * Before this existed, adding an employee always tried to create their login via
 * upsertAccessUser, whose Super-Admin-only gate threw for every other role. The failure was
 * caught and shown as one line of text the actor had no permission to act on, so every
 * employee the recruiting seat added silently ended up with no way to sign in (CN-0006 and
 * PD-0007, 2026-08-04).
 *
 * THE SEAT HERE IS HR OPERATIONS, AND IT IS THE ONE THING IN THIS FUNCTION THAT MUST NOT BE
 * "TIDIED" TO MATCH ITS NAME. The name says "ForRecruiting" and the sibling tool below
 * (updateAccountActiveForRecruiting) really is HR Advisory's — she holds account_activation.
 * This one is not hers: creating the employee is `employees:create`, which lives in the
 * people_records function and reaches HR Operations alone. HR Advisory holds employees at
 * read+export, so she can never reach this path at all.
 *
 * That distinction was lost once already. When "Talent Acquisition" was retired this guard was
 * renamed to "HR Advisory" alongside its sibling, while the sole caller
 * (src/lib/employees/access-provisioning.ts) correctly routes HR Operations into it — so the
 * guard rejected the only role that can reach it and regenerated the CN-0006 incident above
 * verbatim: employee created, login not. Pinned by tests/hr-provisioning-guard.test.ts.
 *
 * Deliberately bypasses assertSuperAdminUserAdminActor for the same reason
 * updateAccountActiveForRecruiting does — that shared gate also covers role/scope/permission
 * changes, which this path must never grant. Everything it protects is still enforced here:
 *
 *  - create-only: refuses if the account already exists, so it can never EDIT an account
 *    (no role changes, no reactivating a disabled admin, no session invalidation).
 *  - no scope grants: a sales scope override is rejected outright.
 *  - rank-bounded: assertActorMayManageUser (called unchanged inside the core) hard-blocks
 *    Super Admin targets for any non-Super-Admin actor and rejects peer-or-higher roles.
 *    HR Operations' rank is 150 (getRolePrivilegeRank), so CEO (300), Finance Manager (200)
 *    and the peer HR seats (150) are all refused; only default-rank (100) employee accounts
 *    are reachable — the same boundary the activation tool already uses.
 */
export async function provisionEmployeeAccountForRecruiting(
  input: AccessUserMutation,
  actor: AccessActor,
) {
  if (actor.role !== "HR Operations") {
    throw new Error("Forbidden: only HR Operations can use this tool.");
  }
  if (input.salesScopeOverride) {
    throw new Error("Forbidden: this tool cannot grant a sales scope override.");
  }

  const loginId = (input.loginId || input.hrId || "").trim();
  if (!loginId) throw new Error("HR_ID or login ID is required.");

  if (await supabaseUser(loginId)) {
    throw new Error(
      `Account ${loginId} already exists. Ask a Super Admin to change an existing account.`,
    );
  }

  return upsertAccessUserCore({ ...input, salesScopeOverride: null }, actor);
}

async function upsertAccessUserCore(input: AccessUserMutation, actor?: AccessActor | null) {
  const loginId = (input.loginId || input.hrId || "").trim();
  if (!loginId) throw new Error("HR_ID or login ID is required.");

  const role = parseRoleStrict(input.role);
  // A retired seat cannot be handed to anyone (owner, 2026-10-08: "no more HR business partner").
  // Refused here, server-side, so the hidden picker option is never the only thing in the way.
  if (retiredPhoenixRoles.has(role)) {
    throw new Error("That seat is retired and cannot be given to anyone.");
  }
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
          // user_access_profiles.hr_id is a case-sensitive FK to employees.hr_id, which is
          // stored uppercase. This value is TYPED BY AN ADMIN in the Access Control form, so
          // normalise it instead of trusting the keystrokes — "b-97" would otherwise be
          // rejected with a raw 23503 rather than matching the B-97 the admin meant.
          hr_id: resolveStoredHrId(input.hrId) ?? resolveStoredHrId(loginId) ?? loginId,
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
    } else {
      // authUserId is falsy here only when the account has no GoTrue identity at all — the
      // happy-path create/update branches above always mint or refresh one via
      // provisionSupabaseAuthIdentity (which returns a real id or throws), so this should be
      // unreachable in normal operation. It fires when app_auth_users already carries a NULL
      // auth_user_id AND neither branch above ran (metadataChanged is false and existing already
      // has no auth_user_id would normally trigger the else-if — this is the belt-and-braces
      // catch for any path that still reaches here without one). Previously this was a silent
      // no-op: app_auth_users was written, user_access_profiles was not, and nothing recorded the
      // gap — that produced CN-0006 and PD-0007 (active/inactive accounts with app_auth_users rows
      // and no profile). Log it so the drift is diagnosable instead of invisible; the backfill
      // script (scripts/backfill-missing-access-profiles.ts) finds and fixes accounts already in
      // this state.
      logError("Access control profile write skipped: no auth_user_id", {
        labels: { event: "access_control_profile_write_skipped_no_auth_user_id" },
        context: { loginId },
      });
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

    if (!nextIsActive) {
      await disableTelegramForIdentity({
        actorLoginId: actor?.loginId ?? "system",
        hrId: input.hrId?.trim() || (existing?.hr_id ?? null),
        reason: input.governanceReason ?? "Access user saved as inactive.",
        userId: loginId,
      });
    }
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
  return performUserStatusUpdate(loginId, isActive, actor, governanceReason);
}

/**
 * Narrow entry point for the portal account-activation tool (Talent Acquisition only —
 * see src/lib/recruitment/account-activation.ts for the caller-side permission check).
 * Deliberately bypasses assertSuperAdminUserAdminActor — that shared gate also covers
 * role/scope/permission changes elsewhere in this file, which this tool must never grant.
 * assertActorMayManageUser below (unchanged, same call as the Super Admin path) already
 * blocks everything this tool must not touch: Super Admin accounts are hard-blocked by role
 * for any non-Super-Admin actor, and the rank comparison blocks same-or-higher-privilege
 * peers — Talent Acquisition's own rank (150, see getRolePrivilegeRank) is not >= CEO's (300)
 * so CEO is blocked, and IS >= another Talent Acquisition's rank (150) so peer accounts are
 * blocked too. Only default-rank (100) roles are reachable.
 */
export async function updateAccountActiveForRecruiting(
  loginId: string,
  isActive: boolean,
  actor: AccessActor,
  governanceReason?: string | null,
) {
  if (actor.role !== "HR Advisory") {
    throw new Error("Forbidden: only HR Advisory can use this tool.");
  }
  return performUserStatusUpdate(loginId, isActive, actor, governanceReason);
}

async function performUserStatusUpdate(
  loginId: string,
  isActive: boolean,
  actor: AccessActor | null | undefined,
  governanceReason?: string | null,
) {
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
      // loginId lets setSupabaseAuthIdentityAccess recover if auth_user_id has gone stale
      // (re-finds the live GoTrue user by email) instead of hard-failing the whole status change.
      await setSupabaseAuthIdentityAccess({
        authUserId: existing.auth_user_id,
        isActive,
        loginId,
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

    if (!isActive) {
      await disableTelegramForIdentity({
        actorLoginId: actor?.loginId ?? "system",
        hrId: existing.hr_id ?? null,
        reason: governanceReason ?? "Access user deactivated.",
        userId: loginId,
      });

      // Unenroll every biometric device, so a deactivated person's phone stops offering to sign
      // them in. This is defence in depth, not the security boundary: the biometric login route
      // already refuses anyone whose app_auth_users row is inactive or whose employee record is
      // terminal. Deliberately non-throwing for that reason — a failure here must not roll back an
      // otherwise successful deactivation, which would leave the account ACTIVE.
      await revokeAllCredentialsForLogin(loginId, "account_deactivated").catch(() => undefined);
    }
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
          loginId,
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
