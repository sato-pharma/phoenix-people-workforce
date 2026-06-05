import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { createSystemNotification } from "@/lib/notifications/system";
import {
  renderTelegramCtaUrl,
  renderTelegramTemplateText,
  validateTelegramCta,
  validateTelegramTemplateText,
} from "@/lib/notifications/telegram-template-placeholders";
import { TelegramTemplateError } from "@/lib/notifications/telegram-template-types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TelegramTemplateWorkflowKey =
  | "birthday"
  | "contract_renewal"
  | "probation"
  | "vacation"
  | "payroll"
  | "general_admin_test";

export type TelegramTemplateDefinition = {
  allowedPlaceholders: string[];
  defaultMessage: string;
  defaultTitle: string;
  eventType: string;
  module: string;
  name: string;
  recommendedPlaceholders: string[];
  sampleVariables: Record<string, string>;
  templateKey: TelegramTemplateWorkflowKey;
};

export type TelegramTemplateView = TelegramTemplateDefinition & {
  isActive: boolean;
  lastUpdated: string | null;
  message: string;
  status: "active" | "inactive";
  title: string;
  ctaEnabled: boolean;
  ctaLabel: string;
  ctaUrl: string;
};

export type TelegramTemplateSaveInput = {
  ctaEnabled: boolean;
  ctaLabel: string;
  ctaUrl: string;
  isActive: boolean;
  message: string;
  templateKey: TelegramTemplateWorkflowKey;
  title: string;
};

const globalPlaceholders = ["employeeName", "employeeHrId", "eventDate", "managerName", "actionUrl", "requestUrl", "employeePortalUrl"];

export const telegramTemplateDefinitions: TelegramTemplateDefinition[] = [
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "Birthday reminder\nEmployee: {{employeeName}}\nHR ID: {{employeeHrId}}\nDate: {{eventDate}}\n\nOpen in Phoenix: {{actionUrl}}",
    defaultTitle: "Birthday Reminder",
    eventType: "birthday",
    module: "birthdays",
    name: "Birthday",
    recommendedPlaceholders: ["employeeName", "eventDate", "actionUrl"],
    sampleVariables: {
      actionUrl: "/admin/employees/EMP001",
      employeeHrId: "EMP001",
      employeeName: "Omar Anwar",
      employeePortalUrl: "/employee-portals/profile",
      eventDate: "15 Jun 2026",
      managerName: "Sara Hassan",
      requestUrl: "/admin/employees/EMP001",
    },
    templateKey: "birthday",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "Contract renewal reminder\nEmployee: {{employeeName}}\nHR ID: {{employeeHrId}}\nDue date: {{eventDate}}\n\nOpen in Phoenix: {{actionUrl}}",
    defaultTitle: "Contract Renewal Reminder",
    eventType: "contract_renewal_reminder",
    module: "contract_renewal",
    name: "Contract Renewal",
    recommendedPlaceholders: ["employeeName", "employeeHrId", "eventDate", "actionUrl"],
    sampleVariables: {
      actionUrl: "/admin/contracts/EMP001",
      employeeHrId: "EMP001",
      employeeName: "Omar Anwar",
      employeePortalUrl: "/employee-portals/profile",
      eventDate: "30 Jun 2026",
      managerName: "Sara Hassan",
      requestUrl: "/admin/contracts/EMP001",
    },
    templateKey: "contract_renewal",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "Probation reminder\nEmployee: {{employeeName}}\nHR ID: {{employeeHrId}}\nManager: {{managerName}}\nDue date: {{eventDate}}\n\nOpen in Phoenix: {{actionUrl}}",
    defaultTitle: "Probation Reminder",
    eventType: "probation_reminder",
    module: "probation",
    name: "Probation",
    recommendedPlaceholders: ["employeeName", "employeeHrId", "managerName", "eventDate", "actionUrl"],
    sampleVariables: {
      actionUrl: "/admin/probation/EMP001",
      employeeHrId: "EMP001",
      employeeName: "Omar Anwar",
      employeePortalUrl: "/employee-portals/probation",
      eventDate: "18 Jun 2026",
      managerName: "Sara Hassan",
      requestUrl: "/admin/probation/EMP001",
    },
    templateKey: "probation",
  },
  {
    allowedPlaceholders: [...globalPlaceholders, "period", "status"],
    defaultMessage: "New vacation request\nEmployee: {{employeeName}}\nPeriod: {{period}}\nStatus: {{status}}\n\nOpen in Phoenix: {{actionUrl}}",
    defaultTitle: "New Vacation Request",
    eventType: "request_submitted",
    module: "vacation",
    name: "Vacation",
    recommendedPlaceholders: ["employeeName", "period", "status", "actionUrl"],
    sampleVariables: {
      actionUrl: "/admin/vacations/REQ-1001",
      employeeHrId: "EMP001",
      employeeName: "Omar Anwar",
      employeePortalUrl: "/employee-portals",
      eventDate: "15 Jun 2026",
      managerName: "Sara Hassan",
      period: "15 Jun 2026 - 18 Jun 2026",
      requestUrl: "/admin/vacations/REQ-1001",
      status: "Pending your approval",
    },
    templateKey: "vacation",
  },
  {
    allowedPlaceholders: ["actionUrl", "employeePortalUrl", "eventDate"],
    defaultMessage: "Your payslip is available.\n\nOpen in Phoenix: {{actionUrl}}",
    defaultTitle: "Payslip Available",
    eventType: "payslip_available",
    module: "payroll",
    name: "Payroll",
    recommendedPlaceholders: ["actionUrl"],
    sampleVariables: {
      actionUrl: "/employee-portals/payroll",
      employeePortalUrl: "/employee-portals/payroll",
      eventDate: "June 2026",
    },
    templateKey: "payroll",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "Phoenix Telegram admin test\nRecipient: {{employeeName}}\nDate: {{eventDate}}\n\nOpen in Phoenix: {{actionUrl}}",
    defaultTitle: "Telegram Admin Test",
    eventType: "telegram_admin_test",
    module: "system",
    name: "General Admin Test",
    recommendedPlaceholders: ["employeeName", "eventDate", "actionUrl"],
    sampleVariables: {
      actionUrl: "/admin/notifications/telegram/templates",
      employeeHrId: "admin-HR",
      employeeName: "Phoenix Admin",
      employeePortalUrl: "/employee-portals",
      eventDate: "5 Jun 2026",
      managerName: "Phoenix",
      requestUrl: "/admin/notifications/telegram/templates",
    },
    templateKey: "general_admin_test",
  },
];

const definitionByKey = new Map(telegramTemplateDefinitions.map((definition) => [definition.templateKey, definition]));

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function actor(access: AccessContext) {
  return access.loginId ?? access.hrId ?? "system";
}

function templatePreviewRunId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function tableMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return text.includes("notification_templates") || text.includes("schema cache") || text.includes("does not exist") || text.includes("could not find the table");
}

function getDefinition(templateKey: string) {
  const definition = definitionByKey.get(templateKey as TelegramTemplateWorkflowKey);
  if (!definition) throw new TelegramTemplateError("unknown_template", "Unknown Telegram template workflow.");
  return definition;
}

type NotificationTemplateRow = {
  is_active?: boolean | null;
  message_template?: string | null;
  metadata?: Record<string, unknown> | null;
  template_key?: string | null;
  title_template?: string | null;
  updated_at?: string | null;
};

async function loadTelegramTemplateRows() {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_templates")
      .select("template_key,title_template,message_template,is_active,metadata,updated_at")
      .eq("channel", "telegram");
    if (error) throw error;
    return new Map(((data ?? []) as NotificationTemplateRow[]).map((row) => [cleanText(row.template_key), row]));
  } catch (error) {
    if (tableMissing(error)) return new Map<string, NotificationTemplateRow>();
    throw error;
  }
}

export async function listTelegramTemplates(): Promise<TelegramTemplateView[]> {
  const rows = await loadTelegramTemplateRows();
  return telegramTemplateDefinitions.map((definition) => {
    const row = rows.get(definition.templateKey);
    const isActive = row?.is_active === true;
    const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const cta = metadata.cta && typeof metadata.cta === "object" && !Array.isArray(metadata.cta)
      ? metadata.cta as Record<string, unknown>
      : {};
    return {
      ...definition,
      ctaEnabled: cta.enabled === true,
      ctaLabel: cleanText(cta.label) || "Open Phoenix",
      ctaUrl: cleanText(cta.url) || "{{actionUrl}}",
      isActive,
      lastUpdated: cleanText(row?.updated_at) || null,
      message: cleanText(row?.message_template) || definition.defaultMessage,
      status: isActive ? "active" : "inactive",
      title: cleanText(row?.title_template) || definition.defaultTitle,
    };
  });
}

export async function saveTelegramTemplate(access: AccessContext, input: TelegramTemplateSaveInput) {
  const definition = getDefinition(input.templateKey);
  const title = cleanText(input.title) || definition.defaultTitle;
  const message = cleanText(input.message);
  const validation = validateTelegramTemplateText(message, definition.allowedPlaceholders);
  const ctaValidation = validateTelegramCta({ ...input, allowedPlaceholders: definition.allowedPlaceholders });
  if (validation.errors.length > 0 || ctaValidation.errors.length > 0) {
    throw new TelegramTemplateError("invalid_template", [...validation.errors, ...ctaValidation.errors].join(" "));
  }

  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("notification_templates")
    .upsert({
      channel: "telegram",
      event_type: definition.eventType,
      is_active: input.isActive,
      message_template: message,
      metadata: {
        allowedPlaceholders: definition.allowedPlaceholders,
        cta: {
          enabled: input.ctaEnabled,
          label: cleanText(input.ctaLabel),
          url: cleanText(input.ctaUrl),
        },
        phase: "telegram_templates",
        recommendedPlaceholders: definition.recommendedPlaceholders,
      },
      module: definition.module,
      template_key: definition.templateKey,
      title_template: title,
      updated_at: now,
    }, { onConflict: "template_key" });
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: actor(access),
    entityId: definition.templateKey,
    entityType: "notification",
    newValues: { ctaEnabled: input.ctaEnabled, isActive: input.isActive, templateKey: definition.templateKey },
    summary: "Telegram template saved.",
  });

  return listTelegramTemplates();
}

export async function renderTelegramTemplate(templateKey: TelegramTemplateWorkflowKey, variables: Record<string, unknown>) {
  const definition = getDefinition(templateKey);
  let row: NotificationTemplateRow | null = null;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_templates")
      .select("title_template,message_template,is_active,metadata")
      .eq("template_key", definition.templateKey)
      .eq("channel", "telegram")
      .maybeSingle();
    if (error) throw error;
    row = data as NotificationTemplateRow | null;
  } catch (error) {
    if (tableMissing(error)) {
      throw new TelegramTemplateError("template_store_missing", "Telegram templates are not available until the notification template table exists.");
    }
    throw error;
  }

  if (!row) throw new TelegramTemplateError("template_missing", "Telegram template is not configured.");
  if (row.is_active !== true) throw new TelegramTemplateError("template_inactive", "Telegram template is inactive.");

  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const cta = metadata.cta && typeof metadata.cta === "object" && !Array.isArray(metadata.cta)
    ? metadata.cta as Record<string, unknown>
    : {};
  const ctaEnabled = cta.enabled === true;
  const ctaValidation = validateTelegramCta({
    allowedPlaceholders: definition.allowedPlaceholders,
    ctaEnabled,
    ctaLabel: cleanText(cta.label),
    ctaUrl: cleanText(cta.url),
  });
  if (ctaValidation.errors.length > 0) throw new TelegramTemplateError("invalid_cta", ctaValidation.errors.join(" "));

  return {
    ctaLabel: ctaEnabled ? cleanText(cta.label) : null,
    ctaUrl: ctaEnabled ? renderTelegramCtaUrl(cleanText(cta.url), variables, definition.allowedPlaceholders) : null,
    message: renderTelegramTemplateText(cleanText(row.message_template), variables, definition.allowedPlaceholders),
    title: cleanText(row.title_template) || definition.defaultTitle,
  };
}

export function previewTelegramTemplate(input: TelegramTemplateSaveInput) {
  const definition = getDefinition(input.templateKey);
  const ctaValidation = validateTelegramCta({ ...input, allowedPlaceholders: definition.allowedPlaceholders });
  if (ctaValidation.errors.length > 0) throw new TelegramTemplateError("invalid_cta", ctaValidation.errors.join(" "));
  return {
    ctaLabel: input.ctaEnabled ? cleanText(input.ctaLabel) : null,
    ctaUrl: input.ctaEnabled ? renderTelegramCtaUrl(input.ctaUrl, definition.sampleVariables, definition.allowedPlaceholders) : null,
    message: renderTelegramTemplateText(input.message, definition.sampleVariables, definition.allowedPlaceholders),
    title: cleanText(input.title) || definition.defaultTitle,
  };
}

export async function sendTelegramTemplateAdminPreview(access: AccessContext, input: TelegramTemplateSaveInput) {
  const definition = getDefinition(input.templateKey);
  const preview = previewTelegramTemplate(input);
  const recipientUserId = actor(access);
  const recipientHrId = access.hrId ?? recipientUserId;
  const result = await createSystemNotification({
    actionUrl: preview.ctaUrl,
    actorId: actor(access),
    channels: ["telegram"],
    eventType: "telegram_template_preview",
    message: preview.message,
    metadata: {
      adminTemplatePreview: true,
      idempotencyKey: `telegram-template-preview:${definition.templateKey}:${recipientUserId}:${templatePreviewRunId()}`,
      templateKey: definition.templateKey,
    },
    module: "system",
    priority: "normal",
    recipientHrId,
    recipientUserId,
    telegram: {
      ctaLabel: preview.ctaLabel,
      ctaUrl: preview.ctaUrl,
    },
    title: `Telegram template preview: ${preview.title}`,
  });

  await writeAuditLog({
    actorLoginId: actor(access),
    entityId: definition.templateKey,
    entityType: "notification",
    newValues: { deliveries: result.deliveries.map((delivery) => ({ channel: delivery.channel, status: delivery.status })) },
    summary: "Telegram template admin preview sent/skipped.",
  });

  return result;
}
