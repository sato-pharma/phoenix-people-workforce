// Recruitment / ATS — pointing a candidate at the job offer letter written for them, and taking the
// pointer off again.
//
// 🔴 THE DIRECTION IS THE WHOLE DESIGN, and this module is where it is easiest to break.
// `src/lib/offers/types.ts` carries the owner's instruction that the offers module is deliberately
// independent of recruitment: an offer may be issued to somebody who never entered the ATS, and "the
// two must not be merged". So the arrow is recruitment -> offers and never back. This file imports
// the offers module's own reader; nothing under `src/lib/offers/` imports anything from here, and
// `offers` gains no candidate column. A `candidate_id` on `offers` is the obvious implementation, it
// was written on 2026-09-28, a pinned test caught it, and it was reverted the same night.
//
// WHY A DEDICATED WRITER RATHER THAN A FIELD ON THE EDIT FORM. The pointer is a uuid. Put through
// `updateCandidate` with the other columns, it becomes a text box that accepts any 36 characters and
// stores them, and an id typed one character wrong points a candidate at somebody else's letter —
// which is how the wrong first working day reaches a new hire. So the id is CONFIRMED against the
// offers module before it is stored, and an id that names no letter is refused in words rather than
// saved.

import { isOfferNotFound, getOffer } from "@/lib/offers/service";
import { mapCandidate, recruitmentDb, textOrNull, type CandidateDbRow } from "@/lib/recruitment/db";
import type { Candidate } from "@/lib/recruitment/types";

/** What the pointer is worth showing as, for a confirmation line. */
export type LinkedOfferSummary = {
  id: string;
  /** The name ON THE LETTER — free text the letter carries, never matched against the candidate. */
  candidateName: string;
  startDate: string;
  status: string;
  title: string;
};

/**
 * Point this candidate at an offer letter, or pass null to take the pointer off.
 *
 * REFUSES AN ID THAT NAMES NO LETTER. `getOffer` is the offers module's own reader and the only
 * thing that can answer whether a letter exists; a missing one comes back as a plain sentence a
 * recruiter can act on, not as a stored pointer to nothing.
 *
 * NEVER MATCHED BY NAME OR EMAIL, on purpose and permanently. The letters carry `candidate_name` and
 * `candidate_email` as free text with no key — measured on 2026-09-08, 0 of 3 live offers matched a
 * candidate by email and 1 of 3 by name, and one e-mail address on production
 * (achieverrr303@gmail.com) is the recipient on six DIFFERENT people's offers. A human says which
 * letter belongs to whom; this function only records the answer.
 *
 * REPLACING A POINTER IS ALLOWED, and is the point: a re-sent or corrected letter supersedes the
 * one before it. The letter that stops being pointed at is untouched in Offers.
 */
export async function setCandidateOfferLetter(candidateId: string, offerId: string | null): Promise<Candidate> {
  const id = String(candidateId ?? "").trim();
  if (!id) throw new Error("Which candidate?");

  const wanted = textOrNull(offerId);
  if (wanted) {
    try {
      await getOffer(wanted);
    } catch (error) {
      if (isOfferNotFound(error)) throw new Error("There is no offer letter with that reference.");
      throw error;
    }
  }

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .update({ offer_id: wanted, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Candidate not found.");
  return mapCandidate(data as CandidateDbRow);
}

/**
 * The letter a candidate points at, summarised — or null when there is no pointer, and null again
 * when the pointer names a letter that has since been deleted.
 *
 * A DELETED LETTER READS AS NO LETTER rather than as an error. The database's own `on delete set
 * null` already clears the pointer when a letter is deleted through it, so this only covers the
 * window before that and rows written by hand; either way a screen showing a candidate must not
 * fail because an offer it merely mentions has gone.
 */
export async function linkedOfferFor(candidate: Pick<Candidate, "offerId">): Promise<LinkedOfferSummary | null> {
  const offerId = textOrNull(candidate.offerId);
  if (!offerId) return null;
  try {
    const offer = await getOffer(offerId);
    return {
      candidateName: offer.candidateName,
      id: offer.id,
      startDate: offer.startDate,
      status: offer.status,
      title: offer.title,
    };
  } catch (error) {
    if (isOfferNotFound(error)) return null;
    throw error;
  }
}
