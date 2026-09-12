import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  byRatingDescending,
  candidateRatingLabels,
  candidateRatings,
  isScreeningRatingFilter,
  matchesRatingFilter,
  MAX_CANDIDATE_RATING,
  parseCandidateRating,
  screeningRatingFilterLabels,
  screeningRatingFilters,
  type CandidateRating,
} from "../src/lib/recruitment/candidate-rating.ts";
import {
  matchesScreeningNarrowing,
  type ScreeningFilterCandidateRow,
} from "../src/lib/recruitment/screening-filter.ts";
import { parseScreeningFilters, screeningHref } from "../src/lib/recruitment/screening-link.ts";
import { orderForScreening, screeningSortKey } from "../src/lib/recruitment/screening-order.ts";
import type { CandidateRoleFamily } from "../src/lib/recruitment/candidate-role-family.ts";

/**
 * The star on a CV: 1, 2 or 3.
 *
 * The owner, 2026-09-12: *"i want be able to favorite a cv more"*. He already had Shortlist, and
 * Shortlist has one volume — everything he liked landed in a single flat pile in arrival order, and
 * the two or three he actually wanted to interview were somewhere inside it. Asked which of four
 * readings he meant, he chose degrees: rank the CVs you like AGAINST EACH OTHER.
 *
 * THE THREE FACTS THIS FILE HOLDS STILL.
 *
 * A STAR IS NOT A STATUS. It sits beside the decision and survives it: a three-star CV that gets
 * sent to a manager is still a three-star CV, which is the entire reason the shortlist can be
 * ordered afterwards. Nothing in the rating path may write a status, and nothing may write a row to
 * `ats_candidate_status_events` — that table is the decision trail, and a star in it would show up
 * as a move in every throughput figure and per-screener report built on it.
 *
 * NULL IS UNRATED AND IT IS NOT ZERO. One representation, so a filter can ask for it plainly.
 *
 * THE STAR IS THE TOP KEY OF THE QUEUE ORDER, above the band and above pharma experience. That is
 * a deliberate inversion: every other rank in `screening-order.ts` is DERIVED from the record, and a
 * star is a person saying "this one". It must never move a CV nobody starred.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

/** A row for the narrowing check, with only the fields these assertions actually read. */
function filterRow(rating: CandidateRating | null): ScreeningFilterCandidateRow {
  return { createdAt: "2026-09-01T00:00:00Z", id: `r${rating ?? "none"}`, rating };
}

export function runRecruitmentCandidateRatingTests() {
  // ── 1 · The ladder ─────────────────────────────────────────────────────────
  assert.deepEqual([...candidateRatings], [1, 2, 3], "the ladder is 1, 2, 3 — widening it is a migration");
  assert.equal(MAX_CANDIDATE_RATING, 3, "the top of the ladder is read from the list, never written twice");
  for (const rating of candidateRatings) {
    assert.ok(candidateRatingLabels[rating]?.length, `${rating} star has no words — a picture cannot be read aloud`);
  }

  // ── 2 · Reading a star out of something untrusted ──────────────────────────
  assert.equal(parseCandidateRating(2), 2, "a number on the ladder");
  assert.equal(parseCandidateRating("3"), 3, "a form control hands back a string");
  assert.equal(parseCandidateRating(" 1 "), 1, "and a query string may carry spaces");
  // ZERO IS NOT A CLEAR. `null` is the only way to say "unrated", and a 0 arriving from anywhere is
  // a value the check constraint would refuse — so it must be refused here rather than quietly
  // becoming "no star", which would make a malformed body indistinguishable from a deliberate one.
  assert.equal(parseCandidateRating(0), null, "0 is not a rating and is not a clear either");
  assert.equal(parseCandidateRating(4), null, "above the ladder is not a rating");
  assert.equal(parseCandidateRating(-1), null, "nor below it");
  assert.equal(parseCandidateRating(2.5), null, "nor between the rungs");
  assert.equal(parseCandidateRating(null), null, "an unrated column reads as unrated");
  assert.equal(parseCandidateRating("top pick"), null, "and an edited address bar narrows nothing rather than throwing");

  // ── 3 · The filter is "that many OR MORE" ──────────────────────────────────
  //
  // The question a recruiter asks the pile is "show me the good ones". On an exact match, picking
  // "2" would HIDE the three-star CVs — the best ones — from a filter chosen to find them.
  assert.equal(matchesRatingFilter(3, "2"), true, "three stars answers a two-star filter");
  assert.equal(matchesRatingFilter(2, "2"), true, "and so does two");
  assert.equal(matchesRatingFilter(1, "2"), false, "one does not");
  assert.equal(matchesRatingFilter(null, "1"), false, "and neither does no star at all");
  assert.equal(matchesRatingFilter(null, "unrated"), true, "`unrated` is where the unstarred work is");
  assert.equal(matchesRatingFilter(1, "unrated"), false, "a starred CV is not unrated");
  assert.equal(matchesRatingFilter(null, null), true, "no filter hides nobody");
  assert.equal(matchesRatingFilter(3, null), true, "including the starred ones");

  assert.ok(isScreeningRatingFilter("unrated"), "`unrated` is a filter value");
  assert.ok(!isScreeningRatingFilter("4"), "a rung that does not exist is not a filter value");
  assert.ok(!isScreeningRatingFilter(2), "the filter travels in a URL, so it is a string");
  for (const value of screeningRatingFilters) {
    assert.ok(screeningRatingFilterLabels[value]?.length, `the ${value} filter has no label`);
  }

  // ── 4 · It survives the round trip through a link ──────────────────────────
  assert.equal(parseScreeningFilters({ rating: "3" }).rating, "3", "a star filter is read off the link");
  assert.equal(parseScreeningFilters({ rating: "unrated" }).rating, "unrated", "and so is the unstarred pile");
  assert.equal(parseScreeningFilters({ rating: "9" }).rating, null, "a rung that does not exist narrows nothing");
  assert.equal(parseScreeningFilters({ rating: "" }).rating, null, "and neither does an empty one");
  assert.equal(
    screeningHref("/recruitment", { rating: "2" }),
    "/recruitment/screening?rating=2",
    "the link carries it back, so a narrowed queue can be bookmarked and pasted",
  );

  // ── 5 · The narrowing drops what the filter did not ask for ────────────
  //
  // Built from the real parser rather than hand-written, so a narrowing here can never carry a shape
  // the address bar could not actually produce.
  const narrowedTo = (rating: string) => parseScreeningFilters({ rating });
  // The third argument is the viewer's own reading, which none of these assertions narrow on.
  const anyViewer = { asOf: Date.parse("2026-09-12T00:00:00Z"), seenByViewer: false };
  assert.equal(
    matchesScreeningNarrowing(filterRow(3), narrowedTo("2"), anyViewer),
    true,
    "a three-star CV survives a two-star filter",
  );
  assert.equal(matchesScreeningNarrowing(filterRow(1), narrowedTo("2"), anyViewer), false, "a one-star CV does not");
  assert.equal(
    matchesScreeningNarrowing(filterRow(null), narrowedTo("unrated"), anyViewer),
    true,
    "the unstarred pile is reachable",
  );
  // AN EMPTY NARROWING MUST HIDE NOBODY. The guard in `matchesRatingFilter` is `!filter` rather than
  // `filter === null`, because a narrowing built by hand — a caller written before stars existed —
  // carries `undefined` here, and `=== null` would fall through to `rating >= Number(undefined)`,
  // which is NaN, which is false: the whole queue would empty.
  assert.equal(
    matchesScreeningNarrowing(filterRow(2), parseScreeningFilters({}), anyViewer),
    true,
    "and a queue with no star filter hides nobody",
  );
  assert.equal(
    matchesRatingFilter(2, undefined),
    true,
    "the same guard, stated directly: an ABSENT star filter narrows nothing",
  );

  // ── 6 · The star is the TOP key of the order ───────────────────────
  type OrderRow = { family: CandidateRoleFamily; name: string; rating: CandidateRating | null };
  const describe = (row: OrderRow) => ({
    createdAt: "2026-09-01T00:00:00Z",
    family: row.family,
    hasPharmaExperience: null,
    rating: row.rating,
  });

  // An ACCOUNTANT is the bottom band there is and a MEDICAL REP is the top one. If a star can lift
  // the accountant over the rep, it outranks everything this module works out for itself — which is
  // exactly the claim, and a deliberate inversion: every other rank here is DERIVED from the record,
  // and a star is a person saying "this one".
  assert.deepEqual(
    orderForScreening(
      [
        { family: "medical_rep" as const, name: "unstarred rep", rating: null },
        { family: "finance" as const, name: "starred accountant", rating: 3 as const },
      ],
      describe,
    ).map((row) => row.name),
    ["starred accountant", "unstarred rep"],
    "a star outranks the band — a person who read the document beats a rule that read the columns",
  );

  assert.deepEqual(
    orderForScreening(
      [
        { family: "medical_rep" as const, name: "one", rating: 1 as const },
        { family: "medical_rep" as const, name: "three", rating: 3 as const },
        { family: "medical_rep" as const, name: "two", rating: 2 as const },
      ],
      describe,
    ).map((row) => row.name),
    ["three", "two", "one"],
    "the best rise to the top, which is the whole ask",
  );

  // ── 7 · AND IT MOVES NOBODY ELSE ──────────────────────────────
  //
  // The guard on the whole feature. `screeningSortKey` NEGATES the star so three stars is -3 and
  // leads; an unrated CV must score exactly 0 there, never a positive number, or every CV nobody has
  // starred — nearly the entire pool — would be pushed BELOW where it sat before the feature existed.
  const plain = { createdAt: "2026-09-01T00:00:00Z", family: "medical_rep" as const, hasPharmaExperience: null };
  const unratedKey = screeningSortKey(plain);
  assert.equal(unratedKey[0], 0, "an unstarred CV must sort exactly where it always did");
  assert.equal(
    screeningSortKey({ ...plain, rating: null })[0],
    0,
    "an explicit null is the same as no star at all",
  );
  assert.equal(
    screeningSortKey({ ...plain, rating: 3 })[0],
    -3,
    "and a star leads by being NEGATIVE, because this key sorts lowest-first",
  );
  assert.equal(unratedKey.length, 5, "five keys: star, band, pharma, experience, arrival");

  // A tie returns 0, so the queue's existing order survives it — see byRatingDescending's note.
  assert.equal(byRatingDescending(2, 2), 0, "two equal stars keep the order the queue already decided");
  assert.ok(byRatingDescending(3, 1) < 0, "higher first");
  assert.ok(byRatingDescending(null, 1) > 0, "and unrated last — not first");

  // ── 8 · A STAR IS NOT A DECISION, in the code that writes it ───────────────
  //
  // Read off the source rather than asserted behaviourally, because the thing being forbidden is an
  // absence: the service must not write a status, must not stamp a status event, and must not go
  // near the decision trail. A behavioural test can only prove what a function DID do.
  const service = read("src/lib/recruitment/candidates.ts");
  const setRating = service.slice(service.indexOf("export async function setCandidateRating"));
  const body = setRating.slice(0, setRating.indexOf("\n}\n") + 3);
  assert.ok(body.includes("ats_candidates"), "the star is written to the candidate row");
  assert.ok(
    !body.includes("ats_candidate_status_events"),
    "a star must NOT write a status event — that table is the decision trail, and a star in it would surface as a move in every throughput figure built on it",
  );
  assert.ok(!/\bstatus:/.test(body), "and it must not write a status either");
  assert.ok(
    body.includes("hrIdForStorage(access.hrId)"),
    "who starred it is stored through hrIdForStorage, never the raw session value — `status_changed_by_hr_id` already holds three spellings for two people from doing it the other way",
  );
  // The stamp describes the star, so it goes when the star goes. A cleared star that left last
  // month's `rated_by_hr_id` behind would say somebody rated a CV that now shows no rating.
  assert.ok(body.includes("rated_at: next === null ? null : ratedAt"), "clearing a star clears its timestamp");
  assert.ok(body.includes("rated_by_hr_id: next === null ? null : actorHrId"), "and clears who set it");

  // ── 9 · The route ─────────────────────────────────────────────────────────
  const routePath = "app/api/recruitment/candidates/[id]/rating/route.ts";
  assert.ok(existsSync(path.join(process.cwd(), routePath)), "the rating route exists");
  const route = read(routePath);
  assert.ok(route.includes("assertSameOriginMutation"), "a mutation route checks its origin");
  assert.ok(
    route.includes('requireRecruitmentAccess(request, "candidates", "update")'),
    "starring changes the shared record, so it takes the same grant a decision does — server-side, before the write",
  );
  assert.ok(route.includes("export async function PATCH"), "one field changes; the rest of the candidate is left alone");
  assert.ok(
    !/export async function (GET|POST|PUT|DELETE)/.test(route),
    "and nothing else is exposed on this path",
  );

  // ── 10 · The migration ─────────────────────────────────────────────────────
  //
  // Unlike the status vocabulary beside it, the ladder IS pinned in the database. A status is a
  // label whose string carries its own meaning; a rating is a POSITION, and what "2" means depends
  // entirely on where the top is. Widening 1–3 to 1–5 would silently restate every star already
  // given, so it should cost a migration and a decision about the existing rows.
  const migrations = readdirSync(path.join(process.cwd(), "supabase/migrations"));
  const ratingMigration = migrations.find((name) => name.includes("ats_candidate_rating"));
  assert.ok(ratingMigration, "the rating columns have a migration");
  const sql = read(`supabase/migrations/${ratingMigration}`);
  assert.match(sql, /add column if not exists rating smallint/i, "the star is a nullable column — null is unrated");
  assert.match(sql, /rating between 1 and 3/i, "and the ladder is pinned by a check constraint");
  assert.match(sql, /rated_by_hr_id/i, "with who set it");
  assert.match(sql, /rated_at/i, "and when");
  // No column is declared NOT NULL. Every CV already in the pool is unrated, and that is the
  // correct starting state — a default of 0 or 1 would have invented six hundred opinions nobody
  // held. (`is not null` in the index predicate below is a different thing and is allowed.)
  assert.ok(
    !/add column[^;]*?not null/is.test(sql),
    "nothing here is NOT NULL — every existing CV is unrated, and that is correct",
  );
  // A PARTIAL index, on the handful of rows that carry a star rather than on all six hundred. The
  // one query it serves is "show me the starred ones", and the unstarred rows can never answer it.
  assert.match(sql, /create index if not exists[\s\S]*?where rating is not null/i, "the star filter is indexed");

  // ── 11 · Both screens get the filter ──────────────────────────────────────
  //
  // The bar has TWO homes — the pool screen and the workstation — and a fix to one is half a fix.
  // That lesson is already written into screening-page-client.tsx's own comments, from the day the
  // filters were reported as "not working" in both places for the same reason.
  const bar = read("src/components/recruitment/screening-page-client.tsx");
  assert.ok(bar.includes("screeningRatingFilters.map"), "the pool screen's bar offers the star filter");
  assert.ok(bar.includes("rating !== null ||"), "and counts it as a narrowing, so Clear appears and the count says 'of'");
  const workstation = read("src/components/recruitment/workstation/workstation-page-client.tsx");
  assert.ok(workstation.includes("rating={shown.rating}"), "the workstation's bar draws the OPTIMISTIC value");
  assert.ok(workstation.includes("shown.rating,"), "and counts it among the active filters when the bar is folded");
  for (const page of [
    "app/(admin)/recruitment/screening/page.tsx",
    "app/employee-portals/recruitment/screening/page.tsx",
  ]) {
    assert.ok(
      read(page).includes("rating={workspace.rating}"),
      `${page} must echo the star filter back, or the select forgets what it was asked`,
    );
  }

  // ── 12 · An unstarred CV draws no stars ───────────────────────────────────
  //
  // Six hundred rows each carrying three empty outlines is six hundred pieces of furniture saying
  // the same nothing. A row with no stars is not "zero stars"; it is one nobody has had an opinion
  // about yet.
  const stars = read("src/components/recruitment/workstation/candidate-stars.tsx");
  assert.ok(
    /if \(rating === null\) return null;/.test(stars),
    "StarMark renders nothing at all for an unrated CV",
  );
  assert.ok(!/rounded/.test(stars), "square edges — the house rule, no exceptions");
}
