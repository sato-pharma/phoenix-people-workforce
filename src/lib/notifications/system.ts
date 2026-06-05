import crypto from "crypto";

import { writeAuditLog } from "@/lib/admin/audit";
import {
  safeSendNotificationEmail,
  type EmailNotificationType,
  type EmailRecipientMode,
  type NotificationEmailInput,
} from "@/lib/notifications/email";
import {
  resolveNotificationPolicy,
  resolveNotificationRecipientsWithGovernance,
  type NotificationRecipientGovernanceWarning,
} from "@/lib/notifications/policy";
import { renderNotificationTemplate } from "@/lib/notifications/templates";
import { sendTelegramNotification } from "@/lib/notifications/telegram";
import { resolveTelegramGovernance } from "@/lib/notifications/telegram-governance";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type SystemNotificationChannel = "in_app" | "email" | "telegram";
export type SystemNotificationPriority = "low" | "normal" | "high" | "critical";

export type CreateSystemNotificationInput = {
  actionUrl?: string | null;
  actorId?: string | null;
  category?: string | null;
  channels?: SystemNotificationChannel[];
  email?: Partial<NotificationEmailInput> & {
    notificationType?: EmailNotificationType;
    recipientMode?: EmailRecipientMode;
  };
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  module: string;
  priority?: SystemNotificationPriority;
  recordId?: string | null;
  recipientHrId?: string | null;
  recipientUserId?: string | null;
  subjectHrId?: string | null;
  telegram?: {
    buttons?: Array<{ label: string; url: string }> | null;
    ctaLabel?: string | null;
    ctaUrl?: string | null;
  };
  title: string;
};

export type SystemNotificationDeliveryResult = {
  channel: SystemNotificationChannel;
  error?: string;
  idempotencyKey: string;
  reason?: string;
  status: "pending" | "sent" | "failed" | "skipped" | "retrying";
};

export type SystemNotificationResult = {
  deliveries: SystemNotificationDeliveryResult[];
  eventId: string | null;
  eventKey: string;
};

type RecipientProfile = {
  email: string | null;
  hrId: string | null;
  name: string | null;
  userId: string | null;
};

type NotificationPreferenceRow = {
  email_enabled?: boolean | null;
  in_app_enabled?: boolean | null;
  module_preferences?: Record<string, unknown> | null;
  preferred_channel?: SystemNotificationChannel | null;
  quiet_hours_end?: string | null;
  quiet_hours_start?: string | null;
  telegram_enabled?: boolean | null;
};

type TelegramConnectionRow = {
  telegram_chat_id?: string | number | null;
  status?: "pending" | "connected" | "disabled" | "failed" | null;
};

type LoadedPreferences = {
  email_enabled: boolean;
  in_app_enabled: boolean;
  module_preferences: Record<string, unknown>;
  preferred_channel: SystemNotificationChannel;
  quiet_hours_end: string | null;
  quiet_hours_start: string | null;
  telegram_enabled: boolean;
};

const sensitivePayrollModules = new Set(["payroll", "payslip", "payslips"]);
const criticalWorkflowModules = new Set([
  "contracts",
  "contract_renewal",
  "excuse",
  "excuses",
  "offers",
  "payroll",
  "payslip",
  "payslips",
  "probation",
  "resignations",
  "vacation",
  "leave",
]);
const systemAnnouncementEvents = new Set(["announcement", "system_announcement"]);

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function cleanHrId(value: string | null | undefined) {
  return cleanText(value).toUpperCase();
}

function schemaMissing(error: unknown, table: string) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes(table.toLowerCase()) ||
    text.includes("could not find the table") ||
    text.includes("schema cache") ||
    text.includes("column") && text.includes("does not exist") ||
    text.includes("42703") ||
    (text.includes("relation") && text.includes("does not exist"))
  );
}

function categoryFor(input: CreateSystemNotificationInput) {
  const explicit = cleanText(input.category).toLowerCase();
  if (explicit) return explicit;

  const moduleName = cleanText(input.module).toLowerCase();
  if (moduleName === "vacation" || moduleName === "leave") return "vacation_request";
  if (moduleName === "excuse" || moduleName === "excuses") return "excuse";
  if (moduleName === "coaching") return "coaching_report";
  if (moduleName === "internal_message" || moduleName === "internal_messages") return "internal_message";
  if (moduleName === "probation") return "probation";
  if (moduleName === "recruitment") return "recruitment";
  if (moduleName === "marketing_requests") return "general";
  return "general";
}

function notificationTypeFor(moduleName: string): EmailNotificationType {
  const moduleKey = moduleName.toLowerCase();
  if (moduleKey.includes("probation")) return "probation";
  if (moduleKey.includes("contract")) return "contract_renewal";
  if (moduleKey.includes("birthday")) return "birthday";
  if (moduleKey.includes("offer")) return "offer";
  if (moduleKey.includes("resignation")) return "resignation";
  if (moduleKey.includes("payroll")) return "general";
  if (moduleKey.includes("password_reset")) return "password_reset";
  if (moduleKey.includes("user_created") || moduleKey.includes("password_setup")) return "user_created";
  return "general";
}

function isSensitivePayroll(input: CreateSystemNotificationInput) {
  const moduleName = cleanText(input.module).toLowerCase();
  const eventType = cleanText(input.eventType).toLowerCase();
  return sensitivePayrollModules.has(moduleName) || eventType.includes("payslip") || input.metadata?.sensitivity === "payroll";
}

function isCriticalWorkflow(input: CreateSystemNotificationInput) {
  if (input.priority === "critical" || input.priority === "high") return true;
  return criticalWorkflowModules.has(cleanText(input.module).toLowerCase());
}

function dedupeChannels(channels: SystemNotificationChannel[]) {
  return Array.from(new Set(channels));
}

function basePolicyChannels(input: CreateSystemNotificationInput, preferred: SystemNotificationChannel) {
  if (input.channels?.length) return dedupeChannels(input.channels);
  const policy = resolveNotificationPolicy(input);
  if (policy.channels.length > 0) {
    const channels = isSensitivePayroll(input) && !policy.telegramGenericOnly
      ? policy.channels.filter((channel) => channel !== "telegram")
      : policy.channels;
    return dedupeChannels(channels.length > 0 ? channels : ["in_app", preferred]);
  }

  if (isSensitivePayroll(input)) {
    return input.metadata?.telegramGenericAllowed === true
      ? ["in_app", "email", "telegram"] satisfies SystemNotificationChannel[]
      : ["in_app", "email"] satisfies SystemNotificationChannel[];
  }

  if (isCriticalWorkflow(input)) return ["in_app", "email", "telegram"] satisfies SystemNotificationChannel[];

  if (systemAnnouncementEvents.has(cleanText(input.eventType).toLowerCase())) {
    return input.metadata?.telegramOptional === true
      ? ["in_app", "email", "telegram"] satisfies SystemNotificationChannel[]
      : ["in_app", "email"] satisfies SystemNotificationChannel[];
  }

  return dedupeChannels(["in_app", preferred]);
}

function eventKeyFor(input: CreateSystemNotificationInput) {
  const metadataKey = typeof input.metadata?.idempotencyKey === "string" ? cleanText(input.metadata.idempotencyKey) : "";
  if (metadataKey) return metadataKey;

  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      actionUrl: input.actionUrl ?? null,
      eventType: input.eventType,
      module: input.module,
      recipientHrId: cleanHrId(input.recipientHrId),
      recipientUserId: cleanText(input.recipientUserId),
      title: input.title,
    }))
    .digest("hex");
}

async function loadRecipientProfile(input: CreateSystemNotificationInput): Promise<RecipientProfile> {
  const userId = cleanText(input.recipientUserId);
  const hrId = cleanHrId(input.recipientHrId);

  try {
    const supabase = getSupabaseAdmin();
    const query = supabase
      .from("app_auth_users")
      .select("login_id,hr_id,name,auth_email")
      .limit(1);
    const { data, error } = userId
      ? await query.ilike("login_id", userId).maybeSingle()
      : hrId
        ? await query.ilike("hr_id", hrId).maybeSingle()
        : { data: null, error: null };

    if (error) throw error;
    const row = data as { auth_email?: string | null; hr_id?: string | null; login_id?: string | null; name?: string | null } | null;
    return {
      email: row?.auth_email ?? null,
      hrId: cleanHrId(row?.hr_id) || hrId || null,
      name: row?.name ?? null,
      userId: row?.login_id ?? (userId || null),
    };
  } catch (error) {
    if (!schemaMissing(error, "app_auth_users")) {
      console.error("Notification recipient profile lookup failed", error);
    }
    return { email: null, hrId: hrId || null, name: null, userId: userId || null };
  }
}

async function loadPreferences(input: CreateSystemNotificationInput): Promise<LoadedPreferences> {
  const userId = cleanText(input.recipientUserId);
  const hrId = cleanHrId(input.recipientHrId);
  const defaults = {
    email_enabled: true,
    in_app_enabled: true,
    module_preferences: {} as Record<string, unknown>,
    preferred_channel: "email" as SystemNotificationChannel,
    quiet_hours_end: null,
    quiet_hours_start: null,
    telegram_enabled: false,
  };

  try {
    let query = getSupabaseAdmin()
      .from("notification_preferences")
      .select("email_enabled,in_app_enabled,telegram_enabled,preferred_channel,module_preferences,quiet_hours_start,quiet_hours_end")
      .limit(1);
    if (userId) query = query.ilike("user_id", userId);
    else if (hrId) query = query.ilike("hr_id", hrId);
    else return defaults;

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    const row = data as NotificationPreferenceRow | null;
    return {
      email_enabled: row?.email_enabled ?? defaults.email_enabled,
      in_app_enabled: row?.in_app_enabled ?? defaults.in_app_enabled,
      module_preferences: row?.module_preferences && typeof row.module_preferences === "object" && !Array.isArray(row.module_preferences)
        ? row.module_preferences
        : defaults.module_preferences,
      preferred_channel: row?.preferred_channel ?? defaults.preferred_channel,
      quiet_hours_end: row?.quiet_hours_end ?? defaults.quiet_hours_end,
      quiet_hours_start: row?.quiet_hours_start ?? defaults.quiet_hours_start,
      telegram_enabled: row?.telegram_enabled ?? defaults.telegram_enabled,
    };
  } catch (error) {
    if (!schemaMissing(error, "notification_preferences")) throw error;
    return defaults;
  }
}

async function loadTelegramConnection(input: CreateSystemNotificationInput) {
  const userId = cleanText(input.recipientUserId);
  const hrId = cleanHrId(input.recipientHrId);
  try {
    let query = getSupabaseAdmin()
      .from("telegram_connections")
      .select("telegram_chat_id,status")
      .order("created_at", { ascending: false })
      .limit(1);
    if (userId) query = query.ilike("user_id", userId);
    else if (hrId) query = query.ilike("hr_id", hrId);
    else return null;

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data as TelegramConnectionRow | null;
  } catch (error) {
    if (!schemaMissing(error, "telegram_connections")) throw error;
    return null;
  }
}

async function createNotificationEvent(input: CreateSystemNotificationInput, eventKey: string, recipient: RecipientProfile) {
  const now = new Date().toISOString();
  const category = categoryFor(input);
  const inAppContent = await renderChannelContent(input, "in_app");
  const metadata = {
    ...(input.metadata ?? {}),
    href: input.actionUrl ?? null,
    message: inAppContent.message,
    title: inAppContent.title,
  };
  const row = {
    action_url: input.actionUrl ?? null,
    actor_id: input.actorId ?? null,
    category,
    employee_hr_id: recipient.hrId,
    event_key: eventKey,
    event_type: input.eventType,
    metadata,
    module: input.module,
    priority: input.priority ?? "normal",
    recipient_user_id: recipient.userId,
    recipients: recipient.hrId ? [recipient.hrId] : [],
    scheduled_for: now.slice(0, 10),
    sent_at: now,
    status: "sent",
    subject: inAppContent.title,
    updated_at: now,
  };

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_events")
      .upsert(row, { onConflict: "event_key" })
      .select("id")
      .single();
    if (error) throw error;
    return String((data as { id?: string | number } | null)?.id ?? "");
  } catch (error) {
    if (!schemaMissing(error, "notification_events")) throw error;

    const { data, error: fallbackError } = await getSupabaseAdmin()
      .from("notification_events")
      .upsert({
        category,
        employee_hr_id: recipient.hrId,
        event_key: eventKey,
        metadata,
        recipients: recipient.hrId ? [recipient.hrId] : [],
        scheduled_for: now.slice(0, 10),
        sent_at: now,
        status: "sent",
        subject: inAppContent.title,
        updated_at: now,
      }, { onConflict: "event_key" })
      .select("id")
      .single();
    if (fallbackError) throw fallbackError;
    return String((data as { id?: string | number } | null)?.id ?? "");
  }
}

async function upsertDelivery(input: {
  channel: SystemNotificationChannel;
  eventId: string | null;
  idempotencyKey: string;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
  nextAttemptAt?: string | null;
  provider?: string | null;
  providerMessageId?: string | null;
  recipient: RecipientProfile;
  recipientAddress?: string | null;
  status: SystemNotificationDeliveryResult["status"];
}) {
  if (!input.eventId) return;
  try {
    const now = new Date().toISOString();
    await getSupabaseAdmin()
      .from("notification_deliveries")
      .upsert({
        channel: input.channel,
        idempotency_key: input.idempotencyKey,
        last_error: input.lastError ?? null,
        metadata: input.metadata ?? {},
        next_attempt_at: input.nextAttemptAt ?? null,
        notification_event_id: input.eventId,
        provider: input.provider ?? input.channel,
        provider_message_id: input.providerMessageId ?? null,
        recipient_address: input.recipientAddress ?? null,
        recipient_hr_id: input.recipient.hrId,
        recipient_user_id: input.recipient.userId,
        sent_at: input.status === "sent" ? now : null,
        status: input.status,
        updated_at: now,
      }, { onConflict: "idempotency_key" });
  } catch (error) {
    if (!schemaMissing(error, "notification_deliveries")) {
      console.error("Notification delivery audit failed", error);
    }
  }
}

async function deliveryAlreadySent(idempotencyKey: string) {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_deliveries")
      .select("status")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    return (data as { status?: string } | null)?.status === "sent";
  } catch (error) {
    if (!schemaMissing(error, "notification_deliveries")) {
      console.error("Notification delivery idempotency check failed", error);
    }
    return false;
  }
}

function telegramMessageFor(input: CreateSystemNotificationInput) {
  if (isSensitivePayroll(input)) return "Your payslip is available.";
  const moduleLabel = cleanText(input.module).replace(/_/g, " ");
  return [
    `Module: ${moduleLabel.charAt(0).toUpperCase()}${moduleLabel.slice(1)}`,
    input.message,
  ].filter(Boolean).join("\n");
}

function timeMinutes(value: string | null | undefined) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function isWithinQuietHours(preferences: LoadedPreferences, now = new Date()) {
  const start = timeMinutes(preferences.quiet_hours_start);
  const end = timeMinutes(preferences.quiet_hours_end);
  if (start === null || end === null || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function modulePreferenceDisabled(preferences: LoadedPreferences, input: CreateSystemNotificationInput, channel: SystemNotificationChannel) {
  const modulePrefs = preferences.module_preferences?.[input.module];
  if (!modulePrefs || typeof modulePrefs !== "object" || Array.isArray(modulePrefs)) return false;
  const value = (modulePrefs as Record<string, unknown>)[channel];
  return value === false;
}

async function renderChannelContent(input: CreateSystemNotificationInput, channel: SystemNotificationChannel) {
  return renderNotificationTemplate({
    actionUrl: input.actionUrl,
    channel,
    eventType: input.eventType,
    fallbackMessage: channel === "telegram" ? telegramMessageFor(input) : input.message,
    fallbackTitle: input.title,
    metadata: input.metadata,
    module: input.module,
  });
}

async function audit(summary: string, input: CreateSystemNotificationInput, eventId: string | null, values?: Record<string, unknown>) {
  await writeAuditLog({
    actorLoginId: input.actorId ?? "system",
    entityId: eventId ?? undefined,
    entityType: "notification",
    newValues: values ?? null,
    summary,
  });
}

async function createGovernanceSkippedNotification(
  input: CreateSystemNotificationInput,
  warnings: NotificationRecipientGovernanceWarning[],
): Promise<SystemNotificationResult> {
  const policy = resolveNotificationPolicy(input);
  const eventKey = eventKeyFor({
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      governanceSkip: true,
    },
  });
  const recipient: RecipientProfile = { email: null, hrId: null, name: null, userId: null };
  const eventId = await createNotificationEvent({
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      governance: {
        failClosed: true,
        warnings,
      },
    },
  }, eventKey, recipient);
  const warningPayload = {
    event: "notification_governance_fail_closed",
    eventId,
    eventType: input.eventType,
    module: input.module,
    recordId: input.recordId ?? null,
    warnings,
  };
  console.warn(JSON.stringify(warningPayload));
  await audit("notification governance fail-closed", input, eventId, warningPayload);

  const channels = dedupeChannels(policy.channels.length > 0 ? policy.channels : ["in_app", "email"]);
  const deliveries: SystemNotificationDeliveryResult[] = [];
  for (const channel of channels) {
    const idempotencyKey = `${eventKey}:${channel}:governance-skip`;
    await upsertDelivery({
      channel,
      eventId,
      idempotencyKey,
      lastError: "Notification skipped because no exact authorized recipient was resolved.",
      metadata: { governance: warningPayload },
      recipient,
      status: "skipped",
    });
    deliveries.push({
      channel,
      idempotencyKey,
      reason: "Notification skipped because no exact authorized recipient was resolved.",
      status: "skipped",
    });
  }

  return { deliveries, eventId, eventKey };
}

function telegramRetryDelayMinutes(attempt: number) {
  const delays = [5, 15, 60, 240];
  return delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)];
}

function nextTelegramRetryAt(attempt: number) {
  const next = new Date();
  next.setMinutes(next.getMinutes() + telegramRetryDelayMinutes(attempt));
  return next.toISOString();
}

export async function processTelegramDeliveryRetries(limit = 10) {
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id,attempts,max_attempts,metadata,status,provider_message_id")
    .eq("channel", "telegram")
    .in("status", ["failed", "pending", "retrying"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 50)));

  if (error) {
    if (schemaMissing(error, "notification_deliveries")) return { attempted: 0, failed: 0, sent: 0 };
    throw error;
  }

  let attempted = 0;
  let failed = 0;
  let sent = 0;

  for (const row of (data ?? []) as Array<{ attempts?: number | null; id: string; max_attempts?: number | null; metadata?: Record<string, unknown> | null }>) {
    const attempts = Number(row.attempts ?? 0);
    const maxAttempts = Number(row.max_attempts ?? 5);
    if (attempts >= maxAttempts) continue;
    const telegram = row.metadata?.telegram as Partial<TelegramRetryPayload> | undefined;
    if (!telegram?.chatId || !telegram?.title || !telegram?.message) continue;

    attempted += 1;
    try {
      const governance = await resolveTelegramGovernance({
        eventType: telegram.eventType ?? null,
        module: telegram.module ?? "system",
      });
      if (!governance.enabled) {
        await supabase
          .from("notification_deliveries")
          .update({
            attempts,
            last_error: governance.reason ?? "Telegram is not allowed by current policy.",
            next_attempt_at: null,
            status: "skipped",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        continue;
      }

      const result = await sendTelegramNotification({
        actionUrl: telegram.actionUrl ?? null,
        buttons: telegram.buttons ?? null,
        chatId: String(telegram.chatId),
        ctaLabel: telegram.ctaLabel ?? null,
        ctaUrl: telegram.ctaUrl ?? null,
        message: governance.genericOnly ? "Your payslip is available." : String(telegram.message),
        title: String(telegram.title),
      });
      if (result.skipped) throw new Error(result.reason);
      await supabase
        .from("notification_deliveries")
        .update({
          attempts: attempts + 1,
          last_error: null,
          next_attempt_at: null,
          provider_message_id: result.providerMessageId ?? null,
          sent_at: new Date().toISOString(),
          status: "sent",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      sent += 1;
    } catch (retryError) {
      const nextAttempts = attempts + 1;
      const terminal = nextAttempts >= maxAttempts;
      await supabase
        .from("notification_deliveries")
        .update({
          attempts: nextAttempts,
          last_error: retryError instanceof Error ? retryError.message : "Telegram retry failed.",
          next_attempt_at: terminal ? null : nextTelegramRetryAt(nextAttempts),
          status: terminal ? "failed" : "retrying",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      failed += 1;
    }
  }

  return { attempted, failed, sent };
}

export async function retryTelegramDeliveryById(id: string): Promise<SystemNotificationDeliveryResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id,attempts,channel,idempotency_key,max_attempts,metadata,recipient_hr_id,recipient_user_id,status")
    .eq("id", id)
    .eq("channel", "telegram")
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    attempts?: number | null;
    id: string;
    idempotency_key?: string | null;
    max_attempts?: number | null;
    metadata?: Record<string, unknown> | null;
    recipient_hr_id?: string | null;
    recipient_user_id?: string | null;
    status?: string | null;
  } | null;
  const idempotencyKey = row?.idempotency_key ?? `telegram-retry:${id}`;
  if (!row) return { channel: "telegram", idempotencyKey, reason: "Delivery was not found.", status: "skipped" };
  if (row.status === "sent") return { channel: "telegram", idempotencyKey, reason: "Delivery already sent.", status: "skipped" };

  const telegram = row.metadata?.telegram as Partial<TelegramRetryPayload> | undefined;
  if (!telegram?.title || !telegram?.message) {
    return { channel: "telegram", idempotencyKey, reason: "Delivery does not contain a retry-safe Telegram payload.", status: "skipped" };
  }

  const governance = await resolveTelegramGovernance({
    eventType: telegram.eventType ?? null,
    module: telegram.module ?? "system",
  });
  if (!governance.enabled) {
    await supabase
      .from("notification_deliveries")
      .update({
        last_error: governance.reason ?? "Telegram is not allowed by current policy.",
        next_attempt_at: null,
        status: "skipped",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, reason: governance.reason, status: "skipped" };
  }

  const preferences = await loadPreferences({
    eventType: telegram.eventType ?? "telegram_retry",
    message: String(telegram.message),
    module: telegram.module ?? "system",
    recipientHrId: row.recipient_hr_id ?? null,
    recipientUserId: row.recipient_user_id ?? null,
    title: String(telegram.title),
  });
  if (!preferences.telegram_enabled) {
    await supabase
      .from("notification_deliveries")
      .update({
        last_error: "Telegram disabled by user preference.",
        next_attempt_at: null,
        status: "skipped",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, reason: "Telegram disabled by user preference.", status: "skipped" };
  }

  const connection = await loadTelegramConnection({
    eventType: telegram.eventType ?? "telegram_retry",
    message: String(telegram.message),
    module: telegram.module ?? "system",
    recipientHrId: row.recipient_hr_id ?? null,
    recipientUserId: row.recipient_user_id ?? null,
    title: String(telegram.title),
  });
  if (connection?.status !== "connected" || !connection.telegram_chat_id) {
    await supabase
      .from("notification_deliveries")
      .update({
        last_error: "Telegram is not connected.",
        next_attempt_at: null,
        status: "skipped",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, reason: "Telegram is not connected.", status: "skipped" };
  }

  const attempts = Number(row.attempts ?? 0);
  const maxAttempts = Number(row.max_attempts ?? 5);
  if (attempts >= maxAttempts) return { channel: "telegram", idempotencyKey, reason: "Maximum retry attempts reached.", status: "skipped" };

  try {
      const result = await sendTelegramNotification({
        actionUrl: telegram.actionUrl ?? null,
        buttons: telegram.buttons ?? null,
        chatId: String(connection.telegram_chat_id),
        ctaLabel: telegram.ctaLabel ?? null,
        ctaUrl: telegram.ctaUrl ?? null,
      message: governance.genericOnly ? "Your payslip is available." : String(telegram.message),
      title: String(telegram.title),
    });
    if (result.skipped) throw new Error(result.reason);
    await supabase
      .from("notification_deliveries")
      .update({
        attempts: attempts + 1,
        last_error: null,
        next_attempt_at: null,
        provider_message_id: result.providerMessageId ?? null,
        sent_at: new Date().toISOString(),
        status: "sent",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, status: "sent" };
  } catch (retryError) {
    const nextAttempts = attempts + 1;
    const message = retryError instanceof Error ? retryError.message : "Telegram retry failed.";
    await supabase
      .from("notification_deliveries")
      .update({
        attempts: nextAttempts,
        last_error: message,
        next_attempt_at: nextAttempts >= maxAttempts ? null : nextTelegramRetryAt(nextAttempts),
        status: nextAttempts >= maxAttempts ? "failed" : "retrying",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", error: message, idempotencyKey, status: nextAttempts >= maxAttempts ? "failed" : "retrying" };
  }
}

type TelegramRetryPayload = {
  actionUrl?: string | null;
  buttons?: Array<{ label: string; url: string }> | null;
  chatId: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  eventType?: string | null;
  message: string;
  module?: string | null;
  title: string;
};

async function createSystemNotificationForRecipient(input: CreateSystemNotificationInput): Promise<SystemNotificationResult> {
  const eventKey = eventKeyFor(input);
  const policy = resolveNotificationPolicy(input);
  const recipient = await loadRecipientProfile(input);
  const preferences = await loadPreferences({ ...input, recipientHrId: recipient.hrId, recipientUserId: recipient.userId });
  const eventId = await createNotificationEvent(input, eventKey, recipient);
  await audit("notification created", input, eventId, {
    channelPolicy: "unified",
    eventType: input.eventType,
    module: input.module,
    priority: input.priority ?? "normal",
  });

  const channels = basePolicyChannels({ ...input, priority: input.priority ?? policy.priority }, preferences.preferred_channel);
  const deliveries: SystemNotificationDeliveryResult[] = [];
  let emailAttempted = false;
  const quietHoursActive = isWithinQuietHours(preferences);

  for (const channel of channels) {
    const idempotencyKey = `${eventKey}:${channel}:${recipient.userId ?? recipient.hrId ?? "unknown"}`;
    if (await deliveryAlreadySent(idempotencyKey)) {
      deliveries.push({ channel, idempotencyKey, reason: "Delivery already sent.", status: "skipped" });
      continue;
    }

    if (modulePreferenceDisabled(preferences, input, channel)) {
      await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Channel disabled by module preference.", recipient, status: "skipped" });
      deliveries.push({ channel, idempotencyKey, reason: "Channel disabled by module preference.", status: "skipped" });
      continue;
    }

    if (quietHoursActive && !policy.bypassQuietHours && channel !== "in_app") {
      await upsertDelivery({
        channel,
        eventId,
        idempotencyKey,
        lastError: "Deferred by quiet hours.",
        metadata: { quietHours: true },
        nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        recipient,
        status: "pending",
      });
      deliveries.push({ channel, idempotencyKey, reason: "Deferred by quiet hours.", status: "pending" });
      continue;
    }

    if (channel === "in_app") {
      const status = preferences.in_app_enabled ? "sent" : "skipped";
      const reason = preferences.in_app_enabled ? undefined : "In-app notifications are disabled for this user.";
      await upsertDelivery({ channel, eventId, idempotencyKey, recipient, status });
      deliveries.push({ channel, idempotencyKey, reason, status });
      continue;
    }

    if (channel === "email") {
      emailAttempted = true;
      if (!preferences.email_enabled) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Email disabled by preference.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Email notifications are disabled for this user.", status: "skipped" });
        continue;
      }

      const emailContent = await renderChannelContent(input, "email");
      const emailInput: NotificationEmailInput = {
        ctaHref: input.actionUrl ?? input.email?.ctaHref,
        ctaLabel: input.email?.ctaLabel ?? "Open in Phoenix",
        employeeHrId: recipient.hrId ?? input.email?.employeeHrId ?? undefined,
        includeHrInbox: input.email?.includeHrInbox,
        metrics: input.email?.metrics,
        notificationType: input.email?.notificationType ?? notificationTypeFor(input.module),
        recipients: input.email?.recipients ?? (recipient.email ? [recipient.email] : undefined),
        recipientMode: input.email?.recipientMode ?? (recipient.email ? "candidate" : undefined),
        subject: input.email?.subject ?? emailContent.title,
        summary: input.email?.summary ?? emailContent.message,
        title: input.email?.title ?? emailContent.title,
        tone: input.email?.tone ?? ((input.priority ?? policy.priority) === "critical" ? "danger" : "neutral"),
      };
      const result = await safeSendNotificationEmail(emailInput);
      const status = result.skipped ? "failed" : "sent";
      const error = result.skipped ? result.reason : undefined;
      await upsertDelivery({
        channel,
        eventId,
        idempotencyKey,
        lastError: error ?? null,
        provider: "email",
        providerMessageId: result.skipped ? null : result.id,
        recipient,
        recipientAddress: recipient.email,
        status,
      });
      await audit(status === "sent" ? "delivery sent" : "delivery failed", input, eventId, { channel, error });
      deliveries.push({ channel, error, idempotencyKey, status });
      continue;
    }

    if (channel === "telegram") {
      const telegramGovernance = await resolveTelegramGovernance({
        eventType: input.eventType,
        module: input.module,
      });
      if (!telegramGovernance.enabled) {
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: telegramGovernance.reason ?? "Telegram is not allowed by current policy.",
          metadata: {
            globalEnabled: telegramGovernance.globalEnabled,
            modulePolicy: telegramGovernance.modulePolicy,
          },
          recipient,
          status: "skipped",
        });
        deliveries.push({
          channel,
          idempotencyKey,
          reason: telegramGovernance.reason ?? "Telegram is not allowed by current policy.",
          status: "skipped",
        });
        continue;
      }

      if (!preferences.telegram_enabled) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Telegram disabled by preference.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Telegram notifications are disabled for this user.", status: "skipped" });
        continue;
      }

      const connection = await loadTelegramConnection({ ...input, recipientHrId: recipient.hrId, recipientUserId: recipient.userId });
      if (connection?.status !== "connected" || !connection.telegram_chat_id) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Telegram is not connected.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Telegram is not connected.", status: "skipped" });
        continue;
      }

      try {
        const telegramContent = await renderChannelContent(input, "telegram");
        const result = await sendTelegramNotification({
          actionUrl: input.actionUrl ?? null,
          buttons: input.telegram?.buttons ?? null,
          chatId: String(connection.telegram_chat_id),
          ctaLabel: input.telegram?.ctaLabel ?? null,
          ctaUrl: input.telegram?.ctaUrl ?? null,
          message: isSensitivePayroll(input) || telegramGovernance.genericOnly ? "Your payslip is available." : telegramContent.message,
          title: telegramContent.title,
        });
        const status = result.skipped ? "skipped" : "sent";
        const reason = result.skipped ? result.reason : undefined;
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: reason ?? null,
          provider: "telegram",
          providerMessageId: result.skipped ? null : result.providerMessageId,
          recipient,
          recipientAddress: String(connection.telegram_chat_id),
          status,
        });
        await audit(status === "sent" ? "delivery sent" : "test notification sent/skipped", input, eventId, { channel, reason });
        deliveries.push({ channel, idempotencyKey, reason, status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Telegram delivery failed.";
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: message,
          metadata: {
            fallback: "email_or_in_app",
            retry: true,
            telegram: {
              actionUrl: input.actionUrl ?? null,
              buttons: input.telegram?.buttons ?? null,
              chatId: String(connection.telegram_chat_id),
              ctaLabel: input.telegram?.ctaLabel ?? null,
              ctaUrl: input.telegram?.ctaUrl ?? null,
              eventType: input.eventType,
              message: isSensitivePayroll(input) || telegramGovernance.genericOnly ? "Your payslip is available." : (await renderChannelContent(input, "telegram")).message,
              module: input.module,
              title: (await renderChannelContent(input, "telegram")).title,
            },
          },
          provider: "telegram",
          recipient,
          recipientAddress: String(connection.telegram_chat_id),
          nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          status: "failed",
        });
        await audit("delivery failed", input, eventId, { channel, error: message, fallback: "email_or_in_app" });
        deliveries.push({ channel, error: message, idempotencyKey, status: "failed" });

        if (!emailAttempted && preferences.email_enabled) {
          const fallback = await createSystemNotification({
            ...input,
            channels: ["email", "in_app"],
            metadata: { ...(input.metadata ?? {}), fallbackFrom: "telegram", idempotencyKey: `${eventKey}:telegram-fallback` },
          });
          deliveries.push(...fallback.deliveries);
        }
      }
    }
  }

  return { deliveries, eventId, eventKey };
}

export async function createSystemNotification(input: CreateSystemNotificationInput): Promise<SystemNotificationResult> {
  const explicitRecipient = cleanText(input.recipientUserId) || cleanHrId(input.recipientHrId);
  if (explicitRecipient) return createSystemNotificationForRecipient(input);

  const resolution = await resolveNotificationRecipientsWithGovernance({
    actorId: input.actorId,
    eventType: input.eventType,
    metadata: input.metadata,
    module: input.module,
    recordId: input.recordId,
    subjectHrId: input.subjectHrId,
  });
  const recipients = resolution.recipients;

  if (recipients.length === 0) return createGovernanceSkippedNotification(input, resolution.warnings);

  const baseIdempotencyKey = typeof input.metadata?.idempotencyKey === "string" ? cleanText(input.metadata.idempotencyKey) : "";
  const results = await Promise.all(
    recipients.map((recipient) =>
      createSystemNotificationForRecipient({
        ...input,
        metadata: {
          ...(input.metadata ?? {}),
          ...(baseIdempotencyKey ? { idempotencyKey: `${baseIdempotencyKey}:${recipient.userId ?? recipient.hrId ?? recipient.email}` } : {}),
        },
        recipientHrId: recipient.hrId ?? null,
        recipientUserId: recipient.userId ?? null,
      }),
    ),
  );

  return {
    deliveries: results.flatMap((result) => result.deliveries),
    eventId: results[0]?.eventId ?? null,
    eventKey: results[0]?.eventKey ?? "",
  };
}
