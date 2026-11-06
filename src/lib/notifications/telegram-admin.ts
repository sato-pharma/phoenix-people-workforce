import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { createSystemNotification, retryTelegramDeliveryById } from "@/lib/notifications/system";
import {
  getTelegramWebhookStatus,
  telegramEnvironmentStatus,
  type TelegramEnvironmentStatus,
  type TelegramWebhookStatus,
} from "@/lib/notifications/telegram";
import { TelegramTemplateError } from "@/lib/notifications/telegram-template-types";
import { listTelegramTemplates, renderTelegramTemplate } from "@/lib/notifications/telegram-templates";
import {
  getTelegramGlobalEnabled,
  listTelegramModulePolicies,
  saveTelegramGlobalEnabled,
  saveTelegramModulePolicy,
  type TelegramModulePolicy,
} from "@/lib/notifications/telegram-governance";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

function testRunId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export type TelegramAdminConnection = {
  connectedAt: string | null;
  department: string | null;
  employeeName: string | null;
  hrId: string | null;
  lastDeliveryAt: string | null;
  line: string | null;
  manager: string | null;
  maskedChatId: string | null;
  status: "pending" | "connected" | "disabled" | "failed";
  telegramEnabled: boolean;
  telegramUsername: string | null;
  userId: string;
};

export type TelegramAdminDelivery = {
  attempts: number;
  eventType: string | null;
  id: string;
  lastError: string | null;
  module: string | null;
  nextAttemptAt: string | null;
  providerError: string | null;
  recipient: string | null;
  recipientHrId: string | null;
  sentAt: string | null;
  status: "pending" | "sent" | "failed" | "skipped" | "retrying";
};

export type TelegramAdminAuditLog = {
  actorLoginId: string | null;
  createdAt: string | null;
  entityId: string | null;
  id: string;
  summary: string;
};

export type TelegramAdminSummary = {
  connectedCount: number;
  lastTestAt: string | null;
  lastTestError: string | null;
  lastTestRecipient: string | null;
  lastTestStatus: TelegramAdminDelivery["status"] | "none";
  pendingCount: number;
};

export type TelegramPilotHealth = {
  adminPilotConnected: boolean;
  adminPilotEnabled: boolean;
  connectedEnabledUsersCount: number;
  env: TelegramEnvironmentStatus;
  generalAdminTestTemplateActive: boolean;
  globalCurrentlyOff: boolean;
  safeForAdminPilot: boolean;
  webhook: TelegramWebhookStatus;
  warnings: string[];
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanHrId(value: unknown) {
  return cleanText(value).toUpperCase();
}

function tableMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return text.includes("schema cache") || text.includes("does not exist") || text.includes("could not find the table");
}

export function maskTelegramChatId(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function status(value: unknown): TelegramAdminConnection["status"] {
  return ["pending", "connected", "disabled", "failed"].includes(String(value))
    ? value as TelegramAdminConnection["status"]
    : "failed";
}

function deliveryStatus(value: unknown): TelegramAdminDelivery["status"] {
  return ["pending", "sent", "failed", "skipped", "retrying"].includes(String(value))
    ? value as TelegramAdminDelivery["status"]
    : "failed";
}

function actor(access: AccessContext) {
  return access.loginId ?? access.hrId ?? "system";
}

function adminTestDisplayDate() {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date());
}

function adminTestTemplateVariables(access: AccessContext, recipientUserId: string, recipientHrId: string) {
  const date = adminTestDisplayDate();
  const adminName = cleanText(access.loginId) || cleanText(access.hrId) || "Phoenix Admin";
  const adminHrId = cleanText(access.hrId) || recipientHrId || recipientUserId;
  return {
    actionUrl: "/admin/notifications/telegram",
    approvalStep: "Admin preview",
    approverName: "Phoenix",
    area: "Head Office",
    department: "Administration",
    dueDate: date,
    employeeHrId: adminHrId,
    employeeName: adminName,
    employeePortalUrl: "/employee-portals",
    eventDate: date,
    line: "Administration",
    managerName: "Phoenix",
    moduleName: "Telegram",
    priority: "Normal",
    reason: "Admin-only test",
    recipientHrId,
    recipientName: adminName,
    requesterHrId: adminHrId,
    requesterName: adminName,
    requestId: "TEST-1001",
    requestType: "Admin test",
    requestUrl: "/admin/notifications/telegram",
    role: access.role,
    status: "Preview",
    submittedAt: date,
    team: "Phoenix Admin",
    updatedAt: date,
    workflowName: "Telegram admin test",
  };
}

function adminTemplateErrorMessage(error: TelegramTemplateError) {
  if (error.code === "template_missing") {
    return "General Admin Test Telegram template is not configured. Open Telegram Templates, save it, and mark it active before sending a Control Center test.";
  }
  if (error.code === "template_inactive") {
    return "General Admin Test Telegram template is inactive. Activate it before sending a Control Center test.";
  }
  if (error.code === "template_store_missing") {
    return "Telegram template storage is not available. The notification template table must exist before sending a Control Center test.";
  }
  return `General Admin Test Telegram template is invalid: ${error.message}`;
}

async function resolveGeneralAdminTestTemplateActive() {
  try {
    const templates = await listTelegramTemplates();
    return templates.find((template) => template.templateKey === "general_admin_test")?.isActive === true;
  } catch (error) {
    if (tableMissing(error)) return false;
    throw error;
  }
}

async function getTelegramPilotHealth(input: {
  access?: AccessContext | null;
  connections: TelegramAdminConnection[];
  globalEnabled: boolean;
}): Promise<TelegramPilotHealth> {
  const currentUserId = input.access ? actor(input.access) : "";
  const currentHrId = cleanHrId(input.access?.hrId);
  const adminConnection = input.connections.find((connection) =>
    cleanText(connection.userId) === currentUserId || cleanHrId(connection.hrId) === currentHrId
  );
  const env = telegramEnvironmentStatus();
  const [webhook, generalAdminTestTemplateActive] = await Promise.all([
    getTelegramWebhookStatus(),
    resolveGeneralAdminTestTemplateActive(),
  ]);
  const connectedEnabledUsersCount = input.connections.filter((connection) => connection.status === "connected" && connection.telegramEnabled).length;
  const warnings = [
    ...(!env.telegramBotToken ? ["TELEGRAM_BOT_TOKEN is missing."] : []),
    ...(!env.telegramBotUsername ? ["TELEGRAM_BOT_USERNAME is missing."] : []),
    ...(!env.phoenixAppUrl ? ["PHOENIX_APP_URL is missing."] : []),
    ...(!env.notificationWebhookSecret ? ["NOTIFICATION_WEBHOOK_SECRET is missing."] : []),
    ...(webhook.urlMatchesExpected === false ? ["Telegram webhook URL does not match the expected Phoenix webhook URL."] : []),
    ...(input.globalEnabled ? ["Global Telegram is ON. Keep it OFF outside a short admin pilot test window."] : []),
    ...(!generalAdminTestTemplateActive ? ["General Admin Test template is missing or inactive."] : []),
    ...(!adminConnection || adminConnection.status !== "connected" ? ["Signed-in admin is not connected to Telegram."] : []),
    ...(adminConnection && !adminConnection.telegramEnabled ? ["Signed-in admin has Telegram disabled in notification preferences."] : []),
    ...(connectedEnabledUsersCount > 1 ? ["More than one connected user has Telegram enabled. Keep pilot limited to the admin account."] : []),
  ];

  return {
    adminPilotConnected: adminConnection?.status === "connected",
    adminPilotEnabled: adminConnection?.telegramEnabled === true,
    connectedEnabledUsersCount,
    env,
    generalAdminTestTemplateActive,
    globalCurrentlyOff: !input.globalEnabled,
    safeForAdminPilot: warnings.length === 0,
    webhook,
    warnings,
  };
}

async function lastTelegramDeliveryByRecipient() {
  const out = new Map<string, string>();
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_deliveries")
      .select("recipient_user_id,recipient_hr_id,sent_at,updated_at,status")
      .eq("channel", "telegram")
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const key = cleanText(row.recipient_user_id) || cleanHrId(row.recipient_hr_id);
      if (!key || out.has(key)) continue;
      out.set(key, cleanText(row.sent_at) || cleanText(row.updated_at));
    }
  } catch (error) {
    if (!tableMissing(error)) throw error;
  }
  return out;
}

export async function getTelegramAdminControlCenter(access?: AccessContext | null) {
  const supabase = getSupabaseAdmin();
  const [globalEnabled, policies, directoryResult, lastDeliveries] = await Promise.all([
    getTelegramGlobalEnabled(),
    listTelegramModulePolicies(),
    getEmployeeDirectory().catch(() => null),
    lastTelegramDeliveryByRecipient(),
  ]);
  const employeesByHrId = new Map((directoryResult?.employees ?? []).map((employee) => [cleanHrId(employee.hrId), employee]));

  let connections: TelegramAdminConnection[] = [];
  let deliveries: TelegramAdminDelivery[] = [];
  let auditLogs: TelegramAdminAuditLog[] = [];

  try {
    // Both lists are paged, every row: a cut list hides a connection or reads its Telegram switch as off.
    // A page that fails throws into the catch below, as the old per-read error did.
    const [connectionData, preferencesData] = await Promise.all([
      fetchAllRows<Record<string, unknown>>(
        () =>
          supabase
            .from("telegram_connections")
            .select("user_id,hr_id,telegram_chat_id,telegram_username,status,linked_at,updated_at")
            .order("updated_at", { ascending: false }),
        "id",
      ),
      fetchAllRows<Record<string, unknown>>(
        () => supabase.from("notification_preferences").select("user_id,hr_id,telegram_enabled"),
        "user_id",
      ),
    ]);

    const prefs = new Map(
      preferencesData.map((row) => [
        cleanText(row.user_id) || cleanHrId(row.hr_id),
        row.telegram_enabled === true,
      ]),
    );

    connections = connectionData.map((row) => {
      const userId = cleanText(row.user_id);
      const hrId = cleanHrId(row.hr_id);
      const employee = employeesByHrId.get(hrId);
      return {
        connectedAt: cleanText(row.linked_at) || null,
        department: employee?.departmentName ?? null,
        employeeName: employee?.displayName ?? null,
        hrId: hrId || null,
        lastDeliveryAt: lastDeliveries.get(userId) ?? lastDeliveries.get(hrId) ?? null,
        line: employee?.lineName ?? null,
        manager: employee?.managerName ?? employee?.managerHrId ?? null,
        maskedChatId: maskTelegramChatId(row.telegram_chat_id),
        status: status(row.status),
        telegramEnabled: prefs.get(userId) ?? prefs.get(hrId) ?? false,
        telegramUsername: cleanText(row.telegram_username) || null,
        userId,
      };
    });
  } catch (error) {
    if (!tableMissing(error)) throw error;
  }

  try {
    const { data, error } = await supabase
      .from("notification_deliveries")
      .select("id,attempts,last_error,next_attempt_at,recipient_hr_id,recipient_user_id,sent_at,status,updated_at,notification_events(module,event_type)")
      .eq("channel", "telegram")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    deliveries = ((data ?? []) as Record<string, unknown>[]).map((row) => {
      const event = row.notification_events as Record<string, unknown> | null;
      const hrId = cleanHrId(row.recipient_hr_id);
      const employee = employeesByHrId.get(hrId);
      const lastError = cleanText(row.last_error) || null;
      return {
        attempts: Number(row.attempts ?? 0),
        eventType: cleanText(event?.event_type) || null,
        id: cleanText(row.id),
        lastError,
        module: cleanText(event?.module) || null,
        nextAttemptAt: cleanText(row.next_attempt_at) || null,
        providerError: lastError,
        recipient: employee?.displayName ?? cleanText(row.recipient_user_id) ?? hrId ?? null,
        recipientHrId: hrId || null,
        sentAt: cleanText(row.sent_at) || null,
        status: deliveryStatus(row.status),
      };
    });
  } catch (error) {
    if (!tableMissing(error)) throw error;
  }

  try {
    // Structured DB-level filter (case-insensitive) instead of regex over a capped
    // 100-row page: matches telegram entity_ids or any summary mentioning Telegram, so
    // history isn't silently truncated and the filter runs before the 25-row limit.
    const { data, error } = await supabase
      .from("audit_logs")
      .select("id,actor_login_id,entity_id,summary,created_at")
      .eq("entity_type", "notification")
      .or("summary.ilike.*telegram*,entity_id.ilike.telegram*")
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw error;
    auditLogs = ((data ?? []) as Record<string, unknown>[])
      .map((row) => ({
        actorLoginId: cleanText(row.actor_login_id) || null,
        createdAt: cleanText(row.created_at) || null,
        entityId: cleanText(row.entity_id) || null,
        id: cleanText(row.id),
        summary: cleanText(row.summary) || "Telegram audit event",
      }));
  } catch (error) {
    if (!tableMissing(error)) throw error;
  }

  const lastTest = deliveries.find((delivery) => delivery.eventType === "telegram_admin_test" || delivery.eventType === "telegram_test");
  const summary: TelegramAdminSummary = {
    connectedCount: connections.filter((connection) => connection.status === "connected").length,
    lastTestAt: lastTest?.sentAt ?? null,
    lastTestError: lastTest?.lastError ?? null,
    lastTestRecipient: lastTest?.recipient ?? lastTest?.recipientHrId ?? null,
    lastTestStatus: lastTest?.status ?? "none",
    pendingCount: connections.filter((connection) => connection.status === "pending").length,
  };

  const pilotHealth = await getTelegramPilotHealth({ access, connections, globalEnabled });

  return { auditLogs, connections, deliveries, globalEnabled, pilotHealth, policies, summary };
}

async function safeWriteAuditLog(input: Parameters<typeof writeAuditLog>[0], context: string) {
  try {
    await writeAuditLog(input);
  } catch (error) {
    // An audit failure must never break the governance action it records.
    logError(`Telegram audit log failed (${context})`, {
      labels: { event: "telegram_audit_log_failed", context },
      error,
    });
  }
}

export async function setTelegramGlobalSwitch(access: AccessContext, enabled: boolean) {
  let previous: boolean | null = null;
  try {
    previous = await getTelegramGlobalEnabled();
  } catch {
    previous = null;
  }
  const value = await saveTelegramGlobalEnabled(enabled);
  await safeWriteAuditLog({
    actorLoginId: actor(access),
    entityId: "telegram",
    entityType: "notification",
    newValues: { enabled },
    oldValues: { enabled: previous },
    summary: "Global Telegram switch changed.",
  }, "global_switch");
  return value;
}

export async function updateTelegramPolicy(access: AccessContext, input: TelegramModulePolicy) {
  let previous: TelegramModulePolicy | null = null;
  try {
    const policies = await listTelegramModulePolicies();
    previous = policies.find((policy) => policy.module === input.module) ?? null;
  } catch {
    previous = null;
  }
  await saveTelegramModulePolicy(input);
  await safeWriteAuditLog({
    actorLoginId: actor(access),
    entityId: `telegram:module:${input.module}`,
    entityType: "notification",
    newValues: input,
    oldValues: previous ?? undefined,
    summary: "Telegram module policy changed.",
  }, "module_policy");
}

export async function adminDisableTelegram(access: AccessContext, userId: string) {
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("telegram_connections")
    .update({
      disabled_at: now,
      failure_reason: "Disabled by Telegram admin.",
      status: "disabled",
      updated_at: now,
    })
    .eq("user_id", userId);
  if (error) throw error;
  await supabase
    .from("notification_preferences")
    .upsert({ telegram_enabled: false, updated_at: now, user_id: userId }, { onConflict: "user_id" });
  await writeAuditLog({
    actorLoginId: actor(access),
    entityId: userId,
    entityType: "notification",
    summary: "Telegram disabled by admin.",
  });
}

export async function adminDisconnectTelegram(access: AccessContext, userId: string) {
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("telegram_connections")
    .update({
      disabled_at: now,
      failure_reason: "Disconnected by Telegram admin.",
      status: "disabled",
      telegram_chat_id: null,
      updated_at: now,
    })
    .eq("user_id", userId);
  if (error) throw error;
  await supabase
    .from("notification_preferences")
    .upsert({ telegram_enabled: false, updated_at: now, user_id: userId }, { onConflict: "user_id" });
  await writeAuditLog({
    actorLoginId: actor(access),
    entityId: userId,
    entityType: "notification",
    summary: "Telegram disconnected by admin.",
  });
}

export async function adminSendTelegramTest(access: AccessContext) {
  const recipientUserId = actor(access);
  const recipientHrId = access.hrId ?? recipientUserId;
  let rendered: Awaited<ReturnType<typeof renderTelegramTemplate>>;
  try {
    rendered = await renderTelegramTemplate("general_admin_test", adminTestTemplateVariables(access, recipientUserId, recipientHrId));
  } catch (error) {
    if (error instanceof TelegramTemplateError) {
      throw new Error(adminTemplateErrorMessage(error));
    }
    throw error;
  }

  const result = await createSystemNotification({
    actionUrl: rendered.ctaUrl ?? rendered.buttons[0]?.url ?? "/admin/notifications/telegram",
    actorId: actor(access),
    channels: ["telegram"],
    eventType: "telegram_admin_test",
    message: rendered.message,
    metadata: {
      adminTest: true,
      idempotencyKey: `telegram-admin-test:${recipientUserId}:${testRunId()}`,
      templateKey: "general_admin_test",
      templateRendered: true,
    },
    module: "system",
    priority: "normal",
    recipientHrId,
    recipientUserId,
    telegram: {
      buttons: rendered.buttons,
      ctaLabel: rendered.ctaLabel,
      ctaUrl: rendered.ctaUrl,
    },
    title: rendered.title,
  });
  await writeAuditLog({
    actorLoginId: actor(access),
    entityId: recipientUserId,
    entityType: "notification",
    newValues: {
      deliveries: result.deliveries.map((delivery) => ({ channel: delivery.channel, status: delivery.status })),
      templateKey: "general_admin_test",
      templateRendered: true,
    },
    summary: "Telegram template-based test notification sent/skipped.",
  });
  return result;
}

export async function adminRetryTelegramDelivery(access: AccessContext, deliveryId: string) {
  const result = await retryTelegramDeliveryById(deliveryId);
  await writeAuditLog({
    actorLoginId: actor(access),
    entityId: deliveryId,
    entityType: "notification",
    newValues: { status: result.status },
    summary: "Telegram failed notification retried.",
  });
  return result;
}
