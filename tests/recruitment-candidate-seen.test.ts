import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { canonicalViewerHrId, unseenCandidateIds } from "../src/lib/recruitment/candidate-views.ts";
import type { CandidateViewMap } from "../src/lib/recruitment/candidate-views.ts";

/**
 * "Every time I open this page I go from the very beginning and see all the CVs again."
 *
 * The owner's report, 2026-08-27. His DECISIONS had in fact survived — 31 shortlisted, 12 rejected
 * and 21 sent were all still in the database, made the day before — but nothing had ever recorded
 * that a CV had been LOOKED AT. Measured that day: 370 of 434 candidates sat at status 'new' with
 * `status_changed_at` NULL, so the queue offered the same strangers every session and there was no
 * way to skip to the ones he had never opened.
 *
 * "Seen" is deliberately not a sixth status. Read-but-undecided is a real state, and folding it
 * into the status vocabulary would have cost every filter, counter and stat card a new code in
 * exchange for losing the one sentence that matters: "seen, and still undecided".
 *
 * The traps this file pins:
 *
 *   1. HR_ID CASE. `ats_candidates` stores `b-10`, `employees` stores `B-10`, and PostgREST `eq` is
 *      case-sensitive. A marker written in one case and read in the other reports every CV as
 *      unseen forever — which is precisely the bug the feature exists to fix.
 *   2. FIRST SEEN IS NEVER REWRITTEN. "You first read this three weeks ago and have opened it four
 *      times since" is a different and far more useful sentence than "you read this a minute ago".
 *   3. THE MIGRATION LANDS AFTER THE CODE. There is a real window in which this runs against a
 *      database that has never heard of `ats_candidate_views`, and in that window the queue must
 *      behave exactly as it did yesterday rather than taking the page down.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

export async function runRecruitmentCandidateSeenTests() {
  // ── 1 · One spelling of an HR_ID, at the single storage boundary ──────────
  assert.equal(canonicalViewerHrId("b-10"), "B-10", "a lower-case id is stored upper-case");
  assert.equal(canonicalViewerHrId("B-10"), "B-10", "an already upper-case id is unchanged");
  assert.equal(canonicalViewerHrId("  b-10  "), "B-10", "surrounding space is not part of an id");
  assert.equal(canonicalViewerHrId(""), null, "an empty id is nobody");
  assert.equal(canonicalViewerHrId(null), null, "a null id is nobody");
  assert.equal(canonicalViewerHrId(undefined), null, "an absent id is nobody");
  assert.equal(
    canonicalViewerHrId("b-10"),
    canonicalViewerHrId("B-10"),
    "the two cases production actually stores must resolve to one viewer",
  );

  // ── 2 · Which of these have I not read ────────────────────────────────────
  const views: CandidateViewMap = {
    "candidate-1": { firstSeenAt: "2026-08-20T10:00:00.000Z", lastSeenAt: "2026-08-26T10:00:00.000Z", viewCount: 4 },
    "candidate-3": { firstSeenAt: "2026-08-26T10:00:00.000Z", lastSeenAt: "2026-08-26T10:00:00.000Z", viewCount: 1 },
  };
  assert.deepEqual(
    unseenCandidateIds(["candidate-1", "candidate-2", "candidate-3", "candidate-4"], views),
    ["candidate-2", "candidate-4"],
    "unseen is everything with no view row, in the order given",
  );
  // Order is the queue's order, not the map's — the jump button lands on the next one DOWN the
  // list, and re-sorting here would send the screener backwards.
  assert.deepEqual(
    unseenCandidateIds(["candidate-4", "candidate-1", "candidate-2"], views),
    ["candidate-4", "candidate-2"],
    "the caller's order is preserved",
  );
  assert.deepEqual(unseenCandidateIds([], views), [], "an empty queue has nothing unseen");
  assert.deepEqual(
    unseenCandidateIds(["candidate-1", "candidate-3"], views),
    [],
    "a fully-read queue reports nothing unseen rather than everything",
  );
  assert.deepEqual(
    unseenCandidateIds(["candidate-1"], {}),
    ["candidate-1"],
    "no view history at all means nothing has been seen — the state on the day the migration lands",
  );

  // ── 3 · The service's own guarantees, pinned at the source ────────────────
  const viewsSource = read("src/lib/recruitment/candidate-views.ts");

  // The first-seen timestamp is carried FORWARD from the existing row, never replaced by `seenAt`.
  assert.match(
    viewsSource,
    /const firstSeenAt = existing\?\.first_seen_at \? String\(existing\.first_seen_at\) : seenAt;/,
    "first_seen_at must be carried forward from the existing row, never overwritten",
  );
  assert.match(
    viewsSource,
    /view_count \?\? 1\) \+ 1/,
    "a repeat read must increment the count rather than reset it",
  );
  assert.match(
    viewsSource,
    /onConflict: "candidate_id,viewer_hr_id"/,
    "the upsert must conflict on the composite key, or a second read inserts a duplicate",
  );
  // Every read and write of the table goes through the canonical spelling. If any path used the raw
  // value, the case trap in section 1 would be live again.
  assert.match(viewsSource, /const viewer = canonicalViewerHrId\(viewerHrId\);/, "reads canonicalise the viewer");
  assert.match(viewsSource, /const viewer = canonicalViewerHrId\(input\.viewerHrId\);/, "writes canonicalise the viewer");
  assert.doesNotMatch(
    viewsSource,
    /\.eq\("viewer_hr_id", viewerHrId\)/,
    "the raw viewer id must never reach a query — that is the case trap",
  );

  // Degrade, do not throw, while the migration is still on its way.
  assert.match(
    viewsSource,
    /code === "42P01" \|\| code === "42703"/,
    "undefined_table and undefined_column are the two codes the pre-migration window produces",
  );
  assert.match(
    viewsSource,
    /if \(isMissingRelation\(error\)\) return \{\};/,
    "a missing table must read as an empty view map, not an exception on the screening page",
  );

  // ── 4 · The route records the CALLER, and is same-origin gated ────────────
  const routeSource = read("app/api/recruitment/candidates/[id]/seen/route.ts");
  // `/api/recruitment/candidates/**` is declared csrfRequired in the access registry, and that
  // declaration is satisfied by this call and nothing else — a registry test greps for it.
  assert.match(routeSource, /assertSameOriginMutation\(request\)/, "a mutation route must be same-origin gated");
  assert.match(
    routeSource,
    /requireRecruitmentAccess\(request, "candidates", "read"\)/,
    "recording that you read a CV is a read grant, not an update — read-only reviewers need it most",
  );
  assert.match(
    routeSource,
    /viewerHrId: access\.hrId/,
    "the viewer comes from the session, never from the request body",
  );
  assert.doesNotMatch(
    routeSource,
    /viewerHrId: (body|payload|json)/,
    "a viewer id accepted from a body would let one person mark another's queue as read",
  );
  // Neither "this session has no HR_ID" nor "the migration has not landed" is an error a screener
  // can act on, so neither may colour a CV red mid-queue.
  assert.match(
    routeSource,
    /recorded: Boolean\(view\), success: true/,
    "nothing recorded must still report success",
  );

  // ── 5 · The queue actually asks, and can jump ─────────────────────────────
  const sessionSource = read("src/components/recruitment/candidate-screening-session.tsx");
  assert.match(sessionSource, /Seen before/, "a CV already read must say so on screen");
  assert.match(sessionSource, /First time/, "a CV never read must say so on screen");
  assert.match(
    sessionSource,
    /jumpToNextFresh/,
    "there must be a way to skip everything already read — the owner asked for exactly this",
  );
  // Marking happens on a dwell timer, not on arrival: flicking past a CV with the arrow key is not
  // reading it, and marking on mount would burn through the whole queue in one held keypress.
  assert.match(sessionSource, /SEEN_DWELL_MS/, "seen must be recorded after a dwell, not on mount");

  // ── 6 · The link that opens on the unread pile ────────────────────────────
  const queueSource = read("src/lib/recruitment/screening-queue.ts");
  assert.match(
    queueSource,
    /candidates\.filter\(\(candidate\) => !views\[candidate\.id\]\)/,
    "?unseen=1 must narrow to what this viewer has never opened",
  );
  // The view map is loaded for the CALLER. A viewer id in a query string would let one person open
  // a link that reports somebody else's reading as their own.
  assert.doesNotMatch(
    queueSource,
    /filters\.(viewer|viewerHrId|hrId)/,
    "the viewer must never be taken from the URL",
  );

  const migration = read("supabase/migrations/20260827213000_candidate_seen_tracking_and_manager_context.sql");
  assert.match(
    migration,
    /viewer_hr_id = upper\(viewer_hr_id\)/,
    "the database itself must refuse a marker written in the wrong case",
  );
  assert.match(
    migration,
    /primary key \(candidate_id, viewer_hr_id\)/,
    "one row per person per candidate — a shared marker would show one screener another's reading",
  );
  assert.match(
    migration,
    /on delete cascade/,
    "deleting a candidate must take its view rows with it",
  );
  assert.match(migration, /enable row level security/, "a new table must not ship without RLS enabled");
}
