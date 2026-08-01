import crypto from "crypto";

import bcrypt from "bcryptjs";

import { systemAuthEmailText } from "@/config/system-settings";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { persistSupabaseAuthIdentityLink, provisionSupabaseAuthIdentity } from "@/lib/auth/supabase-identity";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const passwordSetupExpiryMs = 48 * 60 * 60 * 1000;

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

/**
 * The address a password setup/reset link may actually be mailed to, or null.
 *
 * Candidate order mirrors the notification recipient resolver: the explicit
 * `app_auth_users.email` override first, then the employee's real `employees.work_email`.
 * `auth_email` is never a candidate — see the note at the call site.
 *
 * A failed employees lookup degrades to "no deliverable address" rather than throwing: the caller
 * then either refuses the email send with a clear message or (in copy mode) proceeds normally, so
 * a transient directory problem can never block link GENERATION.
 */
async function resolveDeliverableEmail(user: { email?: string | null; hr_id?: string | null }) {
  const override = pickDeliverableEmail(user.email);
  if (override) return override;

  const hrId = String(user.hr_id ?? "").trim();
  if (!hrId) return null;

  try {
    const { data } = await getSupabaseAdmin()
      .from("employees")
      .select("work_email")
      .eq("hr_id", hrId)
      .maybeSingle();
    return pickDeliverableEmail((data as { work_email?: string | null } | null)?.work_email);
  } catch {
    return null;
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
  // Same resolution the notification recipient resolver already uses (see resolveRecipient in
  // src/lib/notifications/system.ts): app_auth_users.email is an optional override that is set for
  // almost nobody, and the real mailbox lives on employees.work_email. Checking only the former
  // rejected 107 of 112 active production users with "does not have an email address" while their
  // @satopharma.com work address was on file the whole time.
  //
  // auth_email is deliberately NOT a candidate: every row has one, but it is the synthetic Supabase
  // login key phx-<hex>@auth.phoenix.local, not a mailbox. Including it would turn this error into
  // something far worse — a password link "sent" successfully into a hard bounce. pickDeliverableEmail
  // rejects it (and any .local address) even if a future caller passes it in by mistake.
  const deliverableEmail = await resolveDeliverableEmail(user);
  if (deliveryMode === "email" && !deliverableEmail) {
    throw new Error(
      `User ${loginId} has no deliverable email address (checked app_auth_users.email and employees.work_email). Use the copy-link delivery mode instead.`,
    );
  }

  const purpose = input.purpose ?? (user.force_password_reset ? "setup" : "reset");
  const token = createToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + passwordSetupExpiryMs).toISOString();
  // The emailed CTA button routes through the notification href pipeline, which keeps only
  // INTERNAL paths — hrefs.ts internalHref() drops anything not starting with "/" — and then
  // rebuilds the absolute URL via dashboardUrl(). Passing the absolute setupUrl made internalHref
  // drop it entirely, so the activation email rendered with NO button and NO link (employees could
  // not set their password). Hand the notification the RELATIVE path; keep the absolute setupUrl
  // only for copy-mode return / display.
  const setupPath = `/password-setup/${token}`;
  const setupUrl = `${publicBaseUrl(input.origin)}${setupPath}`;
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
      sent_to_email: deliveryMode === "email" ? deliverableEmail : null,
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
      ? await createSystemNotification({
          actionUrl: setupPath,
          actorId: input.actorLoginId ?? "system",
          channels: ["email"],
          email: {
            candidateEmail: deliverableEmail,
            // Greet the person by their real name. Without this the notification recipient
            // resolver (system.ts) falls back to recipient.name, which for a by-email "candidate"
            // send is the login/HR_ID — so the Welcome/Account-Setup and Password-Reset emails
            // opened with "Dear B-10" instead of "Dear <name>". user.name is the display name on
            // the auth record (mirrors employees.full_name).
            recipientName: user.name?.trim() || undefined,
            ctaHref: setupPath,
            ctaLabel: "Set your password",
            metrics: [
              { label: "Login ID", value: loginId },
              { label: "HR_ID", value: user.hr_id ?? loginId },
              { label: "Expires", value: new Date(expiresAt).toLocaleString("en-US") },
            ],
            notificationType: purpose === "setup" ? "user_created" : "password_reset",
            recipientMode: "candidate",
            recipients: deliverableEmail ? [deliverableEmail] : [],
            subject: purpose === "setup" ? systemAuthEmailText.accountSetupSubject : systemAuthEmailText.passwordResetSubject,
            summary:
              purpose === "setup"
                ? systemAuthEmailText.accountSetupSummary
                : systemAuthEmailText.passwordResetSummary,
            title: purpose === "setup" ? systemAuthEmailText.accountSetupTitle : systemAuthEmailText.passwordResetTitle,
            tone: "warning",
          },
          eventType: purpose === "setup" ? "password_setup_link_created" : "password_reset_link_created",
          message:
            purpose === "setup"
              ? systemAuthEmailText.accountSetupSummary
              : systemAuthEmailText.passwordResetSummary,
          metadata: {
            idempotencyKey: `password-setup:${loginId}:${tokenHash}`,
            loginId,
            purpose,
          },
          module: purpose === "setup" ? "password_setup" : "password_reset",
          priority: "high",
          recipientHrId: user.hr_id,
          recipientUserId: loginId,
          title: purpose === "setup" ? systemAuthEmailText.accountSetupTitle : systemAuthEmailText.passwordResetTitle,
        })
      : { deliveries: [{ channel: "email" as const, error: undefined, idempotencyKey: "manual", reason: "Link generated for manual sharing.", status: "skipped" as const }] };
  const emailSent = emailResult.deliveries.some((delivery) => delivery.channel === "email" && delivery.status === "sent");
  const emailDelivery = emailResult.deliveries.find((delivery) => delivery.channel === "email");

  await writeRequiredAuditLog({
    actorLoginId: input.actorLoginId ?? null,
    entityId: loginId,
    entityType: "user",
    newValues: {
      action: "password_setup_link_generated",
      delivery: deliveryMode === "email" && emailSent ? "email_sent" : "link_generated_only",
      deliveryMode,
      expiresAt,
      reason: input.governanceReason ?? null,
      purpose,
      sentTo: deliveryMode === "email" ? deliverableEmail : null,
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
        : !emailSent
          ? `Link generated but email was not delivered: ${emailDelivery?.reason ?? emailDelivery?.error ?? "Delivery did not complete."}`
          : `Password ${purpose === "setup" ? "setup" : "reset"} link sent to ${deliverableEmail}.`,
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
