import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { SystemNotificationChannel } from "@/lib/notifications/system";
import {
  renderTelegramCtaUrl,
  validateTelegramCta,
  validateTelegramTemplateButtons,
  type TelegramTemplateButtonInput,
} from "@/lib/notifications/telegram-template-placeholders";
import { TelegramTemplateError } from "@/lib/notifications/telegram-template-types";

export type NotificationTemplateRenderInput = {
  actionUrl?: string | null;
  channel: SystemNotificationChannel;
  eventType: string;
  fallbackMessage: string;
  fallbackTitle: string;
  metadata?: Record<string, unknown>;
  module: string;
};

export type RenderedNotificationTemplate = {
  buttons?: Array<{ label: string; url: string }> | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  message: string;
  title: string;
};

type NotificationTemplateRow = {
  is_active?: boolean | null;
  message_template?: string | null;
  metadata?: Record<string, unknown> | null;
  title_template?: string | null;
};

function schemaMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return text.includes("notification_templates") || text.includes("schema cache") || text.includes("does not exist") || text.includes("could not find the table");
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function variableValue(input: NotificationTemplateRenderInput, key: string) {
  const direct: Record<string, unknown> = {
    actionUrl: input.actionUrl,
    eventType: input.eventType,
    module: input.module,
  };
  return cleanText(input.metadata?.[key] ?? direct[key]);
}

function renderTemplate(template: string, input: NotificationTemplateRenderInput) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => variableValue(input, key));
}

function metadataObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function templateVariables(input: NotificationTemplateRenderInput) {
  return {
    ...(input.metadata ?? {}),
    actionUrl: input.actionUrl ?? "",
    eventType: input.eventType,
    module: input.module,
  };
}

function allowedPlaceholders(input: NotificationTemplateRenderInput, metadata: Record<string, unknown>) {
  const configured = Array.isArray(metadata.allowedPlaceholders)
    ? metadata.allowedPlaceholders.map(cleanText).filter(Boolean)
    : [];
  if (configured.length > 0) return configured;
  return Array.from(new Set([
    "actionUrl",
    "eventType",
    "module",
    ...Object.keys(input.metadata ?? {}),
  ]));
}

function cleanButton(input: TelegramTemplateButtonInput | Record<string, unknown> | null | undefined): TelegramTemplateButtonInput {
  return {
    enabled: input?.enabled !== false,
    label: cleanText(input?.label) || "Open Phoenix",
    type: cleanText(input?.type) || "custom",
    url: cleanText(input?.url) || "{{actionUrl}}",
  };
}

function enabledButtons(buttons: TelegramTemplateButtonInput[]) {
  return buttons.filter((button) => button.enabled !== false);
}

function buttonsFromMetadata(metadata: Record<string, unknown>) {
  if (!Array.isArray(metadata.buttons)) return [];
  return metadata.buttons
    .filter((button): button is Record<string, unknown> => Boolean(button) && typeof button === "object" && !Array.isArray(button))
    .map(cleanButton)
    .slice(0, 3);
}

function ctaFromMetadata(metadata: Record<string, unknown>) {
  return metadataObject(metadata.cta);
}

function renderTelegramActions(
  input: NotificationTemplateRenderInput,
  template: NotificationTemplateRow | null,
): Partial<Pick<RenderedNotificationTemplate, "buttons" | "ctaLabel" | "ctaUrl">> {
  if (input.channel !== "telegram" || !template) return {};

  const metadata = metadataObject(template.metadata);
  const allowed = allowedPlaceholders(input, metadata);
  const variables = templateVariables(input);
  const buttons = buttonsFromMetadata(metadata);
  const buttonValidation = validateTelegramTemplateButtons({ allowedPlaceholders: allowed, buttons });
  if (buttonValidation.errors.length > 0) {
    throw new TelegramTemplateError("invalid_buttons", buttonValidation.errors.join(" "));
  }

  const renderedButtons = enabledButtons(buttons).map((button) => ({
    label: cleanText(button.label),
    url: renderTelegramCtaUrl(cleanText(button.url), variables, allowed),
  }));

  if (renderedButtons.length > 0) return { buttons: renderedButtons };

  const cta = ctaFromMetadata(metadata);
  const ctaEnabled = cta.enabled === true;
  const ctaValidation = validateTelegramCta({
    allowedPlaceholders: allowed,
    ctaEnabled,
    ctaLabel: cleanText(cta.label),
    ctaUrl: cleanText(cta.url),
  });
  if (ctaValidation.errors.length > 0) {
    throw new TelegramTemplateError("invalid_cta", ctaValidation.errors.join(" "));
  }

  return ctaEnabled
    ? {
      ctaLabel: cleanText(cta.label),
      ctaUrl: renderTelegramCtaUrl(cleanText(cta.url), variables, allowed),
    }
    : {};
}

async function loadTemplate(input: NotificationTemplateRenderInput) {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_templates")
      .select("title_template,message_template,is_active,metadata")
      .eq("module", input.module)
      .eq("event_type", input.eventType)
      .eq("channel", input.channel)
      .maybeSingle();
    if (error) throw error;
    const row = data as NotificationTemplateRow | null;
    if (!row?.is_active) return null;
    return row;
  } catch (error) {
    if (schemaMissing(error)) return null;
    throw error;
  }
}

export async function renderNotificationTemplate(input: NotificationTemplateRenderInput): Promise<RenderedNotificationTemplate> {
  const template = await loadTemplate(input);
  const title = template?.title_template
    ? renderTemplate(template.title_template, input)
    : input.fallbackTitle;
  const message = template?.message_template
    ? renderTemplate(template.message_template, input)
    : input.fallbackMessage;
  const telegramActions = renderTelegramActions(input, template);

  return { message, title, ...telegramActions };
}
