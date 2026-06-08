import crypto from "crypto";

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { buildTelegramDeepLinkFromToken, hashTelegramToken } from "@/lib/notifications/telegram";

export type NotificationPreferences = {
  emailEnabled: boolean;
  inAppEnabled: boolean;
  modulePreferences: Record<string, unknown>;
  preferredChannel: "in_app" | "email" | "telegram";
  quietHoursEnd: string | null;
  quietHoursStart: string | null;
  telegramEnabled: boolean;
};

export type TelegramConnectionState = {
  connectedAt: string | null;
  status: "pending" | "connected" | "disabled" | "failed" | "not_connected";
  telegramUsername: string | null;
};

export type NotificationSettings = {
  preferences: NotificationPreferences;
  telegram: TelegramConnectionState;
};

const defaultPreferences: NotificationPreferences = {
  emailEnabled: true,
  inAppEnabled: true,
  modulePreferences: {},
  preferredChannel: "email",
  quietHoursEnd: null,
  quietHoursStart: null,
  telegramEnabled: false,
};

function userIdFromAccess(access: Pick<AccessContext, "hrId" | "loginId">) {
  return access.loginId ?? access.hrId ?? "";
}

function tableMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return text.includes("does not exist") || text.includes("schema cache") || text.includes("notification_preferences") || text.includes("telegram_connections");
}

function mapPreferences(row: Record<string, unknown> | null | undefined): NotificationPreferences {
  return {
    emailEnabled: row?.email_enabled !== false,
    inAppEnabled: row?.in_app_enabled !== false,
    modulePreferences: row?.module_preferences && typeof row.module_preferences === "object" && !Array.isArray(row.module_preferences)
      ? row.module_preferences as Record<string, unknown>
      : {},
    preferredChannel: ["in_app", "email", "telegram"].includes(String(row?.preferred_channel))
      ? row?.preferred_channel as NotificationPreferences["preferredChannel"]
      : "email",
    quietHoursEnd: typeof row?.quiet_hours_end === "string" ? row.quiet_hours_end : null,
    quietHoursStart: typeof row?.quiet_hours_start === "string" ? row.quiet_hours_start : null,
    telegramEnabled: row?.telegram_enabled === true,
  };
}

function mapTelegram(row: Record<string, unknown> | null | undefined): TelegramConnectionState {
  if (!row) return { connectedAt: null, status: "not_connected", telegramUsername: null };
  const status = ["pending", "connected", "disabled", "failed"].includes(String(row.status))
    ? row.status as TelegramConnectionState["status"]
    : "failed";
  return {
    connectedAt: typeof row.linked_at === "string" ? row.linked_at : null,
    status,
    telegramUsername: typeof row.telegram_username === "string" ? row.telegram_username : null,
  };
}

export async function getNotificationSettings(access: Pick<AccessContext, "hrId" | "loginId">): Promise<NotificationSettings> {
  const userId = userIdFromAccess(access);
  if (!userId) return { preferences: defaultPreferences, telegram: mapTelegram(null) };

  try {
    const supabase = getSupabaseAdmin();
    const [preferences, telegram] = await Promise.all([
      supabase.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle(),
      supabase
        .from("telegram_connections")
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (preferences.error) throw preferences.error;
    if (telegram.error) throw telegram.error;
    return {
      preferences: mapPreferences(preferences.data as Record<string, unknown> | null),
      telegram: mapTelegram(telegram.data as Record<string, unknown> | null),
    };
  } catch (error) {
    if (tableMissing(error)) return { preferences: defaultPreferences, telegram: mapTelegram(null) };
    throw error;
  }
}

export async function saveNotificationPreferences(
  access: Pick<AccessContext, "hrId" | "loginId">,
  input: Partial<Pick<NotificationPreferences, "emailEnabled" | "inAppEnabled" | "preferredChannel" | "quietHoursEnd" | "quietHoursStart" | "telegramEnabled">>,
) {
  const userId = userIdFromAccess(access);
  if (!userId) throw new Error("Authentication is required.");

  const payload = {
    email_enabled: input.emailEnabled,
    hr_id: access.hrId ?? null,
    in_app_enabled: input.inAppEnabled,
    preferred_channel: input.preferredChannel,
    quiet_hours_end: input.quietHoursEnd || null,
    quiet_hours_start: input.quietHoursStart || null,
    telegram_enabled: input.telegramEnabled,
    updated_at: new Date().toISOString(),
    user_id: userId,
  };

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("notification_preferences")
    .upsert(payload, { onConflict: "user_id" });
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: access.loginId ?? userId,
    entityId: userId,
    entityType: "notification",
    newValues: payload,
    summary: "Notification preferences updated.",
  });

  return getNotificationSettings(access);
}

export async function createTelegramConnectionToken(access: Pick<AccessContext, "hrId" | "loginId">) {
  const userId = userIdFromAccess(access);
  if (!userId) throw new Error("Authentication is required.");

  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + 15 * 60 * 1000);
  const supabase = getSupabaseAdmin();
  const existing = await supabase
    .from("telegram_connections")
    .select("id")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;

  const payload = {
    connect_token_expires_at: expires.toISOString(),
    connect_token_hash: hashTelegramToken(token),
    connect_token_used_at: null,
    disabled_at: null,
    failure_reason: null,
    hr_id: access.hrId ?? null,
    status: "pending",
    telegram_chat_id: null,
    updated_at: now.toISOString(),
    user_id: userId,
  };

  const result = existing.data?.id
    ? await supabase.from("telegram_connections").update(payload).eq("id", existing.data.id)
    : await supabase.from("telegram_connections").insert(payload);
  if (result.error) throw result.error;

  await writeAuditLog({
    actorLoginId: access.loginId ?? userId,
    entityId: userId,
    entityType: "notification",
    summary: "Telegram connection token created.",
  });

  return {
    expiresAt: expires.toISOString(),
    link: await buildTelegramDeepLinkFromToken(token),
    token,
  };
}

export async function linkTelegramConnection(input: {
  chatId: string;
  telegramUsername?: string | null;
  token: string;
}) {
  const tokenHash = hashTelegramToken(input.token);
  const now = new Date();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("telegram_connections")
    .select("*")
    .eq("connect_token_hash", tokenHash)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Telegram connection token is invalid.");
  const row = data as Record<string, unknown>;
  if (row.connect_token_used_at) throw new Error("Telegram connection token was already used.");
  if (row.connect_token_expires_at && new Date(String(row.connect_token_expires_at)).getTime() < now.getTime()) {
    await supabase
      .from("telegram_connections")
      .update({ failure_reason: "Token expired.", status: "failed", updated_at: now.toISOString() })
      .eq("id", row.id);
    throw new Error("Telegram connection token expired.");
  }

  const { error: updateError } = await supabase
    .from("telegram_connections")
    .update({
      connect_token_used_at: now.toISOString(),
      failure_reason: null,
      linked_at: now.toISOString(),
      status: "connected",
      telegram_chat_id: input.chatId,
      telegram_username: input.telegramUsername ?? null,
      updated_at: now.toISOString(),
    })
    .eq("id", row.id);
  if (updateError) throw updateError;

  await supabase
    .from("notification_preferences")
    .upsert({
      hr_id: row.hr_id ?? null,
      telegram_enabled: true,
      updated_at: now.toISOString(),
      user_id: row.user_id,
    }, { onConflict: "user_id" });

  await writeAuditLog({
    actorLoginId: String(row.user_id ?? "telegram"),
    entityId: String(row.user_id ?? ""),
    entityType: "notification",
    newValues: { telegramUsername: input.telegramUsername ?? null },
    summary: "Telegram linked.",
  });

  return { ok: true };
}

export async function disconnectTelegram(access: Pick<AccessContext, "hrId" | "loginId">) {
  const userId = userIdFromAccess(access);
  if (!userId) throw new Error("Authentication is required.");
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("telegram_connections")
    .update({
      disabled_at: now,
      status: "disabled",
      telegram_chat_id: null,
      updated_at: now,
    })
    .eq("user_id", userId);
  if (error) throw error;

  await supabase
    .from("notification_preferences")
    .upsert({
      hr_id: access.hrId ?? null,
      telegram_enabled: false,
      updated_at: now,
      user_id: userId,
    }, { onConflict: "user_id" });

  await writeAuditLog({
    actorLoginId: access.loginId ?? userId,
    entityId: userId,
    entityType: "notification",
    summary: "Telegram unlinked.",
  });

  return getNotificationSettings(access);
}

export async function disableTelegramForIdentity(input: {
  actorLoginId?: string | null;
  hrId?: string | null;
  reason?: string | null;
  userId?: string | null;
}) {
  const userId = userIdFromAccess({ hrId: input.hrId ?? null, loginId: input.userId ?? null });
  const hrId = input.hrId ?? null;
  if (!userId && !hrId) return { skipped: true as const };

  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  try {
    let query = supabase
      .from("telegram_connections")
      .update({
        disabled_at: now,
        failure_reason: input.reason ?? "User or employee was deactivated.",
        status: "disabled",
        telegram_chat_id: null,
        updated_at: now,
      });
    query = userId ? query.eq("user_id", userId) : query.eq("hr_id", hrId);
    const { error } = await query;
    if (error) throw error;

    await supabase
      .from("notification_preferences")
      .upsert({
        hr_id: hrId,
        telegram_enabled: false,
        updated_at: now,
        user_id: userId ?? hrId,
      }, { onConflict: "user_id" });

    await writeAuditLog({
      actorLoginId: input.actorLoginId ?? "system",
      entityId: userId ?? hrId ?? "",
      entityType: "notification",
      summary: "Telegram disabled during deactivation.",
    });

    return { skipped: false as const };
  } catch (error) {
    if (tableMissing(error)) return { reason: "Telegram notification tables unavailable.", skipped: true as const };
    throw error;
  }
}
