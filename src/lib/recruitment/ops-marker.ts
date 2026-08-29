// Recruitment / ATS — the stamp an unattended CV re-read leaves on every extraction row it writes.
//
// `ats_candidate_cv_extractions.created_by` answers one question: who read this CV. A human Talent
// Acquisition review writes their own login id; an ops re-read writes one of these markers. That
// separation is load-bearing — an unattended batch must never be mistaken for a person having
// looked — and it always worked.
//
// The DATE in the marker did not. It was a hardcoded literal, `ops:cv-reread-20260816`, written
// once and then carried by every run afterwards. Measured against production 2026-08-29:
//
//   created_by                             rows   first Cairo         last Cairo
//   ops:cv-reread-20260816                  579   2026-08-16 01:27    2026-08-29 20:13
//
// Fourteen days and at least four separate runs — the original batch, the 08-21 "run the extraction
// on the 56", and two since — all claiming to be the sixteenth. The one column meant to tell those
// batches apart could not.
//
// Nothing downstream was mis-decided, because `created_at` was never wrong. The cost is to a reader:
// the stamp exists precisely so that `created_by` can be read ON ITS OWN, and read on its own it
// stated a false date.
//
// THE FIX IS A PAIR AND ONLY WORKS AS A PAIR. The writer stamps the run's own day; every reader
// matches on the PREFIX. An `===` against a whole literal is what froze the writer in the first
// place — the two scripts were kept in sync by both being wrong, so correcting either one alone
// would have silently zeroed the other's count.
//
// The day is Africa/Cairo, and that is not decoration. The original batch began at 01:27 Cairo,
// which is 23:27 UTC on the fifteenth: a UTC stamp would have dated the 2026-08-16 batch
// `20260815`. The one window where the two calendars disagree is the window this script actually
// runs in, because these are long unattended jobs started after midnight.
//
// `cairoTodayIso` is imported rather than re-derived. Two copies of it already exist
// (`@/lib/crm/dates`, `@/lib/attendance/working-days`) and a third written here would be the
// duplicate-Cairo-helper trap this repo has paid for before.

import { cairoTodayIso } from "@/lib/crm/dates";

/**
 * What every ops CV re-read marker begins with.
 *
 * Readers match on THIS, never on a whole marker. The suffix carries the run's day and, for a
 * variant batch, its name — both of which are supposed to change.
 */
export const CV_REREAD_MARKER_PREFIX = "ops:cv-reread-";

/** Africa/Cairo calendar day as YYYYMMDD, the compact form the marker has always used. */
function cairoDayStamp(): string {
  return cairoTodayIso().split("-").join("");
}

/**
 * The marker for a re-read running NOW — `ops:cv-reread-20260829`.
 *
 * `variant` names a batch that is not the default sweep, and lands between the prefix and the day:
 * `cvRereadOpsMarker("legacy-schema")` gives `ops:cv-reread-legacy-schema-20260829`, which is the
 * shape that script already wrote by hand.
 *
 * Called once at the start of a run and reused for every row, so a batch that crosses Cairo
 * midnight stamps one day rather than two. Grouping a run is the whole purpose; splitting it at
 * midnight would defeat that, and `created_at` still carries each row's real instant either way.
 */
export function cvRereadOpsMarker(variant?: string): string {
  const day = cairoDayStamp();
  return variant ? `${CV_REREAD_MARKER_PREFIX}${variant}-${day}` : `${CV_REREAD_MARKER_PREFIX}${day}`;
}

/**
 * Was this extraction row written by an ops re-read rather than by a person?
 *
 * Deliberately matches the whole `ops:cv-reread-` family, so the legacy-schema batch counts as a
 * re-read too — it is one. The `ops:` namespace is what keeps this from ever matching a human
 * login id, which is why the prefix includes it rather than being the looser `cv-reread-`.
 *
 * It does NOT match the 14 rows stamped `cv-reread-universal-2026-08-24`, an older ad-hoc run that
 * predates the namespace. Widening the prefix to catch them would drop the `ops:` guard, and a
 * frozen historical count is a smaller problem than a matcher that can claim a person's review was
 * a machine's.
 */
export function isCvRereadMarker(createdBy: string | null | undefined): boolean {
  return typeof createdBy === "string" && createdBy.startsWith(CV_REREAD_MARKER_PREFIX);
}
