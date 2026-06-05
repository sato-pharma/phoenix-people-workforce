import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { createSystemNotification } from "@/lib/notifications/system";
import {
  renderTelegramCtaUrl,
  renderTelegramTemplateText,
  validateTelegramCta,
  validateTelegramTemplateButtons,
  validateTelegramTemplateText,
  type TelegramTemplateButtonInput,
  type TelegramTemplateButtonType,
} from "@/lib/notifications/telegram-template-placeholders";
import { TelegramTemplateError } from "@/lib/notifications/telegram-template-types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TelegramTemplateWorkflowKey =
  | "birthday"
  | "anniversary"
  | "contract_renewal"
  | "probation"
  | "vacation"
  | "outstation"
  | "payroll"
  | "general_admin_test";

export type TelegramTemplateButton = {
  enabled: boolean;
  label: string;
  type: TelegramTemplateButtonType;
  url: string;
};

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
  buttons: TelegramTemplateButton[];
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
  buttons?: TelegramTemplateButton[];
  ctaEnabled: boolean;
  ctaLabel: string;
  ctaUrl: string;
  isActive: boolean;
  message: string;
  templateKey: TelegramTemplateWorkflowKey;
  title: string;
};

const identityPlaceholders = [
  "employeeName",
  "employeeHrId",
  "recipientName",
  "recipientHrId",
  "requesterName",
  "requesterHrId",
  "managerName",
  "approverName",
];
const organizationPlaceholders = ["department", "line", "area", "team", "role"];
const workflowPlaceholders = [
  "eventDate",
  "dueDate",
  "submittedAt",
  "updatedAt",
  "requestId",
  "requestType",
  "workflowName",
  "moduleName",
  "approvalStep",
  "priority",
  "status",
  "period",
  "location",
  "reason",
];
const linkPlaceholders = ["actionUrl", "requestUrl", "employeePortalUrl"];
const globalPlaceholders = [
  ...identityPlaceholders,
  ...organizationPlaceholders,
  ...workflowPlaceholders,
  ...linkPlaceholders,
];

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
      approvalStep: "HR review",
      approverName: "Sara Hassan",
      area: "Cairo",
      department: "People",
      dueDate: "15 Jun 2026",
      employeeHrId: "EMP001",
      employeeName: "Omar Anwar",
      employeePortalUrl: "/employee-portals/profile",
      eventDate: "15 Jun 2026",
      line: "Sales",
      managerName: "Sara Hassan",
      moduleName: "Birthdays",
      priority: "Normal",
      reason: "Birthday reminder",
      recipientHrId: "admin-HR",
      recipientName: "Phoenix Admin",
      requesterHrId: "EMP001",
      requesterName: "Omar Anwar",
      requestId: "BD-1001",
      requestUrl: "/admin/employees/EMP001",
      requestType: "Birthday",
      role: "HR Manager",
      status: "Scheduled",
      submittedAt: "14 Jun 2026",
      team: "HR Operations",
      updatedAt: "15 Jun 2026",
      workflowName: "Birthday reminder",
    },
    templateKey: "birthday",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "Work anniversary reminder\nEmployee: {{employeeName}}\nHR ID: {{employeeHrId}}\nDate: {{eventDate}}\n\nOpen in Phoenix: {{actionUrl}}",
    defaultTitle: "Work Anniversary Reminder",
    eventType: "anniversary_today",
    module: "anniversary",
    name: "Anniversary",
    recommendedPlaceholders: ["employeeName", "eventDate", "actionUrl"],
    sampleVariables: {
      actionUrl: "/admin/employees/EMP001",
      approvalStep: "HR review",
      approverName: "Sara Hassan",
      area: "Cairo",
      department: "People",
      dueDate: "15 Jun 2026",
      employeeHrId: "EMP001",
      employeeName: "Omar Anwar",
      employeePortalUrl: "/employee-portals/profile",
      eventDate: "15 Jun 2026",
      line: "Sales",
      managerName: "Sara Hassan",
      moduleName: "Anniversary",
      priority: "Normal",
      reason: "Work anniversary reminder",
      recipientHrId: "admin-HR",
      recipientName: "Phoenix Admin",
      requesterHrId: "EMP001",
      requesterName: "Omar Anwar",
      requestId: "ANN-1001",
      requestUrl: "/admin/employees/EMP001",
      requestType: "Work anniversary",
      role: "HR Manager",
      status: "Scheduled",
      submittedAt: "14 Jun 2026",
      team: "HR Operations",
      updatedAt: "15 Jun 2026",
      workflowName: "Work anniversary reminder",
    },
    templateKey: "anniversary",
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
      approvalStep: "Manager review",
      approverName: "Sara Hassan",
      area: "Cairo",
      department: "Sales",
      dueDate: "30 Jun 2026",
      employeeHrId: "EMP001",
      employeeName: "Omar Anwar",
      employeePortalUrl: "/employee-portals/profile",
      eventDate: "30 Jun 2026",
      line: "Sales",
      managerName: "Sara Hassan",
      moduleName: "Contract Renewal",
      priority: "Critical",
      reason: "Contract renewal due",
      recipientHrId: "DSM001",
      recipientName: "Sara Hassan",
      requesterHrId: "EMP001",
      requesterName: "Omar Anwar",
      requestId: "CON-1001",
      requestUrl: "/admin/contracts/EMP001",
      requestType: "Contract renewal",
      role: "District Sales Manager",
      status: "Pending review",
      submittedAt: "1 Jun 2026",
      team: "Cairo East",
      updatedAt: "10 Jun 2026",
      workflowName: "Contract renewal",
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
      approvalStep: "Manager decision",
      approverName: "Sara Hassan",
      area: "Cairo",
      department: "Sales",
      dueDate: "18 Jun 2026",
      employeeHrId: "EMP001",
      employeeName: "Omar Anwar",
      employeePortalUrl: "/employee-portals/probation",
      eventDate: "18 Jun 2026",
      line: "Sales",
      managerName: "Sara Hassan",
      moduleName: "Probation",
      priority: "Critical",
      reason: "Probation decision due",
      recipientHrId: "DSM001",
      recipientName: "Sara Hassan",
      requesterHrId: "EMP001",
      requesterName: "Omar Anwar",
      requestId: "PROB-1001",
      requestUrl: "/admin/probation/EMP001",
      requestType: "Probation",
      role: "District Sales Manager",
      status: "Pending decision",
      submittedAt: "1 Mar 2026",
      team: "Cairo East",
      updatedAt: "10 Jun 2026",
      workflowName: "Probation decision",
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
      approvalStep: "Direct manager review",
      approverName: "Sara Hassan",
      area: "Cairo",
      department: "Sales",
      dueDate: "12 Jun 2026",
      employeeHrId: "EMP001",
      employeeName: "Omar Anwar",
      employeePortalUrl: "/employee-portals",
      eventDate: "15 Jun 2026",
      line: "Sales",
      managerName: "Sara Hassan",
      moduleName: "Vacation",
      priority: "Critical",
      reason: "Annual leave",
      recipientHrId: "DSM001",
      recipientName: "Sara Hassan",
      requesterHrId: "EMP001",
      requesterName: "Omar Anwar",
      period: "15 Jun 2026 - 18 Jun 2026",
      requestId: "REQ-1001",
      requestUrl: "/admin/vacations/REQ-1001",
      requestType: "Vacation request",
      role: "District Sales Manager",
      status: "Pending your approval",
      submittedAt: "10 Jun 2026",
      team: "Cairo East",
      updatedAt: "10 Jun 2026",
      workflowName: "Vacation approval",
    },
    templateKey: "vacation",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "Outstation request\nEmployee: {{employeeName}}\nRequest: {{requestId}}\nStatus: {{status}}\n\nOpen in Phoenix: {{actionUrl}}",
    defaultTitle: "Outstation Request",
    eventType: "request_submitted",
    module: "outstation",
    name: "Outstation",
    recommendedPlaceholders: ["employeeName", "requestId", "status", "actionUrl"],
    sampleVariables: {
      actionUrl: "/admin/outstation/requests",
      approvalStep: "Finance review",
      approverName: "Mona Adel",
      area: "Alexandria",
      department: "Sales",
      dueDate: "20 Jun 2026",
      employeeHrId: "EMP001",
      employeeName: "Omar Anwar",
      employeePortalUrl: "/employee-portals/expenses",
      eventDate: "18 Jun 2026",
      line: "Sales",
      location: "Alexandria",
      managerName: "Sara Hassan",
      moduleName: "Outstation",
      priority: "High",
      reason: "Field visit",
      recipientHrId: "FIN001",
      recipientName: "Mona Adel",
      requesterHrId: "EMP001",
      requesterName: "Omar Anwar",
      requestId: "OUT-1001",
      requestUrl: "/admin/outstation/requests",
      requestType: "Outstation request",
      role: "Finance Manager",
      status: "Pending review",
      submittedAt: "18 Jun 2026",
      team: "Cairo East",
      updatedAt: "18 Jun 2026",
      workflowName: "Outstation review",
    },
    templateKey: "outstation",
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
      approvalStep: "Admin preview",
      approverName: "Phoenix",
      area: "Head Office",
      department: "Administration",
      dueDate: "5 Jun 2026",
      employeeHrId: "admin-HR",
      employeeName: "Phoenix Admin",
      employeePortalUrl: "/employee-portals",
      eventDate: "5 Jun 2026",
      line: "Administration",
      managerName: "Phoenix",
      moduleName: "Telegram",
      priority: "Normal",
      reason: "Admin-only test",
      recipientHrId: "admin-HR",
      recipientName: "Phoenix Admin",
      requesterHrId: "admin-HR",
      requesterName: "Phoenix Admin",
      requestId: "TEST-1001",
      requestUrl: "/admin/notifications/telegram/templates",
      requestType: "Admin test",
      role: "Super Admin",
      status: "Preview",
      submittedAt: "5 Jun 2026",
      team: "Phoenix Admin",
      updatedAt: "5 Jun 2026",
      workflowName: "Telegram admin test",
    },
    templateKey: "general_admin_test",
  },
];

const definitionByKey = new Map(telegramTemplateDefinitions.map((definition) => [definition.templateKey, definition]));
const defaultButton: TelegramTemplateButton = {
  enabled: false,
  label: "Open Phoenix",
  type: "open_phoenix",
  url: "{{actionUrl}}",
};

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

function cleanButtonType(value: unknown): TelegramTemplateButtonType {
  const text = cleanText(value);
  return text === "open_phoenix" || text === "view_details" || text === "custom" ? text : "custom";
}

function cleanButton(input: TelegramTemplateButtonInput | Record<string, unknown> | null | undefined): TelegramTemplateButton {
  return {
    enabled: input?.enabled !== false,
    label: cleanText(input?.label) || "Open Phoenix",
    type: cleanButtonType(input?.type),
    url: cleanText(input?.url) || "{{actionUrl}}",
  };
}

function buttonsFromMetadata(metadata: Record<string, unknown>) {
  if (Array.isArray(metadata.buttons)) {
    const buttons = metadata.buttons
      .filter((button): button is Record<string, unknown> => Boolean(button) && typeof button === "object" && !Array.isArray(button))
      .map(cleanButton)
      .slice(0, 3);
    return buttons.length > 0 ? buttons : [defaultButton];
  }

  const cta = metadata.cta && typeof metadata.cta === "object" && !Array.isArray(metadata.cta)
    ? metadata.cta as Record<string, unknown>
    : {};
  if (Object.keys(cta).length > 0) {
    return [{
      enabled: cta.enabled === true,
      label: cleanText(cta.label) || "Open Phoenix",
      type: "open_phoenix" as const,
      url: cleanText(cta.url) || "{{actionUrl}}",
    }];
  }

  return [defaultButton];
}

function enabledButtons(buttons: TelegramTemplateButton[]) {
  return buttons.filter((button) => button.enabled);
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
    const buttons = buttonsFromMetadata(metadata);
    const primaryButton = buttons[0] ?? defaultButton;
    return {
      ...definition,
      buttons,
      ctaEnabled: primaryButton.enabled,
      ctaLabel: primaryButton.label,
      ctaUrl: primaryButton.url,
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
  const buttons = (input.buttons && input.buttons.length > 0 ? input.buttons : [{
    enabled: input.ctaEnabled,
    label: input.ctaLabel,
    type: "open_phoenix" as const,
    url: input.ctaUrl,
  }]).map(cleanButton).slice(0, 3);
  const titleValidation = validateTelegramTemplateText(title, definition.allowedPlaceholders);
  const validation = validateTelegramTemplateText(message, definition.allowedPlaceholders);
  const ctaValidation = validateTelegramCta({ ...input, allowedPlaceholders: definition.allowedPlaceholders });
  const buttonValidation = validateTelegramTemplateButtons({ allowedPlaceholders: definition.allowedPlaceholders, buttons });
  if (titleValidation.errors.length > 0 || validation.errors.length > 0 || ctaValidation.errors.length > 0 || buttonValidation.errors.length > 0) {
    throw new TelegramTemplateError("invalid_template", [...titleValidation.errors, ...validation.errors, ...ctaValidation.errors, ...buttonValidation.errors].join(" "));
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
        buttons,
        cta: {
          enabled: buttons[0]?.enabled === true,
          label: buttons[0]?.label ?? cleanText(input.ctaLabel),
          url: buttons[0]?.url ?? cleanText(input.ctaUrl),
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
    newValues: { buttonCount: enabledButtons(buttons).length, isActive: input.isActive, templateKey: definition.templateKey },
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
  const buttons = buttonsFromMetadata(metadata);
  const buttonValidation = validateTelegramTemplateButtons({ allowedPlaceholders: definition.allowedPlaceholders, buttons });
  if (buttonValidation.errors.length > 0) throw new TelegramTemplateError("invalid_buttons", buttonValidation.errors.join(" "));
  const renderedButtons = enabledButtons(buttons).map((button) => ({
    label: button.label,
    type: button.type,
    url: renderTelegramCtaUrl(button.url, variables, definition.allowedPlaceholders),
  }));
  const ctaEnabled = renderedButtons.length === 0 && cta.enabled === true;
  const ctaValidation = validateTelegramCta({
    allowedPlaceholders: definition.allowedPlaceholders,
    ctaEnabled,
    ctaLabel: cleanText(cta.label),
    ctaUrl: cleanText(cta.url),
  });
  if (ctaValidation.errors.length > 0) throw new TelegramTemplateError("invalid_cta", ctaValidation.errors.join(" "));

  return {
    buttons: renderedButtons,
    ctaLabel: ctaEnabled ? cleanText(cta.label) : null,
    ctaUrl: ctaEnabled ? renderTelegramCtaUrl(cleanText(cta.url), variables, definition.allowedPlaceholders) : null,
    message: renderTelegramTemplateText(cleanText(row.message_template), variables, definition.allowedPlaceholders),
    title: renderTelegramTemplateText(cleanText(row.title_template) || definition.defaultTitle, variables, definition.allowedPlaceholders),
  };
}

export function previewTelegramTemplate(input: TelegramTemplateSaveInput) {
  const definition = getDefinition(input.templateKey);
  const buttons = (input.buttons && input.buttons.length > 0 ? input.buttons : [{
    enabled: input.ctaEnabled,
    label: input.ctaLabel,
    type: "open_phoenix" as const,
    url: input.ctaUrl,
  }]).map(cleanButton).slice(0, 3);
  const titleValidation = validateTelegramTemplateText(cleanText(input.title) || definition.defaultTitle, definition.allowedPlaceholders);
  const ctaValidation = validateTelegramCta({ ...input, allowedPlaceholders: definition.allowedPlaceholders });
  const buttonValidation = validateTelegramTemplateButtons({ allowedPlaceholders: definition.allowedPlaceholders, buttons });
  if (titleValidation.errors.length > 0) throw new TelegramTemplateError("invalid_template", titleValidation.errors.join(" "));
  if (ctaValidation.errors.length > 0 || buttonValidation.errors.length > 0) {
    throw new TelegramTemplateError("invalid_cta", [...ctaValidation.errors, ...buttonValidation.errors].join(" "));
  }
  const renderedButtons = enabledButtons(buttons).map((button) => ({
    label: button.label,
    type: button.type,
    url: renderTelegramCtaUrl(button.url, definition.sampleVariables, definition.allowedPlaceholders),
  }));
  return {
    buttons: renderedButtons,
    ctaLabel: renderedButtons[0]?.label ?? (input.ctaEnabled ? cleanText(input.ctaLabel) : null),
    ctaUrl: renderedButtons[0]?.url ?? (input.ctaEnabled ? renderTelegramCtaUrl(input.ctaUrl, definition.sampleVariables, definition.allowedPlaceholders) : null),
    message: renderTelegramTemplateText(input.message, definition.sampleVariables, definition.allowedPlaceholders),
    title: renderTelegramTemplateText(cleanText(input.title) || definition.defaultTitle, definition.sampleVariables, definition.allowedPlaceholders),
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
      buttons: preview.buttons,
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
