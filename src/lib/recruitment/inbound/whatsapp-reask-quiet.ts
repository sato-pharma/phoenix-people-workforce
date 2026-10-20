// Recruitment / ATS — the half-hourly WhatsApp re-ask: an applicant who went quiet mid-conversation
// is asked the question they stopped on ONCE more, while WhatsApp still lets us write to them.
//
// THE RULE (owner, 2026-10-20). Off until he switches it on (the Screening Questions screen,
// `ats_recruitment_settings.whatsapp_reask_enabled`); the bot itself must be on too. Then, every half
// hour, each open conversation that:
//
//   * has been quiet at least 2 hours (`updated_at` — the bot's last question, seconds after their
//     last answer) and not more than 22 — a person mid-way through is not chased;
//   * was never re-asked (`reasked_at IS NULL`) — once, never a stream of reminders;
//   * last heard from the applicant under 22 hours ago (the inbox's `last_inbound_at`, else the
//     conversation's own `updated_at`) — WhatsApp refuses a free-form message after 24 hours, and
//     two hours of margin keeps a slow run from landing a send on the wrong side of it;
//
// gets the very question it is parked on, through the same send a new CV's re-ask uses
// (`reaskQuietSession`). At most 20 a run. `reasked_at` is stamped whatever the send did, so a
// failure is never retried into a loop; a closed window closes the conversation as every send does.
//
// `?dryRun=1` lists who would be asked and sends nothing.

import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import { SESSION_COLUMNS } from "@/lib/recruitment/inbound/whatsapp-classify-session-row";
import {
  isWhatsAppClassifyEnabled,
  reaskQuietSession,
  type OpenSessionRow,
} from "@/lib/recruitment/inbound/whatsapp-classify-session";
import { isWhatsAppReaskEnabled } from "@/lib/recruitment/recruitment-settings-db";

const SESSIONS_TABLE = "ats_whatsapp_classification_sessions";
const HOUR_MS = 60 * 60 * 1000;

/** Quiet at least this long before a re-ask. */
export const REASK_QUIET_MIN_MS = 2 * HOUR_MS;
/** And no longer than this since the applicant last wrote — WhatsApp's window is 24 hours. */
export const REASK_WINDOW_MARGIN_MS = 22 * HOUR_MS;
/** Bounded so one run cannot fire a backlog at once. */
export const REASK_MAX_PER_RUN = 20;

export type ReaskCandidateRow = {
  sessionId: string;
  updatedAt: string | null;
  lastInboundAt: string | null;
};

/**
 * Pure: whether this conversation is due a re-ask now. Quiet 2 to 22 hours, and the applicant's own
 * last message (else the conversation's last update) under 22 hours old.
 */
export function isDueForReask(row: { updatedAt: string | null; lastInboundAt: string | null }, nowMs: number): boolean {
  const updated = row.updatedAt ? Date.parse(row.updatedAt) : Number.NaN;
  if (!Number.isFinite(updated)) return false;
  const quietFor = nowMs - updated;
  if (quietFor < REASK_QUIET_MIN_MS || quietFor > REASK_WINDOW_MARGIN_MS) return false;
  const heardAt = row.lastInboundAt ? Date.parse(row.lastInboundAt) : updated;
  const lastHeard = Number.isFinite(heardAt) ? heardAt : updated;
  return nowMs - lastHeard < REASK_WINDOW_MARGIN_MS;
}

export type WhatsAppReaskResult = {
  enabled: boolean;
  dryRun: boolean;
  examined: number;
  due: number;
  reasked: number;
  nothingToAsk: number;
  failed: number;
};

/** The applicant's last inbound message time per (line, number), from the WhatsApp Inbox. */
async function lastInboundTimes(rows: readonly OpenSessionRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const waIds = Array.from(new Set(rows.map((row) => row.wa_id).filter(Boolean)));
  if (waIds.length === 0) return out;
  const { data, error } = await recruitmentDb()
    .from("whatsapp_inbox_conversations")
    .select("phone_number_id,contact_key,last_inbound_at")
    .in("contact_key", waIds);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ phone_number_id: string | null; contact_key: string | null; last_inbound_at: string | null }>) {
    if (!row.contact_key || !row.last_inbound_at) continue;
    out.set(`${row.phone_number_id ?? ""}|${row.contact_key}`, row.last_inbound_at);
  }
  return out;
}

export async function runWhatsAppReask(options: { dryRun?: boolean; now?: Date } = {}): Promise<WhatsAppReaskResult> {
  const dryRun = options.dryRun === true;
  const nowMs = (options.now ?? new Date()).getTime();
  const result: WhatsAppReaskResult = { dryRun, due: 0, enabled: false, examined: 0, failed: 0, nothingToAsk: 0, reasked: 0 };
  if (!isWhatsAppClassifyEnabled() || !(await isWhatsAppReaskEnabled())) return result;
  result.enabled = true;

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select(`${SESSION_COLUMNS},updated_at,extra_current_question_key`)
    .is("completed_at", null)
    .is("reasked_at", null)
    .lt("updated_at", new Date(nowMs - REASK_QUIET_MIN_MS).toISOString())
    .gt("updated_at", new Date(nowMs - REASK_WINDOW_MARGIN_MS).toISOString())
    .order("updated_at", { ascending: true })
    .limit(REASK_MAX_PER_RUN * 3);
  if (error) throw error;
  const rows = (data ?? []) as OpenSessionRow[];
  result.examined = rows.length;

  const inbound = await lastInboundTimes(rows);
  const due = rows
    .filter((row) =>
      isDueForReask(
        { lastInboundAt: inbound.get(`${row.phone_number_id ?? ""}|${row.wa_id}`) ?? null, updatedAt: row.updated_at },
        nowMs,
      ),
    )
    .slice(0, REASK_MAX_PER_RUN);
  result.due = due.length;
  if (dryRun) return result;

  for (const row of due) {
    // Stamped FIRST: a crash or a slow send must never let the next run ask this person again.
    // A run that overlaps this one has already claimed it when no row comes back.
    const { data: stamped, error: stampError } = await supabase
      .from(SESSIONS_TABLE)
      .update({ reasked_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("reasked_at", null)
      .select("id");
    if (!stampError && (stamped ?? []).length === 0) continue;
    if (stampError) {
      result.failed += 1;
      logError("The WhatsApp re-ask could not mark a conversation", {
        error: stampError,
        labels: { event: "whatsapp_reask_stamp_failed" },
      });
      continue;
    }
    try {
      const outcome = await reaskQuietSession(row);
      if (outcome === "reasked") result.reasked += 1;
      else if (outcome === "nothing_to_ask") result.nothingToAsk += 1;
      else result.failed += 1;
    } catch (sendError) {
      result.failed += 1;
      logError("The WhatsApp re-ask failed to send", {
        error: sendError,
        labels: { event: "whatsapp_reask_send_failed" },
      });
    }
  }
  return result;
}
