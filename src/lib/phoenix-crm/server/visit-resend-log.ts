/**
 * Phoenix CRM — what became of each visit a phone held, and the small read the phone asks before sending.
 *
 * WHY THE LOG EXISTS. Nothing recorded a press of Log visit, so "how many visits were pressed and never
 * saved?" had only a floor: failed requests that happened to be reported. Every queued press now ends in one
 * row here, and joining it to `phoenix_crm_visits` answers the question with a count. It undercounts a phone
 * that never reopens or clears its storage, and a rep's own Remove counts too, so read it as "no visit saved",
 * never as "lost".
 *
 * Both follow the capture-evidence rule of this module: a rep's work never waits on them and a failure here
 * reaches nobody. The rep reads nothing from this file except the one switch and their own ids.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import type { VisitResendOutcome } from "@/lib/phoenix-crm/visit-resend-rules";
import { VISIT_OUTBOX_MAX_ENTRIES, VISIT_RESEND_MAX_SECONDS } from "@/lib/phoenix-crm/visit-resend-rules";

const OUTCOMES: readonly VisitResendOutcome[] = ["landed_late", "already_saved", "refused", "timed_out", "removed", "relogged"];

const REFUSAL_CODE_MAX = 80;
const ATTEMPTS_MAX = 1_000;

export type VisitResendStatus = {
  enabled: boolean;
  /** Who this sign-in is, so a tab left open for someone else stops rather than sends under this person. */
  personHrId: string;
  /** Which of the ids they asked about are on file as theirs. Never anybody else's. */
  savedVisitIds: string[];
  /** The server's clock, because only the server knows which side of 02:00 a visit would land on. */
  serverNow: string;
};

/**
 * The switch, the server's clock, and which of these ids stand as their own visits. Read only while a phone is
 * holding something, so a rep with nothing waiting never asks it.
 *
 * 🔴 NARROWED TO THEIR OWN VISITS BY THE QUERY. An id they merely guessed answers nothing, so this can never
 * confirm that somebody else's visit exists.
 */
export async function readVisitResendStatus(viewer: Pick<PhoenixCrmViewer, "hrId" | "config" | "isTestPersona">, rawIds: string | null): Promise<VisitResendStatus> {
  const ids = [
    ...new Set(
      String(rawIds ?? "")
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter(isUuid),
    ),
  ].slice(0, VISIT_OUTBOX_MAX_ENTRIES);
  const enabled = viewer.config.settings.visitResendEnabled;
  const hrId = String(viewer.hrId ?? "").toUpperCase();
  if (ids.length === 0) return { enabled, personHrId: hrId, savedVisitIds: [], serverNow: new Date().toISOString() };

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_visits")
    .select("id")
    .in("id", ids)
    .or(`rep_hr_id.eq."${hrId}",entered_by_hr_id.eq."${hrId}"`);
  // A failed read must never look like "not on file": that would raise a refusal for a visit that stands.
  if (error) throw new Error(error.message);
  return { enabled, personHrId: hrId, savedVisitIds: (data ?? []).map((row) => String(row.id)), serverNow: new Date().toISOString() };
}

function boundedSeconds(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, VISIT_RESEND_MAX_SECONDS);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Files how one held visit ended. Answers nothing and swallows everything: the route answers 204 whatever
 * happens here, so a phone never retries a report and a rep never hears of one.
 *
 * The person is read from the session, never the body. A row already on file for another person is left alone.
 */
export async function recordVisitResend(viewer: Pick<PhoenixCrmViewer, "hrId" | "isTestPersona">, raw: unknown): Promise<void> {
  try {
    const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const outcome = OUTCOMES.find((known) => known === body.outcome);
    const hrId = String(viewer.hrId ?? "").toUpperCase();
    if (!outcome || !hrId || !isUuid(body.visitId) || !isUuid(body.customerId) || typeof body.seatId !== "string" || !body.seatId) return;
    const visitId = String(body.visitId).toLowerCase();
    const row = {
      seat_id: body.seatId.slice(0, 80),
      customer_id: String(body.customerId).toLowerCase(),
      pressed_at_device: isoOrNull(body.pressedAtDevice),
      outcome,
      refusal_code: typeof body.refusalCode === "string" ? body.refusalCode.slice(0, REFUSAL_CODE_MAX) : null,
      queued_seconds: boundedSeconds(body.queuedSeconds),
      attempts: Math.min(Math.max(0, Math.trunc(Number(body.attempts)) || 0), ATTEMPTS_MAX),
      is_test: viewer.isTestPersona,
      updated_at: new Date().toISOString(),
    };
    const supabase = getSupabaseAdmin();
    // Their own row moves on to its later outcome (refused, then Log it again). The narrow update comes first so
    // an id another person already filed can never be overwritten by a body that names it.
    const updated = await supabase.from("phoenix_crm_visit_resend_log").update(row).eq("visit_id", visitId).eq("rep_hr_id", hrId).select("visit_id");
    if (updated.error) {
      console.error("[phoenix-crm] visit resend not logged", updated.error.message);
      return;
    }
    if ((updated.data ?? []).length > 0) return;
    const inserted = await supabase
      .from("phoenix_crm_visit_resend_log")
      .upsert({ ...row, visit_id: visitId, rep_hr_id: hrId }, { onConflict: "visit_id", ignoreDuplicates: true });
    if (inserted.error) console.error("[phoenix-crm] visit resend not logged", inserted.error.message);
  } catch (error) {
    console.error("[phoenix-crm] visit resend not logged", error);
  }
}
