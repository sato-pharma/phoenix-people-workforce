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
    // {{title}}/{{message}} expose the event's domain-composed wording, so one
    // module-wide template can reframe EVERY event of a module without losing the
    // per-event facts (this is what makes the admin template the source of truth).
    message: input.fallbackMessage,
    module: input.module,
    title: input.fallbackTitle,
  };
  // The content placeholders ALWAYS mean the channel-composed wording - some senders
  // (e.g. probation reminders) carry metadata keys literally named title/message that
  // would otherwise shadow them and break the "default template reproduces today's
  // output exactly" contract.
  if (key === "title" || key === "message") return cleanText(direct[key]);
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
  // Direct keys override metadata here, matching variableValue's rule for
  // title/message (the content placeholders always mean the composed wording).
  return {
    ...(input.metadata ?? {}),
    actionUrl: input.actionUrl ?? "",
    eventType: input.eventType,
    message: input.fallbackMessage,
    module: input.module,
    title: input.fallbackTitle,
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
    "message",
    "module",
    "title",
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

  // A template whose buttons/CTA cannot render for THIS event (e.g. a URL placeholder
  // the live metadata does not carry) must never block the notification itself - one
  // bad saved button on a module-wide template would otherwise silently skip EVERY
  // Telegram send of the module. Degrade to a buttonless send: the title/message
  // governance still applies, and caller-supplied workflow buttons (system.ts prefers
  // input.telegram?.buttons) keep working.
  try {
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
  } catch (error) {
    if (error instanceof TelegramTemplateError) {
      console.warn(`Telegram template buttons degraded to buttonless for ${input.module}/${input.eventType}: ${error.message}`);
      return {};
    }
    throw error;
  }
}

/**
 * Pick the row that governs this event: an exact ACTIVE (module, eventType) row wins;
 * otherwise the ACTIVE module-wide "*" row applies; inactive rows never match.
 * Exported for direct unit coverage - this preference order is what makes one
 * admin-edited template govern every event of a module.
 */
export function selectTemplateRow<Row extends { event_type?: string | null; is_active?: boolean | null }>(
  rows: Row[],
  eventType: string,
): Row | null {
  const active = rows.filter((row) => row.is_active === true);
  return active.find((row) => row.event_type === eventType) ?? active.find((row) => row.event_type === "*") ?? null;
}

/**
 * The template rows, held for TEMPLATE_TTL_MS per (module, channel, event) — Phoenix CRM performance
 * audit, 2026-10-16. Every recipient of every notice read them again, once per channel, one after
 * another, for wording an admin edits a few times a month: a plan reminder paid it hundreds of times in
 * one run. Only the WORDING is held — who is told, and on which channel, is decided elsewhere and read
 * fresh. A template saved on this process is seen at once (`forgetNotificationTemplates`, called by the
 * one writer); another process sees it within TEMPLATE_TTL_MS. A failed read is never held.
 */
const TEMPLATE_TTL_MS = 30_000;
const heldTemplates = new Map<string, { rows: Promise<Array<NotificationTemplateRow & { event_type?: string | null }> | null>; readAt: number }>();

/** A template was saved: every send after this reads the stored wording again. */
export function forgetNotificationTemplates(): void {
  heldTemplates.clear();
}

async function loadTemplate(input: NotificationTemplateRenderInput) {
  const key = `${input.module}\u0000${input.channel}\u0000${input.eventType}`;
  const now = Date.now();
  let entry = heldTemplates.get(key);
  if (!entry || now - entry.readAt >= TEMPLATE_TTL_MS) {
    const fresh = { rows: readTemplateRows(input), readAt: now };
    entry = fresh;
    heldTemplates.set(key, fresh);
    fresh.rows.catch(() => {
      if (heldTemplates.get(key) === fresh) heldTemplates.delete(key);
    });
  }
  const rows = await entry.rows;
  return rows === null ? null : selectTemplateRow(rows, input.eventType);
}

async function readTemplateRows(
  input: NotificationTemplateRenderInput,
): Promise<Array<NotificationTemplateRow & { event_type?: string | null }> | null> {
  try {
    // Exact (module, eventType) wins; otherwise the module-wide "*" template applies.
    // The "*" default is what lets a single admin-edited template govern every event of
    // a module - without it, sends whose exact event has no row silently fall back to
    // hardcoded text and admin edits never reach them.
    const { data, error } = await getSupabaseAdmin()
      .from("notification_templates")
      .select("title_template,message_template,is_active,metadata,event_type")
      .eq("module", input.module)
      .eq("channel", input.channel)
      .in("event_type", [input.eventType, "*"]);
    if (error) throw error;
    return (data ?? []) as Array<NotificationTemplateRow & { event_type?: string | null }>;
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
