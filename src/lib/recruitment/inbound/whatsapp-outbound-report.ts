// The READ side of the WhatsApp outbound record — what the "WhatsApp Replies" panel shows.
//
// WHY THIS IS NOT IN whatsapp-outbound-log.ts, which owns the write side of the same table. That
// module carries one absolute rule: it never throws, because an audit row is never worth costing an
// applicant their reply — and tests/whatsapp-outbound-log.test.ts pins it by asserting that FILE
// contains no `throw` at all. A reader has the opposite duty. If this query fails the page must say
// so out loud; a reader that swallowed its error and returned an empty array would render "nothing
// went out" over a broken database, which is the exact confusion this panel exists to end. Two
// contradictory obligations, so two modules.

import { recruitmentDb } from "@/lib/recruitment/db";

/** One message Phoenix sent, as the panel needs it. */
export type OutboundMessageRow = {
  id: string;
  createdAt: string;
  toWaId: string;
  messageType: string;
  /** The exact words delivered. Null for an interactive menu, which has no single body. */
  body: string | null;
  event: string;
  inboundWamid: string | null;
  context: Record<string, unknown> | null;
  ok: boolean;
  failureReason: string | null;
  failureDetail: string | null;
};

/**
 * When this table started recording: the deploy that shipped it, 2026-08-30 02:40:55 Cairo.
 *
 * Load-bearing, not decoration. The panel raises an alarm when messages arrived and none were
 * answered — but an inbound message from BEFORE this instant cannot have a matching outbound row
 * however well the reply worked, because nothing was writing them down yet. Comparing across that
 * boundary manufactures an alarm out of the log's own youth, which is precisely what the first
 * render of this page did: four real inbound messages from the preceding weeks, measured against a
 * log a few hours old, reported as "Phoenix replied to none of them".
 */
export const OUTBOUND_LOG_LIVE_SINCE = "2026-08-30T00:40:55.000Z";

export type WhatsAppOutboundReport = {
  windowDays: number;
  rows: OutboundMessageRow[];
  /** Sent in the window, whether or not Meta accepted them. */
  total: number;
  failed: number;
  /** Inbound messages in the window. Honest to display; NOT safe to compare against replies. */
  inboundInWindow: number;
  /**
   * Inbound messages that arrived while the log was actually recording. The only inbound number a
   * reply count may be compared to, and what decides quiet-versus-broken on the page.
   */
  inboundSinceLogging: number;
};

function windowStartIso(windowDays: number): string {
  return new Date(Date.now() - Math.max(1, windowDays) * 24 * 60 * 60 * 1000).toISOString();
}

function mapRow(row: Record<string, unknown>): OutboundMessageRow {
  return {
    body: typeof row.body === "string" ? row.body : null,
    context: row.context && typeof row.context === "object" ? (row.context as Record<string, unknown>) : null,
    createdAt: String(row.created_at ?? ""),
    event: String(row.event ?? ""),
    failureDetail: typeof row.failure_detail === "string" ? row.failure_detail : null,
    failureReason: typeof row.failure_reason === "string" ? row.failure_reason : null,
    id: String(row.id),
    inboundWamid: typeof row.inbound_wamid === "string" ? row.inbound_wamid : null,
    messageType: String(row.message_type ?? "unknown"),
    ok: row.ok === true,
    toWaId: String(row.to_wa_id ?? ""),
  };
}

/**
 * Everything the panel renders, in one call.
 *
 * ON EMPTINESS, which is the only genuinely hard part of this report. Zero outbound rows means one
 * of two opposite things, and rendering the reassuring one unconditionally is a mistake this
 * repository has already paid for once: during the 2026-08-01 WhatsApp outage the intake-health
 * page reported a perfect score throughout a total outage, because nothing had been enqueued and so
 * nothing had failed. `inboundInWindow` is what separates the two cases here — no replies AND no
 * arrivals is a quiet line, while no replies against real arrivals is an alarm. The view decides
 * the wording; this function's job is to make the distinction available at all.
 *
 * Throws on a query error, deliberately. See the module header.
 */
export async function getWhatsAppOutboundReport(
  windowDays = 30,
  limit = 50,
): Promise<WhatsAppOutboundReport> {
  const supabase = recruitmentDb();
  const since = windowStartIso(windowDays);

  // The later of the two boundaries: there is no point asking about inbound messages from before
  // the log could answer for them.
  const comparableSince = since > OUTBOUND_LOG_LIVE_SINCE ? since : OUTBOUND_LOG_LIVE_SINCE;

  const [messages, sent, failed, inbound, inboundComparable] = await Promise.all([
    supabase
      .from("ats_whatsapp_outbound_messages")
      .select("id,created_at,to_wa_id,message_type,body,event,inbound_wamid,context,ok,failure_reason,failure_detail")
      .order("created_at", { ascending: false })
      .limit(Math.max(1, limit)),
    // count-only reads: the list above is capped at `limit`, so counting its length would report
    // "50" for any busier window and silently understate the real total.
    supabase
      .from("ats_whatsapp_outbound_messages")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since),
    supabase
      .from("ats_whatsapp_outbound_messages")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .eq("ok", false),
    supabase
      .from("ats_whatsapp_inbound_messages")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since),
    supabase
      .from("ats_whatsapp_inbound_messages")
      .select("id", { count: "exact", head: true })
      .gte("created_at", comparableSince),
  ]);

  for (const result of [messages, sent, failed, inbound, inboundComparable]) {
    if (result.error) throw result.error;
  }

  return {
    failed: failed.count ?? 0,
    inboundInWindow: inbound.count ?? 0,
    inboundSinceLogging: inboundComparable.count ?? 0,
    rows: (Array.isArray(messages.data) ? messages.data : []).map((row) =>
      mapRow(row as Record<string, unknown>),
    ),
    total: sent.count ?? 0,
    windowDays,
  };
}
