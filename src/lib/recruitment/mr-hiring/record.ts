// Recruitment / Medical Rep hiring — the two writers: a result at a step, and the NSM's recommendation.
//
// SERVER ONLY. Every check — who may record this step, whether the candidate is on it, whether the
// interview has ended — is made by `mayRecordStep` / `mayRecommend` BEFORE the first write.
//
// A RESULT IS A NEW ROW, NEVER AN EDIT. Both tables are append-only in the database itself; a changed
// mind is a second row and the newest wins (stage.ts).
//
// THE 1ST INTERVIEW'S RESULT CONFIRMS THE AREA AND THE LINE (owner, 7 Nov 2026). They are stored on the
// result row itself (append-only like the rest), the confirmed area wins over the workspace filing on
// the Medical Rep Hiring page and for the DSM's folder, and the Pedia line adds the RSM interview.
//
// WHAT A RESULT ALSO MOVES, so the rest of the system agrees with it:
//   * the interview's own `outcome` (pass → shortlisted, backup → backup, not pass → rejected), so the
//     calendar's "Outcome?" flag, its daily nag and the ten-minute settle job never ask again;
//   * the candidate's status through the same writer the workspace uses: "Do not pass" rejects (with
//     the workspace's reason — `failed_interview` after an interview), "Keep as backup" moves to
//     back-up, and a pass brings a new, backed-up or rejected candidate to shortlisted. A move the
//     status rules refuse (a CV already sent to a manager is never walked back to shortlisted) is
//     simply not made — the result still stands, and the step is read from the result.
// NOTHING IS EVER SENT TO THE CANDIDATE. A rejection never notifies the applicant from here.
//
// A PASS AT THE 1ST INTERVIEW TELLS THE AREA'S MANAGER (owner, 7 Nov 2026) — the DSM of the area HR
// confirmed on the line HR confirmed, or the line's NSM where the area has no real DSM: in-app,
// Telegram, email and a banner on his portal home. After the reply, so the button never waits on it.

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdForStorage } from "@/lib/hr-id";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { afterResponse } from "@/lib/http/after-response";
import { logError } from "@/lib/observability/log";
import { updateCandidateStatus } from "@/lib/recruitment/candidates";
import { statusChangeRefusal } from "@/lib/recruitment/candidate-status";
import { recruitmentDb } from "@/lib/recruitment/db";
import { loadPeople, personName } from "@/lib/recruitment/interview-calendar";
import { mayRecommend, mayRecordStep, mrViewer } from "@/lib/recruitment/mr-hiring/access";
import { isKnownMrArea, loadMrAreaChoices } from "@/lib/recruitment/mr-hiring/areas";
import { loadMrCandidate } from "@/lib/recruitment/mr-hiring/facts-db";
import {
  parseMrRecommendationInput,
  parseMrResultInput,
  type MrRecommendationInput,
  type MrResultInput,
} from "@/lib/recruitment/mr-hiring/inputs";
import { tellMrAreaManagers } from "@/lib/recruitment/mr-hiring/area-notices";
import { notifyMrRecommendationReady } from "@/lib/recruitment/mr-hiring/notify";
import { mrHiringStage, type MrStage } from "@/lib/recruitment/mr-hiring/stage";
import { bookingOutcomeForResult, MR_RESULT_STEP_LABELS, mrResultLabel } from "@/lib/recruitment/mr-hiring/vocabulary";
import { todayInCairo } from "@/lib/date-only";

export type MrWriteResult = { stage: MrStage };

/** The status a result moves the candidate to, or null when it leaves the status as it is. */
export function statusForResult(currentStatus: string, input: Pick<MrResultInput, "result">): "rejected" | "backup" | "shortlisted" | null {
  if (input.result === "not_pass") return currentStatus === "rejected" ? null : "rejected";
  if (input.result === "backup") return currentStatus === "backup" ? null : "backup";
  return currentStatus === "new" || currentStatus === "backup" || currentStatus === "rejected" ? "shortlisted" : null;
}

async function moveCandidateStatus(access: AccessContext, candidateId: string, currentStatus: string, input: MrResultInput): Promise<void> {
  const next = statusForResult(currentStatus, input);
  if (!next || statusChangeRefusal(currentStatus, next)) return;
  const note = `${MR_RESULT_STEP_LABELS[input.step]}: ${mrResultLabel(input.step, input.result)}${input.decidedWithoutDsm ? " (decided by HR, no DSM feedback)" : ""}`;
  try {
    await updateCandidateStatus(access, candidateId, next, note.slice(0, 300));
    if (next === "rejected") {
      // The workspace's own reason vocabulary, written where the workspace reads it.
      const reason = input.step === "hr_screening" ? (input.rejectionReason ?? "other") : "failed_interview";
      const { error } = await recruitmentDb()
        .from("ats_candidates")
        .update({ rejection_reason: reason, rejection_reason_note: input.comment.slice(0, 300) })
        .eq("id", candidateId);
      if (error) throw error;
    }
  } catch (error) {
    // The result is recorded and the step is read from it; a status the record could not follow is
    // reported, not allowed to undo the result.
    logError("Medical Rep hiring: the candidate status could not follow a recorded result", {
      error,
      labels: { candidateId, event: "mr_hiring_status_follow_failed", step: input.step },
    });
  }
}

/** Record a result at one step. Returns where the candidate is afterwards. */
export async function recordMrStepResult(access: AccessContext, candidateId: string, raw: unknown): Promise<MrWriteResult> {
  let input: MrResultInput;
  try {
    input = parseMrResultInput(raw);
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : "Check the result and try again.");
  }
  const record = await loadMrCandidate(candidateId);
  if (!record) throw notFoundError("This candidate is not in the Medical Rep hiring list.");
  const viewer = mrViewer(access);
  const check = mayRecordStep(viewer, record.facts, input.step, { decidedWithoutDsm: input.decidedWithoutDsm });
  if (!check.ok) throw forbiddenError(check.reason);

  // The confirmed area is one of the areas the WhatsApp bot offers, by its own name — never free text.
  if (input.confirmedArea && !isKnownMrArea(await loadMrAreaChoices(), input.confirmedArea)) {
    throw validationError("Choose the area from the list.");
  }

  const actor = hrIdForStorage(access.hrId);
  if (!actor) throw forbiddenError("Sign in again to record a result.");
  const { data: inserted, error } = await recruitmentDb()
    .from("ats_mr_hiring_step_results")
    .insert({
      booking_id: check.booking?.id ?? null,
      by_hr_id: actor,
      candidate_id: candidateId,
      comment: input.comment,
      confirmed_area_name: input.confirmedArea,
      confirmed_line: input.confirmedLine,
      decided_without_dsm: check.decidedWithoutDsm,
      rating: input.rating,
      result: input.result,
      step: input.step,
    })
    .select("id")
    .single();
  if (error) throw error;

  if (check.booking) {
    const { error: outcomeError } = await recruitmentDb()
      .from("ats_interview_bookings")
      .update({ outcome: bookingOutcomeForResult(input.result), outcome_set_at: new Date().toISOString(), outcome_set_by_hr_id: actor })
      .eq("id", check.booking.id);
    if (outcomeError) {
      logError("Medical Rep hiring: the interview outcome could not follow a recorded result", {
        error: outcomeError,
        labels: { bookingId: check.booking.id, event: "mr_hiring_outcome_follow_failed" },
      });
    }
  }
  await moveCandidateStatus(access, candidateId, record.facts.status, input);

  if (input.step === "hr_first" && input.result === "pass" && input.confirmedArea && input.confirmedLine) {
    const notice = {
      areaName: input.confirmedArea,
      candidateId,
      candidateName: record.name,
      line: input.confirmedLine,
      resultId: String((inserted as { id: number | string }).id),
    };
    await afterResponse("mr-area-manager-notice", () => tellMrAreaManagers(notice));
  }

  const after = await loadMrCandidate(candidateId);
  return { stage: mrHiringStage(after?.facts ?? record.facts) };
}

/** Record the NSM's recommendation (§8), then tell the HR Manager the final decision is his. */
export async function recordMrRecommendation(access: AccessContext, candidateId: string, raw: unknown): Promise<MrWriteResult> {
  let input: MrRecommendationInput;
  try {
    input = parseMrRecommendationInput(raw, todayInCairo());
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : "Check the recommendation and try again.");
  }
  const record = await loadMrCandidate(candidateId);
  if (!record) throw notFoundError("This candidate is not in the Medical Rep hiring list.");
  const viewer = mrViewer(access);
  const check = mayRecommend(viewer, record.facts);
  if (!check.ok) throw forbiddenError(check.reason);

  const actor = hrIdForStorage(access.hrId);
  if (!actor) throw forbiddenError("Sign in again to write the recommendation.");
  const { data, error } = await recruitmentDb()
    .from("ats_mr_hiring_recommendations")
    .insert({
      booking_id: check.booking?.id ?? null,
      by_hr_id: actor,
      candidate_id: candidateId,
      note: input.note,
      proposed_joining_date: input.proposedJoiningDate,
      proposed_salary: input.proposedSalary,
      recommendation: input.recommendation,
    })
    .select("id")
    .single();
  if (error) throw error;

  const byName = personName(await loadPeople([actor]), actor);
  await notifyMrRecommendationReady({
    byName,
    candidateId,
    candidateName: record.name,
    recommendation: input.recommendation,
    recommendationId: String((data as { id: number | string }).id),
  });

  const after = await loadMrCandidate(candidateId);
  return { stage: mrHiringStage(after?.facts ?? record.facts) };
}
