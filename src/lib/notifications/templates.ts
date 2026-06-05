import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { SystemNotificationChannel } from "@/lib/notifications/system";

export type NotificationTemplateRenderInput = {
  actionUrl?: string | null;
  channel: SystemNotificationChannel;
  eventType: string;
  fallbackMessage: string;
  fallbackTitle: string;
  metadata?: Record<string, unknown>;
  module: string;
};

type NotificationTemplateRow = {
  is_active?: boolean | null;
  message_template?: string | null;
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

async function loadTemplate(input: NotificationTemplateRenderInput) {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_templates")
      .select("title_template,message_template,is_active")
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

export async function renderNotificationTemplate(input: NotificationTemplateRenderInput) {
  const template = await loadTemplate(input);
  const title = template?.title_template
    ? renderTemplate(template.title_template, input)
    : input.fallbackTitle;
  const message = template?.message_template
    ? renderTemplate(template.message_template, input)
    : input.fallbackMessage;

  return { message, title };
}
