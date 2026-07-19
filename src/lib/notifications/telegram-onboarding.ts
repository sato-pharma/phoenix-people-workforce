import crypto from "crypto";

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { systemIdentity } from "@/config/system-settings";
import { renderTelegramConnectEmailHtml, renderTelegramConnectEmailText } from "@/emails/telegram-connect";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { buildTelegramDeepLinkFromToken, hashTelegramToken, resolveTelegramBotUsername } from "@/lib/notifications/telegram";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Email-onboarding tokens live longer than the 15-minute in-portal token because
// employees may open the invitation hours later — but a connect link is a bearer
// credential, so the window is kept short (48h) to limit exposure of a leaked link.
// The token stays single-use: the webhook marks connect_token_used_at on first /start
// and nulls the hash, and the post-link security alert makes any hijack detectable.
const DEFAULT_TTL_MINUTES = 48 * 60; // 48 hours
const DEFAULT_CAMPAIGN_LIMIT = 250;
// Lifecycle statuses that must NOT be invited (terminal/offboarding). Mirrors the
// active-employee definition in src/lib/employees/employee-directory.ts.
const terminalLifecycleStatuses = new Set([
  "terminated",
  "resigned",
  "inactive",
  "offboarded",
  "left",
  "separated",
  "suspended",
]);

export type TelegramOnboardingTarget = {
  email: string;
  hrId: string | null;
  name: string | null;
  userId: string;
};

export type TelegramOnboardingResult = {
  detail: string;
  email: string;
  status: "sent" | "skipped" | "failed";
  userId: string;
};

export type TelegramOnboardingSummary = {
  attempted: number;
  available: number;
  failed: number;
  results: TelegramOnboardingResult[];
  sent: number;
  skipped: number;
  truncated: boolean;
};

function expiresLabelFor(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

type CreateLinkResult =
  | { expiresAt: string; link: string; skipped: false; token: string }
  | { reason: string; skipped: true };

// Generates a fresh single-use connect token for a specific user and stores it on
// their telegram_connections row (one row per user, mirroring the in-portal flow).
// Already-connected users are left untouched unless `force` is set.
export async function createTelegramOnboardingLink(input: {
  force?: boolean;
  hrId?: string | null;
  ttlMinutes?: number;
  userId: string;
}): Promise<CreateLinkResult> {
  const userId = input.userId.trim();
  if (!userId) throw new Error("A user id is required for the Telegram onboarding link.");
  if (!(await resolveTelegramBotUsername())) throw new Error("Telegram bot is not reachable; cannot build a connect link.");

  const supabase = getSupabaseAdmin();
  const existing = await supabase
    .from("telegram_connections")
    .select("id,status")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;

  const existingRow = existing.data as { id?: string; status?: string } | null;
  if (!input.force && existingRow?.status === "connected") {
    return { reason: "Already connected to Telegram.", skipped: true };
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const link = await buildTelegramDeepLinkFromToken(token);
  if (!link) throw new Error("Telegram bot username is not available; cannot build a connect link.");

  const now = new Date();
  const ttlMinutes = Number.isFinite(input.ttlMinutes) && Number(input.ttlMinutes) > 0 ? Number(input.ttlMinutes) : DEFAULT_TTL_MINUTES;
  const expires = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  const payload = {
    connect_token_expires_at: expires.toISOString(),
    connect_token_hash: hashTelegramToken(token),
    connect_token_used_at: null,
    disabled_at: null,
    failure_reason: null,
    hr_id: input.hrId ?? null,
    status: "pending",
    telegram_chat_id: null,
    updated_at: now.toISOString(),
    user_id: userId,
  };

  const result = existingRow?.id
    ? await supabase.from("telegram_connections").update(payload).eq("id", existingRow.id)
    : await supabase.from("telegram_connections").insert(payload);
  if (result.error) throw result.error;

  return { expiresAt: expires.toISOString(), link, skipped: false, token };
}

// Builds the connect link and emails the premium "connect Telegram" invitation to
// a single employee. Honest about skips (no email / already connected / delivery
// switched off) and never throws — returns a per-recipient result for the campaign.
export async function sendTelegramConnectInvite(input: {
  email: string;
  force?: boolean;
  hrId?: string | null;
  name?: string | null;
  ttlMinutes?: number;
  userId: string;
}): Promise<TelegramOnboardingResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) return { detail: "No email address on file.", email: input.email, status: "skipped", userId: input.userId };

  let created: CreateLinkResult;
  try {
    created = await createTelegramOnboardingLink({
      force: input.force,
      hrId: input.hrId,
      ttlMinutes: input.ttlMinutes,
      userId: input.userId,
    });
  } catch (error) {
    return { detail: error instanceof Error ? error.message : "Unable to create connect link.", email, status: "failed", userId: input.userId };
  }
  if (created.skipped) return { detail: created.reason, email, status: "skipped", userId: input.userId };

  const expiresLabel = expiresLabelFor(created.expiresAt);
  const html = renderTelegramConnectEmailHtml({ connectUrl: created.link, expiresLabel, name: input.name ?? null });
  const text = renderTelegramConnectEmailText({ connectUrl: created.link, expiresLabel, name: input.name ?? null });

  try {
    const sendResult = await sendPhoenixEmail({
      html,
      idempotencyKey: `telegram-onboard:${input.userId}:${created.token.slice(0, 12)}`,
      subject: `Connect Telegram to ${systemIdentity.appName} notifications`,
      text,
      to: [email],
    });
    if ("skipped" in sendResult && sendResult.skipped) {
      return { detail: sendResult.reason, email, status: "skipped", userId: input.userId };
    }
    return { detail: "Invitation email sent.", email, status: "sent", userId: input.userId };
  } catch (error) {
    return { detail: error instanceof Error ? error.message : "Email delivery failed.", email, status: "failed", userId: input.userId };
  }
}

// Active login accounts that have a work email and (by default) are not yet
// connected to Telegram. user_id follows the auth convention login_id ?? hr_id.
export async function listTelegramOnboardingTargets(options?: { onlyUnconnected?: boolean }): Promise<TelegramOnboardingTarget[]> {
  const supabase = getSupabaseAdmin();
  const [usersRes, employeesRes, connectionsRes] = await Promise.all([
    supabase.from("app_auth_users").select("login_id,hr_id,is_active").eq("is_active", true),
    supabase.from("employees").select("hr_id,full_name,nickname,work_email,employment_status").not("work_email", "is", null),
    supabase.from("telegram_connections").select("user_id,status"),
  ]);
  if (usersRes.error) throw usersRes.error;
  if (employeesRes.error) throw employeesRes.error;
  if (connectionsRes.error) throw connectionsRes.error;

  const contactByHr = new Map<string, { email: string; name: string | null }>();
  for (const row of (employeesRes.data ?? []) as Array<{ employment_status: string | null; full_name: string | null; hr_id: string | null; nickname: string | null; work_email: string | null }>) {
    const hrId = String(row.hr_id ?? "").trim();
    const email = String(row.work_email ?? "").trim().toLowerCase();
    // Never invite terminal/offboarding employees, even if they still have an active
    // auth row + work email (this path bypasses the directory active-filter gate).
    if (terminalLifecycleStatuses.has(String(row.employment_status ?? "").trim().toLowerCase())) continue;
    if (hrId && email) contactByHr.set(hrId, { email, name: row.full_name ? resolveEmployeeDisplayName(row.full_name, row.nickname) : null });
  }

  const connectedUserIds = new Set<string>();
  for (const row of (connectionsRes.data ?? []) as Array<{ status: string | null; user_id: string | null }>) {
    if (row.status === "connected" && row.user_id) connectedUserIds.add(String(row.user_id));
  }

  const onlyUnconnected = options?.onlyUnconnected !== false;
  const targets: TelegramOnboardingTarget[] = [];
  const seen = new Set<string>();
  for (const row of (usersRes.data ?? []) as Array<{ hr_id: string | null; login_id: string | null }>) {
    const userId = String(row.login_id ?? row.hr_id ?? "").trim();
    if (!userId || seen.has(userId)) continue;
    if (onlyUnconnected && connectedUserIds.has(userId)) continue;
    const hrId = String(row.hr_id ?? "").trim();
    const contact = hrId ? contactByHr.get(hrId) : undefined;
    if (!contact?.email) continue;
    seen.add(userId);
    targets.push({ email: contact.email, hrId: hrId || null, name: contact.name, userId });
  }
  return targets;
}

// Read-only count of eligible (active, not-yet-connected, has-email, non-terminal)
// employees, for the "you are about to email N people" confirmation preview.
export async function countTelegramOnboardingTargets(): Promise<number> {
  const targets = await listTelegramOnboardingTargets({ onlyUnconnected: true });
  return targets.length;
}

// Resolves the audience, sends the connect invitations sequentially (provider
// rate-limit friendly), audits the outcome, and returns a per-recipient summary.
export async function runTelegramOnboardingCampaign(input: {
  access: Pick<AccessContext, "hrId" | "loginId">;
  force?: boolean;
  limit?: number;
  ttlMinutes?: number;
  userIds?: string[];
}): Promise<TelegramOnboardingSummary> {
  if (!(await resolveTelegramBotUsername())) {
    throw new Error("Telegram bot is not reachable. Provision the bot before sending invitations.");
  }

  let targets = await listTelegramOnboardingTargets({ onlyUnconnected: !input.force });
  if (input.userIds && input.userIds.length > 0) {
    const wanted = new Set(input.userIds.map((id) => String(id).trim()).filter(Boolean));
    targets = targets.filter((target) => wanted.has(target.userId));
  }

  const available = targets.length;
  const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Number(input.limit) : DEFAULT_CAMPAIGN_LIMIT;
  const truncated = available > limit;
  const batch = targets.slice(0, limit);

  const results: TelegramOnboardingResult[] = [];
  for (const target of batch) {
    results.push(
      await sendTelegramConnectInvite({
        email: target.email,
        force: input.force,
        hrId: target.hrId,
        name: target.name,
        ttlMinutes: input.ttlMinutes,
        userId: target.userId,
      }),
    );
  }

  const sent = results.filter((result) => result.status === "sent").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed").length;

  await writeAuditLog({
    actorLoginId: input.access.loginId ?? input.access.hrId ?? "system",
    entityId: "telegram-onboarding",
    entityType: "notification",
    newValues: { attempted: batch.length, available, failed, sent, skipped, truncated },
    summary: `Telegram connect invitations: ${sent} sent, ${skipped} skipped, ${failed} failed.`,
  });

  return { attempted: batch.length, available, failed, results, sent, skipped, truncated };
}
