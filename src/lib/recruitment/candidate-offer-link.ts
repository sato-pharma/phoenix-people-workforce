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
//
// 🔒 A LETTER WITH NO CANDIDATE BEHIND IT IS NOT A GAP TO FILL — owner's ruling, 2026-09-28: *"leave
// Esraa Awad and Taha Sheeba without ATS records"*. On production that day, 11 of the 27 offer letters
// pointed at nobody because nine people never entered the ATS at all, and TWO of them — Esraa Awad
// Hemida and Taha Sheeba Alhammed — are active Medical Representatives hired 01/10 on accepted
// letters. They were seated without passing through recruitment, and an empty pointer is the TRUTH
// about them.
//
// SO DO NOT BACKFILL CANDIDATE RECORDS TO MAKE THE FUNNEL LOOK COMPLETE. It reads like a data defect
// and it is not one. Three reasons it was refused: an employee's messages are built from
// `employee-context.ts` and never read this pointer, so wiring them buys nothing; a record with no
// CV, no source and no application is a hollow row that then appears in the pool, the screening queue
// and every count as though somebody applied; and the cost of leaving it — those two hires being
// invisible to source-of-hire reporting, which runs off candidate records — is NOT fixed by inventing
// two unattributed rows. **The one thing that would be a real defect is a session "completing" this.**

import { isOfferNotFound, getOffer } from "@/lib/offers/service";
import { mapCandidate, recruitmentDb, textOrNull, type CandidateDbRow } from "@/lib/recruitment/db";
import type { Candidate } from "@/lib/recruitment/types";

/**
 * What the pointer is worth showing as.
 *
 * 🔴 NO MONEY ON THIS SHAPE, and that is deliberate. An offer letter carries `total_monthly` and a
 * cost-of-living figure, and the candidate record is read by every seat that can read the pool —
 * which is a wider set than the seats holding the `offers` permission. So this summary carries only
 * what identifies the letter: never a salary, and nothing a reader could infer one from.
 */
export type LinkedOfferSummary = {
  id: string;
  /** The name ON THE LETTER — free text the letter carries, never matched against the candidate. */
  candidateName: string;
  startDate: string;
  status: string;
  territory: string;
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
 * candidate by email and 1 of 3 by name.
 *
 * 🔴 AND `candidate_email` IS NOT NECESSARILY THE CANDIDATE'S AT ALL — the owner's own inbox is the
 * recipient on six of production's 27 letters (his ruling, 2026-09-28: "this my email not theirs"),
 * because that is how he sends one to himself to read or forward. So the address on a letter can
 * belong to the SENDER, and six letters sharing one address is not a duplicate, not a data defect,
 * and nothing to merge — do not "clean it up". It also means e-mail can never seed a backfill: a
 * human says which letter belongs to whom, and this function only records the answer.
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
      territory: offer.territory,
      title: offer.title,
    };
  } catch (error) {
    if (isOfferNotFound(error)) return null;
    throw error;
  }
}

/**
 * The candidate whose record points at this offer letter — the pointer read BACKWARDS.
 *
 * This is what lets HR hire from an accepted letter and still get the CV. `buildOfferHireDraft`
 * carries the letter's ten fields and not one of them is personal, because the offers module does
 * not know a candidate exists and must not learn; the reverse lookup lives HERE, on the recruitment
 * side, which is the same direction every other function in this file runs in.
 *
 * Measured on production 2026-09-30: 12 accepted letters, SEVEN of them with a candidate behind
 * them, and those seven hold between them 7 mobiles, 4 universities, 4 faculties, 4 graduation
 * years, 4 governorates, 3 addresses, 2 degrees and 1 date of birth — every one of which was being
 * retyped off a screen one table away.
 *
 * 🔴 AMBIGUITY RETURNS NULL RATHER THAN GUESSING. The pointer is one column on the CANDIDATE, so
 * nothing in the schema stops two people pointing at one letter (production: 0 do). If two ever do,
 * picking either one puts SOMEBODY ELSE's national id and date of birth on a permanent employee
 * record — so this carries nothing and the form stays blank, which is a form somebody fills in
 * rather than a record nobody re-reads. Same discipline as never matching a letter by name or email.
 *
 * A LETTER WITH NO CANDIDATE IS NOT A GAP — the owner's ruling at the top of this file. Nine of
 * production's 27 letters belong to people who never entered the ATS, and null is the truth about
 * them: the form opens with the letter's own ten fields, exactly as it did before.
 */
export async function candidateForOfferLetter(offerId: string): Promise<Candidate | null> {
  const id = textOrNull(offerId);
  if (!id) return null;

  const supabase = recruitmentDb();
  // Two rows asked for where one is expected: `maybeSingle` would throw on the ambiguous case and
  // turn a prefill into a 500 on the Offers screen. Reading two and refusing is the same answer
  // without the error.
  const { data, error } = await supabase.from("ats_candidates").select("*").eq("offer_id", id).limit(2);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as CandidateDbRow[];
  if (rows.length !== 1) return null;
  return mapCandidate(rows[0]);
}
