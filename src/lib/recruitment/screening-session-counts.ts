// Recruitment / ATS — the Screening page's numbers, moved by the decisions made since it loaded.
//
// WHY THIS EXISTS. The decision tab strip ("Not decided yet 40 · Shortlisted 12 …") and the work
// queue rail ("New CVs 31 …") were the server's counts at load time and nothing else. A Shortlist
// press kept the row in place — deliberately, so the reader never loses his place — and left every
// number exactly where it was, so the page said nothing had happened. The owner, 19 Oct 2026: "when i
// or the talent acquisition short list someone the numbers do not change".
//
// THE ROW STILL DOES NOT MOVE. Only the numbers do. Each decision of this sitting is applied once,
// from the row's STORED status (what the server counted) to the one just given, so pressing Undo puts
// the number back and a second verdict on the same CV never counts twice.
//
// PURE, and fed the rows the page already holds: the workstation is a "use client" component, so a
// database import anywhere in this chain would drag the service-role client into the browser bundle.

import {
  candidateDecisionTabOf,
  candidateMatchesDecisionTab,
  type CandidateDecisionTab,
} from "@/lib/recruitment/candidate-decision-tabs";
import type { CandidateStatus } from "@/lib/recruitment/candidate-status";
import type { ScreeningWorkQueue, WorkQueueCounts } from "@/lib/recruitment/screening-queues";

/** What these counts read off a row: its stored status and the piles the server put it in. */
export type SessionCountRow = {
  id: string;
  status: CandidateStatus | null;
  queues: readonly ScreeningWorkQueue[];
};

/** Every row of this sitting whose decision moved it to a different decision pile. */
function movedRows(rows: readonly SessionCountRow[], decided: Readonly<Record<string, CandidateStatus>>) {
  const moved: { row: SessionCountRow; to: CandidateStatus }[] = [];
  for (const row of rows) {
    const to = decided[row.id];
    if (!to) continue;
    if (candidateDecisionTabOf(row.status) === candidateDecisionTabOf(to)) continue;
    moved.push({ row, to });
  }
  return moved;
}

/**
 * The decision tab strip's numbers after this sitting's decisions.
 *
 * Every CV sits in exactly one pile, so a decision is one pile down and another up, and "All" never
 * moves. Floored at zero: a count can only be short if the server's snapshot and the rows disagree,
 * and a negative number on a tab would be the worse of the two wrong answers.
 */
export function decisionCountsAfterSession(
  counts: Readonly<Record<CandidateDecisionTab, number>>,
  rows: readonly SessionCountRow[],
  decided: Readonly<Record<string, CandidateStatus>>,
): Record<CandidateDecisionTab, number> {
  const next = { ...counts };
  for (const { row, to } of movedRows(rows, decided)) {
    const from = candidateDecisionTabOf(row.status);
    next[from] = Math.max(0, next[from] - 1);
    next[candidateDecisionTabOf(to)] += 1;
  }
  return next;
}

/**
 * The work queue rail's numbers after this sitting's decisions.
 *
 * The rail counts the piles INSIDE the decision tab the page is on. Two cases:
 *
 * - The decision took the CV OFF this tab (shortlisted from "Not decided yet"): it has left every
 *   pile here except "Everyone", which stays the length of the list, because the row itself is still
 *   on screen wearing its verdict until the next load.
 * - It stayed on the tab ("All"): only the piles that read the status move — "New CVs" holds only the
 *   undecided, "Recommended" only the undecided and the shortlisted, and a rejection is red-flagged.
 *
 * Every other pile (duplicates, CV data to save, manager feedback, interviews, not a CV) is a fact
 * about the CV rather than about the decision, and is left as the server counted it.
 */
export function workQueueCountsAfterSession(
  counts: Readonly<WorkQueueCounts>,
  rows: readonly SessionCountRow[],
  decided: Readonly<Record<string, CandidateStatus>>,
  decisionTab: CandidateDecisionTab,
): WorkQueueCounts {
  const next = { ...counts };
  const drop = (queue: ScreeningWorkQueue) => {
    next[queue] = Math.max(0, next[queue] - 1);
  };
  for (const { row, to } of movedRows(rows, decided)) {
    if (!candidateMatchesDecisionTab(to, decisionTab)) {
      for (const queue of row.queues) if (queue !== "all") drop(queue);
      continue;
    }
    if (row.queues.includes("new") && to !== "new") drop("new");
    if (row.queues.includes("recommended") && to !== "new" && to !== "shortlisted") drop("recommended");
    if (to === "rejected" && !row.queues.includes("red_flagged")) next.red_flagged += 1;
  }
  return next;
}
