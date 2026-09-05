import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { CANDIDATE_CLAIM_LEASE_MINUTES } from "../src/lib/recruitment/candidate-views.ts";
import { matchesScreeningNarrowing } from "../src/lib/recruitment/screening-filter.ts";
import { parseScreeningFilters, screeningHref } from "../src/lib/recruitment/screening-link.ts";

/**
 * Two screeners on one queue: "somebody is reading this right now", and "nobody has read this".
 *
 * ── THE TWO FACTS THIS ADDS, AND WHY NEITHER IS THE ONE ALREADY THERE ────────────────────────
 *
 * The queue already knew two things: whether I have read a CV (`seen`) and whether somebody else
 * has (`alsoReadBy`). Both are permanent history. Neither can answer the collision that costs the
 * most — two people opening the same CV in the same minute, both reading it, one reading wasted —
 * because a view row is written 2.5 seconds after render and says only that somebody HAS read it.
 *
 * `claimed_until` is the third fact: somebody IS reading it. The column and its partial index have
 * existed since 20260905062000 and NOTHING in the application referenced them — measured
 * 2026-09-05, zero rows had ever been claimed, and the only mention of the column anywhere in the
 * repository was the migration that created it.
 *
 * `untouched` is the fourth: nobody has read it. That is NOT `unseen`, which since screening became
 * a two-person job includes every CV the other screener has already worked. On production 554 of
 * 781 candidates had never been opened by anyone, so the difference is most of the queue.
 */
export function runRecruitmentScreeningClaimTests() {
  // ── 1 · A LEASE, NOT A LOCK ─────────────────────────────────────────────────────────────────
  assert.ok(
    CANDIDATE_CLAIM_LEASE_MINUTES > 0 && CANDIDATE_CLAIM_LEASE_MINUTES <= 15,
    "the claim is a short lease. Long enough to cover one read, short enough that a closed laptop "
      + "cannot hold a CV away from the other screener - the column's own contract says it EXPIRES "
      + `rather than being released. Found ${CANDIDATE_CLAIM_LEASE_MINUTES} minutes`,
  );

  const views = readFileSync("src/lib/recruitment/candidate-views.ts", "utf8");
  assert.match(
    views,
    /CANDIDATE_CLAIM_LEASE_MINUTES \* 60_000/,
    "opening a CV must claim it, written on the SAME upsert as the view - two writes could half "
      + "succeed and leave a view with no claim, and this row must never disagree with itself",
  );

  // ── 1b · ONLY A SCREENER CLAIMS ────────────────────────────────────────────────────────────
  //
  // Found reviewing this change, not writing it. markCandidateSeen has THREE call sites, and two
  // of them are manager paths: recordManagerCvOpen and the hiring-manager file download behind it.
  // Claiming unconditionally meant a hiring manager previewing a CV already sent to them put
  // "Hany Saad has this open right now. Pick another CV." in front of a screener - advice that is
  // simply wrong, because a manager reading is not competing for screening work.
  assert.match(
    views,
    /claim\?: boolean;/,
    "claiming must be OPT-IN. 'somebody opened this' and 'somebody is screening this right now' are "
      + "different facts with different audiences",
  );
  assert.match(
    views,
    /\.\.\.\(input\.claim/,
    "and the column must be OMITTED when not claiming, never written as null - a manager opening a "
      + "CV must not WIPE a screener's live claim on the row they share",
  );
  const seenRoute = readFileSync("app/api/recruitment/candidates/[id]/seen/route.ts", "utf8");
  assert.match(
    seenRoute,
    /markCandidateSeen\(\{ candidateId: id, claim: true, viewerHrId: access\.hrId \}\)/,
    "the screening beacon is the one caller that claims - this is the collision the lease exists for",
  );
  for (const managerPath of ["src/lib/recruitment/manager-cv-engagement.ts", "src/lib/recruitment/hiring-manager-view.ts"]) {
    const text = readFileSync(managerPath, "utf8");
    const call = /markCandidateSeen\(\{[^}]*\}\)/.exec(text);
    if (!call) continue;
    assert.doesNotMatch(
      call[0],
      /claim:\s*true/,
      `${managerPath} must NOT claim - a manager reading a CV already sent to them is not screening it`,
    );
  }
  assert.match(
    views,
    /\.gt\("claimed_until", now\.toISOString\(\)\)/,
    "only LIVE claims may be read - an expired claim is not a claim, and reading them all would "
      + "report every CV anybody ever opened as being read right now",
  );

  // ── 2 · THE FOURTH STATE IS NOT THE THIRD ───────────────────────────────────────────────────
  const seenOnly = { asOf: Date.now(), seenByViewer: true, seenByAnyone: true };
  const readByOther = { asOf: Date.now(), seenByViewer: false, seenByAnyone: true };
  const nobody = { asOf: Date.now(), seenByViewer: false, seenByAnyone: false };
  const row = { createdAt: new Date().toISOString(), status: "new" } as never;

  const narrow = (seen: "any" | "seen" | "unseen" | "untouched") =>
    ({ area: undefined, notified: "any", received: null, region: null, role: null, seen, source: undefined, status: null }) as never;

  assert.equal(
    matchesScreeningNarrowing(row, narrow("unseen"), readByOther),
    true,
    "a CV the OTHER screener has read is still `unseen` to me - that is what the word means, and it "
      + "is why a two-person queue needs a fourth state",
  );
  assert.equal(
    matchesScreeningNarrowing(row, narrow("untouched"), readByOther),
    false,
    "but it is NOT untouched. If these two agreed, the new filter would be a synonym and 554 of 781 "
      + "candidates would be indistinguishable from the ones already worked",
  );
  assert.equal(matchesScreeningNarrowing(row, narrow("untouched"), nobody), true, "nobody has read it: untouched");
  assert.equal(matchesScreeningNarrowing(row, narrow("untouched"), seenOnly), false, "I read it: not untouched");

  // ── 3 · IT FAILS CLOSED ─────────────────────────────────────────────────────────────────────
  //
  // The one wrong answer that looks like a working filter.
  assert.equal(
    matchesScreeningNarrowing(row, narrow("untouched"), { asOf: Date.now(), seenByViewer: false }),
    false,
    "a caller that does not supply `seenByAnyone` must get NOTHING under this filter, never "
      + "everything. An empty list is a visible bug; a full one reads as '554 CVs nobody has "
      + "touched' and is believed",
  );

  // ── 4 · THE LINK ────────────────────────────────────────────────────────────────────────────
  assert.equal(parseScreeningFilters({ untouched: "1" }).seen, "untouched");
  assert.equal(
    parseScreeningFilters({ untouched: "1", unseen: "1" }).seen,
    "untouched",
    "narrowest wins, the same rule the sent/unsent pair follows - untouched is a SUBSET of unseen, "
      + "so testing it second would mean it could never win",
  );
  assert.equal(parseScreeningFilters({ unseen: "1" }).seen, "unseen", "the owner's bookmarked link is untouched by this");
  assert.equal(parseScreeningFilters({}).seen, "any");
  assert.match(screeningHref("/recruitment", { seen: "untouched" }), /untouched=1/);
  assert.doesNotMatch(
    screeningHref("/recruitment", { seen: "unseen" }),
    /untouched/,
    "and `unseen` must still emit exactly `?unseen=1` - that URL is in the owner's bookmarks",
  );

  // ── 5 · THE SCREEN SAYS IT, BY NAME ─────────────────────────────────────────────────────────
  const list = readFileSync("src/components/recruitment/workstation/workstation-candidate-list.tsx", "utf8");
  assert.match(list, /row\.beingReadBy \? \(/, "the list must show who has a CV open right now");
  assert.match(
    list,
    /\{row\.beingReadBy\} is reading/,
    "named, never an id - the owner's standing rule, and the reason the workspace resolves the "
      + "claim holder's name alongside the other viewers'",
  );
  assert.match(
    list,
    /<Pill tone="warn" title=\{`\$\{row\.beingReadBy\} has this open right now/,
    "warn, not info: this badge asks the reader to do something (pick another CV), where "
      + "`alsoReadBy` only reports history",
  );

  // The workspace must pass BOTH facts, or the filter silently answers the wrong question.
  const workspace = readFileSync("src/lib/recruitment/screening-workspace.ts", "utf8");
  assert.match(
    workspace,
    /seenByAnyone: Boolean\(views\[candidate\.id\]\) \|\| \(otherViewers\.get\(candidate\.id\)\?\.length \?\? 0\) > 0/,
    "both halves - my own map answers only for me, and on a two-person queue that is most of the "
      + "wrong answer",
  );
  assert.match(
    workspace,
    /listLiveClaimsByCandidate\(viewerHrId\)/,
    "and the live claims must actually be loaded, or beingReadBy is null on every row forever",
  );
}
