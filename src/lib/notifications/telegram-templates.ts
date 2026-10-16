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
import { forgetNotificationTemplates } from "@/lib/notifications/templates";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TelegramTemplateWorkflowKey =
  | "vacation"
  | "outstation"
  | "weekly_plans"
  | "marketing_requests"
  | "contract_renewal"
  | "probation"
  | "excuse"
  | "recruitment"
  | "internal_messages"
  | "support_requests"
  | "business_card_requests"
  | "attendance"
  | "field_workforce_compliance"
  | "birthday"
  | "holiday_confirmation"
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
  // Placeholders that MUST be supplied at live send. Any other allowed placeholder is
  // optional and renders to empty if the live event omits it (so a template that passes
  // preview never throws at send). Omitted ⇒ no body placeholder is hard-required.
  requiredPlaceholders?: string[];
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
const linkPlaceholders = ["actionUrl", "approveUrl", "rejectUrl", "requestUrl", "employeePortalUrl"];
// {{title}}/{{message}} carry the event's domain-composed wording (see templates.ts), so a
// single module-wide template can reframe every event without losing per-event facts.
const contentPlaceholders = ["title", "message"];
const globalPlaceholders = [
  ...contentPlaceholders,
  ...identityPlaceholders,
  ...organizationPlaceholders,
  ...workflowPlaceholders,
  ...linkPlaceholders,
];

const baseSampleVariables: Record<string, string> = {
  approvalStep: "Manager review",
  approveUrl: "/leave-management/vacation-decision/REQ-2026-014?decision=approve",
  rejectUrl: "/leave-management/vacation-decision/REQ-2026-014?decision=reject",
  period: "14 Jun 2026 - 18 Jun 2026",
  location: "Alexandria",
  approverName: "Omar Nabil",
  area: "Cairo East",
  department: "Sales",
  dueDate: "14 Jun 2026",
  employeeHrId: "PHX-1024",
  employeeName: "Ahmed Hassan",
  employeePortalUrl: "/employee-portals",
  eventDate: "14 Jun 2026",
  line: "Cardio Line",
  managerName: "Omar Nabil",
  moduleName: "Phoenix Workforce",
  priority: "High",
  reason: "Workflow update",
  recipientHrId: "B-10",
  recipientName: "Omar Anwar",
  requesterHrId: "PHX-1024",
  requesterName: "Ahmed Hassan",
  requestId: "REQ-2026-014",
  requestType: "Annual",
  requestUrl: "/employee-portals",
  role: "District Manager",
  status: "Pending approval",
  submittedAt: "14 Jun 2026",
  team: "Cairo East Team",
  updatedAt: "14 Jun 2026",
  workflowName: "Approval workflow",
};

export const telegramTemplateDefinitions: TelegramTemplateDefinition[] = [
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Vacation Telegram event (submitted, manager decision, final decision, SLA reminders).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "vacation",
    name: "Vacation",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/leave-management/vacation-control",
      message: "Module: Vacation\nAhmed Hassan submitted an Annual vacation request (2026-06-14 to 2026-06-18).",
      title: "Vacation request submitted",
    },
    templateKey: "vacation",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Outstation / Expense Telegram event (submitted, approved, rejected, added to payroll).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "outstation",
    name: "Outstation / Expense",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/employee-portals/expenses",
      message: "Module: Outstation\nYour outstation expense (EGP 1,250) was approved by Omar Nabil.",
      title: "Outstation request approved",
    },
    templateKey: "outstation",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Weekly / Monthly Plans Telegram event (submitted, manager approved, CEO approved, returned/rejected).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "weekly_plans",
    name: "Weekly / Monthly Plans",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/employee-portals/plans",
      message: "Module: Weekly plans\nMariam Adel submitted a weekly plan for 2026-W25.",
      title: "Weekly plan needs manager review",
    },
    templateKey: "weekly_plans",
  },
  {
    allowedPlaceholders: [...globalPlaceholders, "requestCode", "returnUrl"],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Marketing Requests Telegram event (submitted, assigned, returned, approved, rejected, SLA reminders).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "marketing_requests",
    name: "Marketing Requests",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/employee-portals/marketing-requests/inbox",
      approveUrl: "/employee-portals/marketing-requests/decision/REQ-2026-014?decision=approve",
      rejectUrl: "/employee-portals/marketing-requests/decision/REQ-2026-014?decision=reject",
      requestCode: "REQ-2026-014",
      returnUrl: "/employee-portals/marketing-requests/decision/REQ-2026-014?decision=return",
      message: "Module: Marketing requests\nRequest REQ-2026-014 is assigned to you for approval.",
      title: "Marketing request assigned",
    },
    templateKey: "marketing_requests",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Contract Renewal Telegram event (daily renewal reminders + workflow updates).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "contract_renewal",
    name: "Contract Renewal",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/contracts",
      message: "Module: Contract renewal\nContract renewal for Mariam Nabil is due in 14 days. Pending manager recommendation.",
      title: "Contract renewal reminder",
    },
    templateKey: "contract_renewal",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Probation Telegram event (daily reminder checkpoints + workflow updates).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "probation",
    name: "Probation",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/probation",
      message: "Module: Probation\nProbation review for Ahmed Hassan needs your feedback (15 days remaining).",
      title: "Probation feedback required",
    },
    templateKey: "probation",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Excuse Telegram event (manager alert, employee decision, SLA reminders).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "excuse",
    name: "Excuse",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/employee-portals/excuses",
      message: "Module: Excuse\nAhmed Hassan submitted a Morning excuse for 2026-06-16.",
      title: "Excuse request submitted",
    },
    templateKey: "excuse",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Recruitment Telegram event (interview scheduled/rescheduled/cancelled, reminders).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "recruitment",
    name: "Recruitment",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/recruitment",
      message: "Module: Recruitment\nHiring manager interview with Ahmed Hassan for Medical Representative — 16 Jun 2026, 10:30 AM.",
      title: "Interview scheduled",
    },
    templateKey: "recruitment",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Internal Message Telegram event.
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "internal_messages",
    name: "Internal Messages",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/employee-portals",
      message: "Module: Internal message\nOmar Nabil sent you a message: \"Please review the Q3 territory plan today.\"",
      title: "New internal message",
    },
    templateKey: "internal_messages",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Support Request Telegram event (HR alerted when an employee opens a ticket).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "support_requests",
    name: "Support Requests",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/employee-portals/contact-hr-support",
      message: "Module: Support request\nAhmed Hassan opened a support ticket: \"Cannot access payslip for May.\"",
      title: "New support request",
    },
    templateKey: "support_requests",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Business Card Request Telegram event (the owner and
    // HR Operations are alerted when an employee requests printed business cards).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "business_card_requests",
    name: "Business Card Requests",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/admin/business-card-requests",
      message: "Module: Business card request\nAhmed Hassan requested printed business cards.",
      title: "New business card request",
    },
    templateKey: "business_card_requests",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Attendance Telegram event other than the weekly
    // digest itself (digest review, auto-confirm, disputes, plan/punch mismatches, missing-punch steps).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "attendance",
    name: "Attendance",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/employee-portals/attendance",
      message: "Module: Attendance\nAhmed Hassan disputed an attendance record for 2026-06-14: \"Late due to field visit approved by manager.\"",
      title: "Attendance dispute submitted",
    },
    templateKey: "attendance",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches EVERY Field Workforce Compliance Telegram event (monthly digest).
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "field_workforce_compliance",
    name: "Field Workforce Compliance",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/attendance/fingerprint-report",
      message: "Module: Field workforce compliance\nMonthly compliance digest for Jun 2026 is ready for review.",
      title: "Monthly compliance digest",
    },
    templateKey: "field_workforce_compliance",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches the daily Birthday Telegram event.
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "birthday",
    name: "Birthday",
    recommendedPlaceholders: ["title", "message"],
    sampleVariables: {
      ...baseSampleVariables,
      message: "Module: Birthday\nHappy birthday wishes for Ahmed Hassan.",
      title: "Happy Birthday",
    },
    templateKey: "birthday",
  },
  {
    allowedPlaceholders: [...globalPlaceholders],
    defaultMessage: "{{message}}",
    defaultTitle: "{{title}}",
    // Module-wide template: "*" matches the National Holiday confirmation reminder Telegram event.
    // {{title}}/{{message}} are filled per event by the workflow, so the default reproduces
    // today's output exactly until the admin reshapes it.
    eventType: "*",
    module: "holiday_confirmation",
    name: "Holiday Confirmation",
    recommendedPlaceholders: ["title", "message", "actionUrl"],
    sampleVariables: {
      ...baseSampleVariables,
      actionUrl: "/attendance/holiday-calendar",
      message: "Module: Holiday confirmation\nJune 30 Revolution Day is officially dated 2026-06-30 (in 5 days). Confirm the observed day off.",
      title: "National holiday needs confirmation",
    },
    templateKey: "holiday_confirmation",
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
  event_type?: string | null;
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
      .select("template_key,event_type,title_template,message_template,is_active,metadata,updated_at")
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
    const savedRow = rows.get(definition.templateKey);
    // A row saved under an old per-event catalog (event_type differs from the current
    // definition) is LEGACY: surface the safe defaults instead of silently re-scoping
    // its per-event wording/buttons to the whole module on the next save.
    const stale = Boolean(savedRow) && cleanText(savedRow?.event_type) !== definition.eventType;
    const row = stale ? undefined : savedRow;
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
  // Dry-render every enabled button/CTA URL against the sample variables (exactly what
  // the live renderer does). A URL that cannot render here would degrade EVERY send of
  // the module to buttonless - reject it at save instead of persisting it.
  try {
    for (const button of enabledButtons(buttons)) {
      renderTelegramCtaUrl(cleanText(button.url), definition.sampleVariables, definition.allowedPlaceholders);
    }
    if (buttons[0]?.enabled === true) {
      renderTelegramCtaUrl(cleanText(buttons[0].url), definition.sampleVariables, definition.allowedPlaceholders);
    }
  } catch (error) {
    if (error instanceof TelegramTemplateError) {
      throw new TelegramTemplateError("invalid_template", `Button link cannot render: ${error.message}`);
    }
    throw error;
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
  // The senders hold template wording for half a minute; a save reaches the very next send.
  forgetNotificationTemplates();

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
    message: renderTelegramTemplateText(cleanText(row.message_template), variables, definition.allowedPlaceholders, definition.requiredPlaceholders ?? []),
    title: renderTelegramTemplateText(cleanText(row.title_template) || definition.defaultTitle, variables, definition.allowedPlaceholders, definition.requiredPlaceholders ?? []),
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
    message: renderTelegramTemplateText(input.message, definition.sampleVariables, definition.allowedPlaceholders, definition.requiredPlaceholders ?? []),
    title: renderTelegramTemplateText(cleanText(input.title) || definition.defaultTitle, definition.sampleVariables, definition.allowedPlaceholders, definition.requiredPlaceholders ?? []),
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
