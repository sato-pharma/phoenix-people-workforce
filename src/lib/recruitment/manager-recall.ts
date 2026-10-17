// Recruitment / ATS — taking a CV back out of a manager's folders.
//
// The owner, 2026-10-16: the TA or admin pushes a CV whenever needed "and can any time get it back".
//
// A folder is its sends, so taking a CV back is deleting the (candidate, manager) send row — nothing
// else makes it leave. Two other things hold the same fact in older shapes and are put right here so
// a recalled CV cannot come back through them: the `manager_notified_*` stamp on the candidate row
// (still read by the manager's "Sent to you" list and the stale-send nudge), and the candidate's
// `sent_to_manager` status (which counts it as sitting with a manager).

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdForStorage, hrIdsMatch } from "@/lib/hr-id";
import { getCandidate } from "@/lib/recruitment/candidates";
import { CANDIDATE_STATUS_NOTE_MAX_LENGTH, normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import { recruitmentDb } from "@/lib/recruitment/db";
import { returnReleasedCvToShortlist } from "@/lib/recruitment/manager-recall-status";
import { deleteManagerSend, listSendsForCandidate, type ManagerSend } from "@/lib/recruitment/manager-sends";
import { managerLabel } from "@/lib/recruitment/person-labels";

export type RecallResult = {
  candidateName: string;
  managerName: string;
  /** True when no manager holds the CV any more and its status went back to shortlisted. */
  statusReturned: boolean;
};

/** The stamp columns on the candidate row, as they read when nobody holds the CV. */
const CLEARED_STAMP = {
  manager_notified_area: null,
  manager_notified_at: null,
  manager_notified_hr_id: null,
  manager_notified_job_title: null,
  manager_notified_name: null,
  manager_notified_region: null,
  sent_for_area: null,
  sent_for_job_title: null,
  sent_for_line: null,
  sent_for_region: null,
  sent_for_vacancy_id: null,
};

function stampOf(send: ManagerSend) {
  return {
    manager_notified_area: send.managerArea,
    manager_notified_at: send.sentAt,
    manager_notified_hr_id: send.managerHrId,
    manager_notified_job_title: send.managerJobTitle,
    manager_notified_name: send.managerName,
    manager_notified_region: send.managerRegion,
    sent_for_area: send.position?.areaName ?? null,
    sent_for_job_title: send.position?.jobTitle ?? null,
    sent_for_line: send.position?.lineName ?? null,
    sent_for_region: send.position?.regionName ?? null,
    sent_for_vacancy_id: send.position?.vacancyId ?? null,
  };
}

/**
 * Take one CV back from one manager.
 *
 * Throws when that manager does not hold it, rather than reporting a recall that changed nothing.
 * When another manager still holds the CV the legacy stamp is pointed at his newest send, which is
 * what "last send wins" has always meant; when nobody does, the stamp is cleared and a CV that was
 * `sent_to_manager` goes back to `shortlisted`, the state the 45-day return uses, so it is not left
 * counted as sitting with someone.
 */
export async function recallCandidateFromManager(
  access: AccessContext,
  input: { candidateId: string; managerHrId: string; statusNote?: (managerName: string) => string },
): Promise<RecallResult> {
  const candidate = await getCandidate(input.candidateId);
  if (!candidate) throw new Error("Candidate not found.");

  const sends = await listSendsForCandidate(candidate.id);
  const held = sends.find((send) => hrIdsMatch(send.managerHrId, input.managerHrId));
  const stampNamesHim = Boolean(candidate.managerNotified) && hrIdsMatch(candidate.managerNotified?.hrId, input.managerHrId);
  if (!held && !stampNamesHim) throw new Error("That manager does not hold this CV.");

  const managerName = managerLabel(held?.managerName ?? candidate.managerNotified?.name ?? null);
  // Refused BEFORE the send is deleted: a recall that fails after its first write is the half-done
  // state this function must never leave behind.
  const note = input.statusNote ? input.statusNote(managerName) : `Taken back from ${managerName}.`;
  if (note.length > CANDIDATE_STATUS_NOTE_MAX_LENGTH) {
    throw new Error(`Keep the note under ${CANDIDATE_STATUS_NOTE_MAX_LENGTH} characters.`);
  }
  if (held) await deleteManagerSend(candidate.id, input.managerHrId);

  const remaining = sends.filter((send) => !hrIdsMatch(send.managerHrId, input.managerHrId));
  const newest = [...remaining].sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt))[0] ?? null;
  if (stampNamesHim || remaining.length === 0) {
    const { error } = await recruitmentDb()
      .from("ats_candidates")
      .update(newest ? stampOf(newest) : CLEARED_STAMP)
      .eq("id", candidate.id);
    if (error) throw error;
  }

  let statusReturned = false;
  if (remaining.length === 0 && normalizeCandidateStatus(candidate.status) === "sent_to_manager") {
    // Written straight to the table, NOT through updateCandidateStatus: that function is a person's
    // click and refuses `sent_to_manager → shortlisted` on purpose (statusChangeRefusal) to protect a
    // CV a manager still holds. His send was deleted above, so nobody does. Going through it threw
    // after the send was gone and left nine CVs at `sent_to_manager` with nobody holding them
    // (2026-10-17), the same reason manager-hold-return.ts writes its own return.
    statusReturned = await returnReleasedCvToShortlist(recruitmentDb(), {
      actorHrId: hrIdForStorage(access.hrId),
      candidateId: candidate.id,
      changedAt: new Date().toISOString(),
      note,
    });
  }
  return { candidateName: candidate.fullName, managerName, statusReturned };
}

/**
 * A manager hides a CV that reached him — one press, no reason asked.
 *
 * The owner, 2026-10-16: "make district manager able to hide the CV if he received him." It is the
 * recall run on the caller's OWN hold: his send goes, the legacy stamp is put right and a CV nobody
 * else holds goes back to `shortlisted`, so it leaves his folders, his "Sent to you" list and the
 * hourly reminder in one step. Talent Acquisition still has the CV and a re-push brings it back.
 * The manager is always the session's, never a posted id, so nobody can hide a CV from somebody else.
 */
export async function hideCandidateFromManager(
  access: AccessContext,
  candidateId: string,
): Promise<RecallResult> {
  if (!access.hrId) throw new Error("Your session has no HR id, so a CV cannot be hidden.");
  return recallCandidateFromManager(access, {
    candidateId,
    managerHrId: access.hrId,
    statusNote: (managerName) => `Hidden by ${managerName}.`,
  });
}
