// Recruitment / ATS — the record of what Phoenix actually SAID to someone on WhatsApp.
//
// Why this module exists, in one exchange. On 2026-08-30 the owner asked "show me the reply that
// went out". It could not be answered. Phoenix stored the inbound side twice — in
// `ats_whatsapp_inbound_messages` and in `ats_cv_intake_events` — and the outbound side nowhere at
// all; the only production tables matching '%whatsapp%' were both inbound. `notification_events`
// recorded `asked: true`, proving a reply had been sent, and held no copy of it.
//
// So the answer had to be a RECONSTRUCTION: read the source that was live at that second and render
// what it would have produced. That is honest but weak, and it degrades in exactly the direction
// this system is heading — it works only while the composing code is a constant, and stops working
// the moment a message is built from data (a name, an area, a live vacancy). These are messages
// sent to members of the public in the company's name. What left the building should be a record.
//
// ── The one rule this module has ──────────────────────────────────────────────
// IT NEVER THROWS, AND IT NEVER CHANGES A SEND RESULT. An audit row is worth having; it is not
// worth costing an applicant their reply. Every failure here is swallowed to a warning, and the
// caller's `WhatsAppSendResult` is returned untouched whatever happens below.

import { logWarning } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";

/** The shape written to `public.ats_whatsapp_outbound_messages`. */
export type OutboundLogRow = {
  to_wa_id: string;
  phone_number_id: string;
  message_type: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  event: string;
  inbound_wamid: string | null;
  context: Record<string, unknown> | null;
  ok: boolean;
  provider_message_id: string | null;
  failure_reason: string | null;
  failure_detail: string | null;
};

/** What the caller knows that the Graph layer does not: which message this answers, and why. */
export type OutboundLogContext = {
  inboundWamid?: string | null;
  /** Free-form, small. Whatever makes the row explicable a month later. */
  detail?: Record<string, unknown> | null;
};

/**
 * The text a WhatsApp payload will actually display, or null when there is none to show.
 *
 * A text message carries its words in `text.body`; an interactive one carries a structure, and
 * flattening that into a fake "body" would put words in the record that the recipient never read as
 * a paragraph. Interactive content is kept in `payload` instead, whole.
 */
export function outboundBodyFromPayload(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  const text = (payload as { text?: { body?: unknown } }).text;
  const body = text?.body;
  return typeof body === "string" ? body : null;
}

/**
 * Builds the row. Pure, and separated from the write on purpose: this is the part worth pinning in
 * a test, and it must be checkable without a database.
 *
 * The payload is stored verbatim. It is safe to store: the access token travels in an Authorization
 * HEADER, never in the body, so nothing secret passes through here — but the assertion is pinned in
 * the test rather than trusted to this comment, because a future Graph call that moved a credential
 * into the body would silently start writing it to a table.
 */
export function buildOutboundLogRow(input: {
  toWaId: string;
  phoneNumberId: string;
  payload: Record<string, unknown>;
  event: string;
  context?: OutboundLogContext | null;
  result:
    | { ok: true; wamid: string | null }
    | { ok: false; reason: string; detail: string | null };
}): OutboundLogRow {
  const messageType = typeof input.payload.type === "string" ? input.payload.type : "unknown";
  return {
    body: outboundBodyFromPayload(input.payload),
    context: input.context?.detail ?? null,
    event: input.event,
    failure_detail: input.result.ok ? null : (input.result.detail ?? null),
    // The table's own CHECK enforces this pairing too. Both, because a half-written row is worse
    // than a missing one: it would read as evidence of something that did not happen.
    failure_reason: input.result.ok ? null : input.result.reason,
    inbound_wamid: input.context?.inboundWamid ?? null,
    message_type: messageType,
    ok: input.result.ok,
    payload: input.payload,
    phone_number_id: input.phoneNumberId,
    provider_message_id: input.result.ok ? input.result.wamid : null,
    to_wa_id: input.toWaId,
  };
}

/**
 * Writes one row. Never throws.
 *
 * Written AFTER Meta answers, not before, so the row records an OUTCOME rather than an intention.
 * The trade that buys: a process killed between the Graph call and this insert leaves a sent
 * message with no record. A pending-then-update pair would close that window at the cost of two
 * writes on every send and — worse — a row claiming we messaged someone when the send in fact
 * failed. Recording only completed attempts, successes and failures alike, is the more truthful of
 * the two, and the window it leaves is one hard crash wide.
 */
export async function recordOutboundMessage(row: OutboundLogRow): Promise<void> {
  try {
    const supabase = recruitmentDb();
    const { error } = await supabase.from("ats_whatsapp_outbound_messages").insert(row);
    if (error) {
      logWarning("WhatsApp outbound message not logged", {
        context: { code: (error as { code?: string }).code ?? null, event: row.event },
        labels: { event: "whatsapp_outbound_log_failed" },
      });
    }
  } catch (error) {
    logWarning("WhatsApp outbound message log threw", {
      error,
      labels: { event: "whatsapp_outbound_log_threw" },
    });
  }
}
