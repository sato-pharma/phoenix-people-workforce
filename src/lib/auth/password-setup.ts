import crypto from "crypto";

import bcrypt from "bcryptjs";

import { systemAuthEmailText, systemDeployment } from "@/config/system-settings";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveStoredLoginId } from "@/lib/auth/credentials";
import {
  evaluatePasswordResetCode,
  generatePasswordResetCode,
  hashPasswordResetCode,
  normalizePasswordResetCode,
  passwordResetCodeExpiryMs,
  passwordResetCodeLength,
  passwordResetCodeMaxAttempts,
  passwordResetCodeMetricLabel,
  type ResetCodeRow,
} from "@/lib/auth/password-reset-code";
import {
  composePasswordSetupWhatsAppMessage,
  composeTemporaryPasswordMessage,
  composeTemporaryPasswordWhatsAppMessage,
  passwordSetupWhatsAppUrl,
  temporaryPasswordExpiryLabel,
} from "@/lib/auth/password-setup-whatsapp";
import { LEAKED_PASSWORD_MESSAGE, checkLeakedPassword, leakedPasswordAuditValue } from "@/lib/auth/leaked-password";
import { passwordWeakness } from "@/lib/auth/password-strength";
import { forgetTrustedDevices } from "@/lib/auth/second-step-store";
import { persistSupabaseAuthIdentityLink, provisionSupabaseAuthIdentity } from "@/lib/auth/supabase-identity";
import {
  createReadableTemporaryPassword,
  TEMPORARY_PASSWORD_METRIC_LABEL,
  TEMPORARY_PASSWORD_SIGN_IN_LABEL,
  TEMPORARY_PASSWORD_USERNAME_LABEL,
  temporaryPasswordExpiryMs,
  temporaryPasswordSetupTokenExpiryMs,
} from "@/lib/auth/temporary-password";
import { EMAIL_TEMPLATE_KEYS } from "@/lib/email-templates/service";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { createSystemNotification } from "@/lib/notifications/system";
import { sendTelegramNotification } from "@/lib/notifications/telegram";
import { toDialableLocalMobile, toWhatsAppNumber } from "@/lib/reports/organogram-whatsapp";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const passwordSetupExpiryMs = 48 * 60 * 60 * 1000;
// The token minted after a SELF-SERVICE code is accepted lives only as long as the code did — the
// person is standing on the set-password screen the instant it is issued, so it never needs 48h.
const codeVerifiedTokenExpiryMs = passwordResetCodeExpiryMs;

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
  deliveryMode: "copy" | "email" | "whatsapp";
  /** Email mode only: whether the mail really left. False means the link exists and the person does not have it. */
  emailDelivered?: boolean;
  /** Email mode only: the first try did not leave and the outbox is still trying, so nobody can say yet. */
  emailQueuedForRetry?: boolean;
  expiresAt: string;
  loginId: string;
  setupUrl?: string;
  /** WhatsApp mode only: that person's chat with the message already written in it, for the admin to send. */
  whatsAppUrl?: string;
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
    .select("login_id,hr_id,name,email,role,is_active,line,manager_hr_id,auth_user_id,auth_email,force_password_reset,session_version,is_test_persona")
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
    is_test_persona?: boolean | null;
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

/**
 * The WhatsApp number a setup link may actually be carried to, or null.
 *
 * The register is the only source: `employees.mobile_number`, repaired by `toWhatsAppNumber` — seven
 * in ten rows lost their leading zero to a spreadsheet import, and a handful hold two numbers in one
 * field. A number that cannot be read with confidence returns null and the caller refuses the send,
 * because the failure mode here is not a broken button: it is a live password link opened in a
 * stranger's chat.
 *
 * A failed lookup degrades to "no number" rather than throwing, exactly like the email resolver, so a
 * transient directory problem can never block link GENERATION in copy mode.
 */
async function resolveWhatsAppNumber(user: { hr_id?: string | null }) {
  const hrId = String(user.hr_id ?? "").trim();
  if (!hrId) return null;

  try {
    const { data } = await getSupabaseAdmin()
      .from("employees")
      .select("mobile_number")
      .eq("hr_id", hrId)
      .maybeSingle();
    return toWhatsAppNumber((data as { mobile_number?: string | null } | null)?.mobile_number);
  } catch {
    return null;
  }
}

/**
 * The one mailbox the person pressing the button chose, read from the employee register and from nowhere else. A chosen
 * mailbox that is empty is a refusal, never a quiet send to the other one: New Hire Accounts names the address on the
 * button it prints. A failed lookup degrades to "no address", the same as the two resolvers above.
 */
async function resolveChosenEmail(user: { hr_id?: string | null }, emailTo: "private" | "work") {
  const hrId = String(user.hr_id ?? "").trim();
  if (!hrId) return null;

  try {
    const { data } = await getSupabaseAdmin()
      .from("employees")
      .select("work_email, personal_email")
      .eq("hr_id", hrId)
      .maybeSingle();
    const row = data as { personal_email?: string | null; work_email?: string | null } | null;
    return pickDeliverableEmail(emailTo === "private" ? row?.personal_email : row?.work_email);
  } catch {
    return null;
  }
}

export async function sendPasswordSetupLink(input: {
  actorLoginId?: string | null;
  deliveryMode?: "copy" | "email" | "whatsapp";
  /**
   * Which mailbox, for a caller that lets a person choose (New Hire Accounts, owner 2026-11-03). Left out, the mailbox is
   * resolved as it always was. A private address is allowed here because a person pressed for this one person; the
   * self-service reset code below still goes to the Sato mailbox alone.
   */
  emailTo?: "private" | "work";
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
  const deliverableEmail = input.emailTo ? await resolveChosenEmail(user, input.emailTo) : await resolveDeliverableEmail(user);
  if (deliveryMode === "email" && !deliverableEmail && input.emailTo) {
    throw new Error(`User ${loginId} has no ${input.emailTo === "private" ? "private" : "Sato"} email on the employee register.`);
  }
  if (deliveryMode === "email" && !deliverableEmail) {
    throw new Error(
      `User ${loginId} has no deliverable email address (checked app_auth_users.email and employees.work_email). Use the copy-link delivery mode instead.`,
    );
  }

  // Resolved BEFORE anything is written, like the email address above: every path below signs the
  // person out and changes what their password is, so failing after that point would sign someone out
  // to produce an error message.
  const whatsAppNumber = deliveryMode === "whatsapp" ? await resolveWhatsAppNumber(user) : null;
  if (deliveryMode === "whatsapp" && !whatsAppNumber) {
    throw new Error(
      `User ${loginId} has no readable mobile number on the employee register, so no WhatsApp chat can be opened. Use the copy-link delivery mode instead.`,
    );
  }

  // EMAIL AND WHATSAPP SEND A USERNAME, A TEMPORARY PASSWORD AND THE SIGN-IN LINK, NOT A SETUP LINK
  // (owner, 12 Nov 2026 — src/lib/auth/temporary-password.ts), and the same three go to the person's
  // Telegram when it is connected. Copy mode alone still hands back a one-time setup link.
  if ((deliveryMode === "email" && deliverableEmail) || (deliveryMode === "whatsapp" && whatsAppNumber)) {
    return sendTemporaryPassword({
      actorLoginId: input.actorLoginId ?? null,
      channel: deliveryMode === "email" ? { deliverableEmail: deliverableEmail!, kind: "email" } : { kind: "whatsapp", whatsAppNumber: whatsAppNumber! },
      emailTo: input.emailTo ?? null,
      governanceReason: input.governanceReason ?? null,
      purpose: input.purpose ?? (user.force_password_reset ? "setup" : "reset"),
      user,
    });
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
      // A link replaces any emailed temporary password: from here that password opens nothing.
      temporary_password_expires_at: null,
      updated_at: now,
    })
    .eq("login_id", loginId);

  if (updateError) {
    throw updateError;
  }

  const emailResult =
    deliveryMode === "email"
      ? await createSystemNotification({
          // No actionUrl: it is stored on the notification's own row (action_url, metadata.href), and
          // a link that sets a password is never stored. The email's button reads ctaHref below.
          actorId: input.actorLoginId ?? "system",
          channels: ["email"],
          email: {
            candidateEmail: deliverableEmail,
            chosenMailbox: input.emailTo ? deliverableEmail : null,
            // A live set-your-password link: never mirrored to the admin Telegram (owner, 23 Oct 2026).
            credentialEmail: "password_setup_link",
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
              // Cairo local, never raw UTC (house rule) — the recipient reads this expiry time.
              { label: "Expires", value: `${new Date(expiresAt).toLocaleString("en-US", { timeZone: "Africa/Cairo" })} (Cairo)` },
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
      : { deliveries: [{ channel: "email" as const, error: undefined, idempotencyKey: "manual", queuedForRetry: false, reason: "Link generated for manual sharing.", status: "skipped" as const }] };
  // A first try that did not leave is recorded `sent` with `queuedForRetry`, handed to the outbox. It is not a send:
  // on 3 Nov 2026 the first private email was refused at every try while the audit row and the screen both said sent.
  const emailSent = emailResult.deliveries.some((delivery) => delivery.channel === "email" && delivery.status === "sent" && !delivery.queuedForRetry);
  const emailDelivery = emailResult.deliveries.find((delivery) => delivery.channel === "email");
  const emailQueuedForRetry = deliveryMode === "email" && emailDelivery?.queuedForRetry === true;

  // The number as a person dials it (01012345678), not the 20… form wa.me wants: the audit trail is
  // read by a human asking "which handset was this link opened on?".
  const whatsAppLocalNumber = whatsAppNumber ? toDialableLocalMobile(whatsAppNumber) : null;

  // Composed HERE and nowhere else. The URL sets a password, so the only copy of it that leaves the
  // server is the one the admin is about to press send on — it is never stored, logged or re-derivable.
  const whatsAppUrl =
    deliveryMode === "whatsapp" && whatsAppNumber
      ? passwordSetupWhatsAppUrl(
          whatsAppNumber,
          composePasswordSetupWhatsAppMessage({
            expiresAt,
            loginId,
            name: user.name ?? "",
            purpose,
            setupUrl,
          }),
        )
      : null;

  await writeRequiredAuditLog({
    actorLoginId: input.actorLoginId ?? null,
    entityId: loginId,
    entityType: "user",
    newValues: {
      action: "password_setup_link_generated",
      delivery:
        deliveryMode === "whatsapp"
          ? "whatsapp_link_prepared"
          : deliveryMode === "email" && emailSent
            ? "email_sent"
            : emailQueuedForRetry
              ? "email_queued_for_retry"
              : "link_generated_only",
      deliveryMode,
      emailTo: input.emailTo ?? null,
      expiresAt,
      reason: input.governanceReason ?? null,
      purpose,
      sentTo: deliveryMode === "email" ? deliverableEmail : null,
      // The handset the admin was handed, never the link itself.
      sentToWhatsApp: whatsAppLocalNumber,
      token: "[redacted]",
      url: "[redacted]",
    },
    oldValues: null,
    summary: `${deliveryMode === "email" ? "Sent" : deliveryMode === "whatsapp" ? "Prepared WhatsApp" : "Generated"} ${purpose === "setup" ? "setup" : "reset"} link for ${loginId}`,
  });

  return {
    deliveryMessage:
      deliveryMode === "whatsapp"
        ? `WhatsApp message ready for ${user.name?.trim() || loginId} on ${whatsAppLocalNumber}. Open the chat and press send — the link is live from now.`
        : deliveryMode === "copy"
          ? `Password ${purpose === "setup" ? "setup" : "reset"} link generated for copy/paste.`
          : emailQueuedForRetry
            ? "Link generated, but the email has not left yet. Phoenix will try again. If it does not arrive, send the link another way."
            : !emailSent
              ? `Link generated but email was not delivered: ${emailDelivery?.reason ?? emailDelivery?.error ?? "Delivery did not complete."}`
              : `Password ${purpose === "setup" ? "setup" : "reset"} link sent to ${deliverableEmail}.`,
    deliveryMode,
    ...(deliveryMode === "email" ? { emailDelivered: emailSent, emailQueuedForRetry } : {}),
    expiresAt,
    loginId,
    // 🔴 THE RAW LINK LEAVES THE SERVER FOR THE COPY WORKFLOW AND NOTHING ELSE, and the WhatsApp mode
    // is no exception: the live credential is already inside the prepared chat URL below, so handing
    // it back a second time would widen where it can be read for no gain on screen.
    // Pinned by tests/access-governance-hardening.test.ts.
    ...(deliveryMode === "copy" ? { setupUrl } : {}),
    ...(whatsAppUrl ? { whatsAppUrl } : {}),
  } satisfies PasswordSetupLinkResult;
}

/**
 * The username, temporary password and sign-in link (owner, 12 Nov 2026 — src/lib/auth/temporary-password.ts),
 * by email or as a WhatsApp message written into the person's own chat, and to their Telegram when it
 * is connected.
 *
 * The temporary password REPLACES the stored one at once (so any old password dies here, as a reset
 * should) and is kept only as a bcrypt hash; its plain text lives in memory and in the messages. The
 * email is stamped `credentialEmail: "temporary_password"`, so the outbox seals it while it waits and
 * deletes it once finished, the stored copy of the rendered email has it removed, and it is never
 * mirrored to the admin Telegram. The Telegram copy is sent straight to the person's chat and is not
 * stored as a notice. The audit row says what was sent and where, never what the password was.
 */
async function sendTemporaryPassword(input: {
  actorLoginId: string | null;
  channel: { deliverableEmail: string; kind: "email" } | { kind: "whatsapp"; whatsAppNumber: string };
  emailTo: "private" | "work" | null;
  governanceReason: string | null;
  purpose: "reset" | "setup";
  user: Awaited<ReturnType<typeof getAuthUser>>;
}): Promise<PasswordSetupLinkResult> {
  const { channel, purpose, user } = input;
  const loginId = user.login_id;
  const temporaryPassword = createReadableTemporaryPassword();
  const passwordHash = await bcrypt.hash(temporaryPassword, 12);
  const expiresAt = new Date(Date.now() + temporaryPasswordExpiryMs).toISOString();
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const currentVersion = (() => {
    const version = Number((user as { session_version?: unknown }).session_version);
    return Number.isFinite(version) && version > 0 ? version : 1;
  })();

  // An outstanding setup link would otherwise still set a password beside the temporary one.
  await invalidateOutstandingTokens(loginId);

  const { error: updateError } = await supabase
    .from("app_auth_users")
    .update({
      force_password_reset: true,
      password_hash: passwordHash,
      session_version: currentVersion + 1,
      temporary_password_expires_at: expiresAt,
      updated_at: now,
    })
    .eq("login_id", loginId);
  if (updateError) throw updateError;

  // The Supabase side gets the same temporary password, so no OLD password stays live there (the anon
  // key signs in with it). Non-fatal like every bridge sync — the sign-in route repairs the bridge.
  // A test account has no Supabase identity (src/lib/auth/test-persona.ts).
  let bridgeWarning: string | null = null;
  if (user.is_test_persona !== true) try {
    const role = String(user.role ?? "Employee") as Parameters<typeof provisionSupabaseAuthIdentity>[0]["role"];
    const identity = await provisionSupabaseAuthIdentity({
      authUserId: user.auth_user_id ?? null,
      email: user.email ?? null,
      hrId: user.hr_id ?? loginId,
      isActive: Boolean(user.is_active),
      line: user.line ?? null,
      loginId,
      managerHrId: user.manager_hr_id ?? null,
      name: user.name ?? loginId,
      password: temporaryPassword,
      role,
    });
    await persistSupabaseAuthIdentityLink({
      authEmail: identity.authEmail,
      authUserId: identity.authUserId,
      coarseRole: identity.coarseRole,
      email: user.email ?? null,
      hrId: user.hr_id ?? loginId,
      isActive: Boolean(user.is_active),
      line: user.line ?? null,
      loginId,
      managerHrId: user.manager_hr_id ?? null,
      name: user.name ?? loginId,
      role,
    });
  } catch (error) {
    bridgeWarning = error instanceof Error ? error.message : "Supabase auth bridge sync failed.";
  }

  // Always the production address (owner: "the production link"), wherever the button was pressed.
  const signInUrl = `${systemDeployment.productionUrl}/login`;
  const credentials = {
    expiresAt,
    loginId,
    name: user.name ?? "",
    purpose,
    signInUrl,
    temporaryPassword,
  } as const;

  let emailSent = false;
  let emailQueuedForRetry = false;
  let emailFailure: string | null = null;
  let whatsAppUrl: string | null = null;

  if (channel.kind === "email") {
    const title = purpose === "setup" ? systemAuthEmailText.credentialsSetupTitle : systemAuthEmailText.credentialsResetTitle;
    const emailResult = await createSystemNotification({
      actorId: input.actorLoginId ?? "system",
      channels: ["email"],
      email: {
        candidateEmail: channel.deliverableEmail,
        chosenMailbox: input.emailTo ? channel.deliverableEmail : null,
        credentialEmail: "temporary_password",
        ctaHref: "/login",
        ctaLabel: "Sign in",
        // The order the owner asked for: username, password, then the production link.
        metrics: [
          { label: TEMPORARY_PASSWORD_USERNAME_LABEL, value: loginId },
          { label: TEMPORARY_PASSWORD_METRIC_LABEL, value: temporaryPassword },
          { label: TEMPORARY_PASSWORD_SIGN_IN_LABEL, value: signInUrl },
          { label: "Valid until", value: temporaryPasswordExpiryLabel(expiresAt) },
        ],
        notificationType: purpose === "setup" ? "user_created" : "password_reset",
        recipientMode: "candidate",
        recipientName: user.name?.trim() || undefined,
        recipients: [channel.deliverableEmail],
        subject: purpose === "setup" ? systemAuthEmailText.credentialsSetupSubject : systemAuthEmailText.credentialsResetSubject,
        summary: purpose === "setup" ? systemAuthEmailText.credentialsSetupSummary : systemAuthEmailText.credentialsResetSummary,
        title,
        tone: "warning",
      },
      eventType: purpose === "setup" ? "account_credentials_sent" : "temporary_password_sent",
      message: purpose === "setup" ? systemAuthEmailText.credentialsSetupSummary : systemAuthEmailText.credentialsResetSummary,
      metadata: {
        // Keyed on a digest of the HASH, never the password: the key is stored.
        idempotencyKey: `temporary-password:${loginId}:${crypto.createHash("sha256").update(passwordHash).digest("hex").slice(0, 32)}`,
        loginId,
        purpose,
      },
      module: purpose === "setup" ? "password_setup" : "password_reset",
      priority: "high",
      recipientHrId: user.hr_id,
      recipientUserId: loginId,
      title,
    });

    // A first try that did not leave is recorded `sent` with `queuedForRetry`: it is not a send.
    const emailDelivery = emailResult.deliveries.find((delivery) => delivery.channel === "email");
    emailSent = emailResult.deliveries.some(
      (delivery) => delivery.channel === "email" && delivery.status === "sent" && !delivery.queuedForRetry,
    );
    emailQueuedForRetry = emailDelivery?.queuedForRetry === true;
    emailFailure = emailSent || emailQueuedForRetry ? null : emailDelivery?.reason ?? emailDelivery?.error ?? "Delivery did not complete.";
  } else {
    // Composed HERE and handed back once, for the admin to press send in his own WhatsApp — never
    // stored or logged. An automatic send is not possible: see src/lib/auth/password-setup-whatsapp.ts.
    whatsAppUrl = passwordSetupWhatsAppUrl(channel.whatsAppNumber, composeTemporaryPasswordWhatsAppMessage(credentials));
  }

  const telegram = await sendTemporaryPasswordTelegram(user, composeTemporaryPasswordMessage(credentials));
  const whatsAppLocalNumber = channel.kind === "whatsapp" ? toDialableLocalMobile(channel.whatsAppNumber) : null;

  await writeRequiredAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: loginId,
    entityType: "user",
    newValues: {
      action: "temporary_password_sent",
      bridgeWarning,
      delivery:
        channel.kind === "whatsapp"
          ? "whatsapp_message_prepared"
          : emailSent
            ? "email_sent"
            : emailQueuedForRetry
              ? "email_queued_for_retry"
              : "email_not_delivered",
      deliveryMode: channel.kind,
      emailTo: input.emailTo,
      expiresAt,
      password: "[redacted]",
      purpose,
      reason: input.governanceReason,
      sentTo: channel.kind === "email" ? channel.deliverableEmail : null,
      sentToWhatsApp: whatsAppLocalNumber,
      telegram: telegram.outcome,
      url: "[redacted]",
    },
    oldValues: null,
    summary: `${channel.kind === "email" ? "Sent" : "Prepared WhatsApp with"} username and temporary password for ${loginId}`,
  });

  const telegramNote = telegram.outcome === "sent" ? " Also sent to their Telegram." : "";
  const deliveryMessage =
    channel.kind === "whatsapp"
      ? `WhatsApp message ready for ${user.name?.trim() || loginId} on ${whatsAppLocalNumber}, with the username, temporary password and sign-in link. Open the chat and press send.${telegramNote}`
      : emailQueuedForRetry
        ? `Temporary password set, but the email has not left yet. Phoenix will try again. If it does not arrive, send it again.${telegramNote}`
        : emailFailure
          ? `Temporary password set but the email was not delivered: ${emailFailure}${telegramNote}`
          : `Username and temporary password sent to ${channel.deliverableEmail}.${telegramNote}`;

  return {
    deliveryMessage,
    deliveryMode: channel.kind,
    ...(channel.kind === "email" ? { emailDelivered: emailSent, emailQueuedForRetry } : {}),
    expiresAt,
    loginId,
    ...(whatsAppUrl ? { whatsAppUrl } : {}),
  };
}

/**
 * The same three things on the person's Telegram, when they have connected it. Sent straight to their
 * chat — not through createSystemNotification, which would store the text as a notice on the bell.
 * A person with no connected Telegram is simply skipped: a bot cannot start a chat with a phone number.
 * Never throws: Telegram is an extra copy, and its failure must not undo the email or the WhatsApp.
 */
async function sendTemporaryPasswordTelegram(
  user: { hr_id?: string | null; login_id: string },
  message: string,
): Promise<{ outcome: "sent" | "not_connected" | "failed" }> {
  try {
    const supabase = getSupabaseAdmin();
    const byLogin = await supabase
      .from("telegram_connections")
      .select("telegram_chat_id,status")
      .ilike("user_id", user.login_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byLogin.error) throw byLogin.error;
    let connection = byLogin.data as { status?: string | null; telegram_chat_id?: string | number | null } | null;
    const hrId = String(user.hr_id ?? "").trim();
    if (!connection && hrId) {
      const byHrId = await supabase
        .from("telegram_connections")
        .select("telegram_chat_id,status")
        .eq("hr_id", hrId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (byHrId.error) throw byHrId.error;
      connection = byHrId.data as typeof connection;
    }
    if (connection?.status !== "connected" || !connection.telegram_chat_id) return { outcome: "not_connected" };

    const result = await sendTelegramNotification({
      chatId: String(connection.telegram_chat_id),
      keepParagraphs: true,
      message,
      title: "Your Phoenix Workforce sign-in",
    });
    return { outcome: result.skipped ? "failed" : "sent" };
  } catch {
    return { outcome: "failed" };
  }
}

/**
 * The setup token a correct TEMPORARY password earns at sign-in (app/api/auth/login): 15 minutes, on the
 * existing /password-setup screen, which signs the person in once they have chosen their own password.
 */
export async function mintTemporaryPasswordSetupToken(loginId: string): Promise<string> {
  return mintPasswordSetupTokenForLogin(loginId, "setup", temporaryPasswordSetupTokenExpiryMs);
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
  // And not a password every guessing list tries first (password-strength.ts).
  const weakness = passwordWeakness(password, [tokenRow.login_id, tokenRow.hr_id]);
  if (weakness) throw new Error(weakness);
  // And not one that already sits in a published breach (leaked-password.ts). Asked BEFORE the link is
  // spent, so a refused password leaves the link usable; an unreachable service accepts the password and
  // is named on the audit row below.
  const leakVerdict = await checkLeakedPassword(password);
  if (leakVerdict.leaked === true) throw new Error(LEAKED_PASSWORD_MESSAGE);
  const leakedPasswordCheck = leakedPasswordAuditValue(leakVerdict);

  const passwordHash = await bcrypt.hash(password, 12);
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  let bridgeWarning: string | null = null;
  // True when Supabase refused the new password as weak and holds a random secret instead
  // (provisionSupabaseAuthIdentity) — kept on the audit row, where bridgeWarning no longer shows it.
  let supabaseWeakPasswordReplaced = false;

  // THE LINK IS SPENT BEFORE THE PASSWORD IS WRITTEN, IN ONE CONDITIONAL UPDATE (technical audit,
  // 2026-10-23, F-12). The usability check above is a separate read, and the link used to be marked
  // used only after the password write, with no "not yet used" condition — so two submissions of
  // one link both passed the check and both set a password, the second silently replacing the first.
  // Only the request whose update finds the link still unused goes on.
  const { data: claimed, error: claimError } = await supabase
    .from("password_setup_tokens")
    .update({ updated_at: now, used_at: now })
    .eq("token_hash", tokenRow.token_hash)
    .is("used_at", null)
    .select("token_hash");
  if (claimError) {
    throw claimError;
  }
  if (!claimed || claimed.length === 0) {
    throw new Error("This password setup link has already been used.");
  }
  // A password write that fails hands the link back, so the person can try again with it.
  const releaseLink = async () => {
    await supabase
      .from("password_setup_tokens")
      .update({ updated_at: new Date().toISOString(), used_at: null })
      .eq("token_hash", tokenRow.token_hash)
      .eq("used_at", now);
  };

  let currentUser: Awaited<ReturnType<typeof getAuthUser>>;
  try {
    currentUser = await getAuthUser(tokenRow.login_id);
  } catch (error) {
    await releaseLink().catch(() => undefined);
    throw error;
  }

  const { error: userError } = await supabase
    .from("app_auth_users")
    .update({
      force_password_reset: false,
      password_hash: passwordHash,
      temporary_password_expires_at: null,
      session_version: 1 + Number(
        Number.isFinite((currentUser as { session_version?: unknown }).session_version)
          ? (currentUser as { session_version?: number }).session_version
          : 1,
      ),
      updated_at: now,
    })
    .eq("login_id", tokenRow.login_id);

  if (userError) {
    await releaseLink().catch(() => undefined);
    throw userError;
  }

  // A new password ends every "do not ask on this browser" of the second sign-in step (second-step.ts).
  // Best effort, and named on the audit row: the password is already set.
  const trustedDevicesForgotten = await forgetTrustedDevices(tokenRow.login_id).then(
    () => true,
    () => false,
  );

  // A test account (src/lib/auth/test-persona.ts) has no HR id and no Supabase identity; minting one
  // here would leave a Supabase user whose profile row the employees foreign key refuses.
  if (currentUser.is_test_persona !== true) try {
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
    supabaseWeakPasswordReplaced = identity.weakPasswordReplaced === true;
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

  await writeRequiredAuditLog({
    actorLoginId: tokenRow.login_id,
    entityId: tokenRow.login_id,
    entityType: "user",
    newValues: {
      bridgeWarning,
      completedAt: now,
      leakedPasswordCheck,
      purpose: tokenRow.purpose,
      supabaseWeakPasswordReplaced,
      trustedDevicesForgotten,
    },
    oldValues: null,
    summary: `Completed password ${tokenRow.purpose} for ${tokenRow.login_id}`,
  });

  return { bridgeWarning };
}

// ---------------------------------------------------------------------------------------------------
// Self-service reset-by-code (owner, 2026-10-06). An employee types their Sato email (or HR_ID /
// login ID) on /password-reset, receives a 6-digit code in their inbox, enters it, and is handed a
// short-lived password_setup_tokens token that drives the EXISTING /password-setup/[token] screen.
// So this layer only adds the "prove the inbox" step; bcrypt, the session bump, the Supabase bridge
// and the audit trail all stay in completePasswordSetup, unchanged.
// ---------------------------------------------------------------------------------------------------

// Mint a fresh password_setup_tokens row for a login WITHOUT emailing a link (the code already
// proved the inbox). Same insert + single-live-token invariant sendPasswordSetupLink relies on, but
// with a caller-chosen expiry so the code-verified token lives only as long as the code did.
async function mintPasswordSetupTokenForLogin(
  loginId: string,
  purpose: "reset" | "setup",
  expiryMs: number,
): Promise<string> {
  const user = await getAuthUser(loginId);
  if (!user.is_active) {
    throw new Error(`User ${loginId} is inactive.`);
  }

  const token = createToken();
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiryMs).toISOString();
  const supabase = getSupabaseAdmin();

  await invalidateOutstandingTokens(loginId);

  const { error } = await supabase
    .from("password_setup_tokens")
    .insert({
      expires_at: expiresAt,
      login_id: loginId,
      purpose,
      token_hash: tokenHash,
      updated_at: now,
    });

  if (error) {
    throw error;
  }

  return token;
}

/**
 * Email a one-time 6-digit reset code to the Sato mailbox of whoever a person typed on the reset
 * page. ENUMERATION-SAFE: it resolves silently and returns nothing whether the identifier is
 * unknown, inactive, or has no deliverable address — the caller (route) always answers the same
 * "if that account exists, a code was sent". Only the newest code for a login is ever live.
 */
export async function requestPasswordResetCode(input: {
  identifier: string;
  requestIp?: string | null;
}): Promise<void> {
  const loginId = await resolveStoredLoginId(input.identifier).catch(() => null);
  if (!loginId) return;

  let user: Awaited<ReturnType<typeof getAuthUser>>;
  try {
    user = await getAuthUser(loginId);
  } catch {
    return;
  }
  if (!user.is_active) return;

  // Same mailbox resolution the admin link uses: app_auth_users.email override, else the real
  // employees.work_email. No real mailbox -> nothing to send (and nothing to leak).
  const deliverableEmail = await resolveDeliverableEmail(user);
  if (!deliverableEmail) return;

  const code = generatePasswordResetCode();
  const codeHash = hashPasswordResetCode(loginId, code);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + passwordResetCodeExpiryMs);
  const supabase = getSupabaseAdmin();

  // Supersede any still-live code so only the one just emailed can be used.
  await supabase
    .from("password_reset_codes")
    .update({ consumed_at: nowIso, updated_at: nowIso })
    .eq("login_id", loginId)
    .is("consumed_at", null);

  const { error: insertError } = await supabase
    .from("password_reset_codes")
    .insert({
      code_hash: codeHash,
      expires_at: expiresAt.toISOString(),
      login_id: loginId,
      max_attempts: passwordResetCodeMaxAttempts,
      request_ip: input.requestIp ?? null,
      sent_to_email: deliverableEmail,
    });

  if (insertError) {
    throw insertError;
  }

  await createSystemNotification({
    actionUrl: "/password-reset",
    actorId: "system",
    channels: ["email"],
    email: {
      candidateEmail: deliverableEmail,
      // The 6-digit reset code itself: never mirrored to the admin Telegram (owner, 23 Oct 2026).
      credentialEmail: "password_reset_code",
      recipientName: user.name?.trim() || undefined,
      ctaHref: "/password-reset",
      ctaLabel: "Open the password page",
      metrics: [
        { label: passwordResetCodeMetricLabel, value: code },
        {
          label: "Expires",
          value: `${expiresAt.toLocaleString("en-US", { timeZone: "Africa/Cairo" })} (Cairo)`,
        },
      ],
      notificationType: "password_reset",
      recipientMode: "candidate",
      recipients: [deliverableEmail],
      subject: systemAuthEmailText.passwordResetSubject,
      // The code email has its OWN template, because the shared password_reset one is the
      // admin-minted LINK email and its stored body renders no {{detailsTable}} — so the digits
      // went nowhere. Explicit templateKey beats the notificationType mapping (see
      // NotificationEmailInput.templateKey).
      templateKey: EMAIL_TEMPLATE_KEYS.PASSWORD_RESET_CODE,
      summary:
        "Enter this 6-digit code on the Phoenix password page to set a new password. It expires in 15 minutes. If you did not ask for this, ignore this email — your password stays unchanged.",
      title: systemAuthEmailText.passwordResetTitle,
      tone: "warning",
    },
    eventType: "password_reset_code_created",
    message:
      "A one-time password-reset code was requested for your Phoenix account.",
    metadata: {
      idempotencyKey: `password-reset-code:${loginId}:${codeHash}`,
      loginId,
      purpose: "reset_code",
    },
    module: "password_reset",
    priority: "high",
    recipientHrId: user.hr_id,
    recipientUserId: loginId,
    title: systemAuthEmailText.passwordResetTitle,
  });

  await writeRequiredAuditLog({
    actorLoginId: loginId,
    entityId: loginId,
    entityType: "user",
    newValues: {
      action: "password_reset_code_sent",
      code: "[redacted]",
      expiresAt: expiresAt.toISOString(),
      sentTo: deliverableEmail,
    },
    oldValues: null,
    summary: `Sent self-service password reset code to ${loginId}`,
  });
}

/**
 * Check a submitted code against the newest live code for whoever a person typed, enforcing the
 * attempt cap and expiry. On success it consumes the code and returns a short-lived
 * password_setup_tokens token for the /password-setup/[token] screen. Every failure throws the SAME
 * generic error (never revealing whether the account, or the code, was the problem).
 */
export async function verifyPasswordResetCode(input: {
  code: string;
  identifier: string;
  requestIp?: string | null;
}): Promise<{ token: string }> {
  const genericError = new Error("That code is invalid or has expired. Request a new one.");

  const loginId = await resolveStoredLoginId(input.identifier).catch(() => null);
  if (!loginId) throw genericError;

  // Cheap shape gate, same generic error — never spend a real compare on a non-6-digit string.
  if (normalizePasswordResetCode(input.code).length !== passwordResetCodeLength) {
    throw genericError;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("password_reset_codes")
    .select("id, login_id, code_hash, attempts, max_attempts, expires_at, consumed_at")
    .eq("login_id", loginId)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  const row = (data as (ResetCodeRow & { id: string }) | null) ?? null;
  const outcome = evaluatePasswordResetCode({ code: input.code, row });

  if (outcome.status === "ok" && row) {
    const now = new Date().toISOString();
    const { error: consumeError } = await supabase
      .from("password_reset_codes")
      .update({ consumed_at: now, updated_at: now })
      .eq("id", row.id);
    if (consumeError) throw consumeError;

    const token = await mintPasswordSetupTokenForLogin(loginId, "reset", codeVerifiedTokenExpiryMs);
    return { token };
  }

  if (outcome.status === "mismatch" && row) {
    const now = new Date().toISOString();
    await supabase
      .from("password_reset_codes")
      .update({
        attempts: outcome.nextAttempts,
        updated_at: now,
        // A code that has just exhausted its attempts is dead — retire it so the next request mints
        // a fresh one rather than hammering a locked row.
        ...(outcome.locked ? { consumed_at: now } : {}),
      })
      .eq("id", row.id);
  }

  throw genericError;
}
