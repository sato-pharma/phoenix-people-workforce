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

/**
 * The first attempt, on the request path.
 *
 * 🔴 IT MUST SIT ABOVE WHAT A SUPABASE ROUND TRIP ACTUALLY COSTS ON THIS CONTAINER, AND 3 SECONDS
 * DID NOT. It was 3_000 from 23 Oct 2026 to 26 Oct, chosen as "short, because it runs on somebody's
 * request" — which is the right instinct and was the wrong number. Measured on production
 * 26 Oct 2026, 09:31–09:33 UTC, from `process_health`'s own `timings.supabase.fetch` (the client's
 * round trip, not the query):
 *
 *     09:31  2,060 calls   p50 1,396 ms   p95 2,988 ms   max 8,061 ms
 *     09:32  2,266 calls   p50 1,998 ms   p95 3,494 ms   max 5,762 ms
 *     09:33  2,143 calls   p50 1,760 ms   p95 3,512 ms   max 5,680 ms
 *
 * A 3-second budget sits between that p50 and that p95, so it was aborting ordinary writes — 13
 * `supabase.fetch.timeout` in those three minutes, every elapsed reading 3,000–3,107 ms, all of
 * them FIRST attempts. And the database was never the reason: `pg_stat_statements` on
 * `ozucdzovmcqvepbozvqf` put the four inserts behind those aborts at a mean of 0.5–3.3 ms and a
 * worst case of 118.8 ms over 8,626 calls. The whole three seconds was transport.
 *
 * 8_000 clears the measured p95 with better than twice the margin, covers the worst round trip seen,
 * and stays under both `OUTBOX_RETRY_TIMEOUT_MS` (or the retry would add nothing) and
 * `supabaseRequestTimeoutMs` in `src/lib/supabase/server.ts`. Raising it is CHEAPER on the request
 * path than leaving it, not dearer — see `persistThroughOutbox`.
 */
export const OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS = 8_000;

/** The retry, the queue write and the drain. Nothing is waiting on these by the time they run. */
export const OUTBOX_RETRY_TIMEOUT_MS = 10_000;

/**
 * How late the first attempt may end and still count as having SPENT its budget rather than failed.
 *
 * The slack is for the abort timer firing late under event-loop pressure, which this container has:
 * `eventLoopDelayMs` max was 920 / 811 / 1,725 ms in the same three minutes measured above. Being
 * generous here is the safe direction — it sends a borderline case to the queue, which always works.
 */
export const OUTBOX_FIRST_ATTEMPT_SPENT_SLACK_MS = 250;

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

/**
 * Did the first attempt SPEND its whole budget, rather than fail inside it? Pure, so it is tested
 * without a clock.
 *
 * The distinction decides whether a probe and a retry are worth running on the same request — not
 * whether the write survives, which the queue guarantees either way.
 */
export function firstAttemptSpentItsBudget(elapsedMs: number): boolean {
  return elapsedMs >= OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS - OUTBOX_FIRST_ATTEMPT_SPENT_SLACK_MS;
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
 *
 * 🔴 A FIRST ATTEMPT THAT SPENT ITS WHOLE BUDGET IS QUEUED AT ONCE — NO PROBE, NO RETRY ON THAT
 * REQUEST. The probe and the retry are two further round trips, so running them behind an attempt
 * that has already held the request for its full budget was what made the old 3-second cap expensive
 * rather than cheap: a single write could occupy one request for 3 s + 10 s + 10 s + a 10 s queue
 * write. Queueing immediately does the same job with nobody waiting at all — the drain probes
 * `alreadyLanded` before it lands anything, so the duplicate guard is not weakened, only moved off
 * the request. Worst case on the request path falls from ~33 s to ~18 s even as the budget rises.
 *
 * An attempt that failed INSIDE its budget — a PostgREST rejection, a gateway 5xx, a reset
 * connection — still gets the probe and the patient retry. That is the database-restart case the
 * file was built for (four restarts on 22 Oct 2026), and there a second attempt seconds later often
 * lands.
 */
export async function persistThroughOutbox<TPayload>(
  queue: OutboxQueue<TPayload>,
  payload: TPayload,
  onSuccess?: () => void,
): Promise<unknown | null> {
  const startedAt = Date.now();
  try {
    await queue.land(payload, OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS);
    onSuccess?.();
    return null;
  } catch (firstError) {
    if (firstAttemptSpentItsBudget(Date.now() - startedAt)) {
      if (queue.queueable?.(firstError) ?? true) await queueOutboxWrite(queue, payload, firstError);
      return firstError;
    }
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
