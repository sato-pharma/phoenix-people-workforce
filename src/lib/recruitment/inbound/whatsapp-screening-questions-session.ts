// Recruitment / ATS — the extra-question loop, appended to WhatsApp self-classification once the
// fixed six (whatsapp-classify-session.ts) finish.
//
// Kept in its own file rather than folded into that 900-line state machine: this is the ONLY new
// code that touches ats_whatsapp_screening_questions or the session's extra_* columns, and it hands
// off to the UNMODIFIED finishSession the moment the loop completes, so the thank-you text, the
// six-column write and the owner Telegram mirror all run exactly as they do for a session that never
// saw an extra question at all.
//
// EVERYTHING HERE IS BEST-EFFORT AND NEVER THROWS INTO THE WEBHOOK — same rule as the file it
// continues from. The CV and the fixed-six answers are already safely recorded by the time any of
// this runs.

import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import { applyExtraAnswerToCandidate, mergeExtraAnswers } from "@/lib/recruitment/inbound/whatsapp-answer-sync";
import {
  applyAnswersBeforeClosing,
  finishSession,
  isWhatsAppClassifyEnabled,
} from "@/lib/recruitment/inbound/whatsapp-classify-session";
import { SESSION_COLUMNS, type SessionRow } from "@/lib/recruitment/inbound/whatsapp-classify-session-row";
import { linkSessionsToCandidates } from "@/lib/recruitment/inbound/whatsapp-session-link";
import { recomputeCompleteness } from "@/lib/recruitment/workspace/completeness";
import { sendClassifyMenu, sendWhatsAppText } from "@/lib/recruitment/inbound/whatsapp-interactive";
import {
  buildExtraQuestionMenu,
  decideNextExtraStep,
  extraAnswerTooLongText,
  nextActiveQuestion,
  parseExtraQuestionRowId,
  questionsForRole,
  showIfFromRow,
  type ExtraAnswerOutcome,
  type ScreeningQuestion,
  type ScreeningQuestionEndOn,
  type ScreeningQuestionKind,
  type ScreeningQuestionOption,
  type ScreeningQuestionShowIfRow,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions";

const QUESTIONS_TABLE = "ats_whatsapp_screening_questions";
const SESSIONS_TABLE = "ats_whatsapp_classification_sessions";

export type ExtraSessionRow = SessionRow & {
  extra_current_question_key: string | null;
  extra_answers: Record<string, string>;
};

export const EXTRA_SESSION_COLUMNS = `${SESSION_COLUMNS},extra_current_question_key,extra_answers`;

// ── Reading the live question list ──────────────────────────────────────────────────────────────
// Same in-process cache shape as loadAreasByRegion in whatsapp-classify-session.ts: a handful of
// rows that change a few times a year, against a webhook that must ack fast.

const QUESTION_CACHE_TTL_MS = 10 * 60 * 1000;
let questionCache: { at: number; all: ScreeningQuestion[] } | null = null;

/** Also the admin-save invalidation hook — a just-saved question must be live on the very next
 *  message, not up to QUESTION_CACHE_TTL_MS later. Tests call it too, to isolate cache state. */
export function invalidateScreeningQuestionCache(): void {
  questionCache = null;
}

type QuestionRow = {
  id: string;
  question_key: string;
  body_text: string;
  kind: ScreeningQuestionKind;
  options: ScreeningQuestionOption[] | null;
  sort_order: number;
  is_active: boolean;
  applies_to_role_families: string[] | null;
  show_if: ScreeningQuestionShowIfRow | null;
  end_on: ScreeningQuestionEndOn | null;
};

function mapQuestionRow(row: QuestionRow): ScreeningQuestion {
  return {
    appliesToRoleFamilies: row.applies_to_role_families,
    bodyText: row.body_text,
    endOn: row.end_on ?? null,
    id: row.id,
    isActive: row.is_active,
    kind: row.kind,
    options: row.options,
    questionKey: row.question_key,
    showIf: showIfFromRow(row.show_if),
    sortOrder: row.sort_order,
  };
}

/** Every question, retired ones included, in sort order. Also what the WhatsApp Applicants page
 *  reads, so a question's wording there is the wording the bot sends. */
export async function loadAllQuestions(): Promise<ScreeningQuestion[]> {
  if (questionCache && Date.now() - questionCache.at < QUESTION_CACHE_TTL_MS) return questionCache.all;

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(QUESTIONS_TABLE)
    .select("id,question_key,body_text,kind,options,sort_order,is_active,applies_to_role_families,show_if,end_on")
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const all = ((data ?? []) as QuestionRow[]).map(mapQuestionRow);
  questionCache = { all, at: Date.now() };
  return all;
}

/**
 * Active questions THIS APPLICANT is asked, in sort order — what the loop actually asks. Empty means
 * the loop is never entered and the session behaves exactly as it did before this feature existed,
 * which is now the normal outcome for most applicants rather than a rare one.
 *
 * The role is a REQUIRED argument, deliberately, even though most rows will not be scoped. An
 * optional one would default to "unscoped" at any call site that forgot it, and the failure mode of
 * a forgotten filter is silent: the question simply reaches everybody, which is precisely the state
 * this parameter exists to end. Making it required moves that mistake from runtime to the compiler.
 */
export async function listActiveScreeningQuestions(
  roleFamily: string | null,
): Promise<ScreeningQuestion[]> {
  const all = await loadAllQuestions();
  return questionsForRole(all.filter((question) => question.isActive), roleFamily);
}

/**
 * One question by key, active or not. Used to validate a reply against the question the applicant
 * was actually asked, which must still be readable even if an admin deactivated it in the minutes
 * between it being sent and being answered.
 */
async function getQuestionByKey(questionKey: string): Promise<ScreeningQuestion | null> {
  const all = await loadAllQuestions();
  return all.find((question) => question.questionKey === questionKey) ?? null;
}

// ── Sending one question ────────────────────────────────────────────────────────────────────────

async function sendQuestion(
  session: Pick<SessionRow, "id" | "wa_id" | "phone_number_id">,
  question: ScreeningQuestion,
): Promise<boolean> {
  const result =
    question.kind === "tappable"
      ? await sendClassifyMenu({
          menu: buildExtraQuestionMenu(question),
          phoneNumberId: session.phone_number_id,
          toWaId: session.wa_id,
        })
      : await sendWhatsAppText({
          phoneNumberId: session.phone_number_id,
          text: question.bodyText,
          toWaId: session.wa_id,
        });

  if (!result.ok) {
    if (result.reason === "window_closed") await closeIncompleteSession(session.id);
    return false;
  }

  const supabase = recruitmentDb();
  await supabase
    .from(SESSIONS_TABLE)
    .update({ last_prompt_wamid: result.wamid, updated_at: new Date().toISOString() })
    .eq("id", session.id);
  return true;
}

/** Same shape as the private closeSession in whatsapp-classify-session.ts — marks the conversation
 *  done without running the finish flow, for a window that closed mid-loop. What the applicant DID
 *  answer is saved onto the candidate first (owner, 2026-10-20). */
async function closeIncompleteSession(sessionId: string): Promise<void> {
  await applyAnswersBeforeClosing(sessionId);
  const supabase = recruitmentDb();
  await supabase
    .from(SESSIONS_TABLE)
    .update({ completed_at: new Date().toISOString(), step: "done", updated_at: new Date().toISOString() })
    .eq("id", sessionId);
}

async function loadOpenExtraSession(waId: string): Promise<ExtraSessionRow | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select(EXTRA_SESSION_COLUMNS)
    .eq("wa_id", waId)
    .is("completed_at", null)
    .maybeSingle();
  if (error) throw error;
  return (data as ExtraSessionRow | null) ?? null;
}

// ── Starting the loop, once the fixed six finish ────────────────────────────────────────────────

/**
 * Called from whatsapp-classify-session.ts's salary branch instead of finishSession, exactly when
 * at least one active question exists at that moment. Parks the session on `extra` and asks the
 * first one.
 */
export async function startExtraQuestionLoop(
  session: SessionRow,
  fallbackPhoneNumberId: string | null,
  activeQuestions: readonly ScreeningQuestion[],
): Promise<void> {
  // The first question this applicant is actually asked: a conditional one cannot be first, since it
  // depends on an answer nobody has given yet. A conversation RESUMED after "Ask again" starts with
  // the answers already on the candidate (whatsapp-classify-resume-plan.ts), so those are stepped
  // over; a fresh one holds none and starts at the top, exactly as before.
  const supabase = recruitmentDb();
  const { data: held } = await supabase.from(SESSIONS_TABLE).select("extra_answers").eq("id", session.id).maybeSingle();
  const answered = ((held as { extra_answers: Record<string, string> | null } | null)?.extra_answers ?? {}) as Record<
    string,
    string
  >;
  const first = nextActiveQuestion(activeQuestions, new Set(Object.keys(answered)), answered);
  const withPhone = { ...session, phone_number_id: session.phone_number_id ?? fallbackPhoneNumberId };
  if (!first) {
    await finishSession(withPhone, fallbackPhoneNumberId);
    return;
  }
  await supabase
    .from(SESSIONS_TABLE)
    .update({ extra_current_question_key: first.questionKey, step: "extra", updated_at: new Date().toISOString() })
    .eq("id", session.id);
  await sendQuestion(withPhone, first);
}

/**
 * Re-asks the extra question a parked conversation is waiting on, when a new CV reopens it.
 *
 * The one re-ask the classify side cannot perform itself: the question is a database row, scoped to
 * the role the applicant tapped, and this module owns both. Looked up live rather than trusted from
 * the stored key alone — in the hours since it was asked the owner may have deactivated it or scoped
 * it away from this role, and re-sending a question that is no longer in the set would be worse than
 * saying nothing. False when it has gone, so the caller can tell that apart from a send failure.
 */
export async function resendExtraQuestion(
  session: Pick<SessionRow, "id" | "wa_id" | "phone_number_id">,
  questionKey: string,
  roleFamily: string | null,
): Promise<boolean> {
  const questions = await listActiveScreeningQuestions(roleFamily);
  const question = questions.find((candidate) => candidate.questionKey === questionKey);
  if (!question) return false;
  return sendQuestion(session, question);
}

// ── Shared: writing one answer, then advancing or finishing ────────────────────────────────────

async function applyExtraDecision(input: {
  decision: ExtraAnswerOutcome;
  currentQuestionKey: string;
  session: ExtraSessionRow;
  phoneNumberId: string | null;
}): Promise<"advanced" | "completed" | "unknown_value"> {
  const { decision, currentQuestionKey, session, phoneNumberId } = input;
  if (decision.outcome === "unknown_value" || decision.outcome === "unusable_text") return "unknown_value";

  const withPhone = { ...session, phone_number_id: session.phone_number_id ?? phoneNumberId };
  const supabase = recruitmentDb();
  const nowIso = new Date().toISOString();
  const answers = { ...session.extra_answers, [currentQuestionKey]: decision.answerValue };

  if (decision.outcome === "advance") {
    await supabase
      .from(SESSIONS_TABLE)
      .update({
        extra_answers: answers,
        extra_current_question_key: decision.nextQuestion.questionKey,
        updated_at: nowIso,
      })
      .eq("id", session.id);
    // Saved onto the candidate as given, not only when the loop finishes (owner, 2026-10-20).
    await applyExtraAnswerToCandidate(session, currentQuestionKey, decision.answerValue);
    await sendQuestion(withPhone, decision.nextQuestion);
    return "advanced";
  }

  // outcome === "finished" or "ended". An ended conversation is recorded and mirrored exactly like a
  // finished one — the owner still learns who applied — but sends its own message, not the summary.
  await supabase
    .from(SESSIONS_TABLE)
    .update({ extra_answers: answers, extra_current_question_key: null, updated_at: nowIso })
    .eq("id", session.id);
  await finishExtraQuestionLoop(
    { ...session, extra_answers: answers },
    phoneNumberId,
    decision.outcome === "ended" ? decision.message : undefined,
  );
  return "completed";
}

// ── Handling a tapped reply ─────────────────────────────────────────────────────────────────────

export type ExtraQuestionReplyOutcome =
  | "disabled"
  | "not_ours"
  | "no_session"
  | "not_awaiting_this"
  | "unknown_value"
  | "advanced"
  | "completed";

/** Called by the webhook route ONLY after handleClassifyReply itself returns "not_ours" — the two
 *  row-id namespaces (3-part vs. 4-part) never both match the same id, so this never double-handles
 *  a tap the fixed six already own. */
export async function handleExtraQuestionReply(input: {
  waId: string;
  phoneNumberId: string | null;
  rowId: string;
}): Promise<ExtraQuestionReplyOutcome> {
  if (!isWhatsAppClassifyEnabled()) return "disabled";

  const parsed = parseExtraQuestionRowId(input.rowId);
  if (!parsed) return "not_ours";

  try {
    const session = await loadOpenExtraSession(input.waId);
    if (!session) return "no_session";
    if (session.step !== "extra" || session.extra_current_question_key !== parsed.questionKey) {
      return "not_awaiting_this";
    }

    const currentQuestion = await getQuestionByKey(parsed.questionKey);
    if (!currentQuestion) return "unknown_value";

    // Scoped to what this applicant tapped as their role, not to the whole active list. A question
    // added for another seat between two of their replies must not appear mid-conversation.
    const activeQuestions = await listActiveScreeningQuestions(session.job_title_family);
    const decision = decideNextExtraStep({
      activeQuestions,
      answer: { kind: "tapped", value: parsed.value },
      answeredKeysBeforeThis: new Set(Object.keys(session.extra_answers ?? {})),
      answersBeforeThis: session.extra_answers ?? {},
      currentQuestion,
    });

    return await applyExtraDecision({
      currentQuestionKey: parsed.questionKey,
      decision,
      phoneNumberId: input.phoneNumberId,
      session,
    });
  } catch (error) {
    logError("WhatsApp screening extra-question reply failed", {
      error,
      labels: { event: "whatsapp_extra_question_reply_failed" },
    });
    return "no_session";
  }
}

// ── Handling a typed reply ──────────────────────────────────────────────────────────────────────

export type ExtraQuestionTextOutcome =
  | "disabled"
  | "no_session"
  | "not_awaiting_text"
  | "unusable_text"
  | "advanced"
  | "completed";

/** Called by the webhook route ONLY after handleClassifyText itself returns "not_awaiting_text" —
 *  narrow for the same reason handleClassifyText is narrow: this must never swallow a message that
 *  was not an answer to a question we asked. */
export async function handleExtraQuestionText(input: {
  waId: string;
  phoneNumberId: string | null;
  text: string;
}): Promise<ExtraQuestionTextOutcome> {
  if (!isWhatsAppClassifyEnabled()) return "disabled";

  try {
    const session = await loadOpenExtraSession(input.waId);
    if (!session) return "no_session";
    if (session.step !== "extra" || !session.extra_current_question_key) return "not_awaiting_text";

    const currentQuestion = await getQuestionByKey(session.extra_current_question_key);
    if (!currentQuestion || currentQuestion.kind !== "free_text") return "not_awaiting_text";

    const activeQuestions = await listActiveScreeningQuestions(session.job_title_family);
    const decision = decideNextExtraStep({
      activeQuestions,
      answer: { kind: "typed", text: input.text },
      answeredKeysBeforeThis: new Set(Object.keys(session.extra_answers ?? {})),
      answersBeforeThis: session.extra_answers ?? {},
      currentQuestion,
    });

    if (decision.outcome === "unusable_text") {
      await sendWhatsAppText({
        phoneNumberId: session.phone_number_id ?? input.phoneNumberId,
        text: extraAnswerTooLongText(),
        toWaId: session.wa_id,
      });
      return "unusable_text";
    }

    const result = await applyExtraDecision({
      currentQuestionKey: currentQuestion.questionKey,
      decision,
      phoneNumberId: input.phoneNumberId,
      session,
    });
    return result === "unknown_value" ? "not_awaiting_text" : result;
  } catch (error) {
    logError("WhatsApp screening extra-question text failed", {
      error,
      labels: { event: "whatsapp_extra_question_text_failed" },
    });
    return "no_session";
  }
}

// ── Finishing: write the answers, then hand off to the unmodified finish flow ──────────────────

async function finishExtraQuestionLoop(
  session: ExtraSessionRow,
  fallbackPhoneNumberId: string | null,
  closingText?: string,
): Promise<void> {
  const answers = session.extra_answers ?? {};
  if (Object.keys(answers).length > 0) {
    // By the safe links, and merged key by key: the whole-map write this replaced erased any answer HR
    // had added to a question the applicant never reached.
    try {
      const candidateId = (await linkSessionsToCandidates([session])).get(session.id) ?? null;
      if (candidateId) {
        await mergeExtraAnswers(candidateId, answers, { keepHrAnswers: true });
        await recomputeCompleteness([candidateId]);
      }
    } catch (error) {
      logError("WhatsApp extra answers could not be written at the finish", {
        error,
        labels: { event: "whatsapp_extra_question_finish_write_failed" },
      });
    }
  }
  await finishSession(session, fallbackPhoneNumberId, closingText ? { closingText } : undefined);
}

/**
 * Applies a loop's answers to a candidate that has just been created — the extra-answers analogue of
 * applyPendingClassification, called by the intake worker right after it, for the same race: the
 * applicant can answer before the CV finishes processing.
 *
 * FINISHED OR NOT, and AFTER applyPendingClassification (owner, 2026-10-20). Two defects closed here:
 *
 *   1. Only completed loops were read, so the answers of an applicant still mid-loop when their CV
 *      landed reached the candidate only if they finished. Every answer is now saved as it is given,
 *      so an open loop is safe to apply — the next answers follow it.
 *   2. This read `applied_at IS NULL`, and the call just before it — applyPendingClassification —
 *      SETS `applied_at` on that same conversation. So whenever both ran, this found nothing, and
 *      every extra answer given before the CV was processed was silently lost. It now also takes the
 *      conversation already applied to THIS candidate.
 *
 * Which conversation is decided by the three safe links, never the number alone; answers are merged
 * key by key, never as a whole map.
 */
export async function applyPendingExtraAnswers(input: { waId: string; candidateId: string }): Promise<boolean> {
  if (!isWhatsAppClassifyEnabled()) return false;
  try {
    const supabase = recruitmentDb();
    const { data } = await supabase
      .from(SESSIONS_TABLE)
      .select(`${EXTRA_SESSION_COLUMNS},started_at`)
      .eq("wa_id", input.waId)
      .or(`applied_at.is.null,applied_candidate_id.eq.${input.candidateId}`)
      .order("started_at", { ascending: false })
      .limit(5);
    const sessions = ((data ?? []) as ExtraSessionRow[]).filter((row) => Object.keys(row.extra_answers ?? {}).length > 0);
    if (sessions.length === 0) return false;
    const links = await linkSessionsToCandidates(sessions);
    const session = sessions.find((row) => links.get(row.id) === input.candidateId) ?? null;
    if (!session) return false;
    const written = await mergeExtraAnswers(input.candidateId, session.extra_answers ?? {}, { keepHrAnswers: true });
    await recomputeCompleteness([input.candidateId]);
    return written > 0;
  } catch (error) {
    logError("WhatsApp screening extra answers failed to apply to a new candidate", {
      error,
      labels: { event: "whatsapp_extra_question_backfill_failed" },
    });
    return false;
  }
}
