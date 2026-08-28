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

import { canonicalHrIdKey } from "@/lib/hr-id";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb } from "@/lib/recruitment/db";

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

/**
 * Everything this viewer has already opened, keyed by candidate id.
 *
 * Scoped to the viewer and NOT to a candidate list: the whole point is to answer "which of these
 * have I read" for a queue of several hundred in one round trip, and one person's view history is
 * bounded by how many CVs they have personally opened — 434 is the entire pool.
 */
export async function listCandidateViews(viewerHrId: string | null | undefined): Promise<CandidateViewMap> {
  const viewer = canonicalViewerHrId(viewerHrId);
  if (!viewer) return {};

  const { data, error } = await recruitmentDb()
    .from("ats_candidate_views")
    .select("candidate_id,first_seen_at,last_seen_at,view_count")
    .eq("viewer_hr_id", viewer);

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

  const views: CandidateViewMap = {};
  for (const row of rows) {
    const candidateId = row.candidate_id ? String(row.candidate_id) : null;
    if (!candidateId) continue;
    views[candidateId] = {
      firstSeenAt: String(row.first_seen_at ?? ""),
      lastSeenAt: String(row.last_seen_at ?? row.first_seen_at ?? ""),
      viewCount: Number(row.view_count ?? 1),
    };
  }
  return views;
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
