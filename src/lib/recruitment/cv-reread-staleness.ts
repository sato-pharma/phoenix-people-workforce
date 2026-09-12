// ─────────────────────────────────────────────────────────────────────────────
// Which candidates still need their CV read again, and which have already been read correctly.
//
// WHY THIS EXISTS. #3729 fixed four facts the CV extractor got wrong: a graduation year taken from
// the START of an ongoing degree, experience inflated for a fresh graduate, the CV headline stored
// as the current job, and a governorate contradicting the address. A re-read through the fixed
// extractor costs money per CV, and on 2026-09-12 roughly a third of the population had already
// been re-read. `--reread` had no way to say "only the ones that still carry the old reading", so
// finishing the job meant paying a second time for every CV already done.
//
// THE CUT IS A MOMENT, NOT A MARKER. The obvious alternative was to match the `created_by` marker
// of the run that did the work (`ops:cv-reread-20260912`). That was rejected: a marker names ONE
// run, so every future re-read would have to be added here or be re-read forever, and a typo in a
// marker reads exactly like a candidate that was never touched. A timestamp asks the question that
// actually matters — was this reading produced by an extractor that had the fix?
//
// 🔴 THE TRAP IN THAT QUESTION. These jobs run LOCALLY, against production, from whatever branch the
// operator's worktree is on. So a re-read can legitimately predate the merge: the session that
// BUILT the fix had it in its own worktree hours before it landed on `main`. That is not
// hypothetical — the 2026-09-12 re-read began at 00:05:17Z and #3729 merged at 00:09:24Z, so five
// candidates were read in the four minutes before the merge instant.
//
// The cut is therefore deliberately CONSERVATIVE: a reading written AT or BEFORE the merge counts
// as stale even when it may well have been produced by the fixed code. Re-reading a CV that was
// already right costs $0.0043 and changes nothing. Skipping one that is wrong leaves a bad fact on
// a real person's record, which is the entire defect this work exists to repair. When those two
// mistakes cost such different amounts, the cheap one is the one to make.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The instant #3729 — the extractor fix — merged to `main`.
 *
 * Read from GitHub, not remembered: `gh pr view 3729 --json mergedAt` answers
 * `2026-09-12T00:09:24Z` (03:09:24 Cairo), merge commit `51087466ddf307fbb5c68132b79710dfc392a1bb`.
 *
 * A later extractor fix does NOT belong here as an edit — that would silently re-date every
 * judgement this file has already made. Pass the new instant explicitly at the call site instead.
 */
export const EXTRACTOR_FIX_LANDED_AT = "2026-09-12T00:09:24Z";

/**
 * Whether this candidate's newest CV reading still needs to be produced again.
 *
 * `newestReadingAt` is the `created_at` of the newest `ats_candidate_cv_extractions` row for the
 * candidate, or null/undefined when there is no such row at all.
 *
 * Returns true — meaning RE-READ — in three cases:
 *
 *   1. There is no reading on file. Nothing has ever read this CV, so nothing about it is known.
 *   2. The reading is at or before `cutoff`. See the conservative-cut note in the header.
 *   3. The timestamp cannot be understood. A value this function cannot parse is a value it cannot
 *      reason about, and the failure direction here is chosen on cost: re-reading is cents, while
 *      wrongly skipping leaves a defect standing on a person's record.
 *
 * Returns false only when a reading is present, parseable, and STRICTLY newer than the cutoff.
 */
export function needsRereadThroughFixedExtractor(
  newestReadingAt: string | Date | null | undefined,
  cutoff: string | Date = EXTRACTOR_FIX_LANDED_AT,
): boolean {
  const readAt = toInstant(newestReadingAt);
  if (readAt === null) return true;

  const cutoffAt = toInstant(cutoff);
  // An unusable cutoff must never silently pass every candidate as "already fixed". Re-read.
  if (cutoffAt === null) return true;

  return readAt <= cutoffAt;
}

/** Milliseconds since the epoch, or null for anything this cannot make sense of. */
function toInstant(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
