// Recruitment / ATS — keeping the candidate, the job offer letter and the Employee Master telling the
// same story when a letter ends in a hire or in a "did not join".
//
// WHY THIS FILE EXISTS. Three records describe one person's path — the offer letter (offers), the
// candidate (recruitment) and the employee (Employee Master) — and the doors between them were
// opened by hand. On production on 2026-10-14: 26 accepted letters, 2 pointing at an employee, while
// 21 of those people were on the Master; 11 joiners whose candidate record still read shortlisted or
// new; 4 people the Master recorded as "declined offer" whose letter still said accepted. The Talent
// Acquisition dashboard read each record on its own and reported three unrelated stories. The data
// was repaired the same day (pre-image `ats_backup_20261014_offerhirefix`); this file is what keeps
// it repaired.
//
// 🔴 THE DIRECTION IS THE DESIGN, as in `candidate-offer-link.ts`: this file lives on the recruitment
// side and calls INTO the offers module. Nothing under `src/lib/offers/` imports from here, and the
// offers module learns nothing about candidates. The candidate is found ONLY through the pointer the
// candidate carries (`ats_candidates.offer_id`), read backwards by `candidateForOfferLetter` — never
// by name or address, and an ambiguous pointer finds nobody.
//
// 🔒 A LETTER WITH NO CANDIDATE BEHIND IT IS NOT A GAP (owner, 2026-09-28) — so "no candidate points
// at this letter" is a normal answer here, never an error and never a prompt to invent a record.
//
// BEST EFFORT, NEVER A THROW. Every caller has already written the thing that matters (the employee,
// or the declined-offer status). A failed tidy-up must not turn that success into an error the user
// then presses again, so a failure is logged and the caller carries on.

import { hrIdForStorage } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import {
  declineAcceptedOffersForEmployee,
  getOffer,
  isOfferNotFound,
  stampOfferHiredByHr,
} from "@/lib/offers/service";
import type { OfferRecord } from "@/lib/offers/types";
import { recordCandidateStatusEvent } from "@/lib/recruitment/candidates";
import { candidateForOfferLetter } from "@/lib/recruitment/candidate-offer-link";
import { recruitmentDb } from "@/lib/recruitment/db";

type CandidateMove = "already" | "kept" | "moved" | "none";

/** The piles a candidate is still being worked in — the only ones a declined letter may close. */
const LIVE_CANDIDATE_STATUSES: readonly string[] = ["new", "shortlisted", "backup", "sent_to_manager"];

/**
 * Move the candidate whose record points at this letter, writing the history line with it.
 *
 * `status_changed_by_hr_id` is the person who pressed the button (stored in the canonical casing) or
 * null for the joining form, where nobody on staff did. A candidate already on the target status is
 * left alone so a second save cannot stack a second history line. With `onlyFrom`, a candidate in any
 * other pile is left exactly where they are ("kept").
 */
async function moveCandidateOfLetter(
  offerId: string,
  to: "hired" | "rejected",
  note: string,
  actorHrId: string | null,
  onlyFrom?: readonly string[],
): Promise<CandidateMove> {
  const candidate = await candidateForOfferLetter(offerId);
  if (!candidate) return "none";
  if (candidate.status === to) return "already";
  if (onlyFrom && !onlyFrom.includes(candidate.status)) return "kept";

  const changedAt = new Date().toISOString();
  const { error } = await recruitmentDb()
    .from("ats_candidates")
    .update({
      status: to,
      status_changed_at: changedAt,
      status_changed_by_hr_id: actorHrId,
      status_note: note,
      updated_at: changedAt,
    })
    .eq("id", candidate.id);
  if (error) throw new Error(error.message);

  await recordCandidateStatusEvent({
    actorHrId,
    candidateId: candidate.id,
    fromStatus: candidate.status,
    note,
    toStatus: to,
  });
  return "moved";
}

function sameEmployee(left: string | null | undefined, right: string): boolean {
  return String(left ?? "").trim().toLowerCase() === right.trim().toLowerCase();
}

export type HireFromOfferOutcome = {
  /** Did THIS call point the letter at the new employee (false when it already did, or could not). */
  letterLinked: boolean;
  /** What happened to the candidate behind the letter, if there is one. */
  candidate: CandidateMove | "error";
};

/**
 * An employee was just created from this offer letter — by HR's Add Employee (`offerId` came with the
 * form) or by the candidate's own joining form (which has already pointed the letter at the record).
 *
 * The letter is pointed at the employee when it is accepted and not yet linked; the candidate behind
 * it is then marked hired. The candidate step runs only when the letter really points at THIS
 * employee afterwards, so a form opened from the wrong letter can never promote somebody else's CV.
 */
export async function recordHireFromOfferLetter(input: {
  actorHrId: string | null;
  hrId: string;
  offerId: string;
}): Promise<HireFromOfferOutcome> {
  const hrId = String(input.hrId ?? "").trim();
  const offerId = String(input.offerId ?? "").trim();
  if (!hrId || !offerId) return { candidate: "none", letterLinked: false };

  try {
    const linked = await stampOfferHiredByHr(offerId, hrId);
    let letter: OfferRecord | null = linked;
    if (!letter) {
      try {
        letter = await getOffer(offerId);
      } catch (error) {
        if (isOfferNotFound(error)) return { candidate: "none", letterLinked: false };
        throw error;
      }
    }
    if (!sameEmployee(letter.employeeHrId, hrId)) {
      return { candidate: "none", letterLinked: false };
    }

    const startNote = letter.startDate ? ` (first working day ${letter.startDate})` : "";
    const candidate = await moveCandidateOfLetter(
      offerId,
      "hired",
      `Joined the company as ${hrId}${startNote}; recorded from job offer ${letter.reference} when the employee record was created.`,
      hrIdForStorage(input.actorHrId),
    );
    return { candidate, letterLinked: Boolean(linked) };
  } catch (error) {
    logError("A hire was saved but its offer letter and candidate could not be brought into line", {
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "offer_hire_sync_failed", hr_id: hrId, offer_id: offerId },
    });
    return { candidate: "error", letterLinked: false };
  }
}

export type OfferDeclinedOutcome = { candidates: number; letters: number };

/**
 * An employee was recorded as having declined the offer after being hired ("did not join").
 *
 * Every ACCEPTED letter that points at them stops saying accepted, and the candidate behind each
 * letter moves to rejected with the reason — which is the closest word the candidate vocabulary has
 * for "accepted, then withdrew". No rejection NOTICE is sent: this writes a status, nothing else.
 */
export async function recordOfferDeclinedAfterHire(input: {
  actorHrId: string | null;
  employeeHrId: string;
}): Promise<OfferDeclinedOutcome> {
  const employeeHrId = String(input.employeeHrId ?? "").trim();
  if (!employeeHrId) return { candidates: 0, letters: 0 };

  try {
    const letters = await declineAcceptedOffersForEmployee(employeeHrId);
    let candidates = 0;
    for (const letter of letters) {
      const move = await moveCandidateOfLetter(
        letter.id,
        "rejected",
        `Accepted job offer ${letter.reference}, then declined before joining; recorded when ${employeeHrId} was marked as having declined the offer.`,
        hrIdForStorage(input.actorHrId),
      );
      if (move === "moved") candidates += 1;
    }
    return { candidates, letters: letters.length };
  } catch (error) {
    logError("A declined offer was recorded but its letter and candidate could not be brought into line", {
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "offer_decline_sync_failed", hr_id: employeeHrId },
    });
    return { candidates: 0, letters: 0 };
  }
}

/**
 * A letter was marked DECLINED by hand on the Offers screen (the candidate said no): the candidate
 * behind it stops being a live candidate.
 *
 * LIVE PILES ONLY. A candidate already hired or rejected is left exactly as they are — a letter
 * marked declined by mistake must not un-hire somebody, and the hire is the Employee Master's to
 * undo. WITHDRAWN IS NOT DECLINED: the company pulled that letter (or it expired), which says
 * nothing about the candidate, so a withdrawn letter never reaches this function. The history line
 * records what happened and no notice goes out.
 */
export async function recordOfferDeclinedByCandidate(input: {
  actorHrId: string | null;
  offer: Pick<OfferRecord, "id" | "reference">;
}): Promise<CandidateMove | "error"> {
  try {
    return await moveCandidateOfLetter(
      input.offer.id,
      "rejected",
      `Declined job offer ${input.offer.reference}; recorded when the letter was marked declined.`,
      hrIdForStorage(input.actorHrId),
      LIVE_CANDIDATE_STATUSES,
    );
  } catch (error) {
    logError("An offer was marked declined but its candidate could not be brought into line", {
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "offer_candidate_decline_sync_failed", offer_id: input.offer.id },
    });
    return "error";
  }
}
