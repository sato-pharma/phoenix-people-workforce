import type { PhoenixRole } from "@/lib/auth/permissions";
import { getSupabaseAdmin, getSupabaseUserClient } from "@/lib/supabase/server";

export const phoenixSupabaseAccessTokenCookieName = "phoenix_supabase_access_token";
export const phoenixSupabaseRefreshTokenCookieName = "phoenix_supabase_refresh_token";

type CoarseAccessRole = "company_reader" | "employee" | "finance" | "hr" | "manager" | "super_admin";
type AccessScopeType = "COMPANY_READ" | "FINANCE" | "HIERARCHY" | "HR" | "LINE" | "SELF" | "SUPER_ADMIN" | "TEAM";

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
    case "HR Specialist":
      return "hr";
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
      return "COMPANY_READ";
    case "Finance Manager":
      return "FINANCE";
    case "HR Specialist":
      return "HR";
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

export async function provisionSupabaseAuthIdentity(
  input: SupabaseAuthProvisionInput,
): Promise<SupabaseAuthIdentity> {
  const authEmail = buildPhoenixAuthEmail(input.loginId);
  const supabaseAdmin = getSupabaseAdmin();
  const coarseRole = mapPhoenixRoleToCoarseAccessRole(input.role);

  if (input.authUserId) {
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

    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
      input.authUserId,
      updatePayload,
    );

    if (!error && data.user) {
      return {
        authEmail,
        authUserId: data.user.id,
        coarseRole,
      };
    }
  }

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
    throw error ?? new Error("Failed to provision Supabase auth user.");
  }

  return {
    authEmail,
    authUserId: data.user.id,
    coarseRole,
  };
}

export async function setSupabaseAuthIdentityAccess(input: {
  authUserId: string;
  isActive: boolean;
}) {
  const supabaseAdmin = getSupabaseAdmin();
  const { data: existing, error: lookupError } = await supabaseAdmin.auth.admin.getUserById(input.authUserId);
  if (lookupError) {
    throw lookupError;
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(
    input.authUserId,
    {
      app_metadata: {
        ...(existing.user?.app_metadata ?? {}),
        is_active: input.isActive,
      },
      ban_duration: input.isActive ? "none" : longBanDuration,
    },
  );

  if (error) {
    throw error;
  }
}

export async function deleteSupabaseAuthIdentity(authUserId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  const { error } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
  if (error) {
    throw error;
  }
}

export async function createSupabaseAuthSession(
  loginId: string,
  password: string,
): Promise<SupabaseAuthSession> {
  const supabase = getSupabaseUserClient();
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
