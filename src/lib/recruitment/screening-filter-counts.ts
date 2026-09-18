// Recruitment / ATS — how many CVs each filter option would actually return.
//
// WHY THIS EXISTS. Every dropdown on the screening bar was a blind pick. Nine selects, ~68 options
// between them, and not one of them said whether it held 300 people or nobody — so the only way to
// find out was to choose it and wait out the round trip, measured at 5 to 12 seconds against the
// live pool. Finding the district manager applicants meant guessing at Role, waiting, reading the
// "42 of 434" pill, and guessing again. The owner's words on 2026-09-18, after the role-mismatch
// fix made those people findable at all: "i want to reach all those easily by polished working
// filters".
//
// So each option carries its own count — "District Manager (161)" — and the dead ones say so.
// Nothing is hidden: an option reading (0) is the honest answer to "has anybody applied for this",
// and dropping it would turn a question a recruiter can answer into a dropdown that quietly differs
// from the last time he looked. It is the same reasoning screeningAreaOptions already gives for
// listing the areas applicants NAMED rather than every area the company has.
//
// ── ONE PASS, AND THE SAME RESOLVERS AS THE MATCHER ────────────────────────────────────────────
//
// The naive shape is to run matchesScreeningNarrowing once per option per candidate. That is
// ~68 × 434 = ~29,500 calls, each re-resolving candidateScreeningFacts for a row it already
// resolved, on a page that is already slow. This resolves each candidate ONCE and increments every
// bucket that candidate belongs to, which is the same 434 resolutions the queue already pays for.
//
// The danger in doing it that way is drift: a second counting rule that disagrees with the filter
// is exactly the defect screening-filter.ts exists to prevent — "Filtering on a different fact
// from the one displayed is not a narrower filter, it is a wrong one". Two things hold it:
//
//   1. Every bucket below is derived from the SAME function the matcher calls — screeningRoleFamilies,
//      candidateScreeningFacts, candidateSourceChannel, matchesRatingFilter, normalizeCandidateStatus,
//      and this module's own screeningAreaKey/screeningSourceKey. There is no second reading of a
//      column anywhere here.
//   2. tests/recruitment-screening-filter-counts.test.ts asserts, for every filter and every option,
//      that the count equals what matchesScreeningNarrowing itself returns over the same rows.
//      Derived one way, verified against the real matcher — if they ever part, that test fires.
//
// PURE — no I/O, like every other module in this chain. The viewer-specific facts (seen, untouched)
// arrive as predicates, for the reason the matcher takes them as arguments: "have I read this" is a
// fact about the reader, not about the candidate.

import { candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { matchesRatingFilter, screeningRatingFilters } from "@/lib/recruitment/candidate-rating";
import { candidateScreeningFacts, screeningRoleFamilies } from "@/lib/recruitment/candidate-screening-facts";
import { candidateSourceChannel } from "@/lib/recruitment/candidate-source-context";
import { normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import {
  screeningAreaKey,
  screeningSourceKey,
  type ScreeningFilterCandidateRow,
} from "@/lib/recruitment/screening-filter";
import {
  SCREENING_UNKNOWN,
  screeningReceivedFilters,
  type ScreeningReceivedFilter,
} from "@/lib/recruitment/screening-link";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Deliberately a duplicate of screening-filter.ts's own window table, and the test pins the two
 * equal.
 *
 * Exporting the original would have been tidier and is the wrong trade: that constant is the
 * matcher's, and a shared record imported into a counting module is how one of the two quietly
 * becomes the authority over the other. The pin is cheap and it fails loudly.
 */
export const screeningReceivedWindowMs: Record<ScreeningReceivedFilter, number> = {
  day: 24 * HOUR_MS,
  hour: HOUR_MS,
  month: 30 * 24 * HOUR_MS,
  week: 7 * 24 * HOUR_MS,
};

/**
 * One tally per filter, keyed exactly the way that filter's option value is keyed — so the bar can
 * read a count without knowing how any of them were resolved.
 *
 * `area` and `source` are keyed by their FOLDED key (screeningAreaKey, screeningSourceKey), never
 * by the displayed spelling: those two are strings people typed, the options list keeps the first
 * spelling it saw, and a count keyed on the display value would miss every row that differed only
 * by case.
 */
export type ScreeningFilterCounts = {
  area: Record<string, number>;
  notified: Record<string, number>;
  rating: Record<string, number>;
  received: Record<string, number>;
  region: Record<string, number>;
  role: Record<string, number>;
  seen: Record<string, number>;
  source: Record<string, number>;
  status: Record<string, number>;
  /** The population every count above was taken over — the bar's own denominator. */
  total: number;
};

export function emptyScreeningFilterCounts(): ScreeningFilterCounts {
  return {
    area: {},
    notified: {},
    rating: {},
    received: {},
    region: {},
    role: {},
    seen: {},
    source: {},
    status: {},
    total: 0,
  };
}

/**
 * How many of `candidates` each option of each filter would return.
 *
 * WINDOWS AND LADDERS NEST, AND THE COUNTS SAY SO. A CV that arrived twenty minutes ago is inside
 * "Last hour" AND "Last 24 hours" and both wider windows, so it is counted in all four — because
 * that is what picking any one of them would show. The same is true of the star ladder ("2 stars
 * and up" contains the 3-star CVs) and of unseen/untouched, which overlap for every CV nobody has
 * opened. The per-filter tallies therefore do NOT sum to `total`, and must not be made to: each one
 * answers "what would this option give me", which is the only question the bar is asking.
 *
 * A CANDIDATE CAN BE IN TWO ROLE BUCKETS, and that is the fix this module was built beside. Somebody
 * who applied for a district manager seat off a senior medical rep CV is findable under both, so he
 * is counted under both — see screeningRoleFamilies.
 */
export function screeningFilterCounts(
  candidates: readonly ScreeningFilterCandidateRow[],
  context: {
    asOf: number;
    seenByViewer: (candidate: ScreeningFilterCandidateRow) => boolean;
    /** Has ANYBODY opened it — not the same question as seenByViewer; see the matcher. */
    seenByAnyone: (candidate: ScreeningFilterCandidateRow) => boolean;
  },
): ScreeningFilterCounts {
  const counts = emptyScreeningFilterCounts();
  const bump = (bucket: Record<string, number>, key: string) => {
    bucket[key] = (bucket[key] ?? 0) + 1;
  };

  for (const candidate of candidates) {
    counts.total += 1;

    // Only a status the filter can actually ask for. A legacy value that normalizes to null is shown
    // verbatim on the card but is not an option on the bar, so counting it would build a bucket
    // nothing can ever select.
    const status = normalizeCandidateStatus(candidate.status);
    if (status) bump(counts.status, status);

    bump(counts.seen, context.seenByViewer(candidate) ? "seen" : "unseen");
    if (!context.seenByAnyone(candidate)) bump(counts.seen, "untouched");

    bump(counts.notified, candidate.managerNotified ? "sent" : "unsent");

    // A row with no readable arrival time is in NO window, matching the matcher's own fail-closed
    // choice — it never matches one rather than passing every one of them.
    const createdAtMs = candidate.createdAt ? new Date(candidate.createdAt).getTime() : NaN;
    if (Number.isFinite(createdAtMs)) {
      for (const window of screeningReceivedFilters) {
        if (context.asOf - createdAtMs <= screeningReceivedWindowMs[window]) bump(counts.received, window);
      }
    }

    for (const filter of screeningRatingFilters) {
      if (matchesRatingFilter(candidate.rating ?? null, filter)) bump(counts.rating, filter);
    }

    bump(counts.source, screeningSourceKey(candidateSourceChannel(candidate.source, candidate.sourceContext).label));

    const facts = candidateScreeningFacts(candidate);

    const families = screeningRoleFamilies(facts, candidateRowAppliedFor(candidate).text);
    if (families.length === 0) bump(counts.role, SCREENING_UNKNOWN);
    for (const family of families) bump(counts.role, family);

    // Three buckets that are NOT exclusive, mirroring the matcher one branch at a time: `foreign`
    // asks only about the flag, a region code asks only about the code, and `unknown` is the one
    // that requires both to be absent. A record holding a code AND the foreign flag answers two of
    // them, so it is counted in two.
    const code = facts.region?.value.code ?? null;
    const foreign = Boolean(facts.region?.value.foreignCountry);
    if (foreign) bump(counts.region, "foreign");
    if (code !== null) bump(counts.region, code);
    if (code === null && !foreign) bump(counts.region, SCREENING_UNKNOWN);

    const area = facts.area?.value ?? null;
    bump(counts.area, area ? screeningAreaKey(area) : SCREENING_UNKNOWN);
  }

  return counts;
}
