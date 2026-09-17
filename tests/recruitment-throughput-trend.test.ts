import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  THROUGHPUT_BUCKETS,
  THROUGHPUT_BUCKET_DAYS,
  buildThroughput,
  throughputDirection,
} from "../src/lib/recruitment/candidate-throughput.ts";

/**
 * The screening throughput trend — four weeks of "CVs in against CVs cleared".
 *
 * ── WHY THE COUNTING CHANGED ────────────────────────────────────────────────────────────────────
 *
 * The strip that shipped 2026-09-05 read the pool's own status stamps, which cost nothing extra and
 * was measured wrong in BOTH directions the next day against the real decision history:
 *
 *   * 93 "decided this week" against 71 candidates actually receiving a first decision — because a
 *     candidate decided three weeks ago and re-touched yesterday carried a fresh stamp.
 *   * 140 over thirty days against 216 real first decisions, a 54% UNDERCOUNT — because a
 *     re-decision moves a candidate's only stamp forward out of the older window, and a candidate
 *     filed to a shelf leaves the pool entirely.
 *
 * One week's figure absorbs that. A trend does not: somebody acts on a direction, and a direction
 * drawn from an artefact is worse than no direction at all.
 *
 * ── THE THREE THINGS THIS FILE EXISTS TO HOLD ───────────────────────────────────────────────────
 *
 *   1. A SPAN THE HISTORY DOES NOT COVER READS AS UNKNOWN, NEVER AS ZERO. Decisions have only been
 *      recorded since 2026-08-16. Printing "0 decided" for the week before that is a statement
 *      about the recruiter rather than about the table, and it is exactly how a missing record
 *      turns into an accusation.
 *   2. A DECISION IS A CANDIDATE, NOT AN EVENT. Measured the same day, the week of 08-24 carried
 *      461 events across 189 candidates — counting events would report two and a half times the
 *      real output, and every re-decision would read as fresh progress.
 *   3. ARRIVALS COME FROM EVERY CANDIDATE, NOT THE POOL. A CV filed to a shelf still arrived.
 *      Counting only the pool would shrink the "in" side whenever somebody tidied up, so the strip
 *      would report the backlog improving because work was HIDDEN rather than done.
 */
export function runRecruitmentThroughputTrendTests() {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

  const DAY = 24 * 60 * 60 * 1000;
  const WEEK = THROUGHPUT_BUCKET_DAYS * DAY;
  // A fixed instant, so every expectation below is arithmetic rather than a race with the clock.
  const NOW = Date.parse("2026-09-05T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  assert.equal(THROUGHPUT_BUCKETS, 4, "four buckets of seven days is the thirty-day view");
  assert.equal(THROUGHPUT_BUCKET_DAYS, 7, "a bucket is a week");

  // ── 1 · EACH INSTANT LANDS IN EXACTLY ONE BUCKET ──────────────────────────────────────────────

  const spread = buildThroughput({
    arrivals: [ago(1 * DAY), ago(3 * DAY), ago(9 * DAY), ago(16 * DAY), ago(24 * DAY), ago(40 * DAY)],
    firstDecisions: [ago(2 * DAY), ago(10 * DAY), ago(11 * DAY), ago(20 * DAY)],
    historyStartsAt: ago(60 * DAY),
    now: NOW,
    unread: 7,
  });

  assert.deepEqual(
    spread.buckets.map((bucket) => bucket.arrived),
    [2, 1, 1, 1],
    "arrivals fall into this week, last week, and the two before — the 40-day-old one falls outside",
  );
  assert.deepEqual(
    spread.buckets.map((bucket) => bucket.decided),
    [1, 2, 1, 0],
    "decisions bucket the same way, and a week with none genuinely reads 0 when the history covers it",
  );
  assert.equal(spread.arrived7, 2, "the seven-day figure matches bucket zero");
  assert.equal(spread.decided7, 1, "and so does the seven-day decision figure");
  assert.equal(spread.arrived30, 5, "thirty days is the four buckets, not everything ever");
  assert.equal(spread.decided30, 4, "all four decisions are inside thirty days");
  assert.equal(spread.unread, 7, "unread is passed through untouched — it is a question about the pool");

  // The boundary itself. Every span is half-open — [from, to) — so an instant landing exactly on a
  // boundary belongs to the NEWER bucket, and one millisecond older belongs to the older one. The
  // first draft of this assertion had it backwards and the run caught it; getting it wrong in the
  // code rather than the test would silently move a day's work between two weeks.
  const edge = buildThroughput({
    arrivals: [ago(WEEK), ago(WEEK + 1)],
    firstDecisions: [],
    historyStartsAt: ago(60 * DAY),
    now: NOW,
    unread: 0,
  });
  assert.equal(edge.buckets[0].arrived, 1, "an instant exactly seven days old is still this week — from is inclusive");
  assert.equal(edge.buckets[1].arrived, 1, "one millisecond older falls into last week");
  assert.equal(edge.arrived7, 1, "and the seven-day figure agrees with bucket zero");

  // ── 2 · AN UNCOVERED SPAN IS UNKNOWN, NOT ZERO ────────────────────────────────────────────────
  //
  // This is the assertion the module exists for. The history began partway through the reported
  // window, exactly as production stood on 2026-09-05.

  const partial = buildThroughput({
    arrivals: [ago(2 * DAY), ago(9 * DAY), ago(17 * DAY), ago(25 * DAY)],
    firstDecisions: [ago(2 * DAY), ago(9 * DAY)],
    // Recording began 20 days ago — so buckets 0 and 1 are covered, 2 and 3 are not.
    historyStartsAt: ago(20 * DAY),
    now: NOW,
    unread: 0,
  });

  assert.equal(partial.buckets[0].decided, 1, "a fully covered span reports its real count");
  assert.equal(partial.buckets[1].decided, 1, "so does the second");
  assert.strictEqual(
    partial.buckets[2].decided,
    null,
    "a span the history only PARTLY covers must read null — a real number there would mean something " +
      "narrower than its label, which is the whole failure being designed out",
  );
  assert.strictEqual(partial.buckets[3].decided, null, "and a span it does not reach at all reads null");
  assert.notStrictEqual(partial.buckets[3].decided, 0, "null, never zero — zero blames the recruiter");
  assert.strictEqual(
    partial.decided30,
    null,
    "the thirty-day decision figure is unreportable when the history starts inside it",
  );
  assert.equal(partial.arrived30, 4, "arrivals are unaffected — createdAt is complete for every candidate");
  assert.equal(partial.historyCoversEveryBucket, false, "and the strip is told so, so it can say why");

  assert.equal(spread.historyCoversEveryBucket, true, "a history older than the window covers all of it");

  // No history at all — a fresh database, or a missing table.
  const none = buildThroughput({
    arrivals: [ago(1 * DAY)],
    firstDecisions: [],
    historyStartsAt: null,
    now: NOW,
    unread: 0,
  });
  assert.strictEqual(none.decided7, null, "with no history, nothing decided can be reported");
  assert.equal(none.arrived7, 1, "but arrivals still can");
  assert.equal(none.historyCoversEveryBucket, false, "and the strip must say so");

  // ── 3 · RUBBISH IN THE DATA IS IGNORED, NOT COUNTED ───────────────────────────────────────────

  const dirty = buildThroughput({
    arrivals: [ago(1 * DAY), null, undefined, "", "not a date"],
    firstDecisions: [ago(1 * DAY), null, "nonsense"],
    historyStartsAt: ago(60 * DAY),
    now: NOW,
    unread: 0,
  });
  assert.equal(dirty.arrived7, 1, "an unparseable stamp is dropped, never counted as now");
  assert.equal(dirty.decided7, 1, "same on the decision side");

  // ── 4 · THE DIRECTION, WHICH IS THE POINT OF A TREND ──────────────────────────────────────────

  // 10 in / 8 decided this week (net +2) against 10 in / 2 decided last week (net +8): still losing,
  // but losing more slowly — which is the sentence the strip has to be able to say.
  const gaining = buildThroughput({
    arrivals: [...Array(10).fill(ago(1 * DAY)), ...Array(10).fill(ago(8 * DAY))],
    firstDecisions: [...Array(8).fill(ago(1 * DAY)), ...Array(2).fill(ago(8 * DAY))],
    historyStartsAt: ago(60 * DAY),
    now: NOW,
    unread: 0,
  });
  const gainingDirection = throughputDirection(gaining);
  assert.equal(gainingDirection.netThisWeek, 2, "this week's net is arrivals minus decisions");
  assert.equal(gainingDirection.netLastWeek, 8, "and last week's the same way");
  assert.equal(
    gainingDirection.improving,
    true,
    "a smaller net than last week is improving even while the backlog still grows — a strip that " +
      "only said 'the backlog grew' would report no progress on a week that halved the bleed",
  );

  const losing = throughputDirection(
    buildThroughput({
      arrivals: [...Array(10).fill(ago(1 * DAY)), ...Array(10).fill(ago(8 * DAY))],
      firstDecisions: [...Array(2).fill(ago(1 * DAY)), ...Array(8).fill(ago(8 * DAY))],
      historyStartsAt: ago(60 * DAY),
      now: NOW,
      unread: 0,
    }),
  );
  assert.equal(losing.improving, false, "a bigger net than last week is not improving");

  // And it stays SILENT rather than comparing against a week that was never recorded.
  const unknownLastWeek = throughputDirection(
    buildThroughput({
      arrivals: [ago(1 * DAY), ago(8 * DAY)],
      firstDecisions: [ago(1 * DAY)],
      historyStartsAt: ago(6 * DAY),
      now: NOW,
      unread: 0,
    }),
  );
  assert.strictEqual(
    unknownLastWeek.improving,
    null,
    "with last week unrecorded there is no comparison to make — 'better than last week' against a " +
      "week of nulls would be an invented improvement",
  );
  assert.strictEqual(unknownLastWeek.netLastWeek, null, "and its net is unknown, not zero");

  // ── 5 · WHAT THE LOADER FEEDS IT ──────────────────────────────────────────────────────────────

  const workspace = read("src/lib/recruitment/screening-workspace.ts");
  assert.match(
    workspace,
    /arrivals: allCandidates\.map\(\(candidate\) => candidate\.createdAt\)/,
    "arrivals must come from EVERY candidate, not the pool — a CV filed to a shelf still arrived, and " +
      "counting only the pool would make the backlog look better every time somebody tidied up",
  );
  assert.match(
    workspace,
    /firstDecisions: \[\.\.\.decisionHistory\.firstDecisionAt\.values\(\)\]/,
    "decisions come from the recorded history, not from the pool's own status stamps",
  );
  assert.match(
    workspace,
    /unread: reviewPool\.filter\(\(candidate\) => !views\[candidate\.id\]\)\.length/,
    "unread stays a question about the WHOLE review pool — it is the pile still in front of this " +
      "reader. `reviewPool` is that pile and is exactly what `pool` used to be; `pool` itself now " +
      "narrows to one vacant seat while a seat is being screened, and reading it here would make the " +
      "backlog appear to shrink because somebody pressed a seat on the rail. Renamed from " +
      "`shelfFree` on 2026-09-18, when an UNDECIDED filed CV came back into that pile: 371 of " +
      "them had left this page unread, so the backlog it reported was 252 against a true 624",
  );
  // The old method must be gone, not merely unused.
  assert.doesNotMatch(
    workspace,
    /withinSevenDays/,
    "the status-stamp method must be removed, not left beside the new one — two ways to count the " +
      "same thing is how the wrong one gets picked up again",
  );

  // ── 6 · AN UNDO IS NOT A DECISION ─────────────────────────────────────────────────────────────
  //
  // The revert path writes a status event like any other move. If a move BACK to `new` counted, one
  // press and its own undo would read as two CVs cleared from the backlog.
  const service = read("src/lib/recruitment/candidates.ts");
  assert.match(
    service,
    /if \(normalizeCandidateStatus\(row\.to_status\) === "new"\) continue;/,
    "a move back to `new` must never count as a decision — the undo writes exactly that row",
  );
  assert.match(
    service,
    /if \(!held \|\| at < held\) firstDecisionAt\.set\(candidateId, at\)/,
    "the FIRST decision is kept, not the latest — the latest is what the broken method counted",
  );

  // A BATCH IS NOT A DECISION, and this was MISSING when the trend first shipped.
  //
  // `ops:non-egyptian-reject-20260828` moved 65 candidates in one automated sweep. Counting them
  // made the week of 08-29 read 138 decisions against a true 73 — the strip told the owner his
  // backlog had SHRUNK BY 69 that week when it had held level at -4. An automated rejection of
  // scattergun international CVs was presented to him as a week of screening work.
  //
  // The trend exists so somebody acts on the direction. A number that counts a sweep as output is
  // worse than no number, because it rewards running another sweep.
  assert.match(
    service,
    /\.select\("candidate_id,created_at,to_status,actor_hr_id"\)/,
    "the decision history must READ the actor — without it the function cannot tell a sweep from a " +
      "week of work, and it did not read it for the first four hours this trend was live",
  );
  assert.match(
    service,
    /if \(isBatchActor\(row\.actor_hr_id\)\) continue;/,
    "and it must skip batch actors — the same rule the rejection notice uses, so the two can never " +
      "disagree about what counts as a person deciding something",
  );
  // Paged, and refusing rather than truncating: a silently short history understates real output.
  assert.match(
    service,
    /Refusing to report a partial history as a complete one/,
    "the history read must refuse a truncation rather than quietly returning less",
  );
  assert.match(
    service,
    /code === "42P01" \|\| code === "PGRST205"/,
    "a missing table answers PGRST205 here, not 42P01 — both must be treated as one absence",
  );
}
