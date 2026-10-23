import {
  makeOpportunisticDrain,
  type OutboxQueue,
  persistThroughOutbox,
} from "@/lib/platform/write-outbox";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * THE NOTIFICATION WRITES THAT MUST SURVIVE A DATABASE RESTART.
 *
 * Owner, 23 Oct 2026, after the audit outbox shipped and the cause turned out to be four
 * production Postgres restarts between 11:30 and 14:25 Cairo on 22 October: "protect the
 * notification writes with the same outbox". The mechanism is `src/lib/platform/write-outbox.ts`.
 *
 * 🔴 THE DELIVERY RECORD IS THE DANGEROUS ONE, AND IT IS DANGEROUS IN THE OPPOSITE DIRECTION TO
 * THE AUDIT LOG. A lost audit row is a missing record. A lost `notification_deliveries` row is a
 * SECOND EMAIL OR TELEGRAM MESSAGE to a real person: `upsertDelivery` is what records that a send
 * succeeded, it swallowed its own failure with a log line, and the retry drain re-sends any row
 * still sitting open. So an outage during the status write did not merely lose bookkeeping — it
 * armed a duplicate send for the next drain. That is why this queue exists and why its rows are
 * upserts on `idempotency_key`: replaying one is harmless, losing one is not.
 *
 * TWO QUEUES, not one. `notification_events` rows are keyed on `event_key` and
 * `notification_deliveries` rows on `idempotency_key`, and each is its own natural landing probe —
 * the key either exists or it does not, which is a far better answer than the audit trail's
 * timestamp-and-summary probe can give.
 */

export const NOTIFICATION_OUTBOX_TABLE = "notification_write_outbox";

/** Which write a queued row replays. The payload shapes have nothing in common, so this discriminates. */
export type QueuedNotificationWrite =
  | { kind: "notification_event"; eventKey: string; row: Record<string, unknown> }
  | { kind: "notification_delivery"; idempotencyKey: string; row: Record<string, unknown> };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * A stored payload is usable only if it still names its key and carries a row to write.
 *
 * Read as `unknown`: this came back out of a `jsonb` column a previous release wrote, so the
 * declared type is a claim about what should be there rather than a fact about what is.
 */
export function readQueuedNotificationWrite(payload: unknown): QueuedNotificationWrite | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { kind?: unknown; eventKey?: unknown; idempotencyKey?: unknown; row?: unknown };
  const row = candidate.row;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if (candidate.kind === "notification_event" && nonEmptyString(candidate.eventKey)) {
    return { eventKey: candidate.eventKey, kind: "notification_event", row: row as Record<string, unknown> };
  }
  if (candidate.kind === "notification_delivery" && nonEmptyString(candidate.idempotencyKey)) {
    return {
      idempotencyKey: candidate.idempotencyKey,
      kind: "notification_delivery",
      row: row as Record<string, unknown>,
    };
  }
  return null;
}

/**
 * Is the row already there?
 *
 * Both tables carry a unique key, so this is an exact lookup rather than the audit trail's
 * approximate one. A probe that FAILS answers "no": for `notification_events` a duplicate is
 * refused by the unique key anyway, and for `notification_deliveries` the write is an upsert on
 * that key, so replaying either is safe while losing either is not.
 */
export async function notificationWriteAlreadyLanded(payload: QueuedNotificationWrite): Promise<boolean> {
  try {
    const supabase = getSupabaseAdmin({ requestTimeoutMs: 10_000 });
    const { data, error } =
      payload.kind === "notification_event"
        ? await supabase.from("notification_events").select("id").eq("event_key", payload.eventKey).limit(1)
        : await supabase
            .from("notification_deliveries")
            .select("id")
            .eq("idempotency_key", payload.idempotencyKey)
            .eq("status", String(payload.row.status ?? ""))
            .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/**
 * A failure a retry can never fix: the table is not in this schema at all.
 *
 * 🔴 DELIBERATELY NARROWER THAN `schemaMissing` IN `system.ts`, which also returns true for ANY
 * error text containing the table's own name — and a PostgREST error about a table usually does.
 * That is tolerable where it only decides whether to log; here it would decide whether to KEEP a
 * write, and a real outage error naming the table would be thrown away as "schema missing".
 */
export function notificationTableMissing(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes("could not find the table") ||
    text.includes("schema cache") ||
    text.includes("pgrst205") ||
    (text.includes("relation") && text.includes("does not exist"))
  );
}

/** A unique violation means the row is already there — the write succeeded, just not by our hand. */
function isDuplicate(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return true;
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return text.includes("duplicate key") || text.includes("unique constraint");
}

export const notificationWriteQueue: OutboxQueue<QueuedNotificationWrite> = {
  alreadyLanded: notificationWriteAlreadyLanded,
  land: async (payload, timeoutMs) => {
    const supabase = getSupabaseAdmin({ requestTimeoutMs: timeoutMs });
    const { error } =
      payload.kind === "notification_event"
        ? await supabase.from("notification_events").upsert(payload.row, { onConflict: "event_key" })
        : await supabase.from("notification_deliveries").upsert(payload.row, { onConflict: "idempotency_key" });
    if (error && !isDuplicate(error)) throw error;
  },
  queueable: (error) => !notificationTableMissing(error),
  read: readQueuedNotificationWrite,
  table: NOTIFICATION_OUTBOX_TABLE,
};

export const maybeDrainNotificationOutbox = makeOpportunisticDrain(notificationWriteQueue);

/** Write one notification row, surviving an outage. Returns the error that ended it, or null. */
export function persistNotificationWrite(payload: QueuedNotificationWrite): Promise<unknown | null> {
  return persistThroughOutbox(notificationWriteQueue, payload, maybeDrainNotificationOutbox);
}
