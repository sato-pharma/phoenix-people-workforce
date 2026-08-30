// Recruitment / ATS — the WhatsApp self-classification conversation.
//
// A CV arrives -> ask what role -> ask what they graduated in -> ask which region -> (Medical Rep
// only) ask which area inside it -> write the answers onto the candidate. Each answer comes back as
// its own webhook event minutes apart, with nothing but the sender's number tying them together, so
// the conversation's position is held in `ats_whatsapp_classification_sessions` (one open row per
// sender).
//
// The AREA question is the one that cascades: owner's rule 2026-08-30 (see askAreaForRole) asks it
// only of a Medical Rep. Every other applicant — the sales managers, head-office roles, and anyone
// who typed their own job — is asked region only, and the region answer is their last.
//
// EVERYTHING HERE IS BEST-EFFORT AND NEVER THROWS INTO THE WEBHOOK. The CV is already captured and
// queued by the time any of this runs; a failed prompt must never turn a delivered CV into a lost
// one. Failures are logged and the flow simply stops for that applicant.
//
// OFF BY DEFAULT: RECRUITMENT_WHATSAPP_CLASSIFY_ENABLED must be exactly "true", and an access token
// must exist. With either missing this module is a strict no-op with no network call and no row
// written.

import { logError, logWarning } from "@/lib/observability/log";
import { candidateRegionLabels, recruitmentRegionForArea, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilyLabels, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import {
  AREA_OTHER_MAX,
  areaMenu,
  areaOtherPromptText,
  askAreaForRole,
  BACKGROUND_OTHER_MAX,
  backgroundMenu,
  backgroundOtherPromptText,
  backgroundOtherTooLongText,
  candidateBackgroundLabels,
  classifyThankYouText,
  cleanTypedAnswer,
  isOfferedBackground,
  isOfferedRegion,
  isOfferedRoleFamily,
  JOB_TITLE_OTHER_MAX,
  jobTitleMenu,
  jobTitleOtherPromptText,
  jobTitleOtherTooLongText,
  OTHER_ROW_VALUE,
  parseClassifyRowId,
  REGION_OTHER_MAX,
  regionMenu,
  regionOtherPromptText,
  typedAnswerTooLongText,
  type CandidateBackgroundCode,
  type ClassifyMenu,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import {
  candidateDisplayName,
  mirrorWhatsAppEventToOwner,
} from "@/lib/recruitment/inbound/whatsapp-conversation-mirror";
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
  /** What they typed after choosing "Other". Null for every other answer. */
  job_title_other_text: string | null;
  /** Graduation background CODE (pharmacy/science/vet), or "other" when they typed their own. */
  background: string | null;
  /** What they typed after choosing "Other" on the background question. Null otherwise. */
  background_other_text: string | null;
  region_code: string | null;
  /** What they typed after choosing "my region is not listed". Null otherwise. */
  region_other_text: string | null;
  area_name: string | null;
  /** What they typed after choosing "my area is not listed", or when the region had no areas. */
  area_other_text: string | null;
  last_prompt_wamid: string | null;
  applied_candidate_id: string | null;
};

/**
 * The region and area as they should be READ BACK. Same single-source rule as `sessionRoleLabel`:
 * the thank-you message, the owner's Telegram mirror and the candidate columns must never disagree
 * about what the applicant said. A typed answer wins because it only exists when they told us the
 * list was wrong.
 */
export function sessionRegionLabel(session: {
  region_code: string | null;
  region_other_text: string | null;
}): string | null {
  if (session.region_other_text) return session.region_other_text;
  return session.region_code
    ? candidateRegionLabels[session.region_code as CandidateRegionCode]
    : null;
}

export function sessionAreaLabel(session: {
  area_name: string | null;
  area_other_text: string | null;
}): string | null {
  return session.area_name ?? session.area_other_text ?? null;
}

const SESSION_COLUMNS =
  "id,wa_id,phone_number_id,step,job_title_family,job_title_other_text,background,background_other_text,region_code,region_other_text,area_name,area_other_text,last_prompt_wamid,applied_candidate_id";

/**
 * The role as it should be READ BACK — their typed words when they chose "Other", otherwise the
 * family's label. One function so the thank-you message, the owner's Telegram mirror and the
 * candidate record can never disagree about what someone said they were applying for.
 */
export function sessionRoleLabel(session: {
  job_title_family: string | null;
  job_title_other_text: string | null;
}): string | null {
  if (session.job_title_family === "other" && session.job_title_other_text) {
    return session.job_title_other_text;
  }
  return session.job_title_family
    ? candidateRoleFamilyLabels[session.job_title_family as CandidateRoleFamily]
    : null;
}

/**
 * The graduation background as it should be READ BACK — their typed words when they chose "Other",
 * otherwise the code's label. Same single-source rule as `sessionRoleLabel`: the thank-you message,
 * the owner's Telegram mirror and the candidate column must never disagree.
 *
 * Unlike the role families, `candidateBackgroundLabels` has NO "other" key — the typed words are the
 * only label an "Other" answer has — so the code path is guarded by `isOfferedBackground` and reads
 * the map only for a key it actually holds, never producing a literal `undefined`.
 */
export function sessionBackgroundLabel(session: {
  background: string | null;
  background_other_text: string | null;
}): string | null {
  if (session.background === "other") return session.background_other_text;
  if (session.background && isOfferedBackground(session.background)) {
    return candidateBackgroundLabels[session.background];
  }
  return null;
}

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
    const salesRegion = textOrNull(raw.code_region_code);
    if (!name || !salesRegion) continue;
    // Recruitment moved five areas to Delta (3) ahead of the sales geography, so an applicant who
    // picks Delta (3) sees them and Delta (1)/(2)/Others no longer do. Everything else passes
    // through unchanged. See recruitmentRegionForArea in candidate-region.ts.
    const region = recruitmentRegionForArea(name, salesRegion);
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

/**
 * Sends a plain-text question — the "Other" follow-up, which has nothing to tap.
 *
 * Same window handling as `sendStep`: if the applicant has gone quiet for 24 hours Meta rejects it
 * and the conversation is closed rather than left open, because an open row blocks a future CV from
 * starting a fresh one. Deliberately no paid template chase.
 *
 * Unlike `sendStep` this does NOT write the step — the caller has already parked the session on
 * `job_title_other`, and it must stay there even if this prompt fails to reach them, so a typed
 * answer that arrives anyway is still understood.
 */
async function sendPromptText(
  session: Pick<SessionRow, "id" | "wa_id" | "phone_number_id">,
  text: string,
): Promise<boolean> {
  const result = await sendWhatsAppText({
    phoneNumberId: session.phone_number_id,
    text,
    toWaId: session.wa_id,
  });
  if (!result.ok) {
    if (result.reason === "window_closed") await closeSession(session.id, "window_closed");
    return false;
  }
  const supabase = recruitmentDb();
  await supabase
    .from(SESSIONS_TABLE)
    .update({ last_prompt_wamid: result.wamid, updated_at: new Date().toISOString() })
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
  /** True when this sender is a configured bulk-import account. */
  isImportSender: boolean;
  /** True for a coexistence history replay: it already happened, sometimes months ago. */
  historical: boolean;
};

export type StartClassificationOutcome =
  | "disabled"
  | "skipped_import_sender"
  | "skipped_historical"
  | "already_open"
  | "send_failed"
  | "asked";

/**
 * Opens the conversation and asks question 1. Returns why it did nothing when it did nothing.
 *
 * THE IMPORT-SENDER GUARD IS NOT OPTIONAL, and it is the ONLY guard needed here. When the owner
 * forwards a CV from the HR handset, Meta reports the SENDER as the handset's own number — so
 * without it the "what are you applying for?" prompt goes to his phone, once per forwarded CV, and
 * the applicant is never asked anything.
 *
 * Meta's `forwarded` flag USED to be checked alongside it, and was removed 2026-08-28 at the owner's
 * instruction ("must be able to have the testing in both situations"). It was the wrong signal for
 * the job. The scenario it was written for — the HR handset forwarding a pile of CVs — is already
 * caught by the import-sender list, which names that handset. What the flag ADDED was a false
 * negative on a real applicant who forwards their own CV out of their email or a chat: a perfectly
 * ordinary way to apply, and one that got total silence, no menu and no acknowledgement.
 *
 * The list is a reliable signal about WHO sent it; the flag was a guess about WHAT the message was,
 * and it guessed wrong on exactly the people this feature exists to serve. Blast radius of the
 * change is one menu to an unlisted forwarder, because only one conversation is open per sender —
 * and the fix for that is to add them to the list, which is what the list is for.
 */
export async function startClassification(input: StartClassificationInput): Promise<StartClassificationOutcome> {
  if (!isWhatsAppClassifyEnabled()) return "disabled";
  if (input.historical) return "skipped_historical";
  if (input.isImportSender) return "skipped_import_sender";

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
  | "asked_other"
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

      // "Other" is the one answer a list cannot finish. Owner's instruction 2026-08-28: let them
      // type it. The conversation parks on `job_title_other` and the NEXT plain text message this
      // sender writes becomes their job title — see handleClassifyText.
      if (parsed.value === "other") {
        await supabase
          .from(SESSIONS_TABLE)
          .update({ job_title_family: "other", step: "job_title_other", updated_at: nowIso })
          .eq("id", session.id);
        await sendPromptText(
          { ...session, phone_number_id: session.phone_number_id ?? input.phoneNumberId },
          jobTitleOtherPromptText(),
        );
        return "asked_other";
      }

      await supabase
        .from(SESSIONS_TABLE)
        .update({ job_title_family: parsed.value, step: "background", updated_at: nowIso })
        .eq("id", session.id);
      const sent = await sendStep({ ...session, phone_number_id: session.phone_number_id ?? input.phoneNumberId }, backgroundMenu());
      return sent ? "advanced" : "advanced";
    }

    if (parsed.step === "background") {
      // "Other" is the one answer a list cannot finish — same shape as the role question. Park on
      // `background_other` and take the next plain text message as their degree.
      if (parsed.value === OTHER_ROW_VALUE) {
        await supabase
          .from(SESSIONS_TABLE)
          .update({ background: "other", step: "background_other", updated_at: nowIso })
          .eq("id", session.id);
        await sendPromptText(
          { ...session, phone_number_id: session.phone_number_id ?? input.phoneNumberId },
          backgroundOtherPromptText(),
        );
        return "asked_other";
      }
      if (!isOfferedBackground(parsed.value)) return "unknown_value";
      await supabase
        .from(SESSIONS_TABLE)
        .update({ background: parsed.value, step: "region", updated_at: nowIso })
        .eq("id", session.id);
      const sent = await sendStep(
        { ...session, phone_number_id: session.phone_number_id ?? input.phoneNumberId },
        regionMenu(),
      );
      return sent ? "advanced" : "advanced";
    }

    if (parsed.step === "region") {
      // The escape, checked BEFORE the vocabulary guard: "other" is deliberately not a region code,
      // so isOfferedRegion rejects it and it would otherwise read as an unknown value and be dropped.
      if (parsed.value === OTHER_ROW_VALUE) {
        await supabase
          .from(SESSIONS_TABLE)
          .update({ step: "region_other", updated_at: nowIso })
          .eq("id", session.id);
        await sendPromptText(
          { ...session, phone_number_id: session.phone_number_id ?? input.phoneNumberId },
          regionOtherPromptText(),
        );
        return "asked_other";
      }
      if (!isOfferedRegion(parsed.value)) return "unknown_value";

      // The cascade. Only a Medical Rep is asked the area; for everyone else the region they just
      // tapped is their last answer, so record it and finish here. Checked BEFORE loading areas —
      // a manager never needs an area list built, and Delta (3)'s empty-area escape below is a
      // medical-rep concern that must not fire for a role that was never going to be asked an area.
      if (!askAreaForRole(session.job_title_family)) {
        await supabase
          .from(SESSIONS_TABLE)
          .update({ region_code: parsed.value, updated_at: nowIso })
          .eq("id", session.id);
        await finishSession({ ...session, region_code: parsed.value }, input.phoneNumberId);
        return "completed";
      }

      const areas = await areaNamesForRegion(parsed.value);
      if (areas.length === 0) {
        // A real region with no areas yet — Delta (3) on 2026-08-28, live and carrying target the
        // day its first District Manager seat opened. This used to give up and file two answers of
        // three. Now it asks them to type the area, because "we have not drawn the areas yet" is our
        // problem, not the applicant's, and the answer is worth more than the silence was.
        await supabase
          .from(SESSIONS_TABLE)
          .update({ region_code: parsed.value, step: "area_other", updated_at: nowIso })
          .eq("id", session.id);
        logWarning("WhatsApp classification found no areas for a region", {
          context: { regionCode: parsed.value },
          labels: { event: "whatsapp_classify_no_areas" },
        });
        await sendPromptText(
          { ...session, phone_number_id: session.phone_number_id ?? input.phoneNumberId },
          areaOtherPromptText(),
        );
        return "asked_other";
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
    if (parsed.value === OTHER_ROW_VALUE) {
      await supabase
        .from(SESSIONS_TABLE)
        .update({ step: "area_other", updated_at: nowIso })
        .eq("id", session.id);
      await sendPromptText(
        { ...session, phone_number_id: session.phone_number_id ?? input.phoneNumberId },
        areaOtherPromptText(),
      );
      return "asked_other";
    }
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

// ── Handling a TYPED answer ──────────────────────────────────────────────────────────────────────

export type ClassifyTextOutcome =
  | "disabled"
  | "no_session"
  | "not_awaiting_text"
  | "unusable_text"
  | "advanced";

/**
 * Takes a plain text message as the answer to "Other", then carries on to question 2.
 *
 * ONLY acts when the sender's open conversation is parked on `job_title_other`. Every other inbound
 * text — a greeting, a note attached to a CV, anything at all — returns `not_awaiting_text` and is
 * left alone for the caller to buffer as CV context, which is what it was before this existed.
 * That narrowness is the whole safety property: this must never swallow a message that was not an
 * answer to a question we asked.
 */
export async function handleClassifyText(input: {
  waId: string;
  phoneNumberId: string | null;
  text: string;
}): Promise<ClassifyTextOutcome> {
  if (!isWhatsAppClassifyEnabled()) return "disabled";

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
    const awaitingText =
      session.step === "job_title_other" ||
      session.step === "background_other" ||
      session.step === "region_other" ||
      session.step === "area_other";
    if (!awaitingText) return "not_awaiting_text";

    const withPhone = { ...session, phone_number_id: session.phone_number_id ?? input.phoneNumberId };
    const nowIso = new Date().toISOString();

    // Too long to be an answer: say so and stay on the same step rather than recording a paragraph
    // in a column a hiring manager reads. The nudge is free — we are inside the window they opened.
    if (session.step === "job_title_other") {
      const typed = cleanTypedAnswer(input.text, JOB_TITLE_OTHER_MAX);
      if (!typed) {
        await sendPromptText(withPhone, jobTitleOtherTooLongText());
        return "unusable_text";
      }
      await supabase
        .from(SESSIONS_TABLE)
        .update({ job_title_other_text: typed, step: "background", updated_at: nowIso })
        .eq("id", session.id);
      await sendStep(withPhone, backgroundMenu());
      return "advanced";
    }

    if (session.step === "background_other") {
      const typed = cleanTypedAnswer(input.text, BACKGROUND_OTHER_MAX);
      if (!typed) {
        await sendPromptText(withPhone, backgroundOtherTooLongText());
        return "unusable_text";
      }
      await supabase
        .from(SESSIONS_TABLE)
        .update({ background_other_text: typed, step: "region", updated_at: nowIso })
        .eq("id", session.id);
      await sendStep(withPhone, regionMenu());
      return "advanced";
    }

    if (session.step === "region_other") {
      const typed = cleanTypedAnswer(input.text, REGION_OTHER_MAX);
      if (!typed) {
        await sendPromptText(withPhone, typedAnswerTooLongText("region", REGION_OTHER_MAX));
        return "unusable_text";
      }
      // The cascade, in its typed form. A Medical Rep types the area next; for everyone else this
      // typed region is their last answer, so finish here. A region we do not have has no areas to
      // list, so the rep's area is typed too — going back to a menu would offer the areas of a
      // DIFFERENT region, which is worse than asking.
      if (!askAreaForRole(session.job_title_family)) {
        await supabase
          .from(SESSIONS_TABLE)
          .update({ region_other_text: typed, updated_at: nowIso })
          .eq("id", session.id);
        await finishSession({ ...session, region_other_text: typed }, input.phoneNumberId);
        return "advanced";
      }
      await supabase
        .from(SESSIONS_TABLE)
        .update({ region_other_text: typed, step: "area_other", updated_at: nowIso })
        .eq("id", session.id);
      await sendPromptText(withPhone, areaOtherPromptText());
      return "advanced";
    }

    // step === "area_other" — the last answer, typed. Finishes the conversation exactly as a tap on
    // the area menu does, so a typed applicant gets the same thank-you and the same mirror.
    const typedArea = cleanTypedAnswer(input.text, AREA_OTHER_MAX);
    if (!typedArea) {
      await sendPromptText(withPhone, typedAnswerTooLongText("area", AREA_OTHER_MAX));
      return "unusable_text";
    }
    await supabase
      .from(SESSIONS_TABLE)
      .update({ area_other_text: typedArea, updated_at: nowIso })
      .eq("id", session.id);
    await finishSession({ ...session, area_other_text: typedArea }, input.phoneNumberId);
    return "advanced";
  } catch (error) {
    logError("WhatsApp classification failed to handle a typed answer", {
      error,
      labels: { event: "whatsapp_classify_text_failed" },
    });
    return "no_session";
  }
}

// ── Finishing: confirm to the applicant, then write to the candidate ─────────────────────────────

async function finishSession(session: SessionRow, fallbackPhoneNumberId: string | null): Promise<void> {
  const roleLabel = sessionRoleLabel(session);
  const backgroundLabel = sessionBackgroundLabel(session);
  const regionLabel = sessionRegionLabel(session);
  const areaLabel = sessionAreaLabel(session);
  // Whether the area question was part of this applicant's flow at all — Medical Rep only. Drives
  // whether the mirror reads a missing area as "not answered" or simply omits it.
  const areaApplies = askAreaForRole(session.job_title_family);

  await applyClassificationToCandidate(session);
  await closeSession(session.id, "completed");

  // Sent once role and region are in. Area is deliberately NOT required: it is Medical-Rep-only, so
  // a manager legitimately completes without one, and gating the thank-you on it would leave every
  // non-rep applicant with no confirmation at all.
  if (roleLabel && regionLabel) {
    await sendWhatsAppText({
      phoneNumberId: session.phone_number_id ?? fallbackPhoneNumberId,
      text: classifyThankYouText({ areaName: areaLabel, backgroundLabel, regionLabel, roleLabel }),
      toWaId: session.wa_id,
    });
  }

  // Resolve the person the same way applyClassificationToCandidate just did. Reading only
  // applied_candidate_id would leave the mirror nameless for every applicant whose session was
  // opened before their CV finished processing — which is the common case, because the three taps
  // take seconds and the intake worker runs on a cron tick.
  const mirroredCandidateId =
    session.applied_candidate_id ?? (await findCandidateForSender(session.wa_id).catch(() => null));

  // Tell the owner, on the phone he actually carries. This is the whole point of the feature from
  // his side: not that the answers are stored, but that he learns a named person applied for a
  // named role in a named area without reading a CV or forwarding anything. Mirrored even when an
  // answer is missing — a partly-filed applicant is still worth knowing about, and the message says
  // which part they did not reach.
  await mirrorWhatsAppEventToOwner({
    areaApplies,
    // The read-back label, so a TYPED area reaches him too — not just a tapped one.
    areaName: areaLabel,
    backgroundLabel,
    candidateName: await candidateDisplayName(mirroredCandidateId),
    kind: "classified",
    regionLabel,
    roleLabel,
    waId: session.wa_id,
  });
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
  // Their typed words when they chose "Other", the family's label otherwise. `sessionRoleLabel` is
  // the single place that decision is made, so the thank-you message, the owner's Telegram mirror
  // and this column can never disagree about what the applicant said.
  const roleLabel = sessionRoleLabel(session);
  if (roleLabel) payload.applied_for_job_title = roleLabel;
  // The graduation background, as a single read-back label (their typed words for "Other", the code's
  // label otherwise). One column, the same shape as `applied_for_job_title`: a fixed vocabulary for a
  // tapped answer, free text only when they said "Other". Nothing reads it back on screen yet — it is
  // captured now and surfaced later, exactly as region/area were before the screening card read them.
  const backgroundLabel = sessionBackgroundLabel(session);
  if (backgroundLabel) payload.declared_background = backgroundLabel;
  // The code column takes ONLY a real code. A typed region is words, and words in a code column is
  // the shape that produced undefined label lookups and NaN sort keys in production on 2026-08-24 —
  // so it gets its own column instead. An area is a name either way, so both forms share one.
  if (session.region_code) payload.preferred_region_code = session.region_code;
  if (session.region_other_text) payload.preferred_region_name = session.region_other_text;
  const areaLabel = sessionAreaLabel(session);
  if (areaLabel) payload.preferred_area_name = areaLabel;

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
