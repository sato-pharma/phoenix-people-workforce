// Recruitment / ATS — "is this applicant eligible under the Egyptian-nationals-only rule?"
//
// The owner's standing hiring policy is that Phoenix recruits EGYPTIAN NATIONALS ONLY. It is not a
// preference and it is not negotiable per candidate, but until now nothing on screen said so: the AI
// reads nationality off the CV, writes it to the column, and a recruiter had to notice the word
// while scanning a pool of 226 people. Measured in production 2026-08-15, 10 candidates carry a
// stated nationality and 3 of them are not Egyptian — Pakistani, Sudanese and Syrian — and one of
// those three was already rejected by hand, with the reason typed into the status as a sentence.
//
// This module answers only the narrow question the screen needs, as a pure function, so the rule is
// unit-testable and stated in exactly one place.
//
// It FLAGS, it never rejects. That is deliberate and matches how the rest of the platform behaves
// (the expense engine flags and never rejects, by the owner's rule): the AI can misread a line, a
// CV can say "Egyptian-Canadian", and a person makes the call. Nothing here filters a candidate out
// of a list or blocks an action.

/**
 * Every spelling of "Egyptian" this has to recognise, matched as a SUBSTRING of the normalized
 * value. Substring rather than equality on purpose: "Egyptian Arab Republic", "Egyptian - Cairo" and
 * a dual "Egyptian / British" must all read as eligible. A dual national holding Egyptian
 * nationality IS an Egyptian national, so the substring rule is not a loophole — it is the rule.
 */
const EGYPTIAN_MARKERS = ["egypt", "مصر"];

/**
 * True only when the CV STATES a nationality and that nationality is not Egyptian.
 *
 * Blank is never a flag. That is the important half: nationality is absent on 216 of the 226
 * production candidates, so treating "unknown" as "foreign" would paint a warning on almost the
 * whole pool and the flag would be ignored within a day.
 */
export function isStatedNonEgyptian(nationality: string | null | undefined): boolean {
  const normalized = String(nationality ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return !EGYPTIAN_MARKERS.some((marker) => normalized.includes(marker));
}

/** What to show beside the name. Short, because it sits inside a table row that must not wrap. */
export const NON_EGYPTIAN_FLAG_LABEL = "Not Egyptian";

/** The sentence a recruiter reads on hover, and the reason the flag is there at all. */
export function nonEgyptianFlagTitle(nationality: string | null | undefined): string {
  const stated = String(nationality ?? "").trim();
  return `CV states ${stated} — Phoenix recruits Egyptian nationals only.`;
}
