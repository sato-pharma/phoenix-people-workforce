// Recruitment / ATS — every WhatsApp answer reaches the candidate the moment it is given.
//
// THE RULE (owner, 2026-10-20): an applicant's answers are saved AS GIVEN. Until then the bot held
// them on the conversation row and copied them onto the candidate only when the whole conversation
// finished — so the 60-odd applicants who stopped half-way had a role, a region and an area sitting
// in the session table and a blank card in front of HR, and the workspace could not file them.
//
// So each answer, built-in or extra, is written onto the candidate as it lands:
//
//   * built-in answers through the SAME column map the finish uses (`classificationPayload`), only
//     the columns of the question just answered — a later answer never re-writes an earlier one, so
//     an answer HR corrected in the meantime is not put back;
//   * extra answers through `ats_merge_screening_answer`, one key at a time, never the whole map;
//   * the applicant's own answer wins over HR's: the "added by HR" mark on that key is cleared;
//   * the role, region and area re-file the person (`placeFromAnswers`, placed by `whatsapp`);
//   * the stored completeness is recomputed.
//
// WHOSE CANDIDATE. Found by the three safe links (whatsapp-session-link.ts), never by "the newest CV
// from this number" — a forwarder's number would hand one applicant's answers to another. No link yet
// (the CV is still being processed) is not an error: the intake worker's backfill applies the answers
// the moment the candidate exists.
//
// NEVER THROWS. Called from inside the webhook's conversation; a failed write is logged and the
// conversation carries on — the answer is still on the session row, and the finish writes it again.

import { logError } from "@/lib/observability/log";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import {
  classificationPayload,
  sessionAreaLabel,
} from "@/lib/recruitment/inbound/whatsapp-classify-session";
import type { SessionRow } from "@/lib/recruitment/inbound/whatsapp-classify-session-row";
import type { BuiltInQuestionKey } from "@/lib/recruitment/inbound/whatsapp-question-audience";
import { safeCandidateForSession } from "@/lib/recruitment/inbound/whatsapp-session-link";
import { BUILT_IN_ANSWER_KEYS, recomputeCompleteness } from "@/lib/recruitment/workspace/completeness";
import { placeFromAnswers } from "@/lib/recruitment/workspace/placements-db";

const SESSIONS_TABLE = "ats_whatsapp_classification_sessions";

/** The built-in answers that decide where a person is filed. */
const PLACING_KEYS: readonly BuiltInQuestionKey[] = ["job_title", "region", "area"];

/**
 * The candidate this conversation's answers belong to, by the safe links, or null. Remembers the
 * answer on the conversation (`applied_candidate_id`) so the next answer takes rule 1 at once —
 * without `applied_at`, which still means "the finished answers were applied".
 */
export async function candidateForSessionAnswers(session: SessionRow): Promise<string | null> {
  let cvWamid = session.cv_wamid ?? null;
  // A row read without the column (an older select) — read it, since rule 2 needs it.
  if (!session.applied_candidate_id && session.cv_wamid === undefined) {
    const { data } = await recruitmentDb().from(SESSIONS_TABLE).select("cv_wamid").eq("id", session.id).maybeSingle();
    cvWamid = textOrNull((data as { cv_wamid?: string | null } | null)?.cv_wamid);
  }
  const candidateId = await safeCandidateForSession({
    applied_candidate_id: session.applied_candidate_id,
    cv_wamid: cvWamid,
    id: session.id,
    wa_id: session.wa_id,
  });
  if (candidateId && candidateId !== session.applied_candidate_id) {
    await recruitmentDb().from(SESSIONS_TABLE).update({ applied_candidate_id: candidateId }).eq("id", session.id);
  }
  return candidateId;
}

/** The candidate's "added by HR" marks, by answer key. Empty when none. */
export async function readAnswerMarks(candidateId: string): Promise<Record<string, unknown>> {
  const { data, error } = await recruitmentDb().from("ats_candidates").select("answer_marks").eq("id", candidateId).maybeSingle();
  if (error) throw error;
  const marks = (data as { answer_marks?: unknown } | null)?.answer_marks;
  return marks && typeof marks === "object" && !Array.isArray(marks) ? (marks as Record<string, unknown>) : {};
}

/**
 * Clears HR's "added by HR" mark on these answer keys, when there is one: the applicant has now
 * answered for themselves. One read, then one call per marked key only.
 */
export async function clearAnswerMarks(candidateId: string, answerKeys: readonly string[]): Promise<void> {
  if (answerKeys.length === 0) return;
  const db = recruitmentDb();
  const marks = await readAnswerMarks(candidateId);
  for (const key of answerKeys) {
    if (!(key in marks)) continue;
    const { error: rpcError } = await db.rpc("ats_set_answer_mark", {
      p_candidate_id: candidateId,
      p_key: key,
      p_marked_by_hr_id: null,
    });
    if (rpcError) throw rpcError;
  }
}

/** The answer keys that decide where a person is filed, as the marks spell them. */
const PLACING_ANSWER_KEYS = ["role", "region", "area"] as const;

/**
 * Re-files the person from the conversation's role, region and area, and recomputes completeness.
 * Shared by every path that writes the conversation's answers onto a candidate — one answer, the
 * finish, and the intake worker's backfill — so a person is filed the same way whichever ran.
 *
 * Not while HR's correction of the role, region or area stands (its "added by HR" mark): HR filed the
 * person from that correction, and re-filing them from the applicant's older answer would put them in
 * two tabs.
 */
export async function afterSessionAnswersWritten(input: {
  candidateId: string;
  session: SessionRow;
  /** Whether the role, region or area could have changed. False skips the placement. */
  placing: boolean;
}): Promise<void> {
  const { candidateId, session } = input;
  const marks = input.placing ? await readAnswerMarks(candidateId) : {};
  const hrFiled = PLACING_ANSWER_KEYS.some((key) => key in marks);
  if (input.placing && !hrFiled && session.job_title_family) {
    await placeFromAnswers({
      areaName: sessionAreaLabel(session),
      candidateId,
      placedBy: "whatsapp",
      regionCode: session.region_code,
      roleFamily: session.job_title_family,
      sessionId: session.id,
    });
  }
  await recomputeCompleteness([candidateId]);
}

/**
 * One of the six built-in answers, onto the candidate, now. `session` is the conversation AS IT IS
 * after this answer (the caller merges the answer in first). Returns the candidate written, or null.
 */
export async function applyBuiltInAnswerToCandidate(
  session: SessionRow,
  key: BuiltInQuestionKey,
): Promise<string | null> {
  try {
    const candidateId = await candidateForSessionAnswers(session);
    if (!candidateId) return null;
    const payload = classificationPayload(session, [key]);
    if (Object.keys(payload).length > 0) {
      const { error } = await recruitmentDb().from("ats_candidates").update(payload).eq("id", candidateId);
      if (error) throw error;
    }
    await clearAnswerMarks(candidateId, [BUILT_IN_ANSWER_KEYS[key]]);
    await afterSessionAnswersWritten({ candidateId, placing: PLACING_KEYS.includes(key), session });
    return candidateId;
  } catch (error) {
    logError("A WhatsApp answer could not be saved onto the candidate as it was given", {
      error,
      labels: { event: "whatsapp_answer_sync_failed", key },
    });
    return null;
  }
}

/**
 * One extra-question answer, onto the candidate, now — merged by key, so HR's answers to other
 * questions are untouched. The RPC clears HR's mark on this key (the applicant answered).
 */
export async function applyExtraAnswerToCandidate(
  session: SessionRow,
  questionKey: string,
  value: string,
): Promise<string | null> {
  try {
    const candidateId = await candidateForSessionAnswers(session);
    if (!candidateId) return null;
    await mergeExtraAnswers(candidateId, { [questionKey]: value });
    await recomputeCompleteness([candidateId]);
    return candidateId;
  } catch (error) {
    logError("A WhatsApp extra answer could not be saved onto the candidate as it was given", {
      error,
      labels: { event: "whatsapp_extra_answer_sync_failed", key: questionKey },
    });
    return null;
  }
}

/**
 * Merges these extra answers onto the candidate one key at a time, as the applicant's own (no HR
 * mark). Never replaces the whole map: an answer HR added to a question the applicant never reached
 * survives. Throws on a failed write.
 *
 * `keepHrAnswers` is for the paths that REPEAT answers already given (the finish, the intake backfill,
 * a closing conversation): an answer HR corrected since is the newer word and is skipped. A NEW answer
 * the applicant just gave passes false, and wins.
 */
export async function mergeExtraAnswers(
  candidateId: string,
  answers: Readonly<Record<string, string>>,
  options: { keepHrAnswers?: boolean } = {},
): Promise<number> {
  const marks = options.keepHrAnswers ? await readAnswerMarks(candidateId) : {};
  let written = 0;
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (key in marks) continue;
    const { error } = await recruitmentDb().rpc("ats_merge_screening_answer", {
      p_candidate_id: candidateId,
      p_key: key,
      p_marked_by_hr_id: null,
      p_value: value,
    });
    if (error) throw error;
    written += 1;
  }
  return written;
}
