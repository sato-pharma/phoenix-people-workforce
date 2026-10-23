// Recruitment / ATS — the WhatsApp self-classification conversation.
//
// A CV arrives -> ask what role -> ask what they graduated in -> ask which region -> (Medical Rep
// only) ask which area inside it -> ask how many years of experience -> ask what salary they expect
// -> write the answers onto the candidate. Each answer comes back as its own webhook event minutes
// apart, with nothing but the sender's number tying them together, so the conversation's position is
// held in `ats_whatsapp_classification_sessions` (one open row per sender).
//
// EVERY ONE OF THE SIX CAN NOW BE SKIPPED, and which ones are is the owner's to set on
// /admin/screening-questions — the same "who is asked" control the extra questions have had since
// 2026-09-02, extended to the built-in six on 2026-09-05. The area question is where that started:
// owner's rule 2026-08-30 asked it only of a Medical Rep, hardcoded, and that rule is now simply the
// default audience for `area` (whatsapp-question-audience.ts) rather than a branch. Question 1 is
// the one exception and always will be — it establishes the role every other audience is judged
// against, so there is nothing to judge it by.
//
// The consequence for this file: there is exactly ONE place a built-in question decides what comes
// next, `advanceAfterBuiltIn`. It used to be eight hardcoded transitions with the area skip written
// out at three of them.
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
import { loadAutoReplyOverrides } from "@/lib/recruitment/inbound/whatsapp-auto-replies-store";
import { SESSION_COLUMNS, type SessionRow } from "@/lib/recruitment/inbound/whatsapp-classify-session-row";
// The owner's own wording for these six questions, when he has saved any. Pure helper + a cached,
// never-throwing read: with nothing saved (or on a read failure) every prompt keeps its code default.
import {
  applyPromptOverride,
  resolvePromptBody,
} from "@/lib/recruitment/inbound/whatsapp-question-prompts";
import { loadQuestionPromptOverrides } from "@/lib/recruitment/inbound/whatsapp-question-prompts-store";
import {
  builtInQuestionAppliesToRole,
  nextBuiltInQuestion,
  type BuiltInQuestionKey,
  type SavedAudiences,
} from "@/lib/recruitment/inbound/whatsapp-question-audience";
import {
  AREA_OTHER_MAX,
  areaMenu,
  areaOtherPromptText,
  BACKGROUND_OTHER_MAX,
  backgroundMenu,
  backgroundOtherPromptText,
  backgroundOtherTooLongText,
  candidateBackgroundLabels,
  candidateExperienceLabels,
  classifyThankYouText,
  cleanTypedAnswer,
  EXPECTED_SALARY_MAX,
  experienceMenu,
  isOfferedBackground,
  isOfferedExperience,
  isOfferedRegion,
  isOfferedRoleFamily,
  JOB_TITLE_OTHER_MAX,
  jobTitleMenu,
  jobTitleOtherPromptText,
  jobTitleOtherTooLongText,
  OTHER_ROW_VALUE,
  parseClassifyRowId,
  parseDeclaredSalaryFigure,
  reaskPromptForStep,
  REGION_OTHER_MAX,
  regionMenu,
  regionOtherPromptText,
  salaryPromptText,
  salaryTooLongText,
  shouldReaskParkedSession,
  typedAnswerTooLongText,
  type ClassifyMenu,
  type ClassifyReaskPrompt,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import {
  candidateDisplayName,
  mirrorWhatsAppEventToOwner,
} from "@/lib/recruitment/inbound/whatsapp-conversation-mirror";
import { mirrorCandidateCvsToDrive } from "@/lib/recruitment/drive-cv-mirror";
import { sendClassifyMenu, sendWhatsAppText } from "@/lib/recruitment/inbound/whatsapp-interactive";
// Each answer onto the candidate as it is given (owner, 2026-10-20). That file imports
// classificationPayload/sessionAreaLabel back from this one — function declarations, safe across the
// cycle for the same reason the extra-question loop below is.
import {
  afterSessionAnswersWritten,
  applyBuiltInAnswerToCandidate,
  mergeExtraAnswers,
  readAnswerMarks,
} from "@/lib/recruitment/inbound/whatsapp-answer-sync";
import { linkSessionsToCandidates } from "@/lib/recruitment/inbound/whatsapp-session-link";
import {
  firstUnansweredBuiltIn,
  prefilledBuiltInKeys,
  RESUME_CANDIDATE_COLUMNS,
  sessionPrefillFromCandidate,
  type ResumeCandidateRow,
} from "@/lib/recruitment/inbound/whatsapp-classify-resume-plan";
import { BUILT_IN_ANSWER_KEYS, recomputeCompleteness } from "@/lib/recruitment/workspace/completeness";
// The admin-defined extra-question loop this conversation optionally continues into once the fixed
// six finish. whatsapp-screening-questions-session.ts imports finishSession/findCandidateForSender/
// isWhatsAppClassifyEnabled back from this file — all `function` declarations, which are hoisted and
// safe to read across a circular import. SessionRow/SESSION_COLUMNS, the other two symbols that file
// needs, live in whatsapp-classify-session-row.ts instead of here specifically to avoid this cycle:
// SESSION_COLUMNS is a `const`, and a `const` read from a module still mid-initialization throws.
import {
  listActiveScreeningQuestions,
  resendExtraQuestion,
  startExtraQuestionLoop,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions-session";
import { nextActiveQuestion } from "@/lib/recruitment/inbound/whatsapp-screening-questions";

const SESSIONS_TABLE = "ats_whatsapp_classification_sessions";

/** True only when the flag is on AND a token exists — otherwise the whole feature is inert. */
export function isWhatsAppClassifyEnabled(): boolean {
  const flag = String(process.env.RECRUITMENT_WHATSAPP_CLASSIFY_ENABLED ?? "").trim().toLowerCase();
  return flag === "true" && Boolean(process.env.WHATSAPP_ACCESS_TOKEN?.trim());
}

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

/**
 * The experience band as it should be READ BACK — the code's label. Same single-source rule as
 * `sessionRoleLabel`, so the thank-you message, the owner's Telegram mirror and the candidate column
 * never disagree. There is no "Other" on this question, so this only ever reads the label map,
 * guarded by `isOfferedExperience` so a stale code yields null rather than a literal `undefined`.
 */
export function sessionExperienceLabel(session: { experience: string | null }): string | null {
  if (session.experience && isOfferedExperience(session.experience)) {
    return candidateExperienceLabels[session.experience];
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
  regionLabel?: string | null,
): Promise<boolean> {
  // The one seam where the owner's wording is applied. Every tappable question in this file goes
  // through here, so an override cannot reach one prompt and miss another. A step with nothing saved
  // gets the identical object back, so the untouched path is exactly the pre-feature code path.
  // The read never throws: a failure returns an empty map and every question keeps its default.
  const worded = applyPromptOverride(menu, await loadQuestionPromptOverrides(), regionLabel);
  const result = await sendClassifyMenu({
    menu: worded,
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
 * The salary question's wording. It is the one built-in question sent as plain text rather than a
 * menu, so it cannot ride through `sendStep`'s override seam and resolves its own here instead.
 */
async function salaryPromptWithOverride(): Promise<string> {
  return resolvePromptBody({
    defaultBody: salaryPromptText(),
    key: "salary",
    overrides: await loadQuestionPromptOverrides(),
  });
}

/**
 * The audiences the owner has saved for the six, keyed by step.
 *
 * Read through the same never-throwing override load every prompt already goes through, so one
 * database hiccup cannot both blank the wording and rearrange who is asked what — it leaves every
 * question on its code default, which is exactly what this conversation did before either feature
 * existed. A key ABSENT from the map is "nothing configured", which is the `undefined`
 * `resolveBuiltInAudience` expects, so a plain `.get()` is already the right argument.
 *
 * Exported for the WhatsApp Applicants page, so the page and the bot never disagree about who is
 * asked what.
 */
export async function loadSavedAudiences(): Promise<SavedAudiences> {
  const byKey = new Map<string, readonly string[]>();
  for (const [key, override] of await loadQuestionPromptOverrides()) {
    if (override.appliesToRoleFamilies !== undefined) byKey.set(key, override.appliesToRoleFamilies);
  }
  return byKey;
}

/** The three built-in questions that are an ordinary menu send. `area` builds its rows from the
 *  applicant's own region and `salary` is plain text, so both are handled apart in
 *  `advanceAfterBuiltIn`. `job_title` is here only to keep the map total — it is question one, so
 *  it can never be what comes NEXT. */
const BUILT_IN_MENUS: Record<Exclude<BuiltInQuestionKey, "area" | "salary">, () => ClassifyMenu> = {
  background: backgroundMenu,
  experience: experienceMenu,
  job_title: jobTitleMenu,
  region: regionMenu,
};

/**
 * Everything that happens once the fixed six are done for this applicant: hand off to the
 * admin-defined extra questions when any are active for their role, else finish.
 *
 * Extracted from the salary step because salary is no longer guaranteed to BE the last question. The
 * owner can now narrow it to particular job titles, and an applicant it does not apply to finishes
 * the moment the question before it is answered. Two copies of this hand-off would be two places for
 * the extra-question loop to go missing, and the symptom — a conversation that simply stops after
 * the six — looks like the applicant went quiet.
 */
async function finishFixedSix(session: SessionRow, phoneNumberId: string | null): Promise<void> {
  // Scoped to the role this applicant tapped, so the Office Coordinator questions never reach a
  // Medical Rep. See listActiveScreeningQuestions.
  const activeExtraQuestions = await listActiveScreeningQuestions(session.job_title_family);
  if (activeExtraQuestions.length > 0) {
    await startExtraQuestionLoop(session, phoneNumberId, activeExtraQuestions);
  } else {
    await finishSession(session, phoneNumberId);
  }
}

/**
 * Record one of the six answers, then ask whichever of the six comes NEXT for this applicant.
 *
 * THE ONE PLACE A BUILT-IN TRANSITION HAPPENS. This file used to carry eight hardcoded
 * `step: "<the next one>"` transitions — five tapped, three typed — and the single skip that existed
 * (`askAreaForRole`) was already written out at three of them. Making all six skippable that way
 * would have meant every question's rule repeated at every site, with the "Other" branches as the
 * quiet place one goes missing: those are the paths nobody re-reads, and a missed skip there asks a
 * manager for a territory rather than failing loudly.
 *
 * The answer in `patch` is written whether or not a next question exists, so an answer is never lost
 * to a conversation that ends on it.
 */
async function advanceAfterBuiltIn(input: {
  session: SessionRow;
  /** The question just answered. Pass the plain key for a typed "Other" answer too — `region_other`
   *  finishes the region question exactly as a tapped region does. */
  after: BuiltInQuestionKey;
  /** The answer columns this transition writes. */
  patch: Record<string, string>;
  phoneNumberId: string | null;
  nowIso: string;
}): Promise<"advanced" | "asked_other"> {
  const { after, nowIso, patch, session } = input;
  const supabase = recruitmentDb();
  // The session as it will be AFTER this answer. `patch` routinely holds the very field the next
  // decision reads — the role on question 1, the region on question 3 — so the decision is made
  // against the merged row and never against the stale one it was loaded from.
  const answered = { ...session, ...patch } as SessionRow;

  const audiences = await loadSavedAudiences();
  const nextAfter = (key: BuiltInQuestionKey) =>
    nextBuiltInQuestion({
      after: key,
      audiences,
      // Tapped or typed — either is a region on file. A TYPED one has no region code, which is what
      // sends the area question down its typed path below rather than to a menu listing some other
      // region's areas.
      hasRegion: Boolean(answered.region_code || answered.region_other_text),
      roleFamily: answered.job_title_family,
    });
  // A question this conversation already holds an answer to is stepped over. A fresh conversation
  // never holds a LATER answer, so for it this is the plain next question; a RESUMED one (the
  // applicant replied to "Ask again") starts pre-filled from their record and is asked only what is
  // still missing (whatsapp-classify-resume-plan.ts).
  const alreadyAnswered = prefilledBuiltInKeys(answered);
  let next = nextAfter(after);
  while (next && alreadyAnswered.has(next)) next = nextAfter(next);

  // Every path below writes the answer exactly once through here, and the answer then goes straight
  // onto the candidate — saved as given, not only when the conversation finishes (owner, 2026-10-20).
  const write = async (extra: Record<string, string>) => {
    await supabase
      .from(SESSIONS_TABLE)
      .update({ ...patch, ...extra, updated_at: nowIso })
      .eq("id", session.id);
    await applyBuiltInAnswerToCandidate(answered, after);
  };

  if (!next) {
    await write({});
    await finishFixedSix(answered, input.phoneNumberId);
    return "advanced";
  }

  const asked = await askBuiltInQuestion({
    next,
    park: (step) => write({ step }),
    phoneNumberId: input.phoneNumberId,
    session: answered,
  });
  return asked.kind;
}

/**
 * Parks the conversation on one of the six and asks it. `park` writes the step (and, from
 * `advanceAfterBuiltIn`, the answer that led here) BEFORE the send, so a typed answer that arrives
 * even after a failed send is still understood. Shared by the next-question path and a resumed
 * conversation's first question.
 */
async function askBuiltInQuestion(input: {
  session: SessionRow;
  next: BuiltInQuestionKey;
  park: (step: string) => Promise<void>;
  phoneNumberId: string | null;
}): Promise<{ kind: "advanced" | "asked_other"; sent: boolean }> {
  const { next, park } = input;
  const answered = input.session;
  const withPhone = { ...answered, phone_number_id: answered.phone_number_id ?? input.phoneNumberId };
  const write = (extra: { step: string }) => park(extra.step);

  if (next === "area") {
    // Two ways the area question cannot be a menu, and both end as a TYPED answer rather than as a
    // silence: the applicant typed their own region, so there is nothing to list areas for; and a
    // real region with no areas drawn yet — Delta (3) on 2026-08-28, live and carrying target the
    // day its first District Manager seat opened. Asking is worth more than giving up, because "we
    // have not drawn the areas yet" is our problem and not the applicant's.
    const areas = answered.region_code ? await areaNamesForRegion(answered.region_code) : [];
    if (areas.length === 0) {
      if (answered.region_code) {
        logWarning("WhatsApp classification found no areas for a region", {
          context: { regionCode: answered.region_code },
          labels: { event: "whatsapp_classify_no_areas" },
        });
      }
      await write({ step: "area_other" });
      return { kind: "asked_other", sent: await sendPromptText(withPhone, areaOtherPromptText()) };
    }
    await write({ step: "area" });
    const sentArea = await sendStep(
      withPhone,
      areaMenu(answered.region_code as CandidateRegionCode, areas),
      // The only prompt carrying a token: an owner-written "Which area inside {region}?" needs the
      // region they just chose. Passed here rather than derived in sendStep, which cannot know it.
      candidateRegionLabels[answered.region_code as CandidateRegionCode],
    );
    return { kind: "advanced", sent: sentArea };
  }

  if (next === "salary") {
    // The one built-in sent as plain text — there is nothing to tap — so the step is parked here
    // rather than by sendStep, and it must stay parked even if the send fails, so a typed answer
    // that arrives anyway is still understood.
    await write({ step: "salary" });
    return { kind: "advanced", sent: await sendPromptText(withPhone, await salaryPromptWithOverride()) };
  }

  await write({ step: next });
  return { kind: "advanced", sent: await sendStep(withPhone, BUILT_IN_MENUS[next]()) };
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

async function closeSession(sessionId: string, reason: string): Promise<void> {
  const supabase = recruitmentDb();
  // A conversation the applicant walked away from is closed with what they DID answer saved first
  // (owner, 2026-10-20): every answer normally reached the candidate as it was given, and this is the
  // net under the one that could not — the candidate did not exist yet at the time.
  if (reason === "window_closed") await applyAnswersBeforeClosing(sessionId);
  await supabase
    .from(SESSIONS_TABLE)
    .update({ completed_at: new Date().toISOString(), step: "done", updated_at: new Date().toISOString() })
    .eq("id", sessionId);
}

/**
 * Writes an abandoned conversation's answers — the six and any extra ones — onto its candidate before
 * it is closed. Best effort and silent: the applicant is gone, and a candidate not found yet is
 * picked up by the intake worker's backfill.
 */
export async function applyAnswersBeforeClosing(sessionId: string): Promise<void> {
  try {
    const { data } = await recruitmentDb()
      .from(SESSIONS_TABLE)
      .select(`${SESSION_COLUMNS},extra_answers`)
      .eq("id", sessionId)
      .maybeSingle();
    const row = data as (SessionRow & { extra_answers: Record<string, string> | null }) | null;
    if (!row || !row.job_title_family) return;
    const candidateId = (await linkSessionsToCandidates([row])).get(row.id) ?? null;
    if (!candidateId) return;
    await writeClassification(candidateId, row, { finished: true });
    const extras = row.extra_answers ?? {};
    if (Object.keys(extras).length > 0) {
      await mergeExtraAnswers(candidateId, extras, { keepHrAnswers: true });
      await recomputeCompleteness([candidateId]);
    }
  } catch (error) {
    logError("WhatsApp answers could not be saved before the conversation closed", {
      error,
      labels: { event: "whatsapp_classify_close_apply_failed" },
    });
  }
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
  | "reasked"
  | "asked";

/**
 * Opens the conversation and asks question 1 — or, when one is already open and has gone quiet,
 * re-asks the question it is parked on (see reaskOpenSession). Returns why it did nothing when it
 * did nothing.
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
    // would reject the insert anyway. It gets the question it is parked on again instead of the
    // silence this used to answer with — see reaskOpenSession.
    const { data: existing } = await supabase
      .from(SESSIONS_TABLE)
      .select(`${SESSION_COLUMNS},updated_at,extra_current_question_key`)
      .eq("wa_id", input.waId)
      .is("completed_at", null)
      .maybeSingle();
    if (existing) return reaskOpenSession(existing as OpenSessionRow, input);

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
    // Two CVs from one sender arriving in the same second both find no open conversation; the open-
    // conversation unique index lets exactly one insert land, and THAT request asks question one. The
    // loser is not a failure — the applicant is already being asked — so it says so instead of
    // logging a crash and answering send_failed (3 Oct 2026 21:12 Cairo, System Audit APP-B05C8CA4).
    if (error && (error as { code?: string }).code === "23505") return "already_open";
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

/**
 * The session row plus the one column `SESSION_COLUMNS` leaves out. `updated_at` is not part of the
 * conversation's state — nothing in the flow reads it — but it is how long the applicant has been
 * quiet, which is the only thing separating a stalled conversation from a live one.
 */
export type OpenSessionRow = SessionRow & {
  updated_at: string | null;
  /** Which admin-defined question the `extra` step is waiting on. Null on every other step. */
  extra_current_question_key: string | null;
};

/**
 * A CV arrived while this sender's conversation is still open. Ask again.
 *
 * THE SILENCE THIS REPLACES WAS PERMANENT, and that is the whole point of it. A conversation parks
 * when the applicant is asked something and never taps an answer. Nothing then moves it: the only
 * thing that ever closed a stalled row was Meta rejecting a send as `window_closed`, and no send
 * was attempted on this path — so the row stayed open, and every future CV from that number was met
 * with nothing, for good. Production on 2026-09-02: 68 open conversations, all quiet more than six
 * hours, 22 of them still on question one having answered nothing, and three senders who had
 * already re-sent a CV into it and heard nothing back.
 *
 * Re-asking also restores the self-heal, because it is a send: if the applicant really has gone,
 * `sendStep`/`sendPromptText` close the row on `window_closed` and the next CV starts fresh. In
 * practice the window is open here — the CV that triggered this opened it seconds ago — so the
 * question lands.
 *
 * The CV is captured and queued regardless, by the caller, before any of this runs. Nothing here
 * can lose one.
 */
async function reaskOpenSession(
  session: OpenSessionRow,
  input: StartClassificationInput,
): Promise<StartClassificationOutcome> {
  if (!shouldReaskParkedSession({ nowMs: Date.now(), updatedAt: session.updated_at })) return "already_open";

  const prompt = await parkedQuestionPrompt(session);
  if (!prompt) return "already_open";

  const supabase = recruitmentDb();
  // Write-only metadata — nothing reads it — but it is the trace of which CV last put a question in
  // front of this person, and after a re-ask that is the one that just arrived.
  await supabase.from(SESSIONS_TABLE).update({ cv_wamid: input.cvWamid }).eq("id", session.id);

  return (await sendParkedQuestion(session, prompt, input.phoneNumberId)) ? "reasked" : "send_failed";
}

/**
 * What a parked conversation is waiting on, as something to send again — or null when there is
 * nothing to re-ask. A row on `extra` with no current key is unreachable in a healthy session —
 * treated as nothing to re-ask, never as a reason to guess at a question.
 */
async function parkedQuestionPrompt(session: OpenSessionRow): Promise<ClassifyReaskPrompt | null> {
  const areaNames =
    session.step === "area" && session.region_code ? await areaNamesForRegion(session.region_code) : [];
  const prompt = reaskPromptForStep({ areaNames, regionCode: session.region_code, step: session.step });
  if (!prompt) return null;
  if (prompt.kind === "extra" && !session.extra_current_question_key) return null;
  return prompt;
}

/** Sends a parked conversation's question again. True when it reached them. */
async function sendParkedQuestion(
  session: OpenSessionRow,
  prompt: ClassifyReaskPrompt,
  fallbackPhoneNumberId: string | null,
): Promise<boolean> {
  // A row written before the phone number was recorded still has to be answerable, so the delivery's
  // own number stands in — the same fallback every other send in this file uses.
  const target = { ...session, phone_number_id: session.phone_number_id ?? fallbackPhoneNumberId };

  // The extra question is the one prompt this file cannot build: it lives in the database and is
  // scoped to the role the applicant tapped, so the loop that owns it re-sends it. False when the
  // question has since gone, so it reads as nothing sent.
  if (prompt.kind === "extra") {
    return resendExtraQuestion(target, session.extra_current_question_key ?? "", session.job_title_family);
  }
  return prompt.kind === "menu"
    ? sendStep(target, prompt.menu, prompt.regionLabel)
    : sendPromptText(target, prompt.kind === "salary" ? await salaryPromptWithOverride() : prompt.body);
}

/**
 * The half-hourly re-ask (owner, 2026-10-20; app/api/cron/recruitment-whatsapp-reask): an applicant
 * who went quiet mid-conversation is asked the question they stopped on ONCE more, while WhatsApp's
 * 24-hour window is still open. Same prompt, same send as a new CV's re-ask above — one code path.
 * The caller decides who is due and stamps `reasked_at`; this only sends.
 */
export async function reaskQuietSession(
  session: OpenSessionRow,
): Promise<"reasked" | "nothing_to_ask" | "send_failed"> {
  const prompt = await parkedQuestionPrompt(session);
  if (!prompt) return "nothing_to_ask";
  return (await sendParkedQuestion(session, prompt, null)) ? "reasked" : "send_failed";
}

export type ResumeClassificationOutcome = "disabled" | "already_open" | "not_found" | "nothing_to_ask" | "asked" | "send_failed";

/**
 * The applicant replied to "Ask again" (the approved follow-up template, whatsapp-followup-template.ts):
 * open a NEW conversation for the candidate they already are and ask the first question still
 * missing (owner, 2026-10-20: the bot picks the conversation up where their answers stop).
 *
 * The conversation starts PRE-FILLED with every answer already on their record
 * (whatsapp-classify-resume-plan.ts), and is linked to them from the first moment
 * (`applied_candidate_id`, the bot's own link), so each new answer goes straight onto this person
 * and never onto whoever else shares the number. Nothing already answered is asked again (but the
 * role, for someone filed in no tab yet — the plan's "Needs placing starts from the role menu"): the
 * six step over a held answer, the extra questions start after the ones held, and an answer HR typed
 * in keeps its mark, because the finish writes only the questions HR has not marked.
 *
 * One open conversation per number, as everywhere: one already open is left to run. Their reply
 * opened the 24-hour window seconds ago, so the question lands.
 */
export async function resumeClassification(input: {
  candidateId: string;
  waId: string;
  phoneNumberId: string | null;
}): Promise<ResumeClassificationOutcome> {
  if (!isWhatsAppClassifyEnabled()) return "disabled";
  try {
    const supabase = recruitmentDb();
    const { data: open } = await supabase
      .from(SESSIONS_TABLE)
      .select("id")
      .eq("wa_id", input.waId)
      .is("completed_at", null)
      .maybeSingle();
    if (open) return "already_open";

    const { data: row, error } = await supabase
      .from("ats_candidates")
      .select(RESUME_CANDIDATE_COLUMNS)
      .eq("id", input.candidateId)
      .maybeSingle();
    if (error) throw error;
    if (!row) return "not_found";

    const prefill = sessionPrefillFromCandidate(row as unknown as ResumeCandidateRow);
    // Someone filed in no tab yet starts from the role menu, whatever role is on record — the role
    // they tap is what files them. Everything else they already answered is still stepped over.
    const { count: placements, error: placedError } = await supabase
      .from("ats_candidate_placements")
      .select("id", { count: "exact", head: true })
      .eq("candidate_id", input.candidateId);
    if (placedError) throw placedError;
    const next: BuiltInQuestionKey | null =
      (placements ?? 0) === 0 ? "job_title" : firstUnansweredBuiltIn(prefill, await loadSavedAudiences());
    let active: Awaited<ReturnType<typeof listActiveScreeningQuestions>> = [];
    if (!next) {
      active = await listActiveScreeningQuestions(prefill.job_title_family);
      const answeredExtras = new Set(Object.keys(prefill.extra_answers));
      if (!nextActiveQuestion(active, answeredExtras, prefill.extra_answers)) return "nothing_to_ask";
    }

    const { data: inserted, error: insertError } = await supabase
      .from(SESSIONS_TABLE)
      .insert({
        ...prefill,
        applied_candidate_id: input.candidateId,
        phone_number_id: input.phoneNumberId,
        step: next ?? "extra",
        wa_id: input.waId,
      })
      .select(SESSION_COLUMNS)
      .single();
    if (insertError) {
      // The one-open-conversation index: a conversation opened between the read and the insert.
      if ((insertError as { code?: string }).code === "23505") return "already_open";
      throw insertError;
    }
    const session = inserted as SessionRow;

    if (next) {
      const asked = await askBuiltInQuestion({
        next,
        park: async (step) => {
          await supabase
            .from(SESSIONS_TABLE)
            .update({ step, updated_at: new Date().toISOString() })
            .eq("id", session.id);
        },
        phoneNumberId: input.phoneNumberId,
        session,
      });
      return asked.sent ? "asked" : "send_failed";
    }
    await startExtraQuestionLoop(session, input.phoneNumberId, active);
    return "asked";
  } catch (error) {
    logError("A WhatsApp conversation could not be resumed after Ask again", {
      error,
      labels: { event: "whatsapp_classify_resume_failed" },
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

      return advanceAfterBuiltIn({
        after: "job_title",
        nowIso,
        patch: { job_title_family: parsed.value },
        phoneNumberId: input.phoneNumberId,
        session,
      });
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
      return advanceAfterBuiltIn({
        after: "background",
        nowIso,
        patch: { background: parsed.value },
        phoneNumberId: input.phoneNumberId,
        session,
      });
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

      return advanceAfterBuiltIn({
        after: "region",
        nowIso,
        patch: { region_code: parsed.value },
        phoneNumberId: input.phoneNumberId,
        session,
      });
    }

    if (parsed.step === "area") {
      // The area answer — a Medical Rep's last geography question. A manager never reaches it (the
      // region cascade above sent them on to experience). After it, everyone converges on the two
      // screening questions.
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
      return advanceAfterBuiltIn({
        after: "area",
        nowIso,
        patch: { area_name: parsed.value },
        phoneNumberId: input.phoneNumberId,
        session,
      });
    }

    // step === "experience" — the last TAPPABLE answer, asked to everyone. Falls through here rather
    // than sitting behind its own `if`, for the same reason `area` used to: parseClassifyRowId yields
    // only the five tappable steps, the four above are handled, so this is the only one left and the
    // guaranteed return keeps the function total. The next and final question — expected salary — is
    // TYPED, so park on `salary` and let handleClassifyText take the figure. No "Other" branch: the
    // bands are exhaustive, so isOfferedExperience is the only guard needed.
    if (!isOfferedExperience(parsed.value)) return "unknown_value";
    return advanceAfterBuiltIn({
      after: "experience",
      nowIso,
      patch: { experience: parsed.value },
      phoneNumberId: input.phoneNumberId,
      session,
    });
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
      session.step === "area_other" ||
      session.step === "salary";
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
      await advanceAfterBuiltIn({
        after: "job_title",
        nowIso,
        patch: { job_title_other_text: typed },
        phoneNumberId: input.phoneNumberId,
        session,
      });
      return "advanced";
    }

    if (session.step === "background_other") {
      const typed = cleanTypedAnswer(input.text, BACKGROUND_OTHER_MAX);
      if (!typed) {
        await sendPromptText(withPhone, backgroundOtherTooLongText());
        return "unusable_text";
      }
      await advanceAfterBuiltIn({
        after: "background",
        nowIso,
        patch: { background_other_text: typed },
        phoneNumberId: input.phoneNumberId,
        session,
      });
      return "advanced";
    }

    if (session.step === "region_other") {
      const typed = cleanTypedAnswer(input.text, REGION_OTHER_MAX);
      if (!typed) {
        await sendPromptText(withPhone, typedAnswerTooLongText("region", REGION_OTHER_MAX));
        return "unusable_text";
      }
      await advanceAfterBuiltIn({
        after: "region",
        nowIso,
        patch: { region_other_text: typed },
        phoneNumberId: input.phoneNumberId,
        session,
      });
      return "advanced";
    }

    if (session.step === "area_other") {
      // The typed area — a Medical Rep's last geography answer. Advances to experience exactly as a
      // tapped area does, so a typed applicant walks the same remaining flow.
      const typedArea = cleanTypedAnswer(input.text, AREA_OTHER_MAX);
      if (!typedArea) {
        await sendPromptText(withPhone, typedAnswerTooLongText("area", AREA_OTHER_MAX));
        return "unusable_text";
      }
      await advanceAfterBuiltIn({
        after: "area",
        nowIso,
        patch: { area_other_text: typedArea },
        phoneNumberId: input.phoneNumberId,
        session,
      });
      return "advanced";
    }

    // step === "salary" — the last of the fixed six, typed. Finishes THAT set, so every path (rep or
    // manager, tapped or typed) lands here. What happens next depends on whether the owner has
    // defined any active extra question at this exact moment: none -> finish exactly as this always
    // has; one or more -> hand off to the extra-question loop, which calls this same finishSession,
    // unmodified, once IT completes. Stored VERBATIM: an expected salary is "12000", a range,
    // "negotiable" or Arabic numerals, and coercing it to a number would throw away the truthful
    // answer.
    const typedSalary = cleanTypedAnswer(input.text, EXPECTED_SALARY_MAX);
    if (!typedSalary) {
      await sendPromptText(withPhone, salaryTooLongText());
      return "unusable_text";
    }
    await advanceAfterBuiltIn({
      after: "salary",
      nowIso,
      patch: { expected_salary: typedSalary },
      phoneNumberId: input.phoneNumberId,
      session,
    });
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

// Exported so the extra-question loop can call it directly once IT finishes — same thank-you text,
// same six-column write, same owner Telegram mirror, same closeSession, for every session whether or
// not it ever saw an admin-defined question.
export async function finishSession(
  session: SessionRow,
  fallbackPhoneNumberId: string | null,
  /** `closingText` replaces the usual summary — used when an answer ends the conversation early (an
   *  admin-defined question's `endOn`), so the applicant is told why instead of being read a recap of
   *  a form they did not finish. Everything else (the candidate write, the owner mirror, the Drive
   *  move) still runs. */
  options?: { closingText?: string },
): Promise<void> {
  const roleLabel = sessionRoleLabel(session);
  const backgroundLabel = sessionBackgroundLabel(session);
  const regionLabel = sessionRegionLabel(session);
  const areaLabel = sessionAreaLabel(session);
  const experienceLabel = sessionExperienceLabel(session);
  // Verbatim — never coerced. See the salary column note in writeClassification and the menu file.
  const expectedSalary = session.expected_salary ?? null;
  // Whether the area question was part of this applicant's flow at all. Drives whether the mirror
  // reads a missing area as "not answered" or simply omits it — so it has to ask the SAME question
  // the flow asked, audience and all. Reading the code default alone would tell the owner an area is
  // missing from a manager he deliberately narrowed the question away from.
  const savedAudiences = await loadSavedAudiences();
  const areaApplies = builtInQuestionAppliesToRole("area", savedAudiences.get("area"), session.job_title_family);
  // Same question for the region, and it has to be asked the same way: the mirror otherwise reports
  // "Region: not answered" for somebody the owner himself excluded from that question.
  const regionApplies = builtInQuestionAppliesToRole("region", savedAudiences.get("region"), session.job_title_family);

  await applyClassificationToCandidate(session);
  await closeSession(session.id, "completed");

  // Sent once the ROLE is in, and nothing else is required.
  //
  // This used to also require a region, which was safe only while the region question was asked to
  // everybody. Since 2026-09-05 it is one of six the owner can narrow to particular job titles, and
  // the moment he narrows it the old gate would have left every applicant outside that list with no
  // confirmation at all — silence, at the end of a conversation they completed. That is precisely
  // the failure the previous comment here described and deliberately avoided for the AREA question;
  // narrowing the region question simply moved it one question up. Every other line was already
  // shown-when-present, so the summary reads correctly with any subset missing.
  if (options?.closingText) {
    await sendWhatsAppText({
      phoneNumberId: session.phone_number_id ?? fallbackPhoneNumberId,
      text: options.closingText,
      toWaId: session.wa_id,
    });
  } else if (roleLabel) {
    await sendWhatsAppText({
      phoneNumberId: session.phone_number_id ?? fallbackPhoneNumberId,
      text: classifyThankYouText({
        areaName: areaLabel,
        backgroundLabel,
        expectedSalary,
        experienceLabel,
        // The owner's wording for the first and last lines, if he has saved any. Best-effort inside
        // the store, so a database hiccup costs the wording and never the confirmation itself.
        overrides: await loadAutoReplyOverrides(),
        regionLabel,
        roleLabel,
      }),
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
    expectedSalary,
    experienceLabel,
    kind: "classified",
    regionApplies,
    regionLabel,
    roleLabel,
    waId: session.wa_id,
  });

  // Their CV is already in Drive, sitting in the holding folder — it was filed the moment it
  // arrived, before any of these answers existed. NOW it can move to the region and area they just
  // named. This is the second half of the Drive design and the reason the upload never waits: a move
  // is one request and costs nothing, while waiting would leave three CVs in five unfiled for good,
  // because most applicants never finish the conversation.
  //
  // Last, and best-effort, so nothing above it can be lost to a Drive outage.
  await mirrorCandidateCvsToDrive(mirroredCandidateId).catch(() => {});
}

/**
 * The candidate this WhatsApp sender's CV became, via the intake-event trail.
 *
 * Deliberately NOT a phone lookup on ats_candidates: `phone_norm` is an app-maintained dedupe
 * column and matching on it by hand is exactly what the house rule warns against. The intake event
 * already records `sender_identifier` (`+<waId>`) beside the candidate it produced, which is the
 * authoritative link and needs no normalisation of our own.
 */
// Exported for the same reason finishSession is — the extra-question loop needs the same lookup to
// resolve the owner-mirror candidate name and to write its own answers onto the right candidate row.
export async function findCandidateForSender(waId: string): Promise<string | null> {
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
    // By the three safe links (whatsapp-session-link.ts), never "the newest CV from this number": on a
    // forwarder's number that is somebody else's CV, and these answers would land on a stranger.
    const candidateId = (await linkSessionsToCandidates([session])).get(session.id) ?? null;
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

/**
 * The candidate columns the conversation's answers write, keyed as `writeClassification` has always
 * written them. `only` narrows it to the columns of those questions — what the bot writes the moment
 * ONE answer is given (whatsapp-answer-sync.ts), so a later answer never re-writes an earlier one HR
 * may have corrected since. One map for both, so an answer saved as given and an answer saved at the
 * finish can never land in different columns.
 */
export function classificationPayload(
  session: SessionRow,
  only?: readonly BuiltInQuestionKey[],
): Record<string, unknown> {
  const wants = (key: BuiltInQuestionKey) => !only || only.includes(key);
  const nowIso = new Date().toISOString();

  // Only the fields the applicant actually answered are written. An unanswered question must leave
  // its column untouched rather than blanking whatever is already on the record — writing an
  // optional field unconditionally is a silent erase.
  const payload: Record<string, unknown> = { preferences_declared_at: nowIso };
  // Their typed words when they chose "Other", the family's label otherwise. `sessionRoleLabel` is
  // the single place that decision is made, so the thank-you message, the owner's Telegram mirror
  // and this column can never disagree about what the applicant said.
  const roleLabel = sessionRoleLabel(session);
  if (wants("job_title") && roleLabel) payload.applied_for_job_title = roleLabel;
  // The role FAMILY they tapped, raw — what the workspace files them by (owner, 2026-10-20: "we
  // folder based on whatsapp replies"). The label above is for reading; this is the code.
  if (wants("job_title") && session.job_title_family) payload.declared_role_family = session.job_title_family;
  // The graduation background, as a single read-back label (their typed words for "Other", the code's
  // label otherwise). One column, the same shape as `applied_for_job_title`: a fixed vocabulary for a
  // tapped answer, free text only when they said "Other". Nothing reads it back on screen yet — it is
  // captured now and surfaced later, exactly as region/area were before the screening card read them.
  const backgroundLabel = sessionBackgroundLabel(session);
  if (wants("background") && backgroundLabel) payload.declared_background = backgroundLabel;
  // The code column takes ONLY a real code. A typed region is words, and words in a code column is
  // the shape that produced undefined label lookups and NaN sort keys in production on 2026-08-24 —
  // so it gets its own column instead. An area is a name either way, so both forms share one.
  if (wants("region") && session.region_code) payload.preferred_region_code = session.region_code;
  if (wants("region") && session.region_other_text) payload.preferred_region_name = session.region_other_text;
  const areaLabel = sessionAreaLabel(session);
  if (wants("area") && areaLabel) payload.preferred_area_name = areaLabel;
  // The two screening answers. Experience is a fixed band read back to its label (same read-back rule
  // as the role); expected salary is stored VERBATIM — never coerced, because "negotiable", a range,
  // or Arabic numerals are all truthful answers a recruiter reads, and a numeric column would drop them.
  const experienceLabel = sessionExperienceLabel(session);
  if (wants("experience") && experienceLabel) payload.declared_experience = experienceLabel;
  // …and until 2026-09-02 the verbatim answer was aimed at `expected_salary`, which is NUMERIC. The
  // comment above was right about the intent and wrong about the destination, so every answer that
  // was not a bare number failed the cast — 31 of the 42 answered in production. The damage was
  // never confined to the salary: all six answers ride in this ONE update, so a rejected cast threw
  // away that applicant's experience band, region, background and area as well, and the screener
  // then saw a blank card for somebody who had answered every question.
  //
  // Verbatim words go to the text column, which is what a recruiter reads. The numeric column is
  // filled only when the answer really is a figure, so everything that already reads it — the
  // workspace's salary cell, the merge borrow list — keeps working unchanged.
  if (wants("salary") && session.expected_salary) {
    payload.declared_expected_salary = session.expected_salary;
    const figure = parseDeclaredSalaryFigure(session.expected_salary);
    if (figure !== null) payload.expected_salary = figure;
  }
  return payload;
}

/** The built-in questions this conversation has an answer to — the marks the applicant now owns. */
function answeredBuiltInKeys(session: SessionRow): BuiltInQuestionKey[] {
  return [...prefilledBuiltInKeys(session)];
}

/**
 * Writes the conversation's answers onto the candidate, re-files the person and recomputes their
 * completeness. `finished` stamps `applied_at` — "the finished answers were applied" — and is false
 * only for the intake backfill of a conversation still in progress, which links the candidate
 * (`applied_candidate_id`) so every later answer follows it, without claiming the conversation done.
 */
async function writeClassification(
  candidateId: string,
  session: SessionRow,
  options: { finished: boolean } = { finished: true },
): Promise<boolean> {
  const supabase = recruitmentDb();
  const nowIso = new Date().toISOString();
  // Every answer normally reached the candidate the moment it was given; this write repeats them. An
  // answer HR corrected SINCE (its "added by HR" mark) is the newer word and is left as HR wrote it.
  const marks = await readAnswerMarks(candidateId);
  const unmarked = answeredBuiltInKeys(session).filter((key) => !(BUILT_IN_ANSWER_KEYS[key] in marks));
  const payload = classificationPayload(session, unmarked);

  const { error } = await supabase.from("ats_candidates").update(payload).eq("id", candidateId);
  if (error) throw error;

  await supabase
    .from(SESSIONS_TABLE)
    .update(
      options.finished
        ? { applied_at: nowIso, applied_candidate_id: candidateId, updated_at: nowIso }
        : { applied_candidate_id: candidateId },
    )
    .eq("id", session.id);

  // The person is filed where their answers say (unless HR's correction stands) and the stored
  // completeness follows. Best effort: the answers above are what matters, and they are written.
  try {
    await afterSessionAnswersWritten({ candidateId, placing: true, session });
  } catch (followUpError) {
    logError("WhatsApp answers were written but the filing or completeness could not follow", {
      error: followUpError,
      labels: { event: "whatsapp_classify_followup_failed" },
    });
  }
  return true;
}

/**
 * Applies a conversation's answers to a candidate that has just been created. Called by the intake
 * worker: the applicant can tap faster than the CV is processed, and without this their answers would
 * sit in the session table and never reach the record.
 *
 * FINISHED OR NOT (owner, 2026-10-20: answers are saved as given, and an unfinished conversation's
 * answers are recovered). Until that day this read only COMPLETED conversations (`completed_at IS NOT
 * NULL`), because a partial snapshot written here was never re-synced: nothing wrote the region, area,
 * experience or salary the applicant went on to give. Every answer is now written onto the candidate
 * as it lands (whatsapp-answer-sync.ts), so an in-progress conversation is safe to apply — and NOT
 * applying it left the first answers of every applicant whose CV beat their taps nowhere but the
 * session table. Production held 24 such candidates on 2026-09-11.
 *
 * WHICH CONVERSATION. One this candidate's own CV opened, or that the sender only ever used for this
 * one person — the three safe links decide, never the number alone. A finished one is stamped
 * applied; one still in progress is linked (`applied_candidate_id`) and left open, so the rest of
 * its answers follow it.
 *
 * `applied_at IS NULL OR applied_candidate_id = <this candidate>`: a conversation already applied to
 * this same person is read again, so a backfill that ran half-way is finished, and one applied to
 * somebody else is never taken.
 */
export async function applyPendingClassification(input: { waId: string; candidateId: string }): Promise<boolean> {
  if (!isWhatsAppClassifyEnabled()) return false;
  try {
    const supabase = recruitmentDb();
    const { data } = await supabase
      .from(SESSIONS_TABLE)
      .select(`${SESSION_COLUMNS},completed_at,started_at`)
      .eq("wa_id", input.waId)
      .or(`applied_at.is.null,applied_candidate_id.eq.${input.candidateId}`)
      .not("job_title_family", "is", null)
      .order("started_at", { ascending: false })
      .limit(5);
    const sessions = (data ?? []) as Array<SessionRow & { completed_at: string | null }>;
    if (sessions.length === 0) return false;
    const links = await linkSessionsToCandidates(sessions);
    // Newest first; the first conversation whose safe link is this very candidate.
    const session = sessions.find((row) => links.get(row.id) === input.candidateId) ?? null;
    if (!session) return false;
    return writeClassification(input.candidateId, session, { finished: Boolean(session.completed_at) });
  } catch (error) {
    logError("WhatsApp classification failed to apply to a new candidate", {
      error,
      labels: { event: "whatsapp_classify_backfill_failed" },
    });
    return false;
  }
}

// ── Sweeping conversations that answered everything and were never closed ────────────────────────
// A conversation is closed by `finishSession`, and only by it. Anything that answers the last fixed
// question but does not reach that call leaves a row that is open for ever: fully answered, going
// nowhere, and — until the re-ask landed — silently swallowing every future CV from that number.
//
// Production on 2026-09-02 held 39 of them. 31 had their answers written onto the candidate by a
// backfill that set `applied_at` and nothing else; 8 answered everything and never reached a
// candidate at all, with a candidate sitting there the whole time. Nothing in the system was ever
// going to close either group, because nothing was looking.
//
// So something looks. Once per intake tick, beside the message-buffer retention sweep.

/** How long a fully-answered conversation must sit before the sweep treats it as abandoned. */
export const FINISHED_SWEEP_QUIET_MS = 30 * 60 * 1000;

/** Bounded so a backlog cannot turn one tick into an unbounded run. It catches up over ticks. */
const FINISHED_SWEEP_MAX_PER_TICK = 25;

/**
 * Whether a swept row may be closed.
 *
 * NEVER CLOSE A ROW WHOSE ANSWERS DID NOT LAND. Closing is irreversible in practice — the session
 * table is the only place a typed salary or a tapped background exists until `writeClassification`
 * copies it onto the candidate — so a row we could not apply stays open and is retried next tick,
 * by which time the durable worker has usually created the candidate it was waiting for.
 */
export function shouldCloseSweptSession(input: { appliedAt: string | null; appliedNow: boolean }): boolean {
  return Boolean(input.appliedAt) || input.appliedNow;
}

/**
 * Applies and closes conversations that finished but were never marked finished.
 *
 * DELIBERATELY SILENT TO THE APPLICANT. `finishSession` sends a thank-you and mirrors the result to
 * the owner's Telegram; this does neither. It runs over rows that are hours or days old, whose
 * 24-hour window is long shut, so a thank-you would fail as `window_closed` anyway — and a mirror
 * would fire the whole backlog at the owner's phone in one tick. Repairing the record is the job
 * here; talking to people is not.
 *
 * Scoped to `step = 'salary'`, which is the last fixed question and the only step `finishSession` is
 * reached from. That also excludes `extra` by construction: a conversation in the admin-defined loop
 * is legitimately open, holds its position in its own column, and is finished by that loop.
 *
 * Best-effort and never throws, like everything else in this file.
 */
export async function sweepFinishedClassifications(): Promise<{ applied: number; closed: number }> {
  const nothing = { applied: 0, closed: 0 };
  if (!isWhatsAppClassifyEnabled()) return nothing;
  try {
    const supabase = recruitmentDb();
    // The quiet window is what separates an abandoned row from a conversation that answered seconds
    // ago and whose finishSession is still in flight. Stealing that one would send the applicant no
    // thank-you and race the write.
    const quietBefore = new Date(Date.now() - FINISHED_SWEEP_QUIET_MS).toISOString();
    const { data, error } = await supabase
      .from(SESSIONS_TABLE)
      .select(`${SESSION_COLUMNS},applied_at`)
      .is("completed_at", null)
      .eq("step", "salary")
      .not("expected_salary", "is", null)
      .lt("updated_at", quietBefore)
      .order("updated_at", { ascending: true })
      .limit(FINISHED_SWEEP_MAX_PER_TICK);
    if (error) throw error;

    let applied = 0;
    let closed = 0;
    for (const row of (data ?? []) as Array<SessionRow & { applied_at: string | null }>) {
      const appliedNow = row.applied_at ? false : await applyClassificationToCandidate(row);
      if (appliedNow) applied += 1;
      if (!shouldCloseSweptSession({ appliedAt: row.applied_at, appliedNow })) continue;
      await closeSession(row.id, "swept_finished");
      closed += 1;
    }

    if (applied > 0 || closed > 0) {
      logWarning("WhatsApp classification swept conversations that finished but stayed open", {
        context: { applied, closed, examined: (data ?? []).length },
        labels: { event: "whatsapp_classify_finished_sweep" },
      });
    }
    return { applied, closed };
  } catch (error) {
    logError("WhatsApp classification finished-sweep failed", {
      error,
      labels: { event: "whatsapp_classify_finished_sweep_failed" },
    });
    return nothing;
  }
}
