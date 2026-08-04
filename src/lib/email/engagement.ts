import { getSupabaseAdmin } from "@/lib/supabase/server";

// Per-email ACTIVITY — each email's exact situation: sent → delivered → opened → clicked (or
// failed/bounced). Built by correlating what Phoenix sent (notification_outbox) with the provider
// webhook events (email_delivery_events, fed by BOTH the Resend and Brevo webhooks) on the shared
// provider_message_id. Admin-only; the calling page enforces the `communication:read` gate.

export type EmailActivityRow = {
  bounced: boolean;
  clicked: boolean;
  delivered: boolean;
  failedReason: string | null;
  id: string;
  lastActivityAt: string | null;
  opened: boolean;
  provider: "brevo" | "resend" | "unknown";
  recipientEmail: string;
  recipientName: string | null;
  sendStatus: string;
  sentAt: string | null;
  subject: string | null;
};

export type EmailActivityData = {
  generatedAt: string;
  rows: EmailActivityRow[];
  summary: { bounced: number; clicked: number; delivered: number; notSent: number; opened: number; sent: number; total: number };
};

export type EmailActivityOptions = {
  activity?: "all" | "bounced" | "clicked" | "not_sent" | "opened";
  days?: number;
  limit?: number;
  provider?: "all" | "brevo" | "resend";
  search?: string;
};

type OutboxRow = {
  created_at: string;
  id: string;
  last_error: string | null;
  payload: { recipientHrId?: string | null; recipients?: string[] | null; subject?: string | null; title?: string | null } | null;
  provider_message_id: string | null;
  sent_at: string | null;
  status: string | null;
};

type DeliveryEventRow = { occurred_at: string | null; provider_message_id: string | null; status: string | null };

type Aggregate = { bounced: boolean; clicked: boolean; delivered: boolean; lastActivityAt: string | null; opened: boolean };

// PostgREST inlines `.in(...)` values into the request URL/headers. A single filter with
// hundreds of long message IDs can exceed undici's ~16KB header limit (HeadersOverflowError,
// surfaced as a bare "TypeError: fetch failed"). Chunk any `.in()` built from an outbox-sized
// array so the request stays well under that ceiling.
const IN_FILTER_CHUNK_SIZE = 100;

// PostgREST caps a single response, so the window is read page by page. The chips are printed under
// the window heading ("Last 30 days"), so they have to count the whole window: a 30-day window
// holding 910 sent / 448 opened / 151 clicked / 86 not-sent read as 178 / 139 / 64 / 22 while they
// were computed from the first display page (production, 2026-08-04).
const OUTBOX_PAGE_SIZE = 500;

// Ceiling on that scan. Production runs ~1,000 sends per 30-day window (the widest the page offers),
// so this is headroom rather than a live limit — and it throws instead of returning a short count,
// because nothing downstream can tell a truncated chip from a true one.
const MAX_WINDOW_OUTBOX_ROWS = 5000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function loadWindowOutbox(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  sinceIso: string,
  untilIso: string,
): Promise<OutboxRow[]> {
  const rows: OutboxRow[] = [];
  for (let offset = 0; ; offset += OUTBOX_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("notification_outbox")
      .select("id,status,provider_message_id,sent_at,last_error,payload,created_at")
      .gte("created_at", sinceIso)
      // Freeze the top of the window at one instant. The scan is OFFSET-paged and sorted newest
      // first, so a send that lands between two pages would shift every later row down by one and
      // be counted twice — the drain writes to this table continuously.
      .lt("created_at", untilIso)
      .order("created_at", { ascending: false })
      // Tie-break the sort: rows sharing a created_at would otherwise drift between pages and be
      // counted twice or skipped entirely.
      .order("id", { ascending: false })
      .range(offset, offset + OUTBOX_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as OutboxRow[];
    rows.push(...page);
    if (page.length < OUTBOX_PAGE_SIZE) return rows;
    if (rows.length >= MAX_WINDOW_OUTBOX_ROWS) {
      throw new Error(`Email Activity window holds ${MAX_WINDOW_OUTBOX_ROWS}+ sends — refusing to show a partial count.`);
    }
  }
}

export function summarizeEmailActivity(rows: readonly EmailActivityRow[]): EmailActivityData["summary"] {
  return {
    bounced: rows.filter((row) => row.bounced || row.sendStatus === "failed").length,
    clicked: rows.filter((row) => row.clicked).length,
    delivered: rows.filter((row) => row.delivered).length,
    notSent: rows.filter((row) => row.sendStatus !== "sent").length,
    opened: rows.filter((row) => row.opened).length,
    sent: rows.filter((row) => row.sendStatus === "sent").length,
    total: rows.length,
  };
}

/**
 * Splits the matched window into what the table shows and what the chips count. They are produced
 * together, from the same list, so the chips can never quietly become a description of one page:
 * `matched` is the whole window, `rows` is only the slice that renders.
 */
export function buildEmailActivityPage(
  matched: readonly EmailActivityRow[],
  limit: number,
): { rows: EmailActivityRow[]; summary: EmailActivityData["summary"] } {
  return { rows: matched.slice(0, limit), summary: summarizeEmailActivity(matched) };
}

export function providerFor(messageId: string | null): "brevo" | "resend" | "unknown" {
  if (!messageId) return "unknown";
  return /mailin|brevo/i.test(messageId) ? "brevo" : "resend";
}

export function firstRecipient(payload: OutboxRow["payload"]): string {
  const list = payload?.recipients;
  const email = Array.isArray(list) ? String(list[0] ?? "").trim() : "";
  return email || String(payload?.recipientHrId ?? "").trim() || "(routed)";
}

export async function getEmailActivity(options: EmailActivityOptions = {}): Promise<EmailActivityData> {
  const supabase = getSupabaseAdmin();
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const days = options.days && options.days > 0 ? options.days : 7;
  const search = (options.search ?? "").trim().toLowerCase();

  // Spine: what Phoenix tried to send across the WHOLE window, most recent first. Both ends of the
  // window are pinned to the same instant so every page of the scan sees the same table.
  const windowEndMs = Date.now();
  const outbox = await loadWindowOutbox(
    supabase,
    new Date(windowEndMs - days * 24 * 60 * 60 * 1000).toISOString(),
    new Date(windowEndMs).toISOString(),
  );

  // Engagement events for those sends, keyed on provider_message_id.
  const messageIds = Array.from(new Set(outbox.map((row) => row.provider_message_id).filter((id): id is string => Boolean(id))));
  const byMessage = new Map<string, Aggregate>();
  for (const idBatch of chunk(messageIds, IN_FILTER_CHUNK_SIZE)) {
    const { data: eventData, error: eventError } = await supabase
      .from("email_delivery_events")
      .select("provider_message_id,status,occurred_at")
      .in("provider_message_id", idBatch);
    if (eventError) throw eventError;
    for (const event of (eventData ?? []) as DeliveryEventRow[]) {
      const key = event.provider_message_id;
      if (!key) continue;
      const agg = byMessage.get(key) ?? { bounced: false, clicked: false, delivered: false, lastActivityAt: null, opened: false };
      if (event.status === "delivered") agg.delivered = true;
      if (event.status === "opened") agg.opened = true;
      if (event.status === "clicked") agg.clicked = true;
      if (event.status === "bounced" || event.status === "complained") agg.bounced = true;
      if (event.occurred_at && (!agg.lastActivityAt || event.occurred_at > agg.lastActivityAt)) agg.lastActivityAt = event.occurred_at;
      byMessage.set(key, agg);
    }
  }

  // Resolve recipient emails → employee names.
  const emails = Array.from(new Set(outbox.map((row) => firstRecipient(row.payload)).filter((email) => email.includes("@"))));
  const nameByEmail = new Map<string, string>();
  for (const emailBatch of chunk(emails, IN_FILTER_CHUNK_SIZE)) {
    const { data: employees } = await supabase.from("employees").select("full_name,work_email").in("work_email", emailBatch);
    for (const employee of (employees ?? []) as Array<{ full_name: string | null; work_email: string | null }>) {
      const key = employee.work_email?.trim().toLowerCase();
      if (key && employee.full_name) nameByEmail.set(key, employee.full_name);
    }
  }

  const matched: EmailActivityRow[] = [];
  for (const row of outbox) {
    const recipientEmail = firstRecipient(row.payload);
    const recipientName = nameByEmail.get(recipientEmail.toLowerCase()) ?? null;
    const subject = row.payload?.title ?? row.payload?.subject ?? null;
    const provider = providerFor(row.provider_message_id);
    const agg = (row.provider_message_id && byMessage.get(row.provider_message_id)) || { bounced: false, clicked: false, delivered: false, lastActivityAt: null, opened: false };
    const sendStatus = row.status ?? "unknown";

    if (options.provider && options.provider !== "all" && provider !== options.provider) continue;
    if (search && !recipientEmail.toLowerCase().includes(search) && !(recipientName ?? "").toLowerCase().includes(search) && !(subject ?? "").toLowerCase().includes(search)) continue;
    if (options.activity === "opened" && !agg.opened) continue;
    if (options.activity === "clicked" && !agg.clicked) continue;
    if (options.activity === "bounced" && !agg.bounced && sendStatus !== "failed") continue;
    if (options.activity === "not_sent" && sendStatus === "sent") continue;

    matched.push({
      bounced: agg.bounced,
      clicked: agg.clicked,
      delivered: agg.delivered,
      failedReason: sendStatus === "failed" || sendStatus === "skipped" ? row.last_error : null,
      id: row.id,
      lastActivityAt: agg.lastActivityAt,
      opened: agg.opened,
      provider,
      recipientEmail,
      recipientName,
      sendStatus,
      sentAt: row.sent_at,
      subject,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    ...buildEmailActivityPage(matched, limit),
  };
}
