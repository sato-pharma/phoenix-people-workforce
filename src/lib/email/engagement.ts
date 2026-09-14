import { getSupabaseAdmin } from "@/lib/supabase/server";

// Per-email ACTIVITY — each email's exact situation: sent → delivered → opened → clicked (or
// failed/bounced). Built by correlating what Phoenix sent — system notifications (notification_outbox)
// and Sato Email composer sends (sato_email_sends) — with the provider webhook events
// (email_delivery_events, fed by BOTH the Resend and Brevo webhooks) on the shared provider_message_id.
// Admin-only; the calling page enforces the `communication:read` gate.

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

type DeliveryEventRow = { occurred_at: string | null; provider_message_id: string | null; recipients: string[] | null; status: string | null };

export type Aggregate = { bounced: boolean; clicked: boolean; delivered: boolean; lastActivityAt: string | null; opened: boolean };

type ComposerOutcome = { batchIndex?: number | null; id?: string | null; reason?: string | null; recipients?: number | null; status?: string | null };

export type ComposerSendRow = {
  created_at: string;
  id: string;
  outcomes: ComposerOutcome[] | null;
  recipient_emails: string[] | null;
  subject: string | null;
};

/** One person on a composer send, with the provider message their own batch went out as. */
export type ComposerRecipient = {
  failedReason: string | null;
  id: string;
  messageId: string | null;
  recipientEmail: string;
  sendStatus: string;
  sentAt: string;
  subject: string | null;
};

// Composer sends are a handful a day; this is headroom, and like the outbox ceiling it throws rather
// than returning a short list nobody could tell from a true one.
const MAX_WINDOW_COMPOSER_SENDS = 1000;

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

/**
 * Every person on one Sato Email composer send.
 *
 * The composer never touches notification_outbox — it hands mail straight to the provider and logs
 * one row per send in sato_email_sends: the recipients as one flat list, and one outcome per batch.
 * Until this existed those sends were missing from Email Activity entirely, whichever provider
 * carried them. The plan cuts batches as consecutive slices of that same list
 * (buildSatoEmailSendPlan), so walking the outcomes in batch order and taking each one's
 * `recipients` count hands every person back the message id their own batch went out as.
 */
export function expandComposerSend(send: ComposerSendRow): ComposerRecipient[] {
  const emails = (send.recipient_emails ?? []).map((email) => String(email ?? "").trim()).filter(Boolean);
  const outcomes = [...(send.outcomes ?? [])].sort((left, right) => (left.batchIndex ?? 0) - (right.batchIndex ?? 0));
  const person = (recipientEmail: string, outcome: ComposerOutcome | null): ComposerRecipient => {
    const sendStatus = outcome?.status ?? "unknown";
    return {
      failedReason: sendStatus === "sent" ? null : outcome?.reason ?? null,
      id: `${send.id}:${recipientEmail.toLowerCase()}`,
      messageId: outcome?.id ?? null,
      recipientEmail,
      sendStatus,
      sentAt: send.created_at,
      subject: send.subject,
    };
  };

  const rows: ComposerRecipient[] = [];
  let cursor = 0;
  for (const outcome of outcomes) {
    const count = Math.max(0, Math.floor(Number(outcome.recipients ?? 0)));
    for (const recipientEmail of emails.slice(cursor, cursor + count)) rows.push(person(recipientEmail, outcome));
    cursor += count;
  }
  // Anyone no outcome accounts for was still meant to get the email: shown with no message id and
  // an unknown status, never dropped.
  for (const recipientEmail of emails.slice(cursor)) rows.push(person(recipientEmail, null));
  return rows;
}

function emptyAggregate(): Aggregate {
  return { bounced: false, clicked: false, delivered: false, lastActivityAt: null, opened: false };
}

export function foldDeliveryEvent(agg: Aggregate, event: { occurred_at: string | null; status: string | null }): Aggregate {
  if (event.status === "delivered") agg.delivered = true;
  if (event.status === "opened") agg.opened = true;
  if (event.status === "clicked") agg.clicked = true;
  if (event.status === "bounced" || event.status === "complained") agg.bounced = true;
  if (event.occurred_at && (!agg.lastActivityAt || event.occurred_at > agg.lastActivityAt)) agg.lastActivityAt = event.occurred_at;
  return agg;
}

// One provider message reaches a whole composer batch, and both webhooks record each event against the
// one person it happened to — so a composer row reads only its own person's events. Keying on the
// message alone would mark all 25 people in a batch "opened" the moment one of them opened it.
function messageRecipientKey(messageId: string, email: string) {
  return `${messageId}\n${email.trim().toLowerCase()}`;
}

async function loadWindowComposerSends(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  sinceIso: string,
  untilIso: string,
): Promise<ComposerSendRow[]> {
  const { data, error } = await supabase
    .from("sato_email_sends")
    .select("id,created_at,subject,recipient_emails,outcomes")
    .gte("created_at", sinceIso)
    .lt("created_at", untilIso)
    .order("created_at", { ascending: false })
    .limit(MAX_WINDOW_COMPOSER_SENDS + 1);
  if (error) throw error;
  const rows = (data ?? []) as ComposerSendRow[];
  if (rows.length > MAX_WINDOW_COMPOSER_SENDS) {
    throw new Error(`Email Activity window holds ${MAX_WINDOW_COMPOSER_SENDS}+ composer sends — refusing to show a partial count.`);
  }
  return rows;
}

export async function getEmailActivity(options: EmailActivityOptions = {}): Promise<EmailActivityData> {
  const supabase = getSupabaseAdmin();
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const days = options.days && options.days > 0 ? options.days : 7;
  const search = (options.search ?? "").trim().toLowerCase();

  // Spine: what Phoenix tried to send across the WHOLE window, most recent first. Both ends of the
  // window are pinned to the same instant so every page of the scan sees the same table. Two tables:
  // the outbox carries every system notification, sato_email_sends every composer email.
  const windowEndMs = Date.now();
  const sinceIso = new Date(windowEndMs - days * 24 * 60 * 60 * 1000).toISOString();
  const untilIso = new Date(windowEndMs).toISOString();
  const [outbox, composerSends] = await Promise.all([
    loadWindowOutbox(supabase, sinceIso, untilIso),
    loadWindowComposerSends(supabase, sinceIso, untilIso),
  ]);
  const composerRecipients = composerSends.flatMap(expandComposerSend);

  // Engagement events for those sends, keyed on provider_message_id — and, for composer batches, on
  // the person as well.
  const messageIds = Array.from(
    new Set(
      [...outbox.map((row) => row.provider_message_id), ...composerRecipients.map((row) => row.messageId)].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  );
  const byMessage = new Map<string, Aggregate>();
  const byMessageRecipient = new Map<string, Aggregate>();
  for (const idBatch of chunk(messageIds, IN_FILTER_CHUNK_SIZE)) {
    const { data: eventData, error: eventError } = await supabase
      .from("email_delivery_events")
      .select("provider_message_id,status,occurred_at,recipients")
      .in("provider_message_id", idBatch);
    if (eventError) throw eventError;
    for (const event of (eventData ?? []) as DeliveryEventRow[]) {
      const key = event.provider_message_id;
      if (!key) continue;
      byMessage.set(key, foldDeliveryEvent(byMessage.get(key) ?? emptyAggregate(), event));
      for (const recipient of event.recipients ?? []) {
        const personKey = messageRecipientKey(key, recipient);
        byMessageRecipient.set(personKey, foldDeliveryEvent(byMessageRecipient.get(personKey) ?? emptyAggregate(), event));
      }
    }
  }

  // Resolve recipient emails → employee names.
  const emails = Array.from(
    new Set(
      [...outbox.map((row) => firstRecipient(row.payload)), ...composerRecipients.map((row) => row.recipientEmail)].filter((email) =>
        email.includes("@"),
      ),
    ),
  );
  const nameByEmail = new Map<string, string>();
  for (const emailBatch of chunk(emails, IN_FILTER_CHUNK_SIZE)) {
    const { data: employees } = await supabase.from("employees").select("full_name,work_email").in("work_email", emailBatch);
    for (const employee of (employees ?? []) as Array<{ full_name: string | null; work_email: string | null }>) {
      const key = employee.work_email?.trim().toLowerCase();
      if (key && employee.full_name) nameByEmail.set(key, employee.full_name);
    }
  }

  const candidates: Array<{ at: string; row: EmailActivityRow }> = [];
  for (const row of outbox) {
    const recipientEmail = firstRecipient(row.payload);
    const agg = (row.provider_message_id && byMessage.get(row.provider_message_id)) || emptyAggregate();
    const sendStatus = row.status ?? "unknown";
    candidates.push({
      at: row.created_at,
      row: {
        bounced: agg.bounced,
        clicked: agg.clicked,
        delivered: agg.delivered,
        failedReason: sendStatus === "failed" || sendStatus === "skipped" ? row.last_error : null,
        id: row.id,
        lastActivityAt: agg.lastActivityAt,
        opened: agg.opened,
        provider: providerFor(row.provider_message_id),
        recipientEmail,
        recipientName: nameByEmail.get(recipientEmail.toLowerCase()) ?? null,
        sendStatus,
        sentAt: row.sent_at,
        subject: row.payload?.title ?? row.payload?.subject ?? null,
      },
    });
  }
  for (const person of composerRecipients) {
    const agg = (person.messageId && byMessageRecipient.get(messageRecipientKey(person.messageId, person.recipientEmail))) || emptyAggregate();
    candidates.push({
      at: person.sentAt,
      row: {
        bounced: agg.bounced,
        clicked: agg.clicked,
        delivered: agg.delivered,
        failedReason: person.failedReason,
        id: person.id,
        lastActivityAt: agg.lastActivityAt,
        opened: agg.opened,
        provider: providerFor(person.messageId),
        recipientEmail: person.recipientEmail,
        recipientName: nameByEmail.get(person.recipientEmail.toLowerCase()) ?? null,
        sendStatus: person.sendStatus,
        sentAt: person.sentAt,
        subject: person.subject,
      },
    });
  }
  // Newest first across both tables. The sort is stable, so the outbox's own id tie-break survives.
  candidates.sort((left, right) => (left.at === right.at ? 0 : left.at < right.at ? 1 : -1));

  const matched = candidates.map((candidate) => candidate.row).filter((row) => matchesEmailActivityFilters(row, { ...options, search }));

  return {
    generatedAt: new Date().toISOString(),
    ...buildEmailActivityPage(matched, limit),
  };
}

export function matchesEmailActivityFilters(row: EmailActivityRow, options: EmailActivityOptions): boolean {
  const search = (options.search ?? "").trim().toLowerCase();
  if (options.provider && options.provider !== "all" && row.provider !== options.provider) return false;
  if (
    search &&
    !row.recipientEmail.toLowerCase().includes(search) &&
    !(row.recipientName ?? "").toLowerCase().includes(search) &&
    !(row.subject ?? "").toLowerCase().includes(search)
  ) {
    return false;
  }
  if (options.activity === "opened" && !row.opened) return false;
  if (options.activity === "clicked" && !row.clicked) return false;
  if (options.activity === "bounced" && !row.bounced && row.sendStatus !== "failed") return false;
  if (options.activity === "not_sent" && row.sendStatus === "sent") return false;
  return true;
}
