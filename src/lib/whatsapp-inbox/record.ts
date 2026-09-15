// The WhatsApp Inbox — WRITING messages and delivery ticks. Called from two hot paths that must never
// fail because of it: the webhook (Meta disables a webhook that errors or stalls) and every outbound
// send (`postToGraph` in recruitment/inbound/whatsapp-interactive.ts). So every export here NEVER
// throws, and a missing table — the state before the migration is applied — is a quiet no-op.
//
// Kept apart from the reading/sending code (store.ts, send.ts) so the send path imports nothing but a
// database client: whatsapp-interactive.ts is imported by the whole recruitment pipeline, and pulling
// the inbox's candidate and storage code in behind it would be a cycle waiting to happen.

import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  parseInboxDelivery,
  type InboxMessageRecord,
  type InboxOutboundStatus,
  type InboxStatusUpdate,
} from "@/lib/whatsapp-inbox/webhook-parse";

export const WHATSAPP_INBOX_MESSAGES_TABLE = "whatsapp_inbox_messages";
export const WHATSAPP_INBOX_CONVERSATIONS_TABLE = "whatsapp_inbox_conversations";

/** The inbox-specific facts a send carries in `OutboundLogContext.detail.inbox`. */
export type InboxSendDetail = {
  sentByHrId?: string | null;
  /** What the person reads, when the payload alone does not say it — a rendered template. */
  renderedBody?: string | null;
  mediaStoragePath?: string | null;
  mediaMimeType?: string | null;
  mediaFileName?: string | null;
  mediaByteSize?: number | null;
};

type DbError = { code?: string; message?: string } | null;

/** A table that is not there yet answers PGRST205 through PostgREST, 42P01 through SQL. */
function isMissingTable(error: DbError): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

/**
 * The test suite runs with PRODUCTION credentials (AGENTS.md §2.1), and the suites that exercise the
 * webhook and the send path would otherwise write their fixtures into the real inbox. Set once by
 * tests/run-tests.ts and read by nothing in the running app.
 */
function isTestSuite(): boolean {
  return process.env.PHOENIX_TEST_SUITE === "1";
}

function inboundRow(record: InboxMessageRecord): Record<string, unknown> {
  const outbound = record.direction === "outbound";
  return {
    body: record.body,
    contact_name: record.contactName,
    contact_user_id: record.contactUserId,
    contact_username: record.contactUsername,
    contact_wa_id: record.contactWaId,
    direction: record.direction,
    historical: record.historical,
    line_display_number: record.lineDisplayNumber,
    media_file_name: record.media?.fileName ?? null,
    media_id: record.media?.id ?? null,
    media_mime_type: record.media?.mimeType ?? null,
    message_type: record.messageType,
    origin: record.origin,
    payload: record.payload,
    phone_number_id: record.phoneNumberId,
    reply_to_wamid: record.replyToWamid,
    sent_at: record.sentAt ?? new Date().toISOString(),
    // A replayed "failed" would need a reason the replay does not give; it is kept as sent instead.
    status: outbound ? (record.replayStatus && record.replayStatus !== "failed" ? record.replayStatus : "sent") : "received",
    status_at: record.sentAt,
    template_name: record.templateName,
    wamid: record.wamid,
  };
}

export type InboxDeliveryResult = { recorded: number; duplicates: number; failed: number; statusesApplied: number };

/**
 * Records every message and status tick in one webhook delivery. Never throws.
 *
 * Row by row, not one bulk insert: a bulk insert is all-or-nothing, so one duplicate from a Meta retry
 * would throw away every new message beside it. The conversation trigger skips a known wamid itself;
 * a 23505 is the rarer race where two copies arrive at once, and is equally "already recorded".
 */
export async function recordInboxDelivery(payload: unknown): Promise<InboxDeliveryResult> {
  const result: InboxDeliveryResult = { duplicates: 0, failed: 0, recorded: 0, statusesApplied: 0 };
  if (isTestSuite()) return result;
  let delivery: ReturnType<typeof parseInboxDelivery>;
  try {
    delivery = parseInboxDelivery(payload, { fallbackPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? null });
  } catch (error) {
    logWarning("WhatsApp inbox could not parse a delivery", { error, labels: { event: "whatsapp_inbox_parse_threw" } });
    return result;
  }

  try {
    const supabase = getSupabaseAdmin();
    for (const record of delivery.messages) {
      const { error } = await supabase.from(WHATSAPP_INBOX_MESSAGES_TABLE).insert(inboundRow(record));
      if (!error) {
        result.recorded += 1;
        continue;
      }
      if (isMissingTable(error)) return result;
      if (error.code === "23505") {
        result.duplicates += 1;
        continue;
      }
      result.failed += 1;
      logWarning("WhatsApp inbox message not recorded", {
        context: { code: error.code ?? null, message: error.message ?? null },
        labels: { event: "whatsapp_inbox_record_failed", wamid: record.wamid },
      });
    }
    result.statusesApplied = await applyInboxStatuses(delivery.statuses);
  } catch (error) {
    logWarning("WhatsApp inbox recording threw", { error, labels: { event: "whatsapp_inbox_record_threw" } });
  }
  return result;
}

/** Forward-only ticks; the database function refuses a step backwards. Never throws. */
export async function applyInboxStatuses(statuses: InboxStatusUpdate[]): Promise<number> {
  if (statuses.length === 0 || isTestSuite()) return 0;
  let applied = 0;
  try {
    const supabase = getSupabaseAdmin();
    for (const update of statuses) {
      const { data, error } = await supabase.rpc("whatsapp_inbox_apply_status", {
        p_at: update.at ?? new Date().toISOString(),
        p_failure_detail: update.failureDetail,
        p_status: update.status,
        p_wamid: update.wamid,
      });
      if (error) {
        if (error.code === "PGRST202" || isMissingTable(error)) return applied;
        logWarning("WhatsApp inbox status not applied", {
          context: { code: error.code ?? null },
          labels: { event: "whatsapp_inbox_status_failed", wamid: update.wamid },
        });
        continue;
      }
      if (data === true) applied += 1;
    }
  } catch (error) {
    logWarning("WhatsApp inbox status update threw", { error, labels: { event: "whatsapp_inbox_status_threw" } });
  }
  return applied;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The row for one Phoenix send, built from exactly what was posted to Meta. Pure, and exported for the
 * test. Returns null for a payload the inbox cannot place (no recipient number).
 */
export function buildInboxOutboundRow(input: {
  phoneNumberId: string;
  payload: Record<string, unknown>;
  event: string;
  result: { ok: true; wamid: string | null } | { ok: false; reason: string; detail: string | null };
  inbox?: InboxSendDetail | null;
  now?: Date;
}): Record<string, unknown> | null {
  const to = typeof input.payload.to === "string" ? input.payload.to.replace(/\D+/g, "") : "";
  if (!to) return null;
  const type = typeof input.payload.type === "string" ? input.payload.type : "unknown";
  const node = asRecord(input.payload[type]);
  const template = type === "template" ? asRecord(input.payload.template) : null;
  const interactiveBody = type === "interactive" ? text(asRecord(node?.body)?.text) : null;
  const body =
    text(input.inbox?.renderedBody) ??
    (type === "text" ? text(node?.body) : null) ??
    text(node?.caption) ??
    interactiveBody ??
    (template ? `Template: ${text(template.name) ?? "unnamed"}` : null);
  const mediaId = text(node?.id);
  const storagePath = text(input.inbox?.mediaStoragePath);
  const at = (input.now ?? new Date()).toISOString();
  const status: InboxOutboundStatus = input.result.ok ? "accepted" : "failed";

  return {
    body,
    contact_wa_id: to,
    direction: "outbound",
    event: input.event,
    failure_detail: input.result.ok ? null : input.result.detail,
    failure_reason: input.result.ok ? null : input.result.reason,
    media_byte_size: input.inbox?.mediaByteSize ?? null,
    media_fetched_at: storagePath ? at : null,
    media_file_name: text(input.inbox?.mediaFileName) ?? text(node?.filename),
    media_id: mediaId,
    media_mime_type: text(input.inbox?.mediaMimeType),
    media_storage_path: storagePath,
    message_type: type,
    origin: "phoenix",
    payload: input.payload,
    phone_number_id: input.phoneNumberId,
    received_at: at,
    reply_to_wamid: text(asRecord(input.payload.context)?.message_id),
    sent_at: at,
    sent_by_hr_id: text(input.inbox?.sentByHrId),
    status,
    status_at: at,
    template_name: template ? text(template.name) : null,
    wamid: input.result.ok ? input.result.wamid : null,
  };
}

/** Records one Phoenix send in the inbox. Never throws, never changes the send result. */
export async function recordInboxOutbound(input: Parameters<typeof buildInboxOutboundRow>[0]): Promise<void> {
  if (isTestSuite()) return;
  try {
    const row = buildInboxOutboundRow(input);
    if (!row) return;
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from(WHATSAPP_INBOX_MESSAGES_TABLE).insert(row);
    if (error && !isMissingTable(error) && error.code !== "23505") {
      logWarning("WhatsApp inbox outbound message not recorded", {
        context: { code: error.code ?? null, message: error.message ?? null },
        labels: { event: "whatsapp_inbox_outbound_record_failed" },
      });
    }
  } catch (error) {
    logWarning("WhatsApp inbox outbound recording threw", {
      error,
      labels: { event: "whatsapp_inbox_outbound_record_threw" },
    });
  }
}
