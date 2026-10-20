// Recruitment workspace — the daily auto-archive of old rejections.
//
// THE RULE (owner's plan, Phase 4, 20 Oct 2026): a CV rejected more than ARCHIVE_REJECTED_AFTER_DAYS
// (30) ago leaves the working lists by itself, measured from when it was rejected (`status_changed_at`),
// never from when it arrived — a CV that sat a month before anyone read it is not "old" on the day it
// is rejected.
//
// ARCHIVED, NEVER DELETED. `archived_at` only takes the row out of the default views; the "Archived"
// filter brings it back, and Unarchive (the workspace's own route) clears it. Nothing here removes a
// row, a file or a history line, and no message of any kind goes to the candidate.
//
// A MANAGER'S RETURN IS NOT AN OLD REJECTION. A manager's Skip moves the CV to rejected, and while it
// is waiting in the Returned filter (`ats_v_candidate_returns`) somebody in HR still has to look at
// it — so it is left where it is however old, and archives on a later run once HR has acted on it.
//
// The write re-checks status and `archived_at` in its own WHERE, so a candidate HR re-opened between
// the read and the write is not archived from under them. Stamped `archived_by = system:auto-archive`
// so the row says who did it.
//
// The selection is PURE (`rejectionsToArchive`) so `tests/recruitment-auto-archive` pins it.

import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb } from "@/lib/recruitment/db";
import { ARCHIVE_REJECTED_AFTER_DAYS } from "@/lib/recruitment/workspace/vocabulary";

export const AUTO_ARCHIVE_ACTOR = "system:auto-archive";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 1000;

export type ArchiveCandidateRow = {
  id: string;
  status: string | null;
  archived_at: string | null;
  status_changed_at: string | null;
};

/** The instant before which a rejection is old enough to archive. */
export function archiveCutoff(now: Date, days: number = ARCHIVE_REJECTED_AFTER_DAYS): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * The ids to archive. PURE. Rejected, not yet archived, rejected strictly before the cutoff, and not
 * waiting in the Returned filter. A row with no rejection time is never guessed old.
 */
export function rejectionsToArchive(
  rows: readonly ArchiveCandidateRow[],
  returnedIds: ReadonlySet<string>,
  now: Date,
  days: number = ARCHIVE_REJECTED_AFTER_DAYS,
): string[] {
  const cutoff = archiveCutoff(now, days).getTime();
  return rows
    .filter((row) => {
      if (row.status !== "rejected" || row.archived_at) return false;
      const changed = row.status_changed_at ? Date.parse(row.status_changed_at) : Number.NaN;
      if (!Number.isFinite(changed) || changed >= cutoff) return false;
      return !returnedIds.has(row.id);
    })
    .map((row) => row.id);
}

export type AutoArchiveResult = {
  dryRun: boolean;
  /** Rejections older than the cutoff that are not yet archived. */
  eligible: number;
  /** Of those, left alone because a manager's return is still waiting on HR. */
  heldAsReturned: number;
  archived: number;
  cutoff: string;
};

/** Archive every rejection older than the cutoff. `dryRun` reads and counts, and writes nothing. */
export async function archiveOldRejections(options: { dryRun?: boolean; now?: Date } = {}): Promise<AutoArchiveResult> {
  const now = options.now ?? new Date();
  const cutoff = archiveCutoff(now);
  const supabase = recruitmentDb();

  const rows: ArchiveCandidateRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("ats_candidates")
      .select("id,status,archived_at,status_changed_at")
      .eq("status", "rejected")
      .is("archived_at", null)
      .lt("status_changed_at", cutoff.toISOString())
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as ArchiveCandidateRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  const returned = new Set<string>();
  for (const batch of chunkIds(rows.map((row) => row.id))) {
    const { data, error } = await supabase.from("ats_v_candidate_returns").select("candidate_id").in("candidate_id", batch);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ candidate_id: string | null }>) {
      if (row.candidate_id) returned.add(String(row.candidate_id));
    }
  }

  const ids = rejectionsToArchive(rows, returned, now);
  const result: AutoArchiveResult = {
    archived: 0,
    cutoff: cutoff.toISOString(),
    dryRun: Boolean(options.dryRun),
    eligible: rows.length,
    heldAsReturned: rows.filter((row) => returned.has(row.id)).length,
  };
  if (options.dryRun || ids.length === 0) return result;

  const archivedAt = now.toISOString();
  for (const batch of chunkIds(ids)) {
    const { data, error } = await supabase
      .from("ats_candidates")
      .update({ archived_at: archivedAt, archived_by: AUTO_ARCHIVE_ACTOR })
      .in("id", batch)
      .eq("status", "rejected")
      .is("archived_at", null)
      .select("id");
    if (error) throw new Error(error.message);
    result.archived += (data ?? []).length;
  }
  return result;
}
