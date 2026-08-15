// Recruitment — what the candidate pool actually looks like right now.
//
// The four numbers at the top of the recruitment page used to count requisitions, applications and
// hires. Measured in production on 2026-08-15 those read 3, 7, 0 and 7 while 152 CVs arrived that
// week — so the headline of the module described the part of it nobody uses, and said nothing about
// the part that runs hard. These four answer the questions Talent Acquisition actually opens the
// page with: what came in, what has nobody touched, and what has already gone to a manager.
//
// Pure and side-effect free, and computed SERVER-side by the two pages that render the workspace:
// "today" depends on the clock, and a clock read during hydration can disagree with the one from
// the server render across a Cairo midnight. Computing it once, before the props are sent, removes
// that class of bug entirely rather than accepting a rare wrong number.

import { isUnreviewedCandidateStatus } from "@/lib/recruitment/candidate-status";
import type { Candidate } from "@/lib/recruitment/types";

export type CandidatePoolStats = {
  arrivedToday: number;
  arrivedLast7Days: number;
  notYetReviewed: number;
  sentToManager: number;
  total: number;
  /**
   * The instant these were counted at, ISO. Sent to the browser so the pool's "arrived today"
   * filter and its New badge measure from the SAME clock reading as the cards above them — two
   * clock reads would let the cards and the list disagree, and a clock read during render would
   * differ between the server pass and hydration.
   */
  asOf: string;
};

const cairoDayFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

/**
 * The Cairo calendar day an instant falls on, as YYYY-MM-DD — the platform-wide convention.
 *
 * Never the server's own timezone: Railway runs in UTC and Cairo is UTC+2/+3, so a CV that arrived
 * at 01:30 Cairo would otherwise be counted as yesterday's for the first two or three hours of
 * every working day.
 */
export function cairoDayKey(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return cairoDayFormatter.format(date);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function summarizeCandidatePool(
  candidates: readonly Candidate[],
  now: Date = new Date(),
): CandidatePoolStats {
  const today = cairoDayKey(now);
  // Rolling seven days rather than "since Saturday": the pool is read at any hour of any day, and
  // "arrived in the last week" is the question, not "arrived in the current calendar week".
  const weekStart = now.getTime() - SEVEN_DAYS_MS;

  let arrivedToday = 0;
  let arrivedLast7Days = 0;
  let notYetReviewed = 0;
  let sentToManager = 0;

  for (const candidate of candidates) {
    const created = new Date(candidate.createdAt);
    if (!Number.isNaN(created.getTime())) {
      if (cairoDayKey(created) === today) arrivedToday += 1;
      if (created.getTime() >= weekStart) arrivedLast7Days += 1;
    }
    // "Nobody has looked at this yet" has a definition for the first time: the status is still the
    // one intake set. Before the fixed vocabulary this was unanswerable — 225 of 226 rows carried
    // the same free-text default whether or not a human had read them.
    if (isUnreviewedCandidateStatus(candidate.status)) notYetReviewed += 1;
    if (candidate.managerNotified) sentToManager += 1;
  }

  return {
    arrivedLast7Days,
    arrivedToday,
    asOf: now.toISOString(),
    notYetReviewed,
    sentToManager,
    total: candidates.length,
  };
}
