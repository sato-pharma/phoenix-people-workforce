// Recruitment workspace — the answer chips the manager's candidate list draws, built on the SERVER.
//
// Imported by the two pages that render `RecruitmentCandidatesPortal` — the employee portal's
// /employee-portals/recruitment-candidates and its admin-shell twin /recruitment/candidates — so the
// manager, and the CEO on the admin twin, read each CV's answers under the same labels HR reads
// ("one question, one name"). Server-only: the question set is read from the database, so no client
// component may import this file.

import type { Candidate } from "@/lib/recruitment/types";
import {
  answerChipsFor,
  loadAnswerChipContext,
  type AnswerChipCandidate,
  type AnswerChipContext,
} from "@/lib/recruitment/workspace/answer-chips";
import type { WorkspaceAnswerChip } from "@/lib/recruitment/workspace/types";

export { loadAnswerChipContext };
export type { AnswerChipContext };

/** The reply columns the chips read — the applicant's own answers, never a CV-reading column. */
function chipCandidate(candidate: Candidate): AnswerChipCandidate {
  return {
    answerMarks: null,
    appliedForJobTitle: candidate.appliedForJobTitle,
    declaredBackground: candidate.declaredBackground,
    declaredExpectedSalary: candidate.declaredExpectedSalary,
    declaredExperience: candidate.declaredExperience,
    declaredRoleFamily: null,
    preferencesDeclaredAt: candidate.preferencesDeclaredAt,
    preferredAreaName: candidate.preferredAreaName,
    preferredRegionCode: candidate.preferredRegionCode,
    preferredRegionName: candidate.preferredRegionName,
    screeningExtraAnswers: candidate.screeningExtraAnswers,
  };
}

/**
 * Every CV's answers as the workspace's labelled chips, keyed by candidate id. Not tied to a role
 * tab: a manager sees every answer given, and only the questions everyone is asked show as missing.
 * Pass the SAME (redacted) candidates the cards draw, so a chip can never carry what a card hides.
 */
export function answerChipsByCandidate(
  candidates: readonly Candidate[],
  context: AnswerChipContext,
): Record<string, WorkspaceAnswerChip[]> {
  const chips: Record<string, WorkspaceAnswerChip[]> = {};
  for (const candidate of candidates) {
    if (chips[candidate.id]) continue;
    chips[candidate.id] = answerChipsFor(chipCandidate(candidate), { context, nameOf: () => null, roleFamily: null, tab: null });
  }
  return chips;
}
