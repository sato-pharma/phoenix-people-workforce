// Recruitment / ATS — "is this CV red?", answered in one place for every screen that asks.
//
// WHY THIS EXISTS. Red already meant something exact on this module's screens, and the rule was
// written down inside a JSX comment rather than in code: *"Rose is reserved for 'this candidate
// cannot be hired'."* Two things produce it on a candidate row — the CV states a nationality that
// is not Egyptian, and the candidate has been rejected — and each was tested inline, in a different
// file, in a different shape. The pool asked `isStatedNonEgyptian(candidate.nationality)`; the
// status pill asked a tone map. Nothing could ask the whole question, so nothing could COUNT it,
// filter on it, or put it in a tab.
//
// That is the defect this fixes, and it is the owner's own complaint: the CVs he cannot hire sit
// mixed in among the ones he can, on both the pool and the screening queue, so keeping up with
// "what came in that I can actually act on" means reading past them every single time.
//
// IT FLAGS, IT NEVER REJECTS — same rule `nationality.ts` and the expense engine both keep. Nothing
// here deletes a candidate, changes a status, or removes anybody from the system. It sorts the pool
// into two tabs that both remain fully visible, fully actionable, and fully counted.
//
// PURE, AND IT HAS TO STAY PURE. The candidate pool is a "use client" component, so a database
// import anywhere in this chain would drag the service-role client into the browser bundle — the
// exact failure screening-link.ts was split out of screening-queue.ts to avoid. `nationality` and
// `candidate-status` are pure; `types` is imported for its type only.

import { normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import { isStatedNonEgyptian, nonEgyptianFlagTitle } from "@/lib/recruitment/nationality";

/** The reasons a CV is red. Both mean the same thing to a recruiter: this person cannot be hired. */
export const candidateRedFlags = ["not_egyptian", "rejected"] as const;

export type CandidateRedFlag = (typeof candidateRedFlags)[number];

/**
 * Everything this module needs off a candidate — deliberately a structural type rather than
 * `Candidate`, so the pool row, the screening queue and a test fixture can all be answered about
 * without any of them having to build a whole candidate.
 */
export type RedFlagCandidate = {
  nationality?: string | null;
  status?: string | null;
};

/** Short, because these sit inside a table row that must not wrap. */
export const candidateRedFlagLabels: Record<CandidateRedFlag, string> = {
  not_egyptian: "Not Egyptian",
  rejected: "Rejected",
};

/**
 * Every red flag this candidate carries, in the order a reader should hear them.
 *
 * Ineligibility comes first because it is a fact about the applicant that no decision can undo,
 * whereas a rejection is a decision somebody made and could revisit.
 *
 * Note what is deliberately NOT red: a blank nationality (absent on the large majority of the pool
 * — treating unknown as foreign would paint a warning over nearly every row, which is the mistake
 * `isStatedNonEgyptian` exists to avoid), and a file the reader judged not to be a CV (amber, not
 * rose: nothing is wrong with the person, the attachment is simply a certificate).
 */
export function candidateRedFlagsFor(candidate: RedFlagCandidate | null | undefined): CandidateRedFlag[] {
  if (!candidate) return [];
  const flags: CandidateRedFlag[] = [];
  if (isStatedNonEgyptian(candidate.nationality)) flags.push("not_egyptian");
  if (normalizeCandidateStatus(candidate.status) === "rejected") flags.push("rejected");
  return flags;
}

/** True when the row shows a red pill today — the whole question, asked once. */
export function isRedFlaggedCandidate(candidate: RedFlagCandidate | null | undefined): boolean {
  return candidateRedFlagsFor(candidate).length > 0;
}

/**
 * The sentence explaining why this CV is in the red tab, for the tooltip on the row and the tab.
 *
 * Empty string when there is nothing to explain, so a caller can render it or not without first
 * asking a second question. The nationality half reuses `nonEgyptianFlagTitle` rather than
 * restating the policy — one wording of the Egyptian-nationals-only rule, not two that can drift.
 */
export function candidateRedFlagTitle(candidate: RedFlagCandidate | null | undefined): string {
  const flags = candidateRedFlagsFor(candidate);
  if (flags.length === 0) return "";
  const reasons = flags.map((flag) =>
    flag === "not_egyptian" ? nonEgyptianFlagTitle(candidate?.nationality) : "This candidate was rejected.",
  );
  return reasons.join(" ");
}

/** The two tabs, as one type — the pool and the screening queue both key their state on this. */
export type CandidateCvTab = "active" | "red";

export const candidateCvTabs = ["active", "red"] as const;

/**
 * What each tab is called on screen.
 *
 * "Active" rather than "Non-red" because a tab has to mean something to somebody who has never
 * been told what the colours are: these are the CVs still in play. The red tab is named for the
 * flag itself, which is the thing the reader is already looking at on the row.
 */
export const candidateCvTabLabels: Record<CandidateCvTab, string> = {
  active: "Active CVs",
  red: "Red-flagged",
};

/** One line under the tabs, so nobody has to guess what the split is. */
export const candidateCvTabDescriptions: Record<CandidateCvTab, string> = {
  active: "Every CV still in play — nothing on the row says this person cannot be hired.",
  red: "Not Egyptian, or already rejected. Still here, still open, still actionable — just not in the way of the rest.",
};

/**
 * Split a list into the two tabs, keeping each side in the order it arrived in.
 *
 * One pass rather than two `filter` calls, because the pool runs this over every row on every
 * keystroke in the search box, and because a single pass cannot drift into two predicates that
 * disagree about the same candidate.
 */
export function partitionCandidatesByRedFlag<T extends RedFlagCandidate>(
  candidates: readonly T[],
): Record<CandidateCvTab, T[]> {
  const active: T[] = [];
  const red: T[] = [];
  for (const candidate of candidates) {
    if (isRedFlaggedCandidate(candidate)) red.push(candidate);
    else active.push(candidate);
  }
  return { active, red };
}
