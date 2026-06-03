import crypto from "crypto";

import bcrypt from "bcryptjs";

import { systemAuthEmailText } from "@/config/system-settings";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { persistSupabaseAuthIdentityLink, provisionSupabaseAuthIdentity } from "@/lib/auth/supabase-identity";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const passwordSetupExpiryMs = 2 * 60 * 1000;

type PasswordSetupTokenRow = {
  created_at: string;
  created_by_login_id?: string | null;
  email?: string | null;
  expires_at: string;
  force_password_reset?: boolean | null;
  hr_id?: string | null;
  is_active?: boolean | null;
  line?: string | null;
  login_id: string;
  manager_hr_id?: string | null;
  name?: string | null;
  purpose: "reset" | "setup";
  role?: string | null;
  token_hash: string;
  used_at?: string | null;
};

export type PasswordSetupPreview = {
  expiresAt: string;
  hrId: string | null;
  loginId: string;
  name: string;
  purpose: "reset" | "setup";
};

export type PasswordSetupLinkResult = {
  deliveryMessage: string;
  deliveryMode: "copy" | "email";
  expiresAt: string;
  loginId: string;
  setupUrl?: string;
};

export function createTemporaryAuthPassword() {
  return `Px-${crypto.randomBytes(24).toString("base64url")}!9a`;
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function publicBaseUrl(originHint?: string | null) {
  const base = (originHint || process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");

  if (!base) {
    throw new Error("APP_URL or NEXT_PUBLIC_APP_URL is required to send password setup links.");
  }

  if (!/^https?:\/\//i.test(base)) {
    throw new Error("APP_URL or NEXT_PUBLIC_APP_URL must be a public URL.");
  }

  return base;
}

async function getAuthUser(loginIdInput: string) {
  const loginId = String(loginIdInput ?? "").trim();
  if (!loginId) {
    throw new Error("Login ID is required.");
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("login_id,hr_id,name,email,role,is_active,line,manager_hr_id,auth_user_id,auth_email,force_password_reset,session_version")
    .eq("login_id", loginId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error(`User ${loginId} was not found.`);
  }

  return data as Record<string, unknown> & {
    auth_email?: string | null;
    auth_user_id?: string | null;
    email?: string | null;
    force_password_reset?: boolean | null;
    hr_id?: string | null;
    is_active?: boolean | null;
    line?: string | null;
    login_id: string;
    manager_hr_id?: string | null;
    name?: string | null;
    role?: string | null;
  };
}

async function invalidateOutstandingTokens(loginId: string) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("password_setup_tokens")
    .update({
      updated_at: now,
      used_at: now,
    })
    .eq("login_id", loginId)
    .is("used_at", null);

  if (error && !(error instanceof Error && /password_setup_tokens/i.test(error.message))) {
    throw error;
  }
}

export async function sendPasswordSetupLink(input: {
  actorLoginId?: string | null;
  deliveryMode?: "copy" | "email";
  governanceReason?: string | null;
  loginId: string;
  origin?: string | null;
  purpose?: "reset" | "setup";
}) {
  const loginId = String(input.loginId ?? "").trim();
  const user = await getAuthUser(loginId);
  if (!user.is_active) {
    throw new Error(`User ${loginId} is inactive.`);
  }
  const deliveryMode = input.deliveryMode ?? "email";
  if (deliveryMode === "email" && !user.email) {
    throw new Error(`User ${loginId} does not have an email address.`);
  }

  const purpose = input.purpose ?? (user.force_password_reset ? "setup" : "reset");
  const token = createToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + passwordSetupExpiryMs).toISOString();
  const setupUrl = `${publicBaseUrl(input.origin)}/password-setup/${token}`;
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  await invalidateOutstandingTokens(loginId);

  const { error: insertError } = await supabase
    .from("password_setup_tokens")
    .insert({
      created_by_login_id: input.actorLoginId ?? null,
      expires_at: expiresAt,
      login_id: loginId,
      purpose,
      sent_to_email: deliveryMode === "email" ? user.email : null,
      token_hash: tokenHash,
      updated_at: now,
    });

  if (insertError) {
    throw insertError;
  }

  const currentVersion = (() => {
    const version = Number((user as { session_version?: unknown }).session_version);
    return Number.isFinite(version) && version > 0 ? version : 1;
  })();

  const { error: updateError } = await supabase
    .from("app_auth_users")
    .update({
      force_password_reset: true,
      session_version: currentVersion + 1,
      updated_at: now,
    })
    .eq("login_id", loginId);

  if (updateError) {
    throw updateError;
  }

  const emailResult =
    deliveryMode === "email"
      ? await safeSendNotificationEmail({
          ctaHref: setupUrl,
          ctaLabel: "Set your password",
          metrics: [
            { label: "Login ID", value: loginId },
            { label: "HR_ID", value: user.hr_id ?? loginId },
            { label: "Expires", value: new Date(expiresAt).toLocaleString("en-US") },
          ],
          candidateEmail: user.email,
          notificationType: purpose === "setup" ? "user_created" : "password_reset",
          recipients: user.email ? [user.email] : [],
          recipientMode: "candidate",
          subject: purpose === "setup" ? systemAuthEmailText.accountSetupSubject : systemAuthEmailText.passwordResetSubject,
          summary:
            purpose === "setup"
              ? systemAuthEmailText.accountSetupSummary
              : systemAuthEmailText.passwordResetSummary,
          title: purpose === "setup" ? systemAuthEmailText.accountSetupTitle : systemAuthEmailText.passwordResetTitle,
          tone: "warning",
        })
      : { skipped: true as const, reason: "Link generated for manual sharing." };

  await writeRequiredAuditLog({
    actorLoginId: input.actorLoginId ?? null,
    entityId: loginId,
    entityType: "user",
    newValues: {
      action: "password_setup_link_generated",
      delivery: deliveryMode === "email" && !emailResult.skipped ? "email_sent" : "link_generated_only",
      deliveryMode,
      expiresAt,
      reason: input.governanceReason ?? null,
      purpose,
      sentTo: deliveryMode === "email" ? user.email : null,
      token: "[redacted]",
      url: "[redacted]",
    },
    oldValues: null,
    summary: `${deliveryMode === "email" ? "Sent" : "Generated"} ${purpose === "setup" ? "setup" : "reset"} link for ${loginId}`,
  });

  return {
    deliveryMessage:
      deliveryMode === "copy"
        ? `Password ${purpose === "setup" ? "setup" : "reset"} link generated for copy/paste.`
        : emailResult.skipped
          ? `Link generated but email was not delivered: ${emailResult.reason}`
          : `Password ${purpose === "setup" ? "setup" : "reset"} link sent to ${user.email}.`,
    deliveryMode,
    expiresAt,
    loginId,
    ...(deliveryMode === "copy" ? { setupUrl } : {}),
  } satisfies PasswordSetupLinkResult;
}

async function getPasswordSetupToken(token: string) {
  if (!token) {
    throw new Error("Password setup token is required.");
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("password_setup_tokens")
    .select("token_hash,login_id,purpose,expires_at,used_at,created_at,created_by_login_id")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error("This password setup link is invalid.");
  }

  const joined = data as Record<string, unknown> & {
    created_at: string;
    created_by_login_id?: string | null;
    expires_at: string;
    login_id: string;
    purpose: "reset" | "setup";
    token_hash: string;
    used_at?: string | null;
  };
  const user = await getAuthUser(joined.login_id);

  return {
    created_at: joined.created_at,
    created_by_login_id: joined.created_by_login_id ?? null,
    email: typeof user.email === "string" ? user.email : null,
    expires_at: joined.expires_at,
    force_password_reset: Boolean(user.force_password_reset),
    hr_id: typeof user.hr_id === "string" ? user.hr_id : null,
    is_active: Boolean(user.is_active),
    line: typeof user.line === "string" ? user.line : null,
    login_id: joined.login_id,
    manager_hr_id: typeof user.manager_hr_id === "string" ? user.manager_hr_id : null,
    name: typeof user.name === "string" ? user.name : joined.login_id,
    purpose: joined.purpose,
    role: typeof user.role === "string" ? user.role : null,
    token_hash: joined.token_hash,
    used_at: joined.used_at ?? null,
  } satisfies PasswordSetupTokenRow;
}

function assertTokenUsable(tokenRow: PasswordSetupTokenRow) {
  if (!tokenRow.is_active) {
    throw new Error("This account is inactive. Contact your admin.");
  }
  if (tokenRow.used_at) {
    throw new Error("This password setup link has already been used.");
  }
  if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
    throw new Error("This password setup link has expired. Ask your admin for a new one.");
  }
}

export async function getPasswordSetupPreview(token: string): Promise<PasswordSetupPreview> {
  const tokenRow = await getPasswordSetupToken(token);
  assertTokenUsable(tokenRow);

  return {
    expiresAt: tokenRow.expires_at,
    hrId: tokenRow.hr_id,
    loginId: tokenRow.login_id,
    name: tokenRow.name ?? tokenRow.login_id,
    purpose: tokenRow.purpose,
  };
}

export async function completePasswordSetup(input: { password: string; token: string }) {
  const tokenRow = await getPasswordSetupToken(input.token);
  assertTokenUsable(tokenRow);

  const password = String(input.password ?? "").trim();
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  let bridgeWarning: string | null = null;

  const currentUser = await getAuthUser(tokenRow.login_id);

  const { error: userError } = await supabase
    .from("app_auth_users")
    .update({
      force_password_reset: false,
      password_hash: passwordHash,
      session_version: 1 + Number(
        Number.isFinite((currentUser as { session_version?: unknown }).session_version)
          ? (currentUser as { session_version?: number }).session_version
          : 1,
      ),
      updated_at: now,
    })
    .eq("login_id", tokenRow.login_id);

  if (userError) {
    throw userError;
  }

  try {
    const identity = await provisionSupabaseAuthIdentity({
      authUserId: currentUser.auth_user_id ?? null,
      email: currentUser.email ?? null,
      hrId: currentUser.hr_id ?? tokenRow.login_id,
      isActive: Boolean(currentUser.is_active),
      line: currentUser.line ?? null,
      loginId: tokenRow.login_id,
      managerHrId: currentUser.manager_hr_id ?? null,
      name: currentUser.name ?? tokenRow.login_id,
      password,
      role: String(currentUser.role ?? "Employee") as Parameters<typeof provisionSupabaseAuthIdentity>[0]["role"],
    });
    await persistSupabaseAuthIdentityLink({
      authEmail: identity.authEmail,
      authUserId: identity.authUserId,
      coarseRole: identity.coarseRole,
      email: currentUser.email ?? null,
      hrId: currentUser.hr_id ?? tokenRow.login_id,
      isActive: Boolean(currentUser.is_active),
      line: currentUser.line ?? null,
      loginId: tokenRow.login_id,
      managerHrId: currentUser.manager_hr_id ?? null,
      name: currentUser.name ?? tokenRow.login_id,
      role: String(currentUser.role ?? "Employee") as Parameters<typeof provisionSupabaseAuthIdentity>[0]["role"],
    });
  } catch (error) {
    bridgeWarning =
      error instanceof Error
        ? error.message
        : "Failed to update Supabase auth bridge after password setup.";
  }

  const { error: tokenError } = await supabase
    .from("password_setup_tokens")
    .update({
      updated_at: now,
      used_at: now,
    })
    .eq("token_hash", tokenRow.token_hash);

  if (tokenError) {
    throw tokenError;
  }

  await writeRequiredAuditLog({
    actorLoginId: tokenRow.login_id,
    entityId: tokenRow.login_id,
    entityType: "user",
    newValues: {
      bridgeWarning,
      completedAt: now,
      purpose: tokenRow.purpose,
    },
    oldValues: null,
    summary: `Completed password ${tokenRow.purpose} for ${tokenRow.login_id}`,
  });

  return { bridgeWarning };
}
