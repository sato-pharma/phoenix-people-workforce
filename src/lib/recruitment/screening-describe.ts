// Recruitment / ATS — how a candidate row is read for ordering, in ONE place.
//
// WHY IT MOVED HERE. These two functions lived inside `candidate-screening-session.tsx`, which is
// fine while one screen orders the queue and wrong the moment two do. The workstation orders the
// same pool on the SERVER — so a copy here and a copy there would be two rules that agree today and
// drift the first time either is touched, and the symptom would be the two screens disagreeing
// about who is at the top of the queue with nothing on screen to say which was right.
//
// That is not hypothetical in this module: `candidateScreeningRoleFamily` exists precisely because
// the Role filter and the "Applying for" cell each resolved a candidate's job their own way, and a
// District Sales Manager sat on screen invisible to the one filter built to find him.
//
// PURE. Imported by a client component, so nothing here may reach the database.

import { candidateRegionCodes, candidateRegionForGovernorate, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { candidateScreeningFacts, candidateScreeningRoleFamily } from "@/lib/recruitment/candidate-screening-facts";
import { normalizePhone } from "@/lib/recruitment/candidate-matching";
import type { ScreeningOrderInput } from "@/lib/recruitment/screening-order";
import type { Candidate } from "@/lib/recruitment/types";

/**
 * Where a candidate is, for the region filter — what they SAID first, then what the CV shows.
 *
 * The stated preference wins because it is an answer to our own question, while a governorate is
 * wherever they happen to live: a Beni Suef pharmacist who asked for Cairo is a Cairo candidate.
 * Same precedence the Drive filing uses.
 *
 * Only the two PURE readers are used. The free-text address reader would place 8 more of the 534
 * undecided rows and would pull the whole Egypt place vocabulary into this bundle to do it; those
 * eight land under "Region not on the CV", which is true rather than merely convenient.
 */
export function screeningRegionOf(candidate: Candidate): CandidateRegionCode | null {
  const stated = String(candidate.preferredRegionCode ?? "").trim().toUpperCase();
  if ((candidateRegionCodes as readonly string[]).includes(stated)) return stated as CandidateRegionCode;
  return candidateRegionForGovernorate(candidate.governorate);
}

/**
 * What the ordering needs to know about one candidate, resolved through the SAME functions the row
 * and the Role filter use — so the queue cannot disagree with the table about who someone is.
 */
export function describeForOrder(candidate: Candidate): ScreeningOrderInput {
  const facts = candidateScreeningFacts(candidate);
  return {
    createdAt: candidate.createdAt,
    // The phone, normalized by the SAME function the intake dedupe uses. It groups; it never
    // merges — `candidate-matching.ts` stopped matching on phone in August precisely because it
    // merged three different applicants into one record, and this must not walk that back.
    duplicateKey: normalizePhone(candidate.phone ?? candidate.whatsapp),
    family: candidateScreeningRoleFamily(facts, candidateRowAppliedFor(candidate).text),
    hasPharmaExperience: facts.pharmaRep?.value ?? null,
    // A file the extractor already judged not to be a CV is a settled answer, not an open question,
    // so it goes to the back rather than sitting among the ones only a person can read.
    notACv: candidate.notACv,
    region: screeningRegionOf(candidate),
    yearsExperience: candidate.yearsExperience,
  };
}
