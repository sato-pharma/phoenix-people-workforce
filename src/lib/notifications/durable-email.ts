import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import type { SendPhoenixEmailResult } from "@/lib/email/send-phoenix-email";
import { conflictError, notFoundError } from "@/lib/http/api-errors";
import {
  buildDirectEmailPayload,
  durableEmailDedupeKey,
  isDirectEmailPayload,
  sendDirectEmailMessage,
  type DurableEmailMessage,
} from "@/lib/notifications/direct-email-payload";
import {
  claimNotificationOutboxRow,
  deliverDirectEmailOutboxRow,
  getNotificationOutboxRowByDedupeKey,
  notificationOutboxMaxAttempts,
  notificationOutboxTable,
  type DirectEmailDeliveryOutcome,
  type NotificationOutboxRow,
} from "@/lib/notifications/email";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * DURABLE APPROVAL EMAILS (REC-048, 13 Nov 2026) — an approval email survives a provider failure.
 *
 * `sendDurableEmail` is a drop-in for a direct `sendTemplatedEmail` / `sendPhoenixEmail` call:
 *
 *   1. It writes the `notification_outbox` row FIRST — `status: 'processing'`, locked by this send, so
 *      the drain cannot pick it up while the inline send is still running. Its `dedupe_key` is built
 *      from the caller's own key (durableEmailDedupeKey), so a retried request finds the row it
 *      already wrote and never queues a second email.
 *   2. It then sends inline exactly as before — the same sender, the same input.
 *   3. Sent → the row is marked sent. A skip that cannot change → the row is closed `skipped`.
 *      A provider failure or a transient skip → the row is marked failed with the drain's own backoff
 *      (5, 15, 60, 240 minutes) and attempt limit (5), and `/api/notifications/process` sends it again
 *      with the stored input, through the same sender (processNotificationOutboxRow's direct branch).
 *
 * The caller gets the shape it always got: the provider's result on a send, the same skip on a skip
 * that will not be retried, a THROW on a provider failure. Only the reason's words say when the email
 * is now waiting in the outbox ("Queued for retry: …"), the wording the notification system already
 * uses for an email handed to the outbox — so a recorded skip or failure tells the truth.
 *
 * Nothing about WHO receives it changes: the outbox stores the sender's input untouched, and the
 * drain hands it back untouched. If the outbox cannot be written at all, the email is sent directly,
 * exactly as before — durability never costs an email.
 *
 * A credential email (a reset code, a set-your-password link) is never written here: it has its own
 * sealed outbox path (credential-seal.ts), and this payload would keep the code readable.
 */

export type DurableEmailOptions = {
  /** The caller's own readable idempotency key, e.g. `vacation:<request id>:leave_request:<manager email>`. */
  dedupeKey: string;
};

export type OpenedDurableEmailRow =
  | { row: NotificationOutboxRow; state: "claimed" }
  | { row: NotificationOutboxRow; state: "finished" }
  | { row: NotificationOutboxRow; state: "busy" };

/** The database half, injectable so the inline flow is tested without one. */
export type DurableEmailDeps = {
  deliver: (row: NotificationOutboxRow) => Promise<DirectEmailDeliveryOutcome>;
  open: (message: DurableEmailMessage, dedupeKey: string, label: string) => Promise<OpenedDurableEmailRow>;
  sendDirect: (message: DurableEmailMessage) => Promise<SendPhoenixEmailResult>;
};

export const QUEUED_FOR_RETRY_PREFIX = "Queued for retry:";

function originEnvironment(): string {
  return process.env.APP_ENV || process.env.NODE_ENV || "development";
}

/**
 * Writes the row as this send's own claim, or finds the row an earlier attempt of the same request
 * wrote: a `pending`/`failed` one is claimed and sent now, a `sent` one is not sent again, and one
 * another process is sending (or that was closed as skipped) is left alone.
 */
async function openDurableEmailRow(
  message: DurableEmailMessage,
  dedupeKey: string,
  label: string,
): Promise<OpenedDurableEmailRow> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(notificationOutboxTable)
    .insert({
      attempts: 0,
      dedupe_key: dedupeKey,
      // Claimed by THIS send from the first instant: the drain only takes pending/failed rows, and the
      // stale reaper returns this one to the queue if the process dies before it is marked.
      locked_at: now,
      max_attempts: notificationOutboxMaxAttempts,
      next_attempt_at: null,
      payload: buildDirectEmailPayload(message, label, originEnvironment()),
      status: "processing",
      updated_at: now,
    })
    .select("*")
    .single();
  if (!error && data) return { row: data as NotificationOutboxRow, state: "claimed" };

  const existing = await getNotificationOutboxRowByDedupeKey(dedupeKey);
  if (!existing) throw error ?? new Error("The durable email row could not be written.");
  if (existing.status === "sent" || existing.status === "skipped") return { row: existing, state: "finished" };
  if (existing.status === "pending" || existing.status === "failed") {
    const claimed = await claimNotificationOutboxRow(existing.id);
    if (claimed) return { row: claimed, state: "claimed" };
  }
  return { row: existing, state: "busy" };
}

const defaultDeps: DurableEmailDeps = {
  deliver: deliverDirectEmailOutboxRow,
  open: openDurableEmailRow,
  sendDirect: (message) => sendDirectEmailMessage(message),
};

/** What the caller is told about a row an earlier attempt already holds. */
function resultForExistingRow(opened: OpenedDurableEmailRow): SendPhoenixEmailResult {
  const { row } = opened;
  if (row.status === "sent") return { id: row.provider_message_id ?? undefined, skipped: false };
  if (row.status === "skipped") return { reason: row.last_error || "This email was already closed without sending.", skipped: true };
  return { reason: `${QUEUED_FOR_RETRY_PREFIX} this email is already being sent.`, skipped: true };
}

/**
 * The inline flow, with its database half injectable (`deps`) for the tests. Callers use
 * `sendDurableEmail`.
 */
export async function runDurableEmail(
  message: DurableEmailMessage,
  options: DurableEmailOptions,
  deps: DurableEmailDeps = defaultDeps,
): Promise<SendPhoenixEmailResult> {
  // A live credential never sits in this payload — see the header.
  if (message.input.credentialEmail) return deps.sendDirect(message);

  const label = options.dedupeKey.trim();
  const dedupeKey = durableEmailDedupeKey(message, label);

  let opened: OpenedDurableEmailRow;
  try {
    opened = await deps.open(message, dedupeKey, label);
  } catch (error) {
    // Durability must never cost an email: with no row, send exactly as before.
    logError("Durable email could not be written to the outbox — sent directly instead", {
      error,
      labels: { event: "durable_email_outbox_write_failed", label },
    });
    return deps.sendDirect(message);
  }

  if (opened.state !== "claimed") return resultForExistingRow(opened);

  const delivery = await deps.deliver(opened.row);
  if (delivery.outcome === "sent" || delivery.outcome === "skipped") return delivery.result;
  if (delivery.outcome === "queued") {
    return { reason: `${QUEUED_FOR_RETRY_PREFIX} ${delivery.result.reason}`, skipped: true };
  }
  // A provider failure is still a THROW to the caller, as it always was — its own failure record runs
  // unchanged — but the words say the email is waiting in the outbox, not lost.
  throw new Error(`${QUEUED_FOR_RETRY_PREFIX} ${delivery.message}`, { cause: delivery.error });
}

/** Sends an approval email through the outbox — see the header. */
export function sendDurableEmail(
  message: DurableEmailMessage,
  options: DurableEmailOptions,
): Promise<SendPhoenixEmailResult> {
  return runDurableEmail(message, options);
}

// ── Out of retries: the list, and "send again" ─────────────────────────────────────────────────────

export type ExhaustedDurableEmail = {
  attempts: number;
  createdAt: string;
  id: string;
  label: string;
  lastError: string | null;
  lastTriedAt: string;
  recipients: string[];
  subject: string | null;
};

/** A durable direct email that used every attempt and will not be tried again until someone says so. */
export function isExhaustedDurableEmailRow(row: Pick<NotificationOutboxRow, "attempts" | "max_attempts" | "payload" | "status">): boolean {
  return row.status === "failed" && row.attempts >= row.max_attempts && isDirectEmailPayload(row.payload);
}

/** The durable direct emails that ran out of retries, newest first — what the admin screen lists. */
export async function listExhaustedDurableEmails(limit = 50): Promise<ExhaustedDurableEmail[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(notificationOutboxTable)
    .select("id,attempts,max_attempts,status,payload,last_error,created_at,updated_at")
    .eq("status", "failed")
    .eq("payload->>kind", "direct_email")
    .gte("attempts", notificationOutboxMaxAttempts)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<NotificationOutboxRow>)
    .filter(isExhaustedDurableEmailRow)
    .map((row) => {
      const payload = row.payload as unknown as { label?: string; recipients?: string[]; subject?: string | null };
      return {
        attempts: row.attempts,
        createdAt: row.created_at,
        id: row.id,
        label: String(payload.label ?? ""),
        lastError: row.last_error,
        lastTriedAt: row.updated_at,
        recipients: Array.isArray(payload.recipients) ? payload.recipients : [],
        subject: payload.subject ?? null,
      };
    });
}

/**
 * HOW MANY approval emails are out of retries, and when the oldest was written — for the Needs You
 * board (REC-031). The same filter as listExhaustedDurableEmails, so the board row and the screen it
 * links to count the same emails. One read: an exact count and the single oldest row. It THROWS on a
 * failed read, so the board says it could not read the outbox instead of showing nothing.
 */
export async function countExhaustedDurableEmails(): Promise<{ count: number; oldestAt: string | null }> {
  const { data, count, error } = await getSupabaseAdmin()
    .from(notificationOutboxTable)
    .select("created_at", { count: "exact" })
    .eq("status", "failed")
    .eq("payload->>kind", "direct_email")
    .gte("attempts", notificationOutboxMaxAttempts)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const oldest = ((data ?? []) as Array<{ created_at?: string | null }>)[0]?.created_at ?? null;
  return { count: count ?? 0, oldestAt: oldest };
}

/**
 * SEND AGAIN — puts one durable direct email that ran out of retries back in the queue: attempts back
 * to 0, due now. It sends nothing itself; the drain sends it on its next run, through the same sender
 * with the same stored input, and with the full retry budget again.
 *
 * The permission is checked BEFORE anything is read or written (the same `admin` `update` the Email
 * Notifications screen's own changes need). Only an exhausted durable direct email can be re-queued,
 * and the write is a compare-and-set on the attempts it read, so two presses queue it once.
 */
export async function requeueExhaustedDurableEmail(access: AccessContext, outboxId: string): Promise<{ id: string }> {
  await assertPermission(access, "admin", "update");

  const id = String(outboxId ?? "").trim();
  if (!id) throw notFoundError("No email was named.");

  const supabase = getSupabaseAdmin();
  const { data: row, error: readError } = await supabase
    .from(notificationOutboxTable)
    .select("id,attempts,max_attempts,status,payload,last_error")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw readError;
  if (!row) throw notFoundError("That email is no longer in the outbox.");
  const current = row as Pick<NotificationOutboxRow, "attempts" | "id" | "last_error" | "max_attempts" | "payload" | "status">;
  if (!isExhaustedDurableEmailRow(current)) {
    throw conflictError("Only an approval email that used every retry can be sent again — this one is still queued, already sent, or not an approval email.");
  }

  const now = new Date().toISOString();
  const { data: updated, error: writeError } = await supabase
    .from(notificationOutboxTable)
    .update({
      attempts: 0,
      last_error: null,
      locked_at: null,
      next_attempt_at: now,
      status: "pending",
      updated_at: now,
    })
    .eq("id", current.id)
    .eq("status", "failed")
    .eq("attempts", current.attempts)
    .select("id");
  if (writeError) throw writeError;
  if ((updated ?? []).length === 0) throw conflictError("This email was already sent again.");

  const payload = current.payload as unknown as { label?: string };
  await writeAuditLog({
    actorLoginId: access.loginId ?? access.hrId ?? null,
    entityId: current.id,
    entityType: "notification",
    newValues: { attempts: 0, status: "pending" },
    oldValues: { attempts: current.attempts, lastError: current.last_error, status: current.status },
    summary: `Approval email sent again from the outbox (${payload.label ?? current.id}) — the drain sends it on its next run.`,
  });

  return { id: current.id };
}
