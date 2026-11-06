// Recruitment / ATS — "have I read this CV before?"
//
// WHY THIS EXISTS. The candidate pool had exactly one mark a person could leave on a candidate:
// the status. Shortlist, reject, send to a manager — all of them decisions. Reading a CV and
// moving on without judging it wrote nothing at all, so the screening queue offered it again the
// next time, and the time after that. Measured in production on 2026-08-27, 370 of the 434
// candidates sat at status 'new' with no decision timestamp of any kind; the owner reported
// re-reading the same CVs every session and was simply right — nothing had ever recorded that he
// had looked.
//
// So "seen" is deliberately NOT a status. A CV that has been read but not judged is a real and
// common state — you looked, you were not ready to decide, and next time the queue should say so
// rather than presenting a stranger. Folding it into the status vocabulary would have meant a
// sixth code that every filter, counter and stat card had to learn, in exchange for losing the
// ability to say "seen AND still undecided", which is the state that actually matters.
//
// PER PERSON, not per candidate. Today one human screens here (53 of the 61 attributed decisions
// in production are the owner's), so "have I seen this" and "has anyone seen this" happen to have
// the same answer. That is exactly the kind of fact that stops being true without announcement:
// the moment Talent Acquisition screens alongside him, a single shared marker would show each of
// them the other's reading as their own, and the feature would be worse than nothing.

import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb } from "@/lib/recruitment/db";
import { fetchAllRows } from "@/lib/supabase/paginated";

/** One person's history with one candidate. */
export type CandidateView = {
  firstSeenAt: string;
  lastSeenAt: string;
  viewCount: number;
};

/** candidateId -> what this viewer has done with it. Absent key means never opened. */
export type CandidateViewMap = Record<string, CandidateView>;

/**
 * The one and only spelling of an HR_ID in this table: upper-case canonical.
 *
 * This is not house style. `ats_candidates` stores the owner's id as lower-case `b-10` while
 * `public.employees` stores `B-10`, and a join across the two silently returns nobody — that trap
 * cost a wrong answer about who had made 53 decisions during the very investigation that produced
 * this feature. A "seen" marker written in one case and read in another would report every CV as
 * unseen forever, which is precisely the bug this module exists to fix. Normalising at the single
 * storage boundary is what makes that impossible rather than merely unlikely; the table carries a
 * CHECK constraint saying the same thing, so a write in the wrong case fails loudly.
 */
export function canonicalViewerHrId(value: string | null | undefined): string | null {
  return canonicalHrIdKey(value)?.toUpperCase() ?? null;
}

/**
 * True when the error is "that table/column does not exist yet".
 *
 * The code reaches production on a merge to `main`; the migration is a separate, announced step
 * that happens afterwards. There is therefore a real window — minutes or hours — in which this
 * module runs against a database that has never heard of `ats_candidate_views`. In that window the
 * screening queue must degrade to "nothing is marked seen", which is exactly how it behaved
 * yesterday, rather than throwing and taking the whole page down.
 */
function isMissingRelation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // 42P01 undefined_table, 42703 undefined_column.
  return code === "42P01" || code === "42703";
}

/** PostgREST serves at most this many rows for one request, so a whole-history read must page. */
const VIEW_PAGE_SIZE = 1000;

/** A runaway guard, not a data cap: 50 pages is 50,000 CVs read by ONE person. */
const VIEW_PAGE_LIMIT = 50;

/**
 * Everything this viewer has already opened, keyed by candidate id.
 *
 * Scoped to the viewer and NOT to a candidate list: the whole point is to answer "which of these
 * have I read" for a queue of several hundred without a round trip per row.
 *
 * PAGED, and the page loop is the whole reason this comment changed. It used to read the history in
 * one unbounded `.select()`, on the argument that a viewer's history is bounded by the pool — which
 * was true at 434 candidates and is the kind of fact that stops being true without announcement.
 * The pool passed 700 on 2026-09-03 and takes roughly 90 CVs a day, so an unbounded read here was
 * weeks from meeting PostgREST's silent 1000-row cap.
 *
 * What that would have looked like is why the paging is worth its cost: no error and no truncation
 * marker, just the oldest CVs this person has already read coming back as unread. The queue would
 * have offered them again, `?unseen=1` — the bookmarked link — would have filled up with CVs the
 * owner had read weeks earlier, and the symptom is EXACTLY the complaint this module was written to
 * end. Past the guard it THROWS rather than returning a short map, because reporting read CVs as
 * unread is the precise failure the paging exists to remove.
 */
export async function listCandidateViews(viewerHrId: string | null | undefined): Promise<CandidateViewMap> {
  const viewer = canonicalViewerHrId(viewerHrId);
  if (!viewer) return {};

  const supabase = recruitmentDb();
  const views: CandidateViewMap = {};

  for (let page = 0; page < VIEW_PAGE_LIMIT; page += 1) {
    const from = page * VIEW_PAGE_SIZE;
    const { data, error } = await supabase
      .from("ats_candidate_views")
      .select("candidate_id,first_seen_at,last_seen_at,view_count")
      .eq("viewer_hr_id", viewer)
      // An explicit, unique order. `.range()` without one is served in whatever order the planner
      // chose for THAT request, so page two can legitimately repeat page one's rows and omit
      // others — paging over an unordered read loses rows without erroring, which is the same
      // silent shape as the cap this loop exists to defeat.
      .order("candidate_id", { ascending: true })
      .range(from, from + VIEW_PAGE_SIZE - 1);

    if (error) {
      if (isMissingRelation(error)) return {};
      throw error;
    }

    const rows = (data ?? []) as Array<{
      candidate_id?: string | null;
      first_seen_at?: string | null;
      last_seen_at?: string | null;
      view_count?: number | null;
    }>;

    for (const row of rows) {
      const candidateId = row.candidate_id ? String(row.candidate_id) : null;
      if (!candidateId) continue;
      views[candidateId] = {
        firstSeenAt: String(row.first_seen_at ?? ""),
        lastSeenAt: String(row.last_seen_at ?? row.first_seen_at ?? ""),
        viewCount: Number(row.view_count ?? 1),
      };
    }

    // A short page is the last page. At an exact multiple of the page size this costs one extra
    // empty request — the price of never guessing where the data ends.
    if (rows.length < VIEW_PAGE_SIZE) return views;
  }

  throw new Error(
    `Candidate view paging stopped at ${VIEW_PAGE_LIMIT * VIEW_PAGE_SIZE} rows for one viewer. Refusing to report read CVs as unread.`,
  );
}

/** One person's reading of one CV, as the candidate's own page lists it. */
export type CandidateViewer = CandidateView & { viewerHrId: string };

/**
 * Everybody who has opened ONE CV, most recent reader first — the candidate page's "Opened by".
 *
 * The same rows as the two readers around it, asked the third way: by candidate. One candidate has
 * one row per person who ever opened them, a handful at most, so this is a single read with no
 * paging. A missing table answers "nobody", exactly as the queue behaves before the migration.
 */
export async function listViewersOfCandidate(candidateId: string): Promise<CandidateViewer[]> {
  const { data, error } = await recruitmentDb()
    .from("ats_candidate_views")
    .select("viewer_hr_id,first_seen_at,last_seen_at,view_count")
    .eq("candidate_id", candidateId)
    .order("last_seen_at", { ascending: false });

  if (error) {
    if (isMissingRelation(error)) return [];
    throw error;
  }

  const rows = (data ?? []) as Array<{
    viewer_hr_id?: string | null;
    first_seen_at?: string | null;
    last_seen_at?: string | null;
    view_count?: number | null;
  }>;

  const viewers: CandidateViewer[] = [];
  for (const row of rows) {
    const viewerHrId = row.viewer_hr_id ? String(row.viewer_hr_id) : null;
    if (!viewerHrId) continue;
    viewers.push({
      firstSeenAt: String(row.first_seen_at ?? ""),
      lastSeenAt: String(row.last_seen_at ?? row.first_seen_at ?? ""),
      viewCount: Number(row.view_count ?? 1),
      viewerHrId,
    });
  }
  return viewers;
}

/**
 * Who ELSE has opened each of these CVs — the other half of "have I read this".
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 *
 * `listCandidateViews` is deliberately per-person, and its header explains why: the moment a second
 * person screens alongside the owner, a single shared marker would show each of them the other's
 * reading as their own. That reasoning holds and is untouched.
 *
 * But it left the opposite question unanswerable. Measured 2026-09-05: B-10 had opened 200 of the
 * 249 recorded views and made 127 of the 133 decisions, and the owner's answer to "is screening
 * yours alone?" was that he and HR-010 share it. Two people working one queue with no way to see
 * each other's reading do the same CVs twice, and neither can tell which ones.
 *
 * So this reports the OTHER viewers, never merged into the caller's own map. "I have read this" and
 * "somebody has read this" stay two separate facts on the row, because they mean different things:
 * the first decides whether it is offered again, the second only says the work may already be done.
 *
 * SAFE TO COMPARE ACROSS PEOPLE. `viewer_hr_id` is canonical upper-case here by construction —
 * canonicalViewerHrId on every write, plus a CHECK constraint — so this is the one HR_ID column in
 * the module a plain equality may be trusted on. `employees.hr_id` is NOT: 178 of 179 rows in
 * production are mixed case, which is why the name lookup below goes through hrIdLookupKeys.
 *
 * Paged for the same reason listCandidateViews is: PostgREST caps a request at 1000 rows and says
 * nothing, and this reads EVERY viewer's history rather than one person's, so it meets that ceiling
 * sooner than the per-person read does.
 */
export async function listOtherViewersByCandidate(
  viewerHrId: string | null | undefined,
): Promise<Map<string, string[]>> {
  const me = canonicalViewerHrId(viewerHrId);
  const byCandidate = new Map<string, string[]>();
  const supabase = recruitmentDb();

  for (let page = 0; page < VIEW_PAGE_LIMIT; page += 1) {
    const from = page * VIEW_PAGE_SIZE;
    const { data, error } = await supabase
      .from("ats_candidate_views")
      .select("candidate_id,viewer_hr_id")
      // Stable and unique, so paging cannot repeat one row and drop another.
      .order("candidate_id", { ascending: true })
      .order("viewer_hr_id", { ascending: true })
      .range(from, from + VIEW_PAGE_SIZE - 1);

    if (error) {
      // A missing table degrades to "nobody else has read anything", which is exactly how this
      // screen behaved before the column existed.
      if (isMissingRelation(error)) return byCandidate;
      throw error;
    }

    const rows = (data ?? []) as Array<{ candidate_id?: string | null; viewer_hr_id?: string | null }>;
    for (const row of rows) {
      const candidateId = row.candidate_id ? String(row.candidate_id) : null;
      const viewer = row.viewer_hr_id ? String(row.viewer_hr_id) : null;
      if (!candidateId || !viewer) continue;
      // The CALLER is never in their own "also read by" list — that is what their own map is for.
      if (me && viewer === me) continue;
      const list = byCandidate.get(candidateId);
      if (list) list.push(viewer);
      else byCandidate.set(candidateId, [viewer]);
    }

    if (rows.length < VIEW_PAGE_SIZE) return byCandidate;
  }

  throw new Error(
    `Candidate view paging stopped at ${VIEW_PAGE_LIMIT * VIEW_PAGE_SIZE} rows. Refusing to report a read CV as unread by everyone.`,
  );
}

/**
 * Names for a handful of viewer HR ids, so a row can say "Also read by Omar" rather than "B-10".
 *
 * The owner's standing rule is that a screen shows human-readable names, never raw codes. The set
 * is tiny by construction — the people who screen, not the people in the pool — so this is a single
 * targeted read rather than a roster load.
 *
 * `hrIdLookupKeys` on the way in, NOT a plain `.eq`: the views table stores canonical upper case
 * while `employees.hr_id` is whatever was typed, and 178 of 179 production rows are mixed case. A
 * plain match here would return nobody and every row would silently fall back to the id — the exact
 * failure the module has already had twice.
 *
 * A viewer with no employee row keeps their id. That is a recorded fact, not a failure: it is what
 * a dev-auth session or a retired seat looks like, and inventing a name for it would be worse.
 */
/**
 * How long "somebody is reading this right now" stands for.
 *
 * A LEASE, not a lock. The column's own comment sets the contract: it EXPIRES rather than being
 * released, because the failure that matters is a screener closing a laptop mid-CV, and a claim
 * that outlives the person holding it takes the queue away from everybody else.
 *
 * Five minutes is the read, not the session. `markCandidateSeen` fires once, 2.5 seconds after the
 * document renders, so the claim is set once and is not refreshed while somebody reads on. Erring
 * SHORT is the safe direction: an expired claim on a CV still being read costs one duplicated
 * read, which is what this feature already tolerates by being advisory. An over-long claim would
 * hide a CV from the other screener for no reason, which is the failure it exists to prevent.
 */
export const CANDIDATE_CLAIM_LEASE_MINUTES = 5;

/** Somebody else has this CV open right now. */
export type CandidateClaim = {
  viewerHrId: string;
  claimedUntil: string;
};

/**
 * Who is reading each of these candidates RIGHT NOW, excluding the caller.
 *
 * Live claims only: the filter is on `claimed_until > now`, which is also the partial index's
 * predicate, so this reads "CVs open right now" rather than the whole view history.
 *
 * The caller is excluded for the same reason they are excluded from "also read by" — a screener
 * does not need telling that they themselves have the CV open, and showing it would make every
 * candidate they touch look contested.
 */
export async function listLiveClaimsByCandidate(
  viewerHrId: string | null | undefined,
  now: Date = new Date(),
): Promise<Map<string, CandidateClaim>> {
  const me = canonicalViewerHrId(viewerHrId);
  const claims = new Map<string, CandidateClaim>();
  const supabase = recruitmentDb();

  // Paged to the end: a fixed row ceiling would drop the freshest claims past it without a sound.
  type ClaimRow = { candidate_id?: string | null; viewer_hr_id?: string | null; claimed_until?: string | null };
  let data: ClaimRow[];
  try {
    data = await fetchAllRows<ClaimRow>(
      () =>
        supabase
          .from("ats_candidate_views")
          .select("candidate_id,viewer_hr_id,claimed_until")
          .gt("claimed_until", now.toISOString())
          .order("claimed_until", { ascending: false })
          .order("candidate_id", { ascending: true }),
      "viewer_hr_id",
    );
  } catch (error) {
    // A missing table OR a missing column degrades to "nobody is reading anything", which is
    // exactly how the screen behaved before this shipped. The code reaches production on a merge
    // and the migration is a separate step, so that window is real.
    if (isMissingRelation(error)) return claims;
    throw error;
  }

  for (const row of data) {
    const candidateId = row.candidate_id ? String(row.candidate_id) : null;
    const viewer = row.viewer_hr_id ? String(row.viewer_hr_id) : null;
    const until = row.claimed_until ? String(row.claimed_until) : null;
    if (!candidateId || !viewer || !until) continue;
    if (me && viewer === me) continue;
    // Ordered newest-first, so the first claim seen for a candidate is the freshest one.
    if (!claims.has(candidateId)) claims.set(candidateId, { claimedUntil: until, viewerHrId: viewer });
  }

  return claims;
}

export async function resolveViewerNames(viewerHrIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = Array.from(new Set(viewerHrIds.map((id) => canonicalViewerHrId(id)).filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return names;

  const keys = Array.from(new Set(ids.flatMap((id) => hrIdLookupKeys(id))));
  if (keys.length === 0) return names;

  const { data, error } = await recruitmentDb().from("employees").select("hr_id,full_name").in("hr_id", keys);
  if (error) {
    if (isMissingRelation(error)) return names;
    throw error;
  }

  for (const row of (data ?? []) as Array<{ hr_id?: string | null; full_name?: string | null }>) {
    const key = canonicalViewerHrId(String(row.hr_id ?? ""));
    const name = String(row.full_name ?? "").trim();
    if (key && name) names.set(key, name);
  }
  return names;
}

/**
 * Record that this person has now read this CV.
 *
 * Read-then-write rather than a single atomic increment, and that is a considered trade. PostgREST
 * cannot express `view_count = view_count + 1` without an RPC, and adding a database function for
 * a counter that exists to tell one tired human "you saw this on Tuesday" is not worth the
 * migration surface. The only cost of losing a race is a view_count that undercounts by one, on a
 * table where the count is advisory and the timestamps — which do not race — carry the meaning.
 *
 * Returns the stored view so the caller can show "seen 3 times" without a second query.
 */
export async function markCandidateSeen(input: {
  /**
   * Also claim the CV — "I am reading this right now" — for CANDIDATE_CLAIM_LEASE_MINUTES.
   *
   * OPT-IN, and defaulting to false, because "somebody opened this" and "somebody is screening this
   * right now" are different facts with different audiences. Three call sites reach this function:
   * the screening beacon, and TWO manager paths (recordManagerCvOpen, and the hiring-manager file
   * download behind it). A hiring manager previewing a CV that was already sent to them is not
   * competing for screening work, so claiming on their behalf would put "pick another CV" in front
   * of a screener about somebody who is not screening.
   *
   * Default false is the safe direction: a caller that has not thought about it does not claim, and
   * the queue simply behaves as it did before.
   */
  claim?: boolean;
  candidateId: string;
  viewerHrId: string | null | undefined;
  /** Injectable so a test can assert the timestamps without racing the clock. */
  now?: Date;
}): Promise<CandidateView | null> {
  const viewer = canonicalViewerHrId(input.viewerHrId);
  const candidateId = String(input.candidateId ?? "").trim();
  if (!viewer || !candidateId) return null;

  const seenAt = (input.now ?? new Date()).toISOString();
  const supabase = recruitmentDb();

  const { data: existingRow, error: readError } = await supabase
    .from("ats_candidate_views")
    .select("first_seen_at,view_count")
    .eq("candidate_id", candidateId)
    .eq("viewer_hr_id", viewer)
    .maybeSingle();

  if (readError && !isMissingRelation(readError)) throw readError;
  if (readError) return null;

  const existing = existingRow as { first_seen_at?: string | null; view_count?: number | null } | null;
  // The FIRST time is never rewritten. "You first read this three weeks ago and have opened it
  // four times since" is a different and more useful sentence than "you read this a minute ago",
  // which is all a single last_seen_at column could ever say.
  const firstSeenAt = existing?.first_seen_at ? String(existing.first_seen_at) : seenAt;
  const viewCount = existing ? Number(existing.view_count ?? 1) + 1 : 1;

  const { error: writeError } = await supabase.from("ats_candidate_views").upsert(
    {
      candidate_id: candidateId,
      first_seen_at: firstSeenAt,
      last_seen_at: seenAt,
      view_count: viewCount,
      viewer_hr_id: viewer,
      // Claiming is opt-in; see `claim` above. Written on the SAME upsert rather than as a second
      // call: two writes could half-succeed and leave a view with no claim or a claim with no view,
      // and the one thing this row must never do is disagree with itself about who was here.
      //
      // `undefined` rather than null when not claiming, so a manager opening a CV does not WIPE a
      // screener's live claim on it. The two facts share a row; only one of them is being written.
      ...(input.claim
        ? {
            claimed_until: new Date(
              (input.now ?? new Date()).getTime() + CANDIDATE_CLAIM_LEASE_MINUTES * 60_000,
            ).toISOString(),
          }
        : {}),
    },
    { onConflict: "candidate_id,viewer_hr_id" },
  );

  if (writeError) {
    if (isMissingRelation(writeError)) return null;
    throw writeError;
  }

  return { firstSeenAt, lastSeenAt: seenAt, viewCount };
}

/**
 * Which of these candidates this viewer has NOT opened, in the order they were given.
 *
 * The queue's actual question. Kept here rather than in the component so the page, the pool filter
 * and the "skip to the first unseen" jump all answer it the same way — a screen that disagrees
 * with the button about what counts as unseen is worse than having neither.
 */
export function unseenCandidateIds(
  candidateIds: readonly string[],
  views: CandidateViewMap,
): string[] {
  return candidateIds.filter((id) => !views[id]);
}

/**
 * Drop view rows for candidates that no longer exist.
 *
 * Not wired to anything today — `on delete cascade` handles the normal path. It exists for the
 * bulk-delete case, where rows are removed with raw SQL that bypasses the ORM entirely.
 */
export async function pruneViewsForDeletedCandidates(candidateIds: readonly string[]): Promise<number> {
  if (candidateIds.length === 0) return 0;
  const supabase = recruitmentDb();
  let removed = 0;
  for (const batch of chunkIds([...candidateIds])) {
    const { data, error } = await supabase
      .from("ats_candidate_views")
      .delete()
      .in("candidate_id", batch)
      .select("candidate_id");
    if (error) {
      if (isMissingRelation(error)) return removed;
      throw error;
    }
    removed += (data ?? []).length;
  }
  return removed;
}
