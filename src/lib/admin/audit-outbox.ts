import type { AuditLogInput } from "@/lib/admin/audit";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * THE AUDIT TRAIL STOPS LOSING ROWS.
 *
 * `insertAuditLog` opens its client with a 3-second request timeout, and under load the insert is
 * aborted CLIENT-SIDE before PostgREST answers. Measured on production 23 Oct 2026: 109
 * `audit_persistence_failed` errors in 21 days, 40 of them on 22 Oct alone — and they are real
 * losses, not slow successes. The notification logged at 16:19 Cairo that day
 * (entity f67a82b2-fe70-4024-80b4-ca7e3f9a60dc) has NO `audit_logs` row, while its neighbours from
 * the same minute landed.
 *
 * So a failed audit write is now parked in `audit_log_outbox` with its whole payload and retried
 * until it lands. Owner's instruction, 23 Oct 2026: "both, plus never lose a row".
 *
 * 🔴 NO NEW CRON — ON PURPOSE. A scheduled drain would need a `scripts/cronjob-sync.mjs` entry, a
 * cron-job.org slot and a Healthchecks slot, and the project has none free. Instead the queue is
 * drained off real audit traffic: every successful audit write fire-and-forgets a small, bounded,
 * per-process-throttled drain. The system that fills the queue is the system that empties it, it
 * costs nothing at rest, and there is no schedule to rot.
 *
 * 🔴 A TIMED-OUT INSERT MAY STILL HAVE COMMITTED. The abort is the client giving up, not Postgres
 * rolling back — so every retry in here, and the one in `audit.ts`, probes for the row first
 * (`auditLogAlreadyLanded`). Without that probe "never lose a row" would simply have become "write
 * some rows twice", and `/admin/logs` would show the same act happening two or three times.
 */

export const AUDIT_OUTBOX_TABLE = "audit_log_outbox";

/** The first attempt, unchanged: the request path must not wait on the audit trail. */
export const AUDIT_INSERT_TIMEOUT_MS = 3_000;

/**
 * The retry, the queue write and the drain all get longer. Nothing is waiting on them — the retry
 * only runs after the fast attempt has already failed, and by then a slow write beats no write.
 */
export const AUDIT_INSERT_RETRY_TIMEOUT_MS = 10_000;

/** Rows per opportunistic drain. Small: this runs on the back of somebody's real request. */
export const AUDIT_OUTBOX_DRAIN_BATCH = 5;

/** At most one drain per process per this long, however much audit traffic there is. */
export const AUDIT_OUTBOX_DRAIN_INTERVAL_MS = 30_000;

/** One unwritable row must never soak up every drain, so the back-off is capped here. */
export const AUDIT_OUTBOX_MAX_BACKOFF_MS = 60 * 60 * 1000;

/** How far before the recorded attempt the landing probe looks, to absorb clock skew. */
const LANDING_PROBE_SLACK_MS = 10_000;

export type QueuedAuditLog = {
  /** The input exactly as the caller passed it, so a later attempt needs nothing else. */
  input: AuditLogInput;
  /** When the FIRST attempt began — the floor for the landing probe. */
  attemptedAt: string;
};

/** The `audit_logs` columns one input becomes. Shared, so the drain writes what the caller meant. */
export function auditLogRow(input: AuditLogInput) {
  return {
    actor_login_id: input.actorLoginId ?? "system",
    entity_id: input.entityId ?? null,
    entity_type: input.entityType,
    new_values: input.newValues ?? null,
    old_values: input.oldValues ?? null,
    summary: input.summary,
  };
}

/**
 * Doubling back-off in minutes — 1, 2, 4, 8, 16, 32, then an hour for ever.
 *
 * Never "give up": a row that cannot be written today is still the only record of something that
 * happened, and an hourly retry costs one indexed read on a drain that was going to run anyway.
 */
export function nextAttemptDelayMs(attempts: number): number {
  const minutes = 2 ** Math.max(0, attempts - 1);
  return Math.min(minutes * 60_000, AUDIT_OUTBOX_MAX_BACKOFF_MS);
}

/**
 * Should this process start a drain now? Pure, so the throttle is tested without a clock or a
 * database. `draining` is what stops two overlapping requests both starting one.
 */
export function shouldDrainNow(lastDrainAt: number, now: number, draining: boolean): boolean {
  if (draining) return false;
  return now - lastDrainAt >= AUDIT_OUTBOX_DRAIN_INTERVAL_MS;
}

/**
 * Did the write that timed out actually land?
 *
 * Reads through `idx_audit_logs_actor_entity` (actor_login_id, entity_type, entity_id) and narrows
 * on `created_at`, so it stays a cheap indexed lookup however large the table grows.
 *
 * 🔴 A PROBE THAT FAILS ANSWERS "NO", DELIBERATELY. The whole point of this file is that an audit
 * row is never lost; a duplicate row is readable and explicable, a missing one is not. So when the
 * probe itself times out we retry and accept the small chance of writing twice.
 */
export async function auditLogAlreadyLanded(input: AuditLogInput, attemptedAt: string): Promise<boolean> {
  try {
    const since = new Date(new Date(attemptedAt).getTime() - LANDING_PROBE_SLACK_MS).toISOString();
    const supabase = getSupabaseAdmin({ requestTimeoutMs: AUDIT_INSERT_RETRY_TIMEOUT_MS });
    let query = supabase
      .from("audit_logs")
      .select("id")
      .eq("actor_login_id", input.actorLoginId ?? "system")
      .eq("entity_type", input.entityType)
      .eq("summary", input.summary)
      .gte("created_at", since)
      .limit(1);
    query = input.entityId ? query.eq("entity_id", input.entityId) : query.is("entity_id", null);
    const { data, error } = await query;
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Park an audit row that could not be written. Returns whether it is safely queued.
 *
 * Wrapped end to end: a queue write that throws must never become a second, worse failure on top
 * of the one it was handling. The caller logs either way, so a false here degrades to exactly the
 * behaviour that existed before this file — a log line and a lost row.
 */
export async function queueAuditLog(input: AuditLogInput, attemptedAt: string, lastError: unknown): Promise<boolean> {
  try {
    const supabase = getSupabaseAdmin({ requestTimeoutMs: AUDIT_INSERT_RETRY_TIMEOUT_MS });
    const payload: QueuedAuditLog = { attemptedAt, input };
    const { error } = await supabase.from(AUDIT_OUTBOX_TABLE).insert({
      last_error: describeQueueError(lastError),
      payload,
    });
    return !error;
  } catch {
    return false;
  }
}

/** The failure, as one short readable line. Kept small: this column is for a human reading the queue. */
export function describeQueueError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    const parts = [record.code, record.message].filter((part) => typeof part === "string");
    if (parts.length > 0) return parts.join(" ").slice(0, 500);
  }
  return String(error ?? "unknown").slice(0, 500);
}

/**
 * A stored payload is only usable if it still carries the two fields `audit_logs` requires.
 *
 * Read as `unknown`, not as a `Partial<QueuedAuditLog>`: this came back out of a `jsonb` column
 * that a previous release wrote, so the declared type is a claim about what SHOULD be there and
 * checking against it would make these guards unreachable rather than true.
 */
export function readQueuedAuditLog(payload: unknown): QueuedAuditLog | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { attemptedAt?: unknown; input?: unknown };
  const input = candidate.input;
  if (!input || typeof input !== "object") return null;
  const fields = input as { entityType?: unknown; summary?: unknown };
  if (typeof fields.entityType !== "string" || fields.entityType === "") return null;
  if (typeof fields.summary !== "string") return null;
  const attemptedAt = typeof candidate.attemptedAt === "string" ? candidate.attemptedAt : new Date(0).toISOString();
  return { attemptedAt, input: input as AuditLogInput };
}

/**
 * Write out as many due rows as the batch allows. A row is deleted the moment its `audit_logs`
 * insert lands — or the moment the probe shows it had landed all along — and pushed out on the
 * back-off otherwise.
 */
export async function drainAuditLogOutbox(limit = AUDIT_OUTBOX_DRAIN_BATCH): Promise<{ drained: number; deferred: number }> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: AUDIT_INSERT_RETRY_TIMEOUT_MS });
  const { data, error } = await supabase
    .from(AUDIT_OUTBOX_TABLE)
    .select("id, payload, attempts")
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !Array.isArray(data) || data.length === 0) return { deferred: 0, drained: 0 };

  let drained = 0;
  let deferred = 0;

  for (const row of data as { id: string; payload: unknown; attempts: number }[]) {
    const queued = readQueuedAuditLog(row.payload);
    if (!queued) {
      // Nothing a retry can do with it, and leaving it would block the queue head for ever.
      await supabase.from(AUDIT_OUTBOX_TABLE).delete().eq("id", row.id);
      logError("Audit outbox row is unreadable and was dropped", {
        labels: { event: "audit_outbox_payload_unreadable" },
        context: { outboxId: row.id },
      });
      continue;
    }

    const landed = await auditLogAlreadyLanded(queued.input, queued.attemptedAt);
    if (landed) {
      await supabase.from(AUDIT_OUTBOX_TABLE).delete().eq("id", row.id);
      drained += 1;
      continue;
    }

    const { error: insertError } = await supabase.from("audit_logs").insert(auditLogRow(queued.input));
    if (!insertError) {
      await supabase.from(AUDIT_OUTBOX_TABLE).delete().eq("id", row.id);
      drained += 1;
      continue;
    }

    const attempts = (row.attempts ?? 0) + 1;
    await supabase
      .from(AUDIT_OUTBOX_TABLE)
      .update({
        attempts,
        last_error: describeQueueError(insertError),
        next_attempt_at: new Date(Date.now() + nextAttemptDelayMs(attempts)).toISOString(),
      })
      .eq("id", row.id);
    deferred += 1;
  }

  return { deferred, drained };
}

let lastDrainAt = 0;
let draining = false;

/**
 * Fire-and-forget the drain, at most once per `AUDIT_OUTBOX_DRAIN_INTERVAL_MS` per process.
 *
 * Called from the SUCCESS path of an audit write: the database is demonstrably answering at that
 * moment, which is exactly when a queued row has the best chance of landing. Never awaited — the
 * caller's request does not wait on somebody else's audit row.
 */
export function maybeDrainAuditLogOutbox(): void {
  const now = Date.now();
  if (!shouldDrainNow(lastDrainAt, now, draining)) return;
  lastDrainAt = now;
  draining = true;
  void drainAuditLogOutbox()
    .catch(() => {
      // The queue keeps the row; the next successful audit write tries again.
    })
    .finally(() => {
      draining = false;
    });
}
