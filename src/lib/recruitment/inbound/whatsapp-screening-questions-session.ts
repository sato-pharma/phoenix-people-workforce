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
import {
  finishSession,
  findCandidateForSender,
  isWhatsAppClassifyEnabled,
} from "@/lib/recruitment/inbound/whatsapp-classify-session";
import { SESSION_COLUMNS, type SessionRow } from "@/lib/recruitment/inbound/whatsapp-classify-session-row";
import { sendClassifyMenu, sendWhatsAppText } from "@/lib/recruitment/inbound/whatsapp-interactive";
import {
  buildExtraQuestionMenu,
  decideNextExtraStep,
  extraAnswerTooLongText,
  parseExtraQuestionRowId,
  type ExtraAnswerOutcome,
  type ScreeningQuestion,
  type ScreeningQuestionKind,
  type ScreeningQuestionOption,
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
};

function mapQuestionRow(row: QuestionRow): ScreeningQuestion {
  return {
    bodyText: row.body_text,
    id: row.id,
    isActive: row.is_active,
    kind: row.kind,
    options: row.options,
    questionKey: row.question_key,
    sortOrder: row.sort_order,
  };
}

async function loadAllQuestions(): Promise<ScreeningQuestion[]> {
  if (questionCache && Date.now() - questionCache.at < QUESTION_CACHE_TTL_MS) return questionCache.all;

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(QUESTIONS_TABLE)
    .select("id,question_key,body_text,kind,options,sort_order,is_active")
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const all = ((data ?? []) as QuestionRow[]).map(mapQuestionRow);
  questionCache = { all, at: Date.now() };
  return all;
}

/** Active questions only, in sort order — what the loop actually asks. Empty means the loop is
 *  never entered and a session behaves exactly as it did before this feature existed. */
export async function listActiveScreeningQuestions(): Promise<ScreeningQuestion[]> {
  const all = await loadAllQuestions();
  return all.filter((question) => question.isActive);
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
 *  done without running the finish flow, for a window that closed mid-loop. */
async function closeIncompleteSession(sessionId: string): Promise<void> {
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
  const first = activeQuestions[0];
  if (!first) return; // caller already checked non-empty; defensive only.

  const withPhone = { ...session, phone_number_id: session.phone_number_id ?? fallbackPhoneNumberId };
  const supabase = recruitmentDb();
  await supabase
    .from(SESSIONS_TABLE)
    .update({ extra_current_question_key: first.questionKey, step: "extra", updated_at: new Date().toISOString() })
    .eq("id", session.id);
  await sendQuestion(withPhone, first);
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
    await sendQuestion(withPhone, decision.nextQuestion);
    return "advanced";
  }

  // outcome === "finished"
  await supabase
    .from(SESSIONS_TABLE)
    .update({ extra_answers: answers, extra_current_question_key: null, updated_at: nowIso })
    .eq("id", session.id);
  await finishExtraQuestionLoop({ ...session, extra_answers: answers }, phoneNumberId);
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

    const activeQuestions = await listActiveScreeningQuestions();
    const decision = decideNextExtraStep({
      activeQuestions,
      answer: { kind: "tapped", value: parsed.value },
      answeredKeysBeforeThis: new Set(Object.keys(session.extra_answers ?? {})),
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

    const activeQuestions = await listActiveScreeningQuestions();
    const decision = decideNextExtraStep({
      activeQuestions,
      answer: { kind: "typed", text: input.text },
      answeredKeysBeforeThis: new Set(Object.keys(session.extra_answers ?? {})),
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

async function finishExtraQuestionLoop(session: ExtraSessionRow, fallbackPhoneNumberId: string | null): Promise<void> {
  const answers = session.extra_answers ?? {};
  if (Object.keys(answers).length > 0) {
    const candidateId = session.applied_candidate_id ?? (await findCandidateForSender(session.wa_id).catch(() => null));
    if (candidateId) {
      const supabase = recruitmentDb();
      await supabase.from("ats_candidates").update({ screening_extra_answers: answers }).eq("id", candidateId);
    }
  }
  await finishSession(session, fallbackPhoneNumberId);
}

/**
 * Applies a completed-but-unapplied loop's answers to a candidate that has just been created —
 * the extra-answers analogue of applyPendingClassification. Called by the intake worker right
 * alongside it: the applicant can finish the whole conversation (fixed six AND extra questions)
 * before the CV finishes processing, and without this those answers would sit on the session row
 * and never reach the candidate.
 */
export async function applyPendingExtraAnswers(input: { waId: string; candidateId: string }): Promise<boolean> {
  if (!isWhatsAppClassifyEnabled()) return false;
  try {
    const supabase = recruitmentDb();
    const { data } = await supabase
      .from(SESSIONS_TABLE)
      .select(EXTRA_SESSION_COLUMNS)
      .eq("wa_id", input.waId)
      .is("applied_at", null)
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1);
    const session = ((data ?? [])[0] ?? null) as ExtraSessionRow | null;
    if (!session) return false;
    const answers = session.extra_answers ?? {};
    if (Object.keys(answers).length === 0) return false;
    await supabase.from("ats_candidates").update({ screening_extra_answers: answers }).eq("id", input.candidateId);
    return true;
  } catch (error) {
    logError("WhatsApp screening extra answers failed to apply to a new candidate", {
      error,
      labels: { event: "whatsapp_extra_question_backfill_failed" },
    });
    return false;
  }
}
