import type { PhoenixRole } from "@/lib/auth/permissions";
import { getSupabaseAdmin, getSupabaseUserClient } from "@/lib/supabase/server";

export const phoenixSupabaseAccessTokenCookieName = "phoenix_supabase_access_token";
export const phoenixSupabaseRefreshTokenCookieName = "phoenix_supabase_refresh_token";

type CoarseAccessRole = "admin" | "employee" | "hr" | "manager";

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
  password: string;
  role: PhoenixRole;
};

export type SupabaseAuthSession = {
  accessToken: string;
  expiresAt: number | null;
  refreshToken: string;
};

export function buildPhoenixAuthEmail(loginId: string) {
  const normalizedLoginId = loginId.trim().toLowerCase();
  const encodedLoginId = Buffer.from(normalizedLoginId).toString("hex");
  return `phx-${encodedLoginId}@auth.phoenix.local`;
}

export function mapPhoenixRoleToCoarseAccessRole(role: PhoenixRole): CoarseAccessRole {
  switch (role) {
    case "Super Admin":
    case "CEO":
    case "Finance Manager":
      return "admin";
    case "HR Specialist":
      return "hr";
    case "District Manager":
    case "Regional Manager":
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "SFE Manager":
    case "Training Manager":
    case "Marketing Manager":
    case "Manager":
      return "manager";
    default:
      return "employee";
  }
}

function userMetadata(input: SupabaseAuthProvisionInput) {
  return {
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
    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
      input.authUserId,
      {
        app_metadata: appMetadata(input),
        email: authEmail,
        email_confirm: true,
        password: input.password,
        user_metadata: userMetadata(input),
      },
    );

    if (!error && data.user) {
      return {
        authEmail,
        authUserId: data.user.id,
        coarseRole,
      };
    }
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    app_metadata: appMetadata(input),
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
