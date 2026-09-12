// Recruitment / ATS — the star on a CV: 1, 2 or 3.
//
// The owner, 2026-09-12: "i want be able to favorite a cv more". Asked which of four readings he
// meant, he chose degrees — rank the CVs you like AGAINST EACH OTHER, so the best rise to the top
// of the shortlist instead of all sitting in one flat pile.
//
// A STAR IS NOT A STATUS, and keeping the two apart is the whole design. `candidate-status.ts` holds
// the decision — new, shortlisted, sent_to_manager, rejected, hired — and it is a single slot that
// moves forward: one value at a time, each replacing the last. A star answers a different question,
// "how much did I like this one", and it has to SURVIVE the decision rather than be replaced by it.
// A three-star CV that gets sent to a manager is still a three-star CV, and that is exactly what
// makes the shortlist orderable afterwards.
//
// NULL IS UNRATED, AND IT IS NOT ZERO. Nobody has starred this CV. Clearing a star writes null back
// rather than 0 so "unrated" has one representation and a filter can ask for it plainly.
//
// Pure on purpose — no database, no React — for the same reason candidate-status.ts is: the server
// route, the queue rows, the filter bar and the screening session all import this one list and
// cannot drift apart. It is also imported by screening-link.ts, which a "use client" component
// pulls in, so nothing here may ever reach a Supabase client. See that file's header.

/**
 * The ladder, low to high.
 *
 * PINNED IN THE DATABASE TOO, by a check constraint — unlike the status vocabulary beside it, which
 * deliberately refuses one. That difference is not an inconsistency. A status is a LABEL and the
 * string carries its own meaning, so renaming or adding one should cost nothing but a code change.
 * A rating is a POSITION ON A LADDER, and what "2" means depends entirely on where the top is:
 * widening 1-3 to 1-5 would silently restate every star already given, because two out of three is
 * not two out of five. Widening it SHOULD cost a migration and a decision about the existing rows.
 */
export const candidateRatings = [1, 2, 3] as const;
export type CandidateRating = (typeof candidateRatings)[number];

/** The top of the ladder. Read from the list rather than written twice. */
export const MAX_CANDIDATE_RATING: CandidateRating = candidateRatings[candidateRatings.length - 1]!;

/**
 * What each rung means in words.
 *
 * Stars alone are a picture, and a picture cannot be read by a screen reader, put in a tooltip or
 * printed in a sentence. These are what the control announces and what a filter option says, so a
 * reader never has to count shapes to know what they picked.
 */
export const candidateRatingLabels: Record<CandidateRating, string> = {
  1: "Worth a look",
  2: "Strong",
  3: "Top pick",
};

export function isCandidateRating(value: unknown): value is CandidateRating {
  return typeof value === "number" && (candidateRatings as readonly number[]).includes(value);
}

/**
 * A rating out of anything untrusted — a database column, a JSON body, a query string.
 *
 * ANYTHING UNRECOGNISED IS null, never a guess and never a throw. That is the same rule every other
 * parser in this module family follows: a screen that shows an unrated CV is a far better outcome
 * than one that 500s because a column holds a value the check constraint should have refused, or
 * because somebody edited the address bar.
 */
export function parseCandidateRating(value: unknown): CandidateRating | null {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed)) return null;
  return isCandidateRating(parsed) ? parsed : null;
}

/**
 * The filter, as "this many stars OR MORE" rather than "exactly this many".
 *
 * Deliberate: the question a recruiter asks the pile is "show me the good ones", and on an exact
 * match "2" would hide the three-star CVs — the best ones — from a filter chosen to find them.
 * `unrated` is its own answer rather than the absence of one, because "nobody has starred this yet"
 * is a real thing to go looking for and is where the unstarred work is.
 *
 * The numeric values stay correct if the ladder is ever widened; only the list of options grows.
 */
export const screeningRatingFilters = ["3", "2", "1", "unrated"] as const;
export type ScreeningRatingFilter = (typeof screeningRatingFilters)[number];

export const screeningRatingFilterLabels: Record<ScreeningRatingFilter, string> = {
  1: "1 star and up",
  2: "2 stars and up",
  3: "3 stars only",
  unrated: "Not starred yet",
};

export function isScreeningRatingFilter(value: unknown): value is ScreeningRatingFilter {
  return typeof value === "string" && (screeningRatingFilters as readonly string[]).includes(value);
}

/** Does this candidate's star satisfy that filter? `null` on either side means "no narrowing"/"unrated". */
export function matchesRatingFilter(
  rating: CandidateRating | null,
  filter: ScreeningRatingFilter | null | undefined,
): boolean {
  // `!filter`, not `filter === null`. A narrowing built by hand — a test, a caller that predates
  // this filter — carries `undefined` rather than `null` here, and `=== null` would fall straight
  // through to `rating >= Number(undefined)`, which is NaN, which is false: an empty narrowing
  // would have hidden the entire pool. Every other filter in matchesScreeningNarrowing guards on
  // truthiness for exactly this reason.
  if (!filter) return true;
  if (filter === "unrated") return rating === null;
  return rating !== null && rating >= Number(filter);
}

/**
 * The order the queue puts two CVs in, by star alone — higher first, unrated last.
 *
 * A COMPARATOR RATHER THAN A SORT, because the star is never the only thing ordering the pool: the
 * queue already has an order of its own and this is applied as the first key on top of it, so two
 * CVs with the same star keep whatever order the queue had already decided. Returning 0 for a tie
 * is what makes that work — see the pool ordering in screening-workspace.ts.
 *
 * Unrated sorts LAST and not first. An unstarred CV is not a bad CV — most of the pile has never
 * been looked at — but the whole point of the feature is that what you liked is at the top.
 */
export function byRatingDescending(
  left: CandidateRating | null,
  right: CandidateRating | null,
): number {
  return (right ?? 0) - (left ?? 0);
}
