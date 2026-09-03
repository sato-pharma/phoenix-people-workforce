// Recruitment / ATS — where a CV goes when the applicant never answered the questions.
//
// WHY THIS EXISTS, AND WHY IT IS A SEPARATE SHELF.
//
// `candidate-folder-suggestion.ts` trusts exactly one marker: `preferencesDeclaredAt`, set when a
// WhatsApp classification conversation completes. Its reasoning is sound and is not weakened here —
// three quarters of `applied_for_job_title` values were written by the CV extractor rather than
// tapped by a person, and filing on a machine's guess puts people into area folders nobody will
// open again.
//
// But that rule was answering "which AREA folder", and it left a second question unasked. Measured
// on production 2026-09-04, of 529 candidates holding a stored CV and no declared answers:
//
//   378  have a governorate the CV extractor already read
//     4  more have one recoverable from their free-text address
//     5  are outside Egypt altogether
//   140  have nothing that names a place
//
// A second pass on 2026-09-04, after the first 757 CVs were filed, found three more seams and
// this module now reads all of them: 31 of that last group had answered the region question in
// WhatsApp without finishing the conversation; 53 more had a street address naming a town the
// governorate map did not carry; and the rest of the world was reaching 'no location' rather
// than its own country. See `egyptRegionFromFreeText` for the two traps that sit on the second.
//
// So 387 of 529 CVs were sitting in one flat folder while the database already knew what part of
// the country each person lives in. The owner's instruction on 2026-09-04 was direct: *"I don't want
// a CV sitting with no folder."* He is right, and the cost of the old behaviour was worse than the
// risk being avoided — a CV nobody can find is a certainty, where a coarse region is at worst a
// near miss one folder away.
//
// THE LINE THIS MODULE HOLDS: an inference never enters the confirmed tree. It files under its own
// top-level shelf, named so that nobody reading the folder can mistake it for a stated answer, and
// it stops at REGION. It never guesses an area, because area is the level at which a wrong folder
// becomes unfindable, and it never guesses a role, because a free-typed current job title would
// shatter the shelf into single-CV folders named after other companies' titles.
//
// When the applicant finally answers, `mirrorCvToDrive` moves the file into the confirmed tree by
// itself — the inferred folder is a waiting room, not a destination.
//
// PURE — no database, no React, same rule as candidate-folder-suggestion.ts and for the same reason.

import {
  candidateRegionLabels,
  egyptRegionFromFreeText,
  foreignCountryForGovernorate,
  type CandidateRegionCode,
} from "@/lib/recruitment/candidate-region";

/** Everything this module reads. Structural, so a caller need not build a whole candidate. */
export type InferableCandidate = {
  address?: string | null;
  governorate?: string | null;
  /** `preferred_region_code` — the region the APPLICANT chose, in their own words. */
  preferredRegionCode?: string | null;
  sentForRegion?: string | null;
};

/** Which field produced the answer — carried so a screen and a log can say why a CV is where it is. */
export type InferenceBasis =
  | "governorate"
  | "address"
  | "vacancy"
  | "declared-preference"
  | "outside-egypt";

export type InferredPlacement = {
  basis: InferenceBasis;
  /** The company region, when the place is in Egypt. */
  regionCode: CandidateRegionCode | null;
  /** The folder name this becomes — a region label, or a country. */
  label: string;
};

const trimmed = (value: string | null | undefined): string => String(value ?? "").trim();

/**
 * A region code the record already holds, validated against the real list.
 *
 * `sent_for_region` is written when a candidate is actually put forward for a vacancy, so it is a
 * recruiter's action rather than an extraction — the strongest signal in this file. It is still
 * checked against `candidateRegionLabels` rather than trusted as text, because an unrecognised code
 * would otherwise become a folder named after a typo.
 */
function regionFromStoredCode(raw: string | null | undefined): CandidateRegionCode | null {
  const code = trimmed(raw).toUpperCase();
  if (!code) return null;
  return code in candidateRegionLabels ? (code as CandidateRegionCode) : null;
}

/**
 * Where this candidate's CV suggests they are, or null when nothing in the record names a place.
 *
 * Order is by how much a human had to do with the value: a vacancy a recruiter sent them for, then
 * the governorate the extractor read, then the free-text address, then a country outside Egypt.
 * Null is a real answer and means the record is silent — it is never widened into a guess.
 */
export function inferCandidatePlacement(
  candidate: InferableCandidate | null | undefined,
): InferredPlacement | null {
  if (!candidate) return null;

  const fromVacancy = regionFromStoredCode(candidate.sentForRegion);
  if (fromVacancy) {
    return { basis: "vacancy", label: candidateRegionLabels[fromVacancy], regionCode: fromVacancy };
  }

  // The applicant's OWN answer to "which region", when they gave one. It sits below the vacancy
  // because being put forward for a job is a later and more considered act than stating a
  // preference, and above the CV because a person typing an answer beats a machine reading a page.
  //
  // These exist without `preferences_declared_at` because the WhatsApp flow saves each answer as it
  // arrives and stamps completion only at the end — so a conversation abandoned at question three
  // leaves a real, stated region behind. 31 of the 130 candidates whose CV named no place at all
  // had one (production, 2026-09-04). Filing them as "no location" was reading past their answer.
  const fromPreference = regionFromStoredCode(candidate.preferredRegionCode);
  if (fromPreference) {
    return {
      basis: "declared-preference",
      label: candidateRegionLabels[fromPreference],
      regionCode: fromPreference,
    };
  }

  const fromGovernorate = egyptRegionFromFreeText(candidate.governorate);
  if (fromGovernorate) {
    return {
      basis: "governorate",
      label: candidateRegionLabels[fromGovernorate],
      regionCode: fromGovernorate,
    };
  }

  const fromAddress = egyptRegionFromFreeText(candidate.address);
  if (fromAddress) {
    return { basis: "address", label: candidateRegionLabels[fromAddress], regionCode: fromAddress };
  }

  // Asked only once every Egyptian route has answered null, so an Egyptian governorate can never
  // reach it — the same ordering `candidate-region.ts` documents for its own two lookups.
  const abroad =
    foreignCountryForGovernorate(candidate.governorate) ??
    foreignCountryForGovernorate(candidate.address);
  if (abroad) return { basis: "outside-egypt", label: abroad, regionCode: null };

  return null;
}
