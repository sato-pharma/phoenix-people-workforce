import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * ONE OUTBOX MECHANISM, FOR EVERY WRITE THAT MUST NOT BE LOST.
 *
 * Built for the audit trail on 23 Oct 2026 and generalised the same day, when the cause of that
 * loss turned out not to be the audit trail's business at all: production Postgres restarted FOUR
 * times between 11:30 and 14:25 Cairo on 22 October (`database_restarted`, postmaster start moving
 * at 08:30, 08:51, 09:33 and 11:25 UTC), with Cloudflare 520s and 521s at the edge. The database
 * was down, not slow. Everything writing through a short client timeout in those minutes lost what
 * it was writing, and only the audit log had anywhere to put it.
 *
 * So the mechanism lives here and the domains supply the parts that differ: which table queues the
 * work, how a payload is written for real, and whether it had already landed.
 *
 * THE THREE PROPERTIES THAT MATTER, and why each is here rather than in a caller:
 *
 *   never lost       a write that fails twice is parked with its whole payload and retried on a
 *                    doubling back-off, for ever. A row that cannot be written today is still the
 *                    only record that something happened.
 *   never doubled    a client-side abort is the CLIENT giving up, not Postgres rolling back, so
 *                    every retry asks `alreadyLanded` first. Without that, "never lose a write"
 *                    quietly becomes "do some of them twice" — which for a notification means a
 *                    real second email or Telegram message to a real person.
 *   never scheduled  no cron: cron-job.org and Healthchecks have no slot free, and a queue drained
 *                    off its own domain's successful traffic is self-healing and costs nothing at
 *                    rest. The database is demonstrably answering at the moment a drain starts.
 *
 * Each domain keeps its OWN table rather than sharing one with a `kind` column. The audit queue was
 * already live in production when this was generalised, and dropping it to merge the two would have
 * left the serving build writing to a table that no longer existed — a window with the exact
 * behaviour this file exists to remove.
 */

/** The first attempt, on the request path. Short on purpose: nothing waits on durability here. */
export const OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS = 3_000;

/** The retry, the queue write and the drain. Nothing is waiting on these by the time they run. */
export const OUTBOX_RETRY_TIMEOUT_MS = 10_000;

/** Rows per opportunistic drain. Small: this runs on the back of somebody's real request. */
export const OUTBOX_DRAIN_BATCH = 5;

/** At most one drain per process per this long, however much traffic there is. */
export const OUTBOX_DRAIN_INTERVAL_MS = 30_000;

/** One unwritable row must never soak up every drain, so the back-off is capped here. */
export const OUTBOX_MAX_BACKOFF_MS = 60 * 60 * 1000;

export type OutboxQueue<TPayload> = {
  /** The queue table: payload jsonb, attempts, last_error, next_attempt_at, created_at. */
  table: string;
  /** Narrow a stored `jsonb` payload, or null when nothing can be done with it. */
  read: (payload: unknown) => TPayload | null;
  /**
   * Write the payload for real, with the given per-request timeout. Throws on failure, like the
   * live path it stands in for. The timeout is passed in rather than fixed because the FIRST
   * attempt runs on somebody's request and the later ones do not.
   */
  land: (payload: TPayload, timeoutMs: number) => Promise<void>;
  /** Did the attempt that timed out actually commit? A failure here answers "no" — see below. */
  alreadyLanded: (payload: TPayload) => Promise<boolean>;
  /**
   * Is this failure worth queueing? Default yes. A domain says no for a failure a retry can never
   * fix — a table that does not exist on this schema — because queueing one of those parks a row
   * that backs off for ever and is never written.
   */
  queueable?: (error: unknown) => boolean;
};

/**
 * Doubling back-off in minutes — 1, 2, 4, 8, 16, 32, then an hour for ever.
 *
 * Never "give up": the point of the queue is that the write survives, and an hourly retry costs one
 * indexed read on a drain that was going to run anyway.
 */
export function nextAttemptDelayMs(attempts: number): number {
  const minutes = 2 ** Math.max(0, attempts - 1);
  return Math.min(minutes * 60_000, OUTBOX_MAX_BACKOFF_MS);
}

/** Should this process start a drain now? Pure, so the throttle is tested without a clock. */
export function shouldDrainNow(lastDrainAt: number, now: number, draining: boolean): boolean {
  if (draining) return false;
  return now - lastDrainAt >= OUTBOX_DRAIN_INTERVAL_MS;
}

/** The failure as one short readable line. A PostgREST rejection is a plain object, not an `Error`. */
export function describeOutboxError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    const parts = [record.code, record.message].filter((part) => typeof part === "string");
    if (parts.length > 0) return parts.join(" ").slice(0, 500);
  }
  return String(error ?? "unknown").slice(0, 500);
}

/**
 * Park a payload that could not be written. Returns whether it is safely queued.
 *
 * Wrapped end to end: a queue write that throws must never become a second, worse failure on top of
 * the one it is handling. A `false` degrades to exactly the behaviour that existed before — the
 * caller's log line, and a lost write.
 */
export async function queueOutboxWrite<TPayload>(
  queue: OutboxQueue<TPayload>,
  payload: TPayload,
  lastError: unknown,
): Promise<boolean> {
  try {
    const supabase = getSupabaseAdmin({ requestTimeoutMs: OUTBOX_RETRY_TIMEOUT_MS });
    const { error } = await supabase.from(queue.table).insert({
      last_error: describeOutboxError(lastError),
      payload,
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Try the write on the request path, then once more with room to breathe, then queue it.
 *
 * Returns the error that ended it, or null when the write landed (or had already landed). This is
 * the whole contract a caller needs: one call, and the write is either done or safely queued.
 */
export async function persistThroughOutbox<TPayload>(
  queue: OutboxQueue<TPayload>,
  payload: TPayload,
  onSuccess?: () => void,
): Promise<unknown | null> {
  try {
    await queue.land(payload, OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS);
    onSuccess?.();
    return null;
  } catch (firstError) {
    if (await queue.alreadyLanded(payload)) return null;
    try {
      await queue.land(payload, OUTBOX_RETRY_TIMEOUT_MS);
      onSuccess?.();
      return null;
    } catch (retryError) {
      const failure = retryError ?? firstError;
      if (queue.queueable?.(failure) ?? true) await queueOutboxWrite(queue, payload, failure);
      return retryError;
    }
  }
}

/**
 * Write out as many due rows as the batch allows. A row is deleted the moment its write lands — or
 * the moment the probe shows it had landed all along — and pushed out on the back-off otherwise.
 *
 * `only` lands just the rows whose payload it accepts, DUE OR NOT: a domain that must have every row
 * for one subject written before it moves on (a payroll run about to confirm Part 2) cannot wait out
 * an hour of back-off. A row it does not accept is left exactly as it was.
 */
export async function drainOutbox<TPayload>(
  queue: OutboxQueue<TPayload>,
  limit = OUTBOX_DRAIN_BATCH,
  only?: (payload: TPayload) => boolean,
): Promise<{ drained: number; deferred: number }> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: OUTBOX_RETRY_TIMEOUT_MS });
  let select = supabase.from(queue.table).select("id, payload, attempts");
  if (!only) select = select.lte("next_attempt_at", new Date().toISOString());
  const { data, error } = await select.order("created_at", { ascending: true }).limit(limit);

  if (error || !Array.isArray(data) || data.length === 0) return { deferred: 0, drained: 0 };

  let drained = 0;
  let deferred = 0;

  for (const row of data as { id: string; payload: unknown; attempts: number }[]) {
    const payload = queue.read(row.payload);
    if (payload && only && !only(payload)) continue;
    if (!payload) {
      // Nothing a retry can do with it, and leaving it would block the queue head for ever.
      await supabase.from(queue.table).delete().eq("id", row.id);
      logError("Outbox row is unreadable and was dropped", {
        labels: { event: "outbox_payload_unreadable", table: queue.table },
        context: { outboxId: row.id },
      });
      continue;
    }

    let landed = false;
    let failure: unknown = null;
    try {
      if (await queue.alreadyLanded(payload)) {
        landed = true;
      } else {
        await queue.land(payload, OUTBOX_RETRY_TIMEOUT_MS);
        landed = true;
      }
    } catch (error_) {
      failure = error_;
    }

    if (landed) {
      await supabase.from(queue.table).delete().eq("id", row.id);
      drained += 1;
      continue;
    }

    if (!(queue.queueable?.(failure) ?? true)) {
      // A retry can never fix it, and leaving it would block the queue head for ever.
      await supabase.from(queue.table).delete().eq("id", row.id);
      logError("Outbox row cannot be written on this schema and was dropped", {
        labels: { event: "outbox_write_unwritable", table: queue.table },
        context: { outboxId: row.id },
        error: failure,
      });
      continue;
    }

    const attempts = (row.attempts ?? 0) + 1;
    await supabase
      .from(queue.table)
      .update({
        attempts,
        last_error: describeOutboxError(failure),
        next_attempt_at: new Date(Date.now() + nextAttemptDelayMs(attempts)).toISOString(),
      })
      .eq("id", row.id);
    deferred += 1;
  }

  return { deferred, drained };
}

/**
 * A per-process, per-queue throttle around `drainOutbox`, fired and forgotten.
 *
 * Called from the SUCCESS path of a real write: the database is demonstrably answering at that
 * moment, which is when a queued row has the best chance of landing. Never awaited — the caller's
 * request does not wait on somebody else's queued write.
 */
export function makeOpportunisticDrain<TPayload>(queue: OutboxQueue<TPayload>): () => void {
  let lastDrainAt = 0;
  let draining = false;
  return () => {
    const now = Date.now();
    if (!shouldDrainNow(lastDrainAt, now, draining)) return;
    lastDrainAt = now;
    draining = true;
    void drainOutbox(queue)
      .catch(() => {
        // The queue keeps the row; the next successful write tries again.
      })
      .finally(() => {
        draining = false;
      });
  };
}
