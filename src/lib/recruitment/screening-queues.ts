// Recruitment / ATS — "what needs my attention right now?", answered as five piles.
//
// WHY THIS EXISTS. The screening queue could answer "who is next" and nothing else. Every other
// question a recruiter opens the module with — which CVs nobody has read, which ones are worth
// reading first, which ones are sitting unanswered with a manager, which ones might be the same
// person twice, who is being interviewed today — had to be reconstructed by hand out of eight
// dropdowns, and four of them could not be reconstructed at all.
//
// So this is the classifier behind the work-queue rail. It is PURE and it takes a structural row,
// for the same reason `red-flag.ts` and `screening-order.ts` are: the rule that decides what a
// recruiter is shown first is worth testing against a plain object rather than against 555
// production candidates, and the candidate list is a "use client" component, so a database import
// anywhere in this chain would drag the service-role client into the browser bundle.
//
// IT SORTS, IT NEVER HIDES. Every candidate is still reachable — "Everyone" is a queue too, and
// nothing here changes a status, removes a row, or decides anything about a person.

import { STALE_SEND_NUDGE_AFTER_DAYS } from "@/lib/recruitment/stale-send-thresholds";
import type { ScreeningBand } from "@/lib/recruitment/screening-order";
import type { CandidateStatus } from "@/lib/recruitment/candidate-status";

/**
 * The piles, in the order a recruiter should meet them.
 *
 * `all` is last and is deliberately part of the same vocabulary rather than a special case beside
 * it: a rail whose only escape from a narrowed pile is a different narrowed pile is a rail a
 * recruiter gets stuck in, and the empty case — a pile worked down to zero — is exactly where that
 * bites. Every screen that renders these renders `all` too.
 */
export const screeningWorkQueues = [
  "new",
  "recommended",
  "manager_feedback",
  "duplicates",
  "interviews",
  "all",
] as const;

export type ScreeningWorkQueue = (typeof screeningWorkQueues)[number];

/** The headline on the rail. Short — this sits in a 210px column. */
export const screeningWorkQueueLabels: Record<ScreeningWorkQueue, string> = {
  all: "Everyone",
  duplicates: "Duplicate review",
  interviews: "Interviews today",
  manager_feedback: "Manager feedback",
  new: "New CVs",
  recommended: "Recommended",
};

/** The second line, saying what the pile actually is rather than repeating its name. */
export const screeningWorkQueueDescriptions: Record<ScreeningWorkQueue, string> = {
  all: "Every CV in this pool",
  duplicates: "Same phone, two records",
  interviews: "Scheduled for today",
  manager_feedback: "Pending / overdue",
  new: "First review required",
  recommended: "Strong role fit",
};

/**
 * The sentence shown when a pile is empty.
 *
 * Written per queue rather than one generic "nothing here", because the four of these that can
 * legitimately read zero mean four different things, and "no duplicate groups" is good news while
 * "no CVs at all" is a filter the recruiter should undo.
 */
export const screeningWorkQueueEmptyLabels: Record<ScreeningWorkQueue, string> = {
  all: "No CVs match the filters above.",
  duplicates: "No two records share a phone number. Nothing to merge.",
  interviews: "Nobody is being interviewed today.",
  manager_feedback: "Every CV sent to a manager has been answered.",
  new: "Every CV here has been reviewed at least once.",
  recommended: "No field-force or pharma CVs are waiting in this pool.",
};

/**
 * The bands that put a CV in `recommended`.
 *
 * Field force is the job Phoenix hires into; pharma-adjacent is a pharmacist or product manager,
 * which is a real read even when the seat is not theirs. Everything below that — sales in another
 * industry, an unreadable title, another field entirely — is a CV worth reading, not a CV worth
 * reading FIRST, and putting it here would make the word "recommended" mean nothing.
 */
const RECOMMENDED_BANDS: readonly ScreeningBand[] = ["field_force", "pharma_adjacent"];

/**
 * Everything the classifier needs about one candidate.
 *
 * Structural rather than `Candidate`, so a test fixture is six fields instead of sixty and so the
 * server can hand this in already-derived — the client must never re-run the band computation over
 * 555 rows to draw a rail.
 */
export type WorkQueueInput = {
  band: ScreeningBand;
  status: CandidateStatus | null;
  /** How many records share this person's identity key, counting this one. 1 means no twin. */
  duplicateCount: number;
  /** When this CV went to a manager, or null. The ISO stamp, so "how long" is answerable. */
  sentToManagerAt: string | null;
  /**
   * When somebody with the CV in hand answered — a manager's comment, or a decision recorded after
   * the send. Null means the send is still open, which is the whole point of the pile.
   */
  answeredAt: string | null;
  /** An interview scheduled for today, Cairo. */
  interviewToday: boolean;
  /** Ineligible or already rejected — see red-flag.ts. Kept out of the "worth reading" piles. */
  redFlagged: boolean;
};

/** How many whole days a CV has been sitting with a manager, as at `now`. */
export function daysSinceSend(sentAt: string, now: Date): number {
  const sent = new Date(sentAt).getTime();
  if (!Number.isFinite(sent)) return 0;
  return Math.max(0, Math.floor((now.getTime() - sent) / 86_400_000));
}

/**
 * Has this CV been with a manager long enough to chase?
 *
 * Reads the SAME threshold the nightly stale-send check nudges on, imported rather than repeated.
 * The owner set three days himself on 2026-08-28 and was shown the objection before doing it; a
 * second copy of the number here is a second thing that can drift away from what actually fires.
 */
export function isManagerFeedbackOverdue(input: WorkQueueInput, now: Date): boolean {
  if (!input.sentToManagerAt || input.answeredAt) return false;
  return daysSinceSend(input.sentToManagerAt, now) >= STALE_SEND_NUDGE_AFTER_DAYS;
}

/**
 * Which piles this candidate is in. A candidate can be in several — that is not a defect.
 *
 * A brand-new medical rep CV is genuinely both "nobody has read this" and "worth reading first",
 * and forcing a single home for each row would mean one of those two rails lied about its own
 * size. The counts are counts of the pile, not a partition of the pool.
 */
export function workQueuesFor(input: WorkQueueInput): ScreeningWorkQueue[] {
  const queues: ScreeningWorkQueue[] = ["all"];

  // Unread and unjudged. Red-flagged rows are excluded: a rejected candidate or one whose CV states
  // a nationality we cannot hire is not "first review required" — a person already answered.
  if (!input.redFlagged && input.status === "new") queues.push("new");

  // Worth meeting first. Shortlisted stays in on purpose: a CV shortlisted but not yet sent is
  // still a recommendation waiting to be acted on, and dropping it the moment somebody agreed with
  // it would empty the pile of exactly the people it exists to surface.
  if (
    !input.redFlagged &&
    (input.status === "new" || input.status === "shortlisted") &&
    RECOMMENDED_BANDS.includes(input.band)
  ) {
    queues.push("recommended");
  }

  // Sent, and nothing has come back. Keyed on the send stamp and the answer, never on the status:
  // production carries sends whose status was later moved by hand, and a pile that empties because
  // somebody re-labelled a row is a pile that loses the candidate it was tracking.
  if (input.sentToManagerAt && !input.answeredAt) queues.push("manager_feedback");

  // Two records, one phone. Red-flagged rows are excluded for the same reason as above — merging a
  // rejected duplicate into a rejected duplicate is not work.
  if (!input.redFlagged && input.duplicateCount > 1) queues.push("duplicates");

  if (input.interviewToday) queues.push("interviews");

  return queues;
}

/** True when this candidate belongs in that pile. */
export function isInWorkQueue(input: WorkQueueInput, queue: ScreeningWorkQueue): boolean {
  return workQueuesFor(input).includes(queue);
}

export type WorkQueueCounts = Record<ScreeningWorkQueue, number>;

/** An empty tally — every queue present at zero, so a rail never has to guard a missing key. */
export function emptyWorkQueueCounts(): WorkQueueCounts {
  return {
    all: 0,
    duplicates: 0,
    interviews: 0,
    manager_feedback: 0,
    new: 0,
    recommended: 0,
  };
}

/**
 * How many are in each pile, plus how many of the manager sends are overdue.
 *
 * The overdue figure is reported BESIDE the manager-feedback count rather than replacing it: "12
 * pending, 4 of them overdue" is two facts a recruiter acts on differently, and collapsing them
 * into one number loses the eight that are merely in flight.
 */
export function tallyWorkQueues<T>(
  items: readonly T[],
  describe: (item: T) => WorkQueueInput,
  now: Date,
): { counts: WorkQueueCounts; overdueManagerFeedback: number } {
  const counts = emptyWorkQueueCounts();
  let overdueManagerFeedback = 0;
  for (const item of items) {
    const input = describe(item);
    for (const queue of workQueuesFor(input)) counts[queue] += 1;
    if (isManagerFeedbackOverdue(input, now)) overdueManagerFeedback += 1;
  }
  return { counts, overdueManagerFeedback };
}
