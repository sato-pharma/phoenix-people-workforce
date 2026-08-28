// Recruitment / ATS — the three-question WhatsApp self-classification conversation.
//
// A CV arrives -> ask what role -> ask which region -> ask which area inside it -> write the three
// answers onto the candidate. Each answer comes back as its own webhook event minutes apart, with
// nothing but the sender's number tying them together, so the conversation's position is held in
// `ats_whatsapp_classification_sessions` (one open row per sender).
//
// EVERYTHING HERE IS BEST-EFFORT AND NEVER THROWS INTO THE WEBHOOK. The CV is already captured and
// queued by the time any of this runs; a failed prompt must never turn a delivered CV into a lost
// one. Failures are logged and the flow simply stops for that applicant.
//
// OFF BY DEFAULT: RECRUITMENT_WHATSAPP_CLASSIFY_ENABLED must be exactly "true", and an access token
// must exist. With either missing this module is a strict no-op with no network call and no row
// written.

import { logError, logWarning } from "@/lib/observability/log";
import { candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilyLabels, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import {
  areaMenu,
  classifyThankYouText,
  isOfferedRegion,
  isOfferedRoleFamily,
  jobTitleMenu,
  parseClassifyRowId,
  regionMenu,
  type ClassifyMenu,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import { sendClassifyMenu, sendWhatsAppText } from "@/lib/recruitment/inbound/whatsapp-interactive";

const SESSIONS_TABLE = "ats_whatsapp_classification_sessions";

/** True only when the flag is on AND a token exists — otherwise the whole feature is inert. */
export function isWhatsAppClassifyEnabled(): boolean {
  const flag = String(process.env.RECRUITMENT_WHATSAPP_CLASSIFY_ENABLED ?? "").trim().toLowerCase();
  return flag === "true" && Boolean(process.env.WHATSAPP_ACCESS_TOKEN?.trim());
}

type SessionRow = {
  id: string;
  wa_id: string;
  phone_number_id: string | null;
  step: string;
  job_title_family: string | null;
  region_code: string | null;
  area_name: string | null;
  last_prompt_wamid: string | null;
  applied_candidate_id: string | null;
};

const SESSION_COLUMNS =
  "id,wa_id,phone_number_id,step,job_title_family,region_code,area_name,last_prompt_wamid,applied_candidate_id";

// ── Areas, read live ─────────────────────────────────────────────────────────────────────────────
// Areas are the one layer of this vocabulary that genuinely moves as the org changes, so they are
// read rather than hard-coded — a stale list would offer a territory that no longer exists. Cached
// in-process for the lifetime of the serverless instance: 49 rows that change a few times a year,
// against a webhook that must ack fast.

const AREA_CACHE_TTL_MS = 10 * 60 * 1000;
let areaCache: { at: number; byRegion: Map<string, string[]> } | null = null;

export function resetAreaCacheForTests(): void {
  areaCache = null;
}

async function loadAreasByRegion(): Promise<Map<string, string[]>> {
  if (areaCache && Date.now() - areaCache.at < AREA_CACHE_TTL_MS) return areaCache.byRegion;

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("au_v_canonical_areas")
    .select("area_name,code_region_code,sort_order,is_active")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) throw error;

  const byRegion = new Map<string, string[]>();
  for (const raw of (data ?? []) as Array<{ area_name: string | null; code_region_code: string | null }>) {
    const name = textOrNull(raw.area_name);
    const region = textOrNull(raw.code_region_code);
    if (!name || !region) continue;
    const list = byRegion.get(region);
    if (list) list.push(name);
    else byRegion.set(region, [name]);
  }

  areaCache = { at: Date.now(), byRegion };
  return byRegion;
}

/** Active area names for a region, in the org's own sort order. Empty when the region has none. */
export async function areaNamesForRegion(regionCode: string): Promise<string[]> {
  const byRegion = await loadAreasByRegion();
  return byRegion.get(regionCode) ?? [];
}

// ── Sending one step's prompt ────────────────────────────────────────────────────────────────────

async function sendStep(
  session: Pick<SessionRow, "id" | "wa_id" | "phone_number_id">,
  menu: ClassifyMenu,
): Promise<boolean> {
  const result = await sendClassifyMenu({
    menu,
    phoneNumberId: session.phone_number_id,
    toWaId: session.wa_id,
  });
  if (!result.ok) {
    if (result.reason === "window_closed") {
      // Expected: the applicant went quiet for 24 hours. Close the conversation rather than leaving
      // an open row that would block a future CV from starting a fresh one. Deliberately no paid
      // template chase — see whatsapp-interactive.ts.
      await closeSession(session.id, "window_closed");
    }
    return false;
  }

  const supabase = recruitmentDb();
  await supabase
    .from(SESSIONS_TABLE)
    .update({ last_prompt_wamid: result.wamid, step: menu.step, updated_at: new Date().toISOString() })
    .eq("id", session.id);
  return true;
}

async function closeSession(sessionId: string, _reason: string): Promise<void> {
  const supabase = recruitmentDb();
  await supabase
    .from(SESSIONS_TABLE)
    .update({ completed_at: new Date().toISOString(), step: "done", updated_at: new Date().toISOString() })
    .eq("id", sessionId);
}

// ── Opening the conversation, when a CV lands ────────────────────────────────────────────────────

export type StartClassificationInput = {
  waId: string;
  phoneNumberId: string | null;
  cvWamid: string;
  /** Meta's forwarded flag. A forwarded CV is not the applicant messaging us — see below. */
  forwarded: boolean;
  /** True when this sender is a configured bulk-import account. */
  isImportSender: boolean;
  /** True for a coexistence history replay: it already happened, sometimes months ago. */
  historical: boolean;
};

export type StartClassificationOutcome =
  | "disabled"
  | "skipped_forwarded"
  | "skipped_historical"
  | "already_open"
  | "send_failed"
  | "asked";

/**
 * Opens the conversation and asks question 1. Returns why it did nothing when it did nothing.
 *
 * THE FORWARDED GUARD IS NOT OPTIONAL. When the owner forwards a CV from the HR handset, Meta
 * reports the SENDER as the handset's own number — so without this check the "thanks for your CV,
 * what are you applying for?" prompt goes to the owner's phone, once per forwarded CV, and the
 * applicant is never asked anything. Verified in production data: forwarded CVs carry
 * `sender_identifier` = the HR number and `forwarded: true`.
 */
export async function startClassification(input: StartClassificationInput): Promise<StartClassificationOutcome> {
  if (!isWhatsAppClassifyEnabled()) return "disabled";
  if (input.historical) return "skipped_historical";
  if (input.forwarded || input.isImportSender) return "skipped_forwarded";

  try {
    const supabase = recruitmentDb();

    // One open conversation per sender. A second CV mid-flow must not start a parallel conversation:
    // the applicant's next tap would be ambiguous between the two, and the partial unique index
    // would reject the insert anyway.
    const { data: existing } = await supabase
      .from(SESSIONS_TABLE)
      .select("id")
      .eq("wa_id", input.waId)
      .is("completed_at", null)
      .maybeSingle();
    if (existing) return "already_open";

    const { data: inserted, error } = await supabase
      .from(SESSIONS_TABLE)
      .insert({
        cv_wamid: input.cvWamid,
        phone_number_id: input.phoneNumberId,
        step: "job_title",
        wa_id: input.waId,
      })
      .select(SESSION_COLUMNS)
      .single();
    if (error) throw error;

    const sent = await sendStep(inserted as SessionRow, jobTitleMenu());
    return sent ? "asked" : "send_failed";
  } catch (error) {
    logError("WhatsApp classification failed to start", {
      error,
      labels: { event: "whatsapp_classify_start_failed", wamid: input.cvWamid },
    });
    return "send_failed";
  }
}

// ── Handling a tap ───────────────────────────────────────────────────────────────────────────────

export type ClassifyReplyOutcome =
  | "disabled"
  | "not_ours"
  | "no_session"
  | "out_of_step"
  | "unknown_value"
  | "no_areas"
  | "advanced"
  | "completed";

/**
 * Applies one tapped answer and asks the next question (or finishes). `rowId` is the id WhatsApp
 * echoes back from the row the applicant tapped.
 */
export async function handleClassifyReply(input: {
  waId: string;
  phoneNumberId: string | null;
  rowId: string;
}): Promise<ClassifyReplyOutcome> {
  if (!isWhatsAppClassifyEnabled()) return "disabled";

  const parsed = parseClassifyRowId(input.rowId);
  if (!parsed) return "not_ours";

  try {
    const supabase = recruitmentDb();
    const { data: sessionRow } = await supabase
      .from(SESSIONS_TABLE)
      .select(SESSION_COLUMNS)
      .eq("wa_id", input.waId)
      .is("completed_at", null)
      .maybeSingle();
    if (!sessionRow) return "no_session";
    const session = sessionRow as SessionRow;

    // A tap on an OLD menu (the applicant scrolled up and answered question 1 again). Ignored rather
    // than replayed: rewinding would re-ask questions they have already answered.
    if (parsed.step !== session.step) return "out_of_step";

    const nowIso = new Date().toISOString();

    if (parsed.step === "job_title") {
      if (!isOfferedRoleFamily(parsed.value)) return "unknown_value";
      await supabase
        .from(SESSIONS_TABLE)
        .update({ job_title_family: parsed.value, step: "region", updated_at: nowIso })
        .eq("id", session.id);
      const sent = await sendStep({ ...session, phone_number_id: session.phone_number_id ?? input.phoneNumberId }, regionMenu());
      return sent ? "advanced" : "advanced";
    }

    if (parsed.step === "region") {
      if (!isOfferedRegion(parsed.value)) return "unknown_value";
      const areas = await areaNamesForRegion(parsed.value);
      if (areas.length === 0) {
        // No area list to offer. Finish on what we have rather than dead-ending the applicant on a
        // question with no answers — two of three fields is still far better than none.
        await supabase
          .from(SESSIONS_TABLE)
          .update({ region_code: parsed.value, step: "area", updated_at: nowIso })
          .eq("id", session.id);
        logWarning("WhatsApp classification found no areas for a region", {
          context: { regionCode: parsed.value },
          labels: { event: "whatsapp_classify_no_areas" },
        });
        await finishSession({ ...session, region_code: parsed.value }, input.phoneNumberId);
        return "no_areas";
      }
      await supabase
        .from(SESSIONS_TABLE)
        .update({ region_code: parsed.value, step: "area", updated_at: nowIso })
        .eq("id", session.id);
      const sent = await sendStep(
        { ...session, phone_number_id: session.phone_number_id ?? input.phoneNumberId },
        areaMenu(parsed.value as CandidateRegionCode, areas),
      );
      return sent ? "advanced" : "advanced";
    }

    // step === "area" — the last answer.
    const validAreas = session.region_code ? await areaNamesForRegion(session.region_code) : [];
    if (validAreas.length > 0 && !validAreas.includes(parsed.value)) return "unknown_value";
    await supabase
      .from(SESSIONS_TABLE)
      .update({ area_name: parsed.value, updated_at: nowIso })
      .eq("id", session.id);
    await finishSession({ ...session, area_name: parsed.value }, input.phoneNumberId);
    return "completed";
  } catch (error) {
    logError("WhatsApp classification failed to handle a reply", {
      error,
      labels: { event: "whatsapp_classify_reply_failed" },
    });
    return "no_session";
  }
}

// ── Finishing: confirm to the applicant, then write to the candidate ─────────────────────────────

async function finishSession(session: SessionRow, fallbackPhoneNumberId: string | null): Promise<void> {
  const roleLabel = session.job_title_family
    ? candidateRoleFamilyLabels[session.job_title_family as CandidateRoleFamily]
    : null;
  const regionLabel = session.region_code
    ? candidateRegionLabels[session.region_code as CandidateRegionCode]
    : null;

  await applyClassificationToCandidate(session);
  await closeSession(session.id, "completed");

  if (roleLabel && regionLabel && session.area_name) {
    await sendWhatsAppText({
      phoneNumberId: session.phone_number_id ?? fallbackPhoneNumberId,
      text: classifyThankYouText({ areaName: session.area_name, regionLabel, roleLabel }),
      toWaId: session.wa_id,
    });
  }
}

/**
 * The candidate this WhatsApp sender's CV became, via the intake-event trail.
 *
 * Deliberately NOT a phone lookup on ats_candidates: `phone_norm` is an app-maintained dedupe
 * column and matching on it by hand is exactly what the house rule warns against. The intake event
 * already records `sender_identifier` (`+<waId>`) beside the candidate it produced, which is the
 * authoritative link and needs no normalisation of our own.
 */
async function findCandidateForSender(waId: string): Promise<string | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_cv_intake_events")
    .select("candidate_id,created_at")
    .eq("sender_identifier", `+${waId}`)
    .not("candidate_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as { candidate_id: string | null } | undefined;
  return row?.candidate_id ?? null;
}

/**
 * Copies the three answers onto the candidate. Called when the conversation completes; if the
 * candidate does not exist yet (the durable worker has not run), nothing is written and
 * `applyPendingClassification` picks it up once the candidate appears.
 */
export async function applyClassificationToCandidate(session: SessionRow): Promise<boolean> {
  try {
    const candidateId = session.applied_candidate_id ?? (await findCandidateForSender(session.wa_id));
    if (!candidateId) return false;
    return writeClassification(candidateId, session);
  } catch (error) {
    logError("WhatsApp classification failed to reach a candidate", {
      error,
      labels: { event: "whatsapp_classify_apply_failed" },
    });
    return false;
  }
}

async function writeClassification(candidateId: string, session: SessionRow): Promise<boolean> {
  const supabase = recruitmentDb();
  const nowIso = new Date().toISOString();

  // Only the fields the applicant actually answered are written. An unanswered question must leave
  // its column untouched rather than blanking whatever is already on the record — writing an
  // optional field unconditionally is a silent erase.
  const payload: Record<string, unknown> = { preferences_declared_at: nowIso };
  if (session.job_title_family) {
    payload.applied_for_job_title = candidateRoleFamilyLabels[session.job_title_family as CandidateRoleFamily];
  }
  if (session.region_code) payload.preferred_region_code = session.region_code;
  if (session.area_name) payload.preferred_area_name = session.area_name;

  const { error } = await supabase.from("ats_candidates").update(payload).eq("id", candidateId);
  if (error) throw error;

  await supabase
    .from(SESSIONS_TABLE)
    .update({ applied_at: nowIso, applied_candidate_id: candidateId, updated_at: nowIso })
    .eq("id", session.id);
  return true;
}

/**
 * Applies a completed-but-unapplied conversation to a candidate that has just been created.
 * Called by the intake worker: the applicant can finish tapping before the CV finishes processing,
 * and without this their answers would sit in the session table and never reach the record.
 */
export async function applyPendingClassification(input: { waId: string; candidateId: string }): Promise<boolean> {
  if (!isWhatsAppClassifyEnabled()) return false;
  try {
    const supabase = recruitmentDb();
    const { data } = await supabase
      .from(SESSIONS_TABLE)
      .select(SESSION_COLUMNS)
      .eq("wa_id", input.waId)
      .is("applied_at", null)
      .not("job_title_family", "is", null)
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1);
    const session = ((data ?? [])[0] ?? null) as SessionRow | null;
    if (!session) return false;
    return writeClassification(input.candidateId, session);
  } catch (error) {
    logError("WhatsApp classification failed to apply to a new candidate", {
      error,
      labels: { event: "whatsapp_classify_backfill_failed" },
    });
    return false;
  }
}
