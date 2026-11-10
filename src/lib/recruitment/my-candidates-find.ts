// Recruitment — finding a CV on the manager's "My Candidates" page (owner, 2026-11-10: "premium polish
// the page, god mode enhancements").
//
// A district manager's page holds four lists at once — the CVs sent to him, his own shelf, a folder
// per area he holds, and the candidates on his open positions — and the same applicant can sit in
// more than one. Until this, finding "the one from Tanta who studied at Mansoura" meant opening every
// folder in turn. One search and four quick views now narrow ALL of those lists together.
//
// Pure, so the page and the tests read the same rules:
//   • every word typed must be found somewhere on the CV (AND, not OR) — a name, a phone, a town, a
//     university, a current employer, the role applied for;
//   • Arabic is matched the way people type it — أ إ آ ا are one letter, ى is ي, ة is ه, the short
//     vowels are ignored — and Arabic-Indic digits are read as digits;
//   • a word of digits is matched against the phone with every space and dash removed, so
//     "0100 123" finds 01001234567. A phone the page hid ("I will call" not pressed) is not on the
//     candidate at all — the server removed it — so a hidden number can never be searched out;
//   • the quick views are the questions a manager opens the page with: what is waiting on me, what
//     is new in my folders, and who have I said I will call.

import { isViewersOwnClaim, type CandidateCallClaims } from "@/lib/recruitment/candidate-call-claims";
import { isUnreviewedCandidateStatus } from "@/lib/recruitment/candidate-status";
import type { DistrictManagerBoard } from "@/lib/recruitment/district-manager-folders";
import { managerHoldDaysLeft } from "@/lib/recruitment/manager-hold-window";
import type { Candidate } from "@/lib/recruitment/types";

/** The quick views, in the order the tray shows them. */
export const MY_CANDIDATES_VIEWS = ["all", "waiting", "unopened", "calling", "leaving"] as const;
export type MyCandidatesView = (typeof MY_CANDIDATES_VIEWS)[number];

export const MY_CANDIDATES_VIEW_LABELS: Record<MyCandidatesView, string> = {
  all: "All",
  calling: "You will call",
  leaving: "Going back soon",
  unopened: "Not opened",
  waiting: "Waiting on you",
};

/** Everything a match needs beyond the candidate itself. */
export type MyCandidatesFind = {
  /** Who has said "I will call", keyed by candidate id — as loaded with the page. */
  claims: CandidateCallClaims;
  /** The folder CVs he has not opened since they were sent. */
  unseenIds: ReadonlySet<string>;
  /** The CVs going back to the recruitment team within `MANAGER_HOLD_WARN_DAYS` — see `goingBackSoonIds`. */
  leavingIds: ReadonlySet<string>;
  /** The words typed, already folded by `findTokens`. Empty = no search. */
  tokens: readonly string[];
  view: MyCandidatesView;
  viewerHrId: string | null;
};

/** A CV sent to him still needs his answer: untouched, or sent and not yet answered. */
export function isAwaitingManagerAnswer(status: string | null | undefined): boolean {
  return isUnreviewedCandidateStatus(status) || status === "sent_to_manager";
}

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/** One spelling for the ways the same word is typed — case, Arabic letter forms, vowels, digits. */
export function foldForFind(value: string): string {
  return value
    .toLowerCase()
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - ARABIC_INDIC_ZERO))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - EXTENDED_ARABIC_INDIC_ZERO))
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

/** The typed search as words, each folded. Nothing typed is no words, and no words matches everything. */
export function findTokens(query: string): string[] {
  const folded = foldForFind(query);
  return folded ? folded.split(" ") : [];
}

function digitsOnly(value: string): string {
  return value.replace(/\D+/g, "");
}

/** Every searchable word on the CV, folded once. */
function haystackOf(candidate: Candidate): { digits: string; text: string } {
  const parts = [
    candidate.fullName,
    candidate.email,
    candidate.phone,
    candidate.governorate,
    candidate.address,
    candidate.currentJobTitle,
    candidate.currentEmployer,
    candidate.appliedForJobTitle,
    candidate.faculty,
    candidate.university,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return { digits: candidate.phone ? digitsOnly(foldForFind(candidate.phone)) : "", text: foldForFind(parts.join(" ")) };
}

/** Whether every typed word is on this CV. A word of three or more digits is also tried against the phone's digits. */
export function candidateMatchesTokens(candidate: Candidate, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = haystackOf(candidate);
  return tokens.every((token) => {
    if (haystack.text.includes(token)) return true;
    const digits = digitsOnly(token);
    return digits.length >= 3 && digits.length === token.replace(/[\s-]/g, "").length && haystack.digits.includes(digits);
  });
}

/** Whether a candidate belongs in the chosen quick view. `awaiting` is the caller's own answer to "is this waiting on him". */
export function candidateInView(
  candidate: Candidate,
  awaiting: boolean,
  find: Pick<MyCandidatesFind, "claims" | "leavingIds" | "unseenIds" | "view" | "viewerHrId">,
): boolean {
  switch (find.view) {
    case "all":
      return true;
    case "waiting":
      return awaiting;
    case "unopened":
      return find.unseenIds.has(candidate.id);
    case "calling":
      return isViewersOwnClaim(find.claims[candidate.id] ?? null, find.viewerHrId);
    case "leaving":
      return find.leavingIds.has(candidate.id);
  }
}

/** The whole test: in the view AND carrying every typed word. */
export function matchesMyCandidatesFind(candidate: Candidate, awaiting: boolean, find: MyCandidatesFind): boolean {
  return candidateInView(candidate, awaiting, find) && candidateMatchesTokens(candidate, find.tokens);
}

/** True when anything narrows the page — a word typed or a view other than All. */
export function isFindActive(find: Pick<MyCandidatesFind, "tokens" | "view">): boolean {
  return find.view !== "all" || find.tokens.length > 0;
}

/**
 * The area boards with only the matching CVs left in each folder. EVERY FOLDER STAYS — an area with
 * no match is still one of his areas — and each board's count is recounted, so the line over it
 * says what is shown.
 */
export function narrowBoards<T extends { id: string }>(
  boards: readonly DistrictManagerBoard<T>[],
  keep: (candidate: T) => boolean,
): DistrictManagerBoard<T>[] {
  return boards.map((board) => {
    const folders = board.folders.map((folder) => ({ ...folder, candidates: folder.candidates.filter(keep) }));
    return { ...board, candidateCount: folders.reduce((sum, folder) => sum + folder.candidates.length, 0), folders };
  });
}

/** One CV on the page with its own answer to "is this waiting on him" — the input to the counts. */
export type MyCandidatesEntry = { awaiting: boolean; candidate: Candidate };

/**
 * How many DIFFERENT people each quick view holds, after the typed words — the figure on each tab.
 * Counted by person, never by card: an applicant in a folder and on a position is one CV. When the
 * same person is waiting in one list and not in another, waiting wins (he still owes an answer).
 */
export function countMyCandidatesViews(
  entries: readonly MyCandidatesEntry[],
  find: Omit<MyCandidatesFind, "view">,
): Record<MyCandidatesView, number> {
  const people = new Map<string, MyCandidatesEntry>();
  for (const entry of entries) {
    const known = people.get(entry.candidate.id);
    if (!known || (entry.awaiting && !known.awaiting)) people.set(entry.candidate.id, entry);
  }
  const counts: Record<MyCandidatesView, number> = { all: 0, calling: 0, leaving: 0, unopened: 0, waiting: 0 };
  for (const { awaiting, candidate } of people.values()) {
    if (!candidateMatchesTokens(candidate, find.tokens)) continue;
    for (const view of MY_CANDIDATES_VIEWS) {
      if (candidateInView(candidate, awaiting, { ...find, view })) counts[view] += 1;
    }
  }
  return counts;
}

// ── GOING BACK: the 45-day window, as a countdown on his own sends ─────────────────────────────────
//
// A CV sent to a manager leaves his account 45 days after it was sent (manager-hold-window.ts), and
// until now the page said so only in a sentence over the list. The countdown puts it on the CV that is
// actually about to go, so he answers it before it quietly disappears.
//
// ONLY WHERE THE WINDOW APPLIES. A manager who holds area folders keeps his sends with no clock (the
// send query drops the cutoff for him), so he is shown no countdown at all — a number counting down
// to an event that will not happen is worse than none. A CV reached through a requisition he owns is a
// hiring process, not an inbox, and is not governed either; only `initialSentToMe` is passed in here.

/** How close to going back a CV must be before it is flagged and counted in "Going back soon". */
export const MANAGER_HOLD_WARN_DAYS = 7;

/** Whole days until this sent CV goes back to the recruitment team, or null when no clock runs on it. */
export function goingBackInDays(
  candidate: Pick<Candidate, "managerNotified">,
  options: { holdsFolders: boolean; now: Date },
): number | null {
  if (options.holdsFolders) return null;
  const sentAt = candidate.managerNotified?.sentAt;
  if (!sentAt) return null;
  return managerHoldDaysLeft(sentAt, options.now);
}

/** The sent CVs within `MANAGER_HOLD_WARN_DAYS` of going back — the "Going back soon" view. */
export function goingBackSoonIds(
  candidates: readonly Pick<Candidate, "id" | "managerNotified">[],
  options: { holdsFolders: boolean; now: Date },
): Set<string> {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const days = goingBackInDays(candidate, options);
    if (days !== null && days > 0 && days <= MANAGER_HOLD_WARN_DAYS) ids.add(candidate.id);
  }
  return ids;
}

/** The words on a CV's countdown flag: "Goes back in 3 days", "Goes back tomorrow". */
export function goingBackLabel(days: number): string {
  if (days <= 1) return "Goes back tomorrow";
  return `Goes back in ${days} days`;
}
