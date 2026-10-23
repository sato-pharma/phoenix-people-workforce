import type { AuditLogInput } from "@/lib/admin/audit";
import {
  makeOpportunisticDrain,
  type OutboxQueue,
  OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS,
  OUTBOX_RETRY_TIMEOUT_MS,
  persistThroughOutbox,
} from "@/lib/platform/write-outbox";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * THE AUDIT TRAIL'S QUEUE. The mechanism is `src/lib/platform/write-outbox.ts`; this file is only
 * the three things that are specific to `audit_logs`.
 *
 * Why it exists: `insertAuditLog` ran on a 3-second client timeout with no retry and no queue, and
 * lost 109 rows in 21 days — 40 of them inside the three hours on 22 Oct 2026 when production
 * Postgres restarted four times. Account: `docs/observability.md`.
 */

export const AUDIT_OUTBOX_TABLE = "audit_log_outbox";
export const AUDIT_INSERT_TIMEOUT_MS = OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS;
export const AUDIT_INSERT_RETRY_TIMEOUT_MS = OUTBOX_RETRY_TIMEOUT_MS;

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
 * A stored payload is only usable if it still carries the two fields `audit_logs` requires.
 *
 * Read as `unknown`, not as a `Partial<QueuedAuditLog>`: this came back out of a `jsonb` column a
 * previous release wrote, so the declared type is a claim about what SHOULD be there and checking
 * against it would make these guards unreachable rather than true.
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
 * Did the write that timed out actually land?
 *
 * Reads through `idx_audit_logs_actor_entity` (actor_login_id, entity_type, entity_id) narrowed on
 * `created_at`, so it stays a cheap indexed lookup however large the table grows. A probe that
 * FAILS answers "no" on purpose: a duplicate audit row is readable and explicable, a missing one
 * is not.
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

export const auditLogQueue: OutboxQueue<QueuedAuditLog> = {
  alreadyLanded: (queued) => auditLogAlreadyLanded(queued.input, queued.attemptedAt),
  land: async (queued, timeoutMs) => {
    const supabase = getSupabaseAdmin({ requestTimeoutMs: timeoutMs });
    const { error } = await supabase.from("audit_logs").insert(auditLogRow(queued.input));
    if (error) throw error;
  },
  read: readQueuedAuditLog,
  table: AUDIT_OUTBOX_TABLE,
};

export const maybeDrainAuditLogOutbox = makeOpportunisticDrain(auditLogQueue);

/** Write one audit row, surviving an outage. Returns the error that ended it, or null. */
export function persistAuditLogThroughOutbox(input: AuditLogInput): Promise<unknown | null> {
  return persistThroughOutbox(
    auditLogQueue,
    { attemptedAt: new Date().toISOString(), input },
    maybeDrainAuditLogOutbox,
  );
}
