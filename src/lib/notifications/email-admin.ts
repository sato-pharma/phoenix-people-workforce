import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type EmailAdminDelivery = {
  attempts: number;
  eventType: string | null;
  id: string;
  lastError: string | null;
  module: string | null;
  nextAttemptAt: string | null;
  recipient: string | null;
  recipientHrId: string | null;
  sentAt: string | null;
  status: "pending" | "sent" | "failed" | "skipped" | "retrying";
  subject: string | null;
  updatedAt: string | null;
};

export type EmailAdminSummary = {
  failedCount: number;
  pendingCount: number;
  retryingCount: number;
  sentCount: number;
  skippedCount: number;
};

export type EmailAdminControlCenter = {
  deliveries: EmailAdminDelivery[];
  hasMoreDeliveries: boolean;
  summary: EmailAdminSummary;
};

const EMAIL_DELIVERY_LIMIT = 200;
const EMAIL_STATUSES = ["sent", "pending", "failed", "skipped", "retrying"] as const;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanHrId(value: unknown) {
  return canonicalHrIdForDisplay(cleanText(value)) ?? "";
}

function deliveryStatus(value: unknown): EmailAdminDelivery["status"] {
  const status = cleanText(value);
  return (EMAIL_STATUSES as readonly string[]).includes(status) ? (status as EmailAdminDelivery["status"]) : "pending";
}

function tableMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return text.includes("schema cache") || text.includes("does not exist") || text.includes("could not find the table");
}

// head:true asks Postgrest for the row count only (no rows returned), so five status
// counts over the whole table costs about the same as one — no need to derive the
// summary from the capped delivery page below and risk undercounting past the cap.
async function emailDeliveryStatusCounts(): Promise<EmailAdminSummary> {
  const empty: EmailAdminSummary = { failedCount: 0, pendingCount: 0, retryingCount: 0, sentCount: 0, skippedCount: 0 };
  try {
    const supabase = getSupabaseAdmin();
    const results = await Promise.all(
      EMAIL_STATUSES.map((status) =>
        supabase
          .from("notification_deliveries")
          .select("id", { count: "exact", head: true })
          .eq("channel", "email")
          .eq("status", status),
      ),
    );
    const counts = { ...empty };
    EMAIL_STATUSES.forEach((status, index) => {
      const { error, count } = results[index];
      if (error) throw error;
      const key = `${status === "sent" ? "sentCount" : status === "pending" ? "pendingCount" : status === "failed" ? "failedCount" : status === "skipped" ? "skippedCount" : "retryingCount"}` as keyof EmailAdminSummary;
      counts[key] = count ?? 0;
    });
    return counts;
  } catch (error) {
    if (!tableMissing(error)) throw error;
    return empty;
  }
}

async function listEmailDeliveries(): Promise<{ deliveries: EmailAdminDelivery[]; hasMore: boolean }> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_deliveries")
      .select(
        "id,attempts,last_error,next_attempt_at,recipient_address,recipient_hr_id,sent_at,status,updated_at,notification_events(module,event_type,subject)",
      )
      .eq("channel", "email")
      .order("updated_at", { ascending: false })
      .limit(EMAIL_DELIVERY_LIMIT + 1);
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];
    const hasMore = rows.length > EMAIL_DELIVERY_LIMIT;
    const deliveries = rows.slice(0, EMAIL_DELIVERY_LIMIT).map((row) => {
      const event = row.notification_events as Record<string, unknown> | null;
      const hrId = cleanHrId(row.recipient_hr_id);
      return {
        attempts: Number(row.attempts ?? 0),
        eventType: cleanText(event?.event_type) || null,
        id: cleanText(row.id),
        lastError: cleanText(row.last_error) || null,
        module: cleanText(event?.module) || null,
        nextAttemptAt: cleanText(row.next_attempt_at) || null,
        recipient: cleanText(row.recipient_address) || hrId || null,
        recipientHrId: hrId || null,
        sentAt: cleanText(row.sent_at) || null,
        status: deliveryStatus(row.status),
        subject: cleanText(event?.subject) || null,
        updatedAt: cleanText(row.updated_at) || null,
      };
    });
    return { deliveries, hasMore };
  } catch (error) {
    if (!tableMissing(error)) throw error;
    return { deliveries: [], hasMore: false };
  }
}

/**
 * Read-only email delivery status for admins: which notification emails actually went
 * out (sent) vs. didn't (pending/failed/skipped/retrying), most recent first. Mirrors
 * getTelegramAdminControlCenter's shape but has no connections/policies/kill-switch
 * concept — every employee has an email by virtue of their account, unlike Telegram's
 * opt-in per-user connection flow — so this is intentionally simpler and pure read-only.
 */
export async function getEmailAdminControlCenter(): Promise<EmailAdminControlCenter> {
  const [summary, { deliveries, hasMore }] = await Promise.all([
    emailDeliveryStatusCounts(),
    listEmailDeliveries(),
  ]);
  return { deliveries, hasMoreDeliveries: hasMore, summary };
}
