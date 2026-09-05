// Recruitment / ATS — "the reader found this and nobody wrote it down", made visible on the row.
//
// ── THE GAP ─────────────────────────────────────────────────────────────────────────────────────
//
// Measured on production 2026-09-05: 581 of the 582 live candidates have a parsed CV, and yet
//
//   * 204 carry no `yearsExperience` on the record while the extraction holds a perfectly good
//     number,
//   * 109 the same for `nationalId`, on a pool holding almost no national ids at all,
//   * 90 the same for `currentJobTitle`,
//   * 271 candidates — 47% of the pool — have at least one of the three.
//
// This is NOT an extraction failure and the fix is NOT to widen the gate. `cv-auto-apply.ts` writes
// a finding unattended only at `confidence: "high"`; `low` waits for a human, and that rule is
// correct — a low-confidence guess overwriting a real answer is the failure it exists to prevent.
// The gap is the other half: for a candidate created by automatic intake there was no screen where
// a human ever SAW the proposal, so `low` waited for a review that never came.
//
// `listUnappliedCvFields` already puts those findings in front of whoever opens the CV. This module
// is what gets them to open it, by putting a count on the row and giving the pile an address.
//
// ── WHY ONLY THREE FIELDS ───────────────────────────────────────────────────────────────────────
//
// Measured the same day: the full `extracted_fields` blob for the pool is 1,549 kB, and the loader
// that reads it says so in its own comment — it is called with only the candidates the free
// evidence could not answer, because every round trip from here crosses the Atlantic. Pulling all
// of it on every screening page load to compute a badge would be the most expensive thing the page
// does, for a number nobody reads until they act on it.
//
// Projecting only these three keys costs 105 kB — fifteen times less. They are not an arbitrary
// sample: they are the three that change what the product DOES. `yearsExperience` orders the queue
// and drives role fit, `nationalId` is the identity key the locked dedupe rule in
// candidate-matching.ts needs and almost never has, and `currentJobTitle` is what the fit band is
// read from.
//
// SO THE BADGE CAN UNDERCOUNT, AND THAT IS THE SAFE DIRECTION. It points at a CV worth opening; the
// CV Data tab loads the whole extraction and remains the authority on exactly what is unsaved. The
// badge's own words name the three fields rather than claiming to be a total.

import { listUnappliedCvFields, type ExtractedCandidateFields } from "@/lib/recruitment/cv-extraction-fields";
import { universalCvFields } from "@/lib/recruitment/cv-field-schemas";
import type { CvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import type { Candidate } from "@/lib/recruitment/types";

/**
 * The keys the row badge checks.
 *
 * Adding one here is cheap in bytes and expensive in nothing — but it must also be added to the
 * projected select in `loadRowFindings`, or it will silently never be read and the badge will
 * quietly stop counting it. The test pins the two lists against each other for that reason.
 */
export const ROW_FINDING_KEYS = ["yearsExperience", "nationalId", "currentJobTitle"] as const;

export type RowFindingKey = (typeof ROW_FINDING_KEYS)[number];

/**
 * The same field definitions the CV Data tab uses, narrowed to the three above.
 *
 * Built from `universalCvFields` rather than re-declared, so the badge and the tab can never
 * disagree about what a field is called, where it is stored, or what counts as a real finding —
 * that split is the failure `listUnappliedCvFields` was written to close, and re-declaring the
 * columns here would reopen it one field at a time.
 */
export const rowFindingSchema: CvPositionSchema = {
  fields: universalCvFields.filter((field) => (ROW_FINDING_KEYS as readonly string[]).includes(field.key)),
  instructions: "",
  label: "Row findings",
  positionKey: "row-findings",
};

/**
 * How many of the checked fields the reader found and the record still does not hold.
 *
 * Delegates to `listUnappliedCvFields` with the narrowed schema, so "is this a real finding" and
 * "does the candidate already have it" are answered by exactly the code the CV Data tab uses. An
 * empty repeating block, a blank string and a re-extraction that found nothing are all handled
 * there and must not be re-implemented here.
 */
export function countRowFindings(
  fields: ExtractedCandidateFields | null | undefined,
  candidate: Candidate,
): number {
  if (!fields) return 0;
  return listUnappliedCvFields(fields, candidate, rowFindingSchema).length;
}
