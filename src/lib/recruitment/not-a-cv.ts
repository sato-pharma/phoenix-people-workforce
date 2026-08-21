// Recruitment / ATS — the "this file is not a CV" flag, and the words that explain it.

/**
 * What to show in the pool. Two words, because it sits inside a table row that must not wrap.
 *
 * The extractor asks one question with two halves — *is this a CV?* and *extract these 38 fields* —
 * and its own prompt tells the model that on anything else it may leave every field null. So on a
 * photographed certificate the model answers `is_cv: false`, nulls all 38, and finishes in seven
 * seconds. That is the designed answer, not a failed read.
 *
 * The pool could not tell the two apart, because the verdict was computed and then thrown away:
 * `persistCvExtraction` wrote six columns and `is_cv` was not one of them (fixed in #2271, which
 * also backfilled nothing — 418 pre-existing rows still read NULL). Twenty-three "WhatsApp Import"
 * rows in production are photographs of ICDL certificates, training diplomas and Saudi experience
 * letters. Each showed as a blank row with no reason given, so the same thirteen distinct images
 * were re-read three separate times at full vision price, hunting a fault that never existed.
 */
export const NOT_A_CV_LABEL = "Not a CV";

/** The sentence a recruiter reads on hover, and on a phone the whole reason the row is empty. */
export const NOT_A_CV_TITLE =
  "The CV read judged this file not to be a CV — typically a photographed certificate, diploma or experience letter. The empty fields are its answer, not a failed read.";

/**
 * True only when a read is on record AND that read said no.
 *
 * Deliberately not `!candidate.notACv === false` cleverness: absent means "nobody has judged this
 * file", which is the state of every row read before the column existed, and calling those not-a-CV
 * would put a warning on most of the pool — the same mistake `isStatedNonEgyptian` exists to avoid.
 */
export function isNotACv(candidate: { notACv?: boolean } | null | undefined): boolean {
  return candidate?.notACv === true;
}
