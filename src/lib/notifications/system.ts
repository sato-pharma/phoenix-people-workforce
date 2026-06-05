import crypto from "crypto";

import { writeAuditLog } from "@/lib/admin/audit";
import {
  safeSendNotificationEmail,
  type EmailNotificationType,
  type EmailRecipientMode,
  type NotificationEmailInput,
} from "@/lib/notifications/email";
import { sendTelegramNotification } from "@/lib/notifications/telegram";
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
  recipientHrId?: string | null;
  recipientUserId?: string | null;
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
  telegram_enabled?: boolean | null;
};

type TelegramConnectionRow = {
  telegram_chat_id?: string | number | null;
  status?: "pending" | "connected" | "disabled" | "failed" | null;
};

type LoadedPreferences = {
  email_enabled: boolean;
  in_app_enabled: boolean;
  preferred_channel: SystemNotificationChannel;
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
  return "general";
}

function notificationTypeFor(moduleName: string): EmailNotificationType {
  const moduleKey = moduleName.toLowerCase();
  if (moduleKey.includes("probation")) return "probation";
  if (moduleKey.includes("contract")) return "contract_renewal";
  if (moduleKey.includes("birthday")) return "birthday";
  if (moduleKey.includes("offer")) return "offer";
  if (moduleKey.includes("resignation")) return "resignation";
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
    preferred_channel: "email" as SystemNotificationChannel,
    telegram_enabled: false,
  };

  try {
    let query = getSupabaseAdmin()
      .from("notification_preferences")
      .select("email_enabled,in_app_enabled,telegram_enabled,preferred_channel,module_preferences")
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
      preferred_channel: row?.preferred_channel ?? defaults.preferred_channel,
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
  const metadata = {
    ...(input.metadata ?? {}),
    href: input.actionUrl ?? null,
    message: input.message,
    title: input.title,
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
    subject: input.title,
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
        subject: input.title,
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

async function audit(summary: string, input: CreateSystemNotificationInput, eventId: string | null, values?: Record<string, unknown>) {
  await writeAuditLog({
    actorLoginId: input.actorId ?? "system",
    entityId: eventId ?? undefined,
    entityType: "notification",
    newValues: values ?? null,
    summary,
  });
}

export async function createSystemNotification(input: CreateSystemNotificationInput): Promise<SystemNotificationResult> {
  const eventKey = eventKeyFor(input);
  const recipient = await loadRecipientProfile(input);
  const preferences = await loadPreferences({ ...input, recipientHrId: recipient.hrId, recipientUserId: recipient.userId });
  const eventId = await createNotificationEvent(input, eventKey, recipient);
  await audit("notification created", input, eventId, {
    channelPolicy: "unified",
    eventType: input.eventType,
    module: input.module,
    priority: input.priority ?? "normal",
  });

  const channels = basePolicyChannels(input, preferences.preferred_channel);
  const deliveries: SystemNotificationDeliveryResult[] = [];
  let emailAttempted = false;

  for (const channel of channels) {
    const idempotencyKey = `${eventKey}:${channel}:${recipient.userId ?? recipient.hrId ?? "unknown"}`;
    if (await deliveryAlreadySent(idempotencyKey)) {
      deliveries.push({ channel, idempotencyKey, reason: "Delivery already sent.", status: "skipped" });
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

      const emailInput: NotificationEmailInput = {
        ctaHref: input.actionUrl ?? input.email?.ctaHref,
        ctaLabel: input.email?.ctaLabel ?? "Open in Phoenix",
        employeeHrId: recipient.hrId ?? input.email?.employeeHrId ?? undefined,
        includeHrInbox: input.email?.includeHrInbox,
        metrics: input.email?.metrics,
        notificationType: input.email?.notificationType ?? notificationTypeFor(input.module),
        recipients: input.email?.recipients ?? (recipient.email ? [recipient.email] : undefined),
        recipientMode: input.email?.recipientMode ?? (recipient.email ? "candidate" : undefined),
        subject: input.email?.subject ?? input.title,
        summary: input.email?.summary ?? input.message,
        title: input.email?.title ?? input.title,
        tone: input.email?.tone ?? (input.priority === "critical" ? "danger" : "neutral"),
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
        const result = await sendTelegramNotification({
          actionUrl: input.actionUrl ?? "/",
          chatId: String(connection.telegram_chat_id),
          message: telegramMessageFor(input),
          title: input.title,
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
          metadata: { retry: true, fallback: "email_or_in_app" },
          provider: "telegram",
          recipient,
          recipientAddress: String(connection.telegram_chat_id),
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
