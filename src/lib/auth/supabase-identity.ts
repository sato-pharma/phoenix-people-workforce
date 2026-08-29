import type { PhoenixRole } from "@/lib/auth/permissions";
import { resolveStoredHrId } from "@/lib/hr-id";
import { getSupabaseAdmin, getSupabaseAuthBridgeClient } from "@/lib/supabase/server";

export const phoenixSupabaseAccessTokenCookieName = "phoenix_supabase_access_token";
export const phoenixSupabaseRefreshTokenCookieName = "phoenix_supabase_refresh_token";

type CoarseAccessRole = "company_reader" | "employee" | "finance" | "manager" | "super_admin";
type AccessScopeType = "COMPANY_READ" | "FINANCE" | "HIERARCHY" | "LINE" | "SELF" | "SUPER_ADMIN" | "TEAM";

export type SupabaseAuthIdentity = {
  authEmail: string;
  authUserId: string;
  coarseRole: CoarseAccessRole;
};

export type SupabaseAuthProvisionInput = {
  authUserId?: string | null;
  email?: string | null;
  hrId: string | null;
  isActive: boolean;
  line?: string | null;
  loginId: string;
  managerHrId?: string | null;
  name?: string | null;
  password?: string | null;
  role: PhoenixRole;
};

export type SupabaseAuthSession = {
  accessToken: string;
  expiresAt: number | null;
  refreshToken: string;
};

const longBanDuration = "876000h";
const authUserListPageSize = 1000;

export function buildPhoenixAuthEmail(loginId: string) {
  const normalizedLoginId = loginId.trim().toLowerCase();
  const encodedLoginId = Buffer.from(normalizedLoginId).toString("hex");
  return `phx-${encodedLoginId}@auth.phoenix.local`;
}

export function mapPhoenixRoleToCoarseAccessRole(role: PhoenixRole): CoarseAccessRole {
  switch (role) {
    case "Super Admin":
      return "super_admin";
    case "CEO":
    case "SFE Manager":
      return "company_reader";
    case "Finance Manager":
      return "finance";
    case "District Manager":
    case "Regional Manager":
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Training Manager":
    case "Marketing Manager":
    case "Manager":
      return "manager";
    default:
      return "employee";
  }
}

export function mapPhoenixRoleToAccessScopeType(role: PhoenixRole): AccessScopeType {
  switch (role) {
    case "Super Admin":
      return "SUPER_ADMIN";
    case "CEO":
    case "SFE Manager":
    // HR Operations, 2026-08-29 (owner), kept in step with scopeForRole, which now returns
    // "company" for this seat. This column is only the mirror written at provisioning; access is
    // decided by scopeForRole at request time and never read back from here. A mirror that
    // disagrees with the live function is how an audit of this table reaches a wrong conclusion.
    case "HR Operations":
      return "COMPANY_READ";
    case "Finance Manager":
      return "FINANCE";
    case "District Manager":
    case "Manager":
      return "TEAM";
    case "Regional Manager":
      return "HIERARCHY";
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Training Manager":
    case "Marketing Manager":
      return "LINE";
    default:
      return "SELF";
  }
}

function userMetadata(input: SupabaseAuthProvisionInput) {
  return {
    access_scope: mapPhoenixRoleToAccessScopeType(input.role),
    hr_id: input.hrId,
    line: input.line ?? null,
    login_id: input.loginId,
    manager_hr_id: input.managerHrId ?? null,
    name: input.name ?? input.loginId,
    phoenix_role: input.role,
  };
}

function appMetadata(input: SupabaseAuthProvisionInput) {
  return {
    access_scope: mapPhoenixRoleToAccessScopeType(input.role),
    coarse_access_role: mapPhoenixRoleToCoarseAccessRole(input.role),
    hr_id: input.hrId,
    is_active: input.isActive,
    line: input.line ?? null,
    login_id: input.loginId,
    phoenix_role: input.role,
  };
}

// The whole auth-user set is small (low hundreds) and the loop early-exits on the
// first non-full page, so a couple of pages always cover everyone. Capping the
// worst case keeps a bridge hiccup from turning into a long paginated scan.
const authUserListMaxPages = 3;

async function findAuthUserIdByEmail(authEmail: string) {
  const normalizedEmail = authEmail.trim().toLowerCase();
  const supabaseAdmin = getSupabaseAdmin();

  for (let page = 1; page <= authUserListMaxPages; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: authUserListPageSize,
    });
    if (error) throw error;

    const match = data.users.find((user) => user.email?.trim().toLowerCase() === normalizedEmail);
    if (match) return match.id;
    if (data.users.length < authUserListPageSize) return null;
  }

  return null;
}

async function updateSupabaseAuthUser(input: SupabaseAuthProvisionInput, authUserId: string) {
  const authEmail = buildPhoenixAuthEmail(input.loginId);
  const coarseRole = mapPhoenixRoleToCoarseAccessRole(input.role);
  const updatePayload: {
    app_metadata: ReturnType<typeof appMetadata>;
    ban_duration?: string;
    email: string;
    email_confirm: true;
    password?: string;
    user_metadata: ReturnType<typeof userMetadata>;
  } = {
    app_metadata: appMetadata(input),
    ban_duration: input.isActive ? "none" : longBanDuration,
    email: authEmail,
    email_confirm: true,
    user_metadata: userMetadata(input),
  };

  if (input.password) {
    updatePayload.password = input.password;
  }

  const { data, error } = await getSupabaseAdmin().auth.admin.updateUserById(
    authUserId,
    updatePayload,
  );

  if (error || !data.user) {
    throw error ?? new Error("Failed to update Supabase auth user.");
  }

  return {
    authEmail,
    authUserId: data.user.id,
    coarseRole,
  };
}

export async function provisionSupabaseAuthIdentity(
  input: SupabaseAuthProvisionInput,
  // hotPath = called from the login request. The linked authUserId is
  // authoritative there, so we do a single direct update and never fall back to
  // the paginated email scan or admin.createUser. Those fallbacks are what turned
  // a transient bridge hiccup into a ~10s login; on the hot path we fail fast and
  // let login continue on the Phoenix session instead.
  options?: { hotPath?: boolean },
): Promise<SupabaseAuthIdentity> {
  const authEmail = buildPhoenixAuthEmail(input.loginId);
  const supabaseAdmin = getSupabaseAdmin();
  const coarseRole = mapPhoenixRoleToCoarseAccessRole(input.role);

  if (input.authUserId) {
    try {
      return await updateSupabaseAuthUser(input, input.authUserId);
    } catch (error) {
      const is404 = typeof error === "object" && error !== null && "status" in error && (error as Record<string, unknown>).status === 404;
      // Fail fast on the hot path to avoid slow fallbacks during transient bridge outages (e.g. 5xx/timeout).
      // However, a 404 means the bridge is up and the user is definitively missing or stale, so we MUST recover.
      if (options?.hotPath && !is404) throw error;
      const recoveredAuthUserId = await findAuthUserIdByEmail(authEmail);
      if (recoveredAuthUserId) {
        return updateSupabaseAuthUser(input, recoveredAuthUserId);
      }
    }
  } else if (options?.hotPath) {
    // If they have no authUserId, we must check if they exist by email before creating them.
    // In the non-hot path, createUser failing handles this, but on the hot path we'd prefer not to
    // blindly assume they don't exist if we can avoid an error-driven flow. Still, createUser is fast.
  }

  // If we reach here on the hot path, we know the bridge is likely healthy (we didn't fail-fast above)
  // but the user is missing (either no authUserId initially, or they 404'd). We must allow createUser.

  if (!input.password) {
    throw new Error("Password is required to provision a new Supabase auth user.");
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    app_metadata: appMetadata(input),
    ban_duration: input.isActive ? "none" : longBanDuration,
    email: authEmail,
    email_confirm: true,
    password: input.password,
    user_metadata: userMetadata(input),
  });

  if (error || !data.user) {
    const recoveredAuthUserId = await findAuthUserIdByEmail(authEmail);
    if (recoveredAuthUserId) {
      return updateSupabaseAuthUser(input, recoveredAuthUserId);
    }
    throw error ?? new Error("Failed to provision Supabase auth user.");
  }

  return {
    authEmail,
    authUserId: data.user.id,
    coarseRole,
  };
}

export async function persistSupabaseAuthIdentityLink(
  input: SupabaseAuthProvisionInput & SupabaseAuthIdentity,
) {
  const supabaseAdmin = getSupabaseAdmin();
  const updatedAt = new Date().toISOString();

  const { error: appUserError } = await supabaseAdmin
    .from("app_auth_users")
    .update({
      auth_email: input.authEmail,
      auth_user_id: input.authUserId,
      updated_at: updatedAt,
    })
    .eq("login_id", input.loginId);

  if (appUserError) throw appUserError;

  await supabaseAdmin
    .from("user_access_profiles")
    .update({ is_active: false, updated_at: updatedAt })
    .eq("login_id", input.loginId)
    .neq("auth_user_id", input.authUserId);

  const { error: profileError } = await supabaseAdmin
    .from("user_access_profiles")
    .upsert({
      auth_user_id: input.authUserId,
      // Case-sensitive FK to employees.hr_id (stored uppercase) — see the matching note in
      // src/lib/admin/access-control.ts. Normalising here too keeps the two writers of this
      // column from disagreeing about spelling for the same person.
      hr_id: resolveStoredHrId(input.hrId) ?? resolveStoredHrId(input.loginId) ?? input.loginId,
      is_active: input.isActive,
      line: input.line ?? null,
      login_id: input.loginId,
      manager_hr_id: input.managerHrId ?? null,
      phoenix_role: input.role,
      role: input.coarseRole,
      scope_type: mapPhoenixRoleToAccessScopeType(input.role),
      updated_at: updatedAt,
    }, {
      onConflict: "auth_user_id",
    });

  if (profileError) throw profileError;
}

export async function setSupabaseAuthIdentityAccess(input: {
  authUserId: string;
  isActive: boolean;
  /** Used only to recover via findAuthUserIdByEmail if authUserId is stale (see below). */
  loginId?: string;
}): Promise<{ authUserId: string }> {
  const supabaseAdmin = getSupabaseAdmin();
  let authUserId = input.authUserId;
  let { data: existing, error: lookupError } = await supabaseAdmin.auth.admin.getUserById(authUserId);

  // Same stale-link recovery as provisionSupabaseAuthIdentity: app_auth_users.auth_user_id can
  // drift from the live auth.users row (e.g. a prior re-provision under this login_id), which
  // otherwise hard-fails every activate/deactivate for that user with a 404.
  if (lookupError?.status === 404 && input.loginId) {
    const recoveredAuthUserId = await findAuthUserIdByEmail(buildPhoenixAuthEmail(input.loginId));
    if (recoveredAuthUserId) {
      authUserId = recoveredAuthUserId;
      ({ data: existing, error: lookupError } = await supabaseAdmin.auth.admin.getUserById(authUserId));
    }
  }
  if (lookupError) {
    // A Supabase Auth user that's already gone can't authenticate anyway, so "banned" is already
    // the effective end state — treat 404 as a no-op rather than failing the caller's saga (which
    // otherwise rolls back an already-successful app_auth_users.is_active update). Only genuinely
    // unexpected errors (network, permissions) still throw.
    if (lookupError.status === 404) return { authUserId };
    throw lookupError;
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(
    authUserId,
    {
      app_metadata: {
        ...(existing.user?.app_metadata ?? {}),
        is_active: input.isActive,
      },
      ban_duration: input.isActive ? "none" : longBanDuration,
    },
  );

  if (error) {
    if (error.status === 404) return { authUserId };
    throw error;
  }

  return { authUserId };
}

export async function deleteSupabaseAuthIdentity(authUserId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  const { error } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
  // A 404 here means the GoTrue user is already gone — that's the delete's desired end state,
  // not a failure to surface (unlike updateUserById/getUserById, where a 404 on an id we still
  // expect to be live signals broken app_auth_users<->auth.users linkage).
  if (error && error.status !== 404) {
    throw error;
  }
}

export async function createSupabaseAuthSession(
  loginId: string,
  password: string,
): Promise<SupabaseAuthSession> {
  const supabase = getSupabaseAuthBridgeClient();
  const authEmail = buildPhoenixAuthEmail(loginId);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: authEmail,
    password,
  });

  if (error || !data.session) {
    throw error ?? new Error("Failed to create Supabase auth session.");
  }

  return {
    accessToken: data.session.access_token,
    expiresAt: data.session.expires_at ?? null,
    refreshToken: data.session.refresh_token,
  };
}
