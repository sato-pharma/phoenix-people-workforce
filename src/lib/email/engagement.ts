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

// PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred ids
// can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
// HeadersOverflowError (crashed /admin/notifications/email-tracking in production, digest
// 2995304036@E394). Batch any .in() built from a large deduped array instead of passing it whole.
function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

  // Spine: what Phoenix tried to send, most recent first.
  const { data: outboxData, error: outboxError } = await supabase
    .from("notification_outbox")
    .select("id,status,provider_message_id,sent_at,last_error,payload,created_at")
    .gte("created_at", new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(500);
  if (outboxError) throw outboxError;
  const outbox = (outboxData ?? []) as OutboxRow[];

  // Engagement events for those sends, keyed on provider_message_id.
  const messageIds = Array.from(new Set(outbox.map((row) => row.provider_message_id).filter((id): id is string => Boolean(id))));
  const byMessage = new Map<string, Aggregate>();
  for (const batch of chunk(messageIds)) {
    const { data: eventData, error: eventError } = await supabase
      .from("email_delivery_events")
      .select("provider_message_id,status,occurred_at")
      .in("provider_message_id", batch);
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
  for (const batch of chunk(emails)) {
    const { data: employees } = await supabase.from("employees").select("full_name,work_email").in("work_email", batch);
    for (const employee of (employees ?? []) as Array<{ full_name: string | null; work_email: string | null }>) {
      const key = employee.work_email?.trim().toLowerCase();
      if (key && employee.full_name) nameByEmail.set(key, employee.full_name);
    }
  }

  const rows: EmailActivityRow[] = [];
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

    rows.push({
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
    if (rows.length >= limit) break;
  }

  return {
    generatedAt: new Date().toISOString(),
    rows,
    summary: {
      bounced: rows.filter((row) => row.bounced || row.sendStatus === "failed").length,
      clicked: rows.filter((row) => row.clicked).length,
      delivered: rows.filter((row) => row.delivered).length,
      notSent: rows.filter((row) => row.sendStatus !== "sent").length,
      opened: rows.filter((row) => row.opened).length,
      sent: rows.filter((row) => row.sendStatus === "sent").length,
      total: rows.length,
    },
  };
}
