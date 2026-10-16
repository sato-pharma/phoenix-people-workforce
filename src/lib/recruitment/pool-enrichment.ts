// Recruitment — the pure halves of the page's whole-pool reads.
//
// The Recruitment page used to ask the database the same questions about the whole pool several times:
// six `head` counts of `ats_candidates.status` beside the pool read that already carries every status,
// and three enrichment loops that walked the pool's ids a hundred at a time. Every request crosses the
// Atlantic, so the page now reads the pool once, derives what it can from those rows, and walks the two
// small side tables whole. The decisions live here, free of any database client, so a test can drive
// them with plain arrays (this repository's suite runs with PRODUCTION credentials, so a test must
// never reach a real table).

import type { CandidateStatus } from "@/lib/recruitment/candidate-status";

/** How many candidates sit in each pile of the candidate pool (`ats_candidates.status`). */
export type PoolCounts = Record<CandidateStatus, number>;

/**
 * The six piles from a total and the five counted piles.
 *
 * `new` is the REMAINDER, not a count of its own: the decision tabs file a status nothing can read
 * under "not decided yet", and a legacy free-text status or a missing one belongs there too. One
 * rule for both ways of counting (the database's `head` counts and the pool's own rows), so the two
 * can never disagree about what "new" means.
 */
export function candidatePoolCountsFromTotals(totals: {
  backup: number;
  hired: number;
  rejected: number;
  sentToManager: number;
  shortlisted: number;
  total: number;
}): PoolCounts {
  return {
    backup: totals.backup,
    hired: totals.hired,
    new: Math.max(0, totals.total - totals.shortlisted - totals.backup - totals.sentToManager - totals.rejected - totals.hired),
    rejected: totals.rejected,
    sent_to_manager: totals.sentToManager,
    shortlisted: totals.shortlisted,
  };
}

/**
 * The same piles, counted from rows already in hand.
 *
 * Each status is matched EXACTLY, as the database's `.eq("status", …)` does, so a row whose status is
 * anything else (a legacy free-text value, or none) lands in `new` through the remainder rule above.
 * Only valid when the rows ARE the whole pool: a filtered list would count a different thing.
 */
export function countCandidatePoolStatuses(statuses: Iterable<string | null | undefined>): PoolCounts {
  let total = 0;
  let shortlisted = 0;
  let backup = 0;
  let sentToManager = 0;
  let rejected = 0;
  let hired = 0;
  for (const status of statuses) {
    total += 1;
    if (status === "shortlisted") shortlisted += 1;
    else if (status === "backup") backup += 1;
    else if (status === "sent_to_manager") sentToManager += 1;
    else if (status === "rejected") rejected += 1;
    else if (status === "hired") hired += 1;
  }
  return candidatePoolCountsFromTotals({ backup, hired, rejected, sentToManager, shortlisted, total });
}

/** One CV-reading row, as the verdict read selects it. */
export type ExtractionVerdictRow = {
  candidate_id?: unknown;
  created_at?: unknown;
  id?: unknown;
  is_cv?: unknown;
};

function textOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

/**
 * The candidates whose most recent CV read judged the file explicitly NOT to be a CV.
 *
 * The NEWEST row per candidate decides, so a later re-read that DID find a CV overrules an older "no".
 * "Newest" is compared as an instant, never as text: two spellings of one moment must not tie, and a
 * stamp that cannot be parsed sorts oldest so it can never overrule a real one. A true tie is broken
 * by the larger id, so the answer does not depend on the order the rows arrived in — the whole table
 * is read in id order now, where the batched read used to arrive newest-first.
 *
 * Only an explicit `false` lands in the set. NULL is "no judgement recorded" — every row written before
 * the column existed reads that way — and flagging those would hide real applicants.
 */
export function notACvCandidateIds(rows: readonly ExtractionVerdictRow[]): Set<string> {
  const newest = new Map<string, { id: string; isCv: unknown; time: number }>();
  for (const row of rows) {
    const candidateId = textOrNull(row.candidate_id);
    if (!candidateId) continue;
    const parsed = Date.parse(String(row.created_at ?? ""));
    const time = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    const id = String(row.id ?? "");
    const held = newest.get(candidateId);
    if (held && (held.time > time || (held.time === time && held.id >= id))) continue;
    newest.set(candidateId, { id, isCv: row.is_cv, time });
  }
  const notACv = new Set<string>();
  for (const [candidateId, verdict] of newest) {
    if (verdict.isCv === false) notACv.add(candidateId);
  }
  return notACv;
}
