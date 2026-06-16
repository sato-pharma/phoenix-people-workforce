import bcrypt from "bcryptjs";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { isSupabaseBridgeRequiredForRole, updateAppSessionVersion } from "@/lib/auth/app-sessions";
import { normalizeRole } from "@/lib/auth/permissions";
import {
  createSupabaseAuthSession,
  persistSupabaseAuthIdentityLink,
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
  provisionSupabaseAuthIdentity,
} from "@/lib/auth/supabase-identity";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export { phoenixSupabaseAccessTokenCookieName, phoenixSupabaseRefreshTokenCookieName };

export class WrongCurrentPasswordError extends Error {
  constructor() {
    super("Current password is incorrect.");
    this.name = "WrongCurrentPasswordError";
  }
}

export class SamePasswordError extends Error {
  constructor() {
    super("New password must be different from your current password.");
    this.name = "SamePasswordError";
  }
}

export type ChangePasswordResult = {
  /** Absolute expiry from the existing app_sessions row; used to preserve the original timeout. */
  absoluteExpiresAt: string | null;
  newSessionVersion: number;
  /**
   * When true the app_sessions row for the caller's session could not be updated
   * (session was revoked or missing between the password write and the version bump).
   * The password IS changed; the caller must redirect to /login so the user can
   * authenticate fresh rather than issuing an immediately-invalid token.
   */
  sessionRefreshRequired: boolean;
  /** Non-null only for roles that require a Supabase bridge AND bridge sync succeeded. */
  supabaseSession: { accessToken: string; refreshToken: string } | null;
};

export async function changeUserPassword(input: {
  currentPassword: string;
  ip?: string | null;
  loginId: string;
  newPassword: string;
  sessionId: string;
}): Promise<ChangePasswordResult> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("app_auth_users")
    .select(
      "login_id, password_hash, session_version, hr_id, email, name, role, is_active, line, manager_hr_id, auth_user_id, auth_email",
    )
    .eq("login_id", input.loginId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("User account not found.");

  const row = data as {
    auth_email?: string | null;
    auth_user_id?: string | null;
    email?: string | null;
    hr_id?: string | null;
    is_active?: boolean | null;
    line?: string | null;
    login_id: string;
    manager_hr_id?: string | null;
    name?: string | null;
    password_hash: string;
    role?: string | null;
    session_version?: number | null;
  };

  // Verify current password before any mutation.
  const passwordMatches = await bcrypt.compare(input.currentPassword, row.password_hash);
  if (!passwordMatches) throw new WrongCurrentPasswordError();

  // Reject identical passwords — avoids pointless session_version churn that would
  // invalidate all other active sessions without any security benefit.
  const isSamePassword = await bcrypt.compare(input.newPassword, row.password_hash);
  if (isSamePassword) throw new SamePasswordError();

  if (input.newPassword.length < 8) {
    throw new Error("New password must be at least 8 characters.");
  }

  const newPasswordHash = await bcrypt.hash(input.newPassword, 12);
  const currentVersion = Number.isFinite(row.session_version) ? Number(row.session_version) : 1;
  const newVersion = currentVersion + 1;
  const now = new Date().toISOString();

  // Write the new password hash and bump session_version.
  const { error: updateError } = await supabase
    .from("app_auth_users")
    .update({
      password_hash: newPasswordHash,
      session_version: newVersion,
      updated_at: now,
    })
    .eq("login_id", input.loginId);

  if (updateError) throw updateError;

  // Update the caller's own app_sessions row to the new version so their
  // current session stays alive. If this fails (row was revoked or missing),
  // flag it — the route will tell the user to re-login rather than issue an
  // immediately-invalid token.
  let sessionRefreshRequired = false;
  let absoluteExpiresAt: string | null = null;

  try {
    const sessionUpdate = await updateAppSessionVersion(input.sessionId, newVersion);
    if (!sessionUpdate.updated) {
      sessionRefreshRequired = true;
    } else {
      absoluteExpiresAt = sessionUpdate.absoluteExpiresAt;
    }
  } catch {
    sessionRefreshRequired = true;
  }

  // Sync Supabase auth identity with the new password.
  let supabaseSession: { accessToken: string; refreshToken: string } | null = null;
  const role = normalizeRole(row.role ?? "Employee");
  const bridgeRequired = isSupabaseBridgeRequiredForRole(role);

  try {
    const identity = await provisionSupabaseAuthIdentity({
      authUserId: row.auth_user_id ?? null,
      email: row.email ?? null,
      hrId: row.hr_id ?? input.loginId,
      isActive: Boolean(row.is_active),
      line: row.line ?? null,
      loginId: input.loginId,
      managerHrId: row.manager_hr_id ?? null,
      name: row.name ?? input.loginId,
      password: input.newPassword,
      role: String(row.role ?? "Employee") as Parameters<typeof provisionSupabaseAuthIdentity>[0]["role"],
    });
    await persistSupabaseAuthIdentityLink({
      authEmail: identity.authEmail,
      authUserId: identity.authUserId,
      coarseRole: identity.coarseRole,
      email: row.email ?? null,
      hrId: row.hr_id ?? input.loginId,
      isActive: Boolean(row.is_active),
      line: row.line ?? null,
      loginId: input.loginId,
      managerHrId: row.manager_hr_id ?? null,
      name: row.name ?? input.loginId,
      role: String(row.role ?? "Employee") as Parameters<typeof provisionSupabaseAuthIdentity>[0]["role"],
    });

    // For roles that rely on the Supabase bridge, create a fresh Supabase auth
    // session with the new password so their access token cookie stays valid.
    if (bridgeRequired) {
      supabaseSession = await createSupabaseAuthSession(input.loginId, input.newPassword);
    }
  } catch {
    // Non-fatal: bridge sync failure is logged below but does not roll back
    // the Phoenix password change. Bridge-required roles will need to re-login
    // if the Supabase cookie becomes stale, which is handled at session validation.
  }

  await writeRequiredAuditLog({
    actorLoginId: input.loginId,
    entityId: input.loginId,
    entityType: "user",
    newValues: {
      action: "self_service_password_change",
      bridgeRequired,
      ip: input.ip ?? null,
      sessionId: input.sessionId,
      sessionRefreshRequired,
      supabaseBridgeSynced: bridgeRequired ? supabaseSession !== null : null,
    },
    oldValues: null,
    summary: `Password changed by ${input.loginId} (self-service)`,
  });

  return { absoluteExpiresAt, newSessionVersion: newVersion, sessionRefreshRequired, supabaseSession };
}
