// Recruitment / ATS — durable inbound-CV intake queue (ats_inbound_intake_queue).
//
// Receipt is decoupled from processing: the WhatsApp webhook and the email poller ENQUEUE a
// lightweight reference (never file bytes), and intake-worker.ts drains this queue, re-materializes
// the bytes, and runs ingestInboundCv. This gives the webhook a sub-second ack (so Meta never
// disables it under load) and gives BOTH channels retry-with-backoff + dead-lettering, so a
// transient failure (media 5xx, OpenAI blip, storage hiccup) is retried instead of lost.
//
// Mirrors the proven public.background_jobs pattern (service.ts + claim_next_background_job RPC).

import { recruitmentDb } from "@/lib/recruitment/db";
import type { WhatsAppSourceContext } from "@/lib/recruitment/candidate-source-context";

export type InboundQueueChannel = "whatsapp" | "email";
export type InboundQueueStatus = "queued" | "processing" | "done" | "dead";

// Payloads carry REFERENCES only — the worker downloads WhatsApp media by id and re-fetches the
// email by UID, so no (potentially large) bytes ever sit in a jsonb row.
export type WhatsAppQueuePayload = {
  kind: "whatsapp";
  wamid: string;
  from: string;
  messageType: string;
  mediaId: string;
  mimeType: string;
  filename: string | null;
  caption: string | null;
  contactName: string | null;
  forwarded: boolean;
  deliveredToPhoneNumberId: string | null;
  deliveredToDisplayNumber: string | null;
  // Assembled at webhook time (caption + the sender's preceding buffered messages) so the context
  // reflects what was true when the CV arrived, not minutes later when the worker runs.
  sourceContext: WhatsAppSourceContext | null;
};

export type EmailQueuePayload = {
  kind: "email";
  mailboxLabel: string;
  // The IMAP folder the UID lives in ("INBOX" or the junk folder) — the worker must open the same
  // folder to re-fetch, since a UID is only unique within a folder.
  folderPath: string;
  uid: number;
  messageId: string | null;
  // Set only for a multi-attachment email fan-out (Phase 2) — which attachment this row is.
  attachmentIndex?: number | null;
};

export type InboundQueuePayload = WhatsAppQueuePayload | EmailQueuePayload;

export type InboundQueueRow = {
  id: string;
  channel: InboundQueueChannel;
  provider_message_id: string;
  source: string;
  payload: InboundQueuePayload;
  status: InboundQueueStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
};

// Retry backoff: first failure waits BASE, then doubles, capped at MAX. `attempts` is the
// post-claim attempt number (the claim RPC increments before the worker runs), so attempt 1 is
// the first try; its failure schedules a BASE-length wait.
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;

export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
}

// A message is dead-lettered once it has used up its attempts. Pure so the boundary is testable.
export function shouldDeadLetter(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

/**
 * Enqueue one inbound item. Idempotent on (channel, provider_message_id): a redelivered webhook or
 * a re-seen UID is a no-op, so the same message is never queued twice. Returns whether a NEW row
 * was created (false = it was already queued/processed).
 */
export async function enqueueInbound(input: {
  channel: InboundQueueChannel;
  providerMessageId: string;
  source: string;
  payload: InboundQueuePayload;
}): Promise<{ enqueued: boolean }> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_inbound_intake_queue")
    .upsert(
      {
        channel: input.channel,
        payload: input.payload,
        provider_message_id: input.providerMessageId,
        source: input.source,
      },
      { ignoreDuplicates: true, onConflict: "channel,provider_message_id" },
    )
    .select("id");
  if (error) throw error;
  return { enqueued: Array.isArray(data) && data.length > 0 };
}

/**
 * Manually re-queue a dead-lettered row (admin "retry" action): resets it to queued with a fresh
 * attempt budget and an immediate next_attempt_at. Only a `dead` row is eligible — a queued/
 * processing row is already in flight. Returns whether a row was actually re-queued.
 */
export async function requeueInbound(id: string): Promise<boolean> {
  const supabase = recruitmentDb();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("ats_inbound_intake_queue")
    .update({ attempts: 0, finished_at: null, last_error: null, next_attempt_at: now, status: "queued", updated_at: now })
    .eq("id", id)
    .eq("status", "dead")
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export type DeadLetteredInboundRow = {
  id: string;
  channel: string;
  provider_message_id: string;
  last_error: string | null;
  attempts: number;
  created_at: string;
};

/** The dead-lettered rows for the admin intake-health panel (newest first). */
export async function listDeadLetteredInbound(limit = 50): Promise<DeadLetteredInboundRow[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_inbound_intake_queue")
    .select("id,channel,provider_message_id,last_error,attempts,created_at")
    .eq("status", "dead")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, limit));
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as DeadLetteredInboundRow[];
}

/** Atomically claim up to `limit` ready rows (queued+due, or a stale 'processing' left by a crash). */
export async function claimNextInbound(limit: number): Promise<InboundQueueRow[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase.rpc("claim_next_inbound_intake", { p_limit: Math.max(1, limit) });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as InboundQueueRow[];
}

export async function markInboundDone(id: string): Promise<void> {
  const supabase = recruitmentDb();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("ats_inbound_intake_queue")
    .update({ finished_at: now, last_error: null, status: "done", updated_at: now })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Record a failed attempt: dead-letter if attempts are exhausted, else re-queue with backoff.
 * Returns which happened so the worker can fire a dead-letter alert exactly once.
 */
export async function markInboundFailure(
  row: Pick<InboundQueueRow, "id" | "attempts" | "max_attempts">,
  errorMessage: string,
): Promise<"dead" | "retry"> {
  const supabase = recruitmentDb();
  const now = new Date();
  const dead = shouldDeadLetter(row.attempts, row.max_attempts);
  const patch = dead
    ? { finished_at: now.toISOString(), last_error: errorMessage.slice(0, 2000), status: "dead" as const, updated_at: now.toISOString() }
    : {
        last_error: errorMessage.slice(0, 2000),
        next_attempt_at: new Date(now.getTime() + backoffMs(row.attempts)).toISOString(),
        status: "queued" as const,
        updated_at: now.toISOString(),
      };
  const { error } = await supabase.from("ats_inbound_intake_queue").update(patch).eq("id", row.id);
  if (error) throw error;
  return dead ? "dead" : "retry";
}
