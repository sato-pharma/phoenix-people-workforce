// Recruitment / ATS — the decision tabs: one pile per verdict, on every screen that lists CVs.
//
// THE OWNER, 2026-09-18: "in any screening page you must show did not decide yet — I press on it, it
// shows me the people I did not decide yet — shortlisted, I press on it, I only see shortlisted — and
// rejected." And the reason, in his own words: once a CV is seen or decided it should not stay in
// every list making a crowd, so that when a new CV arrives he knows it easily.
//
// Asked in chat the same night, he chose:
//
//   - FIVE PILES AND AN "ALL", in this order: Not decided yet · Shortlisted · Sent to manager ·
//     Rejected · Hired · All. Sent and hired are their own piles rather than folded into another,
//     so every CV sits in exactly one of the five.
//   - EVERY SCREEN OPENS ON "NOT DECIDED YET". "All" sits last, for a search across everybody.
//   - A CV HE MOVES INTO ONE OF HIS OWN FOLDERS LEAVES EVERY PILE, and is found by opening the folder.
//     That half is `isInCvFolder` in candidate-folder.ts, not here.
//
// ONE RULE, THREE SCREENS. The screening page, the candidate pool and the WhatsApp Applicants page
// all place a CV with `candidateDecisionTabOf`, so "Rejected 12" means the same twelve people on
// each of them. Pure, and it imports one pure vocabulary, so a client component can use it without
// dragging a database client into the browser bundle.

import {
  candidateStatusLabels,
  normalizeCandidateStatus,
  type CandidateStatus,
} from "@/lib/recruitment/candidate-status";

/** The piles, in the order the owner reads them: the undecided work first, "All" last. */
export const candidateDecisionTabs = ["new", "shortlisted", "backup", "sent_to_manager", "rejected", "hired", "all"] as const;
export type CandidateDecisionTab = (typeof candidateDecisionTabs)[number];

/** The six piles a CV can actually sit in — every tab except "All". */
export type CandidateDecisionPile = Exclude<CandidateDecisionTab, "all">;

/** Where every screen opens: the CVs nobody has decided yet. */
export const DEFAULT_CANDIDATE_DECISION_TAB: CandidateDecisionTab = "new";

/**
 * The tab names. "Not decided yet" rather than the status's own "New": a CV that arrived in March
 * and was never decided is not new, and the owner named the pile by what it holds.
 */
export const candidateDecisionTabLabels: Record<CandidateDecisionTab, string> = {
  all: "All",
  backup: candidateStatusLabels.backup,
  hired: candidateStatusLabels.hired,
  new: "Not decided yet",
  rejected: candidateStatusLabels.rejected,
  sent_to_manager: candidateStatusLabels.sent_to_manager,
  shortlisted: candidateStatusLabels.shortlisted,
};

/** One line saying what a tab holds, for its tooltip. */
export const candidateDecisionTabDescriptions: Record<CandidateDecisionTab, string> = {
  all: "Every CV, whatever has been decided about it.",
  backup: "Held in reserve behind the shortlist.",
  hired: "Joined the company.",
  new: "Nobody has shortlisted, held back, rejected, sent or hired them yet.",
  rejected: "Not proceeding.",
  sent_to_manager: "Pushed to a hiring manager.",
  shortlisted: "Worth taking forward.",
};

export function isCandidateDecisionTab(value: unknown): value is CandidateDecisionTab {
  return typeof value === "string" && (candidateDecisionTabs as readonly string[]).includes(value);
}

/**
 * The one pile this CV sits in.
 *
 * A status the list cannot read goes to "Not decided yet", never to a decided pile: filing a CV as
 * decided on a guess about what somebody once typed would take it out of the pile where the work is,
 * and a person would be lost. Production held no such value on 2026-09-18 (all 1,142 rows sit on the five codes), so
 * this costs nothing today and stays right through any future backfill.
 */
export function candidateDecisionTabOf(status: string | null | undefined): CandidateDecisionPile {
  return normalizeCandidateStatus(status) ?? "new";
}

/** Does this CV belong on this tab? "All" keeps everybody. */
export function candidateMatchesDecisionTab(status: string | null | undefined, tab: CandidateDecisionTab): boolean {
  return tab === "all" || candidateDecisionTabOf(status) === tab;
}

/**
 * How many CVs each tab holds. "All" is the whole list, so it always equals the sum of the other six
 * — the one strip on the page whose numbers add up, because every CV sits in exactly one pile.
 */
export function countCandidatesByDecisionTab(
  candidates: Iterable<{ status?: string | null }>,
): Record<CandidateDecisionTab, number> {
  const counts: Record<CandidateDecisionTab, number> = {
    all: 0,
    backup: 0,
    hired: 0,
    new: 0,
    rejected: 0,
    sent_to_manager: 0,
    shortlisted: 0,
  };
  for (const candidate of candidates) {
    counts.all += 1;
    counts[candidateDecisionTabOf(candidate.status)] += 1;
  }
  return counts;
}

/**
 * The screening link's status narrowing, read as a tab: a status is that pile, and null is "All".
 *
 * The link keeps the `status` it has always carried rather than growing a second parameter for the
 * same question. What changed is only what its ABSENCE means — see `parseScreeningStatus` in
 * screening-link.ts.
 */
export function decisionTabForStatusFilter(status: CandidateStatus | null): CandidateDecisionTab {
  return status ?? "all";
}

/** The other direction: the status narrowing a tab asks the screening link for. */
export function statusFilterForDecisionTab(tab: CandidateDecisionTab): CandidateStatus | null {
  return tab === "all" ? null : tab;
}
